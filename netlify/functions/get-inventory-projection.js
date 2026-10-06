/**
 * get-inventory-projection.js  (v2, 2026-10-06)
 * SAVE AS: netlify/functions/get-inventory-projection.js
 *
 * SHADOW MODE: estimates each technician's current-year registration-form
 * rolls on hand right now, so the number can be compared with the next sheet
 * they actually submit. It sends nothing and flags nothing.
 *
 *   projected = last counted rolls
 *             - (completed restocks since the sheet date x rollsPerRestock)
 *             + rolls from shipments that arrived after the sheet
 *
 * Inputs it reads (all already in the database):
 *   inventory_sheets      parsed count sheets (saved from inventory mail)
 *   site_visits           completed restocks per technician (closed-ticket data)
 *   consumable_shipments  Neumo -> technician shipments
 *   technicians           roster (id, state, contractor flag)
 *
 * ASSUMPTIONS (shown on the page, adjustable by query string):
 *   rollsPerRestock  default 1    forms rolls used per completed restock. A
 *                                 first guess; it should be calibrated from
 *                                 consecutive sheets (see `calibration`).
 *   reserveWeeks     default 4    weeks of use a technician should keep; rolls
 *                                 beyond that are reported as "spare".
 * A shipment counts as arrived when marked delivered, or when it shipped more
 * than 7 days ago with no confirmation ("likely arrived"). Shipments that
 * shipped no later than 5 days before the sheet date are assumed to be in that
 * count already. Partial rolls are ignored (only reliable at month-end).
 *
 * v2 (2026-10-06): adds "on the way" per technician -- current-year form rolls in
 * shipments that are requested or shipped but not yet delivered, so a low projected
 * number is not alarming when the box is already coming. It is reported separately
 * and is NOT added into projectedNow (that stays "what the tech should have in hand
 * now"); the page shows it in its own column with the total after arrival.
 *   - shipped, not delivered, shipped within LIKELY_ARRIVED_DAYS (older ones are
 *     already treated as arrived above)
 *   - requested, no tracking yet, requested within REQUEST_STALE_DAYS (older ones
 *     are assumed never to have shipped and are ignored)
 *   - same "already in the count" rule as arrivals: skipped if it shipped / was
 *     requested ALREADY_COUNTED_DAYS or more before the sheet date
 *   - only rolls of the technician's own current-year form count (other items such
 *     as paper, ribbon and cleaning cards are ignored), same match as arrivals
 *
 * GET ?state=GA  &rollsPerRestock=1  &reserveWeeks=4
 */
const { createClient } = require("@supabase/supabase-js");
const { resolveSheetTech } = require("./lib/inventory-names.js");

const LIKELY_ARRIVED_DAYS = 7;
const ALREADY_COUNTED_DAYS = 5;
const REQUEST_STALE_DAYS = 14;
const AVG_WINDOW_DAYS = 56;

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(obj),
  };
}
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const normCode = (v) => { const s = String(v == null ? "" : v).replace(/\s+/g, ""); return /^\d{5,}$/.test(s) ? s.replace(/^0+/, "") : null; };
function etDate(d) { return new Date(d).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
function addDaysStr(ymd, n) { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000); }

// Current-year forms = the form item with the latest year in its name.
function currentYearForms(parsed) {
  const forms = (parsed && parsed.summary && parsed.summary.forms) || [];
  const dated = forms.filter((f) => f.year).sort((a, b) => Number(b.year) - Number(a.year));
  return dated[0] || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Supabase env vars not configured" });
  const q = event.queryStringParameters || {};
  const rollsPerRestock = Math.max(0, Number(q.rollsPerRestock) || 1);
  const reserveWeeks = Math.max(0, Number(q.reserveWeeks) || 4);
  const stateFilter = /^[A-Z]{2}$/.test(String(q.state || "").toUpperCase()) ? String(q.state).toUpperCase() : "";
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const today = etDate(new Date());

  const { data: techs, error: tErr } = await supabase.from("technicians").select("id, name, home_state, is_contractor, active").eq("active", true);
  if (tErr) return json(500, { error: tErr.message });
  const roster = techs || [];

  const { data: sheets, error: sErr } = await supabase
    .from("inventory_sheets").select("id, filename, received_at, parsed").not("parsed", "is", null)
    .order("received_at", { ascending: false }).limit(600);
  if (sErr) return json(500, { error: sErr.message });

  // Two newest sheets per technician (by the date written on the sheet).
  const byTech = new Map();
  for (const s of sheets || []) {
    const p = s.parsed || {};
    const tech = resolveSheetTech(roster, p.techName);
    if (!tech) continue;
    // Some sheets have no readable date cell; fall back to the day the sheet
    // arrived (Eastern) and mark it.
    const date = p.invDate || etDate(s.received_at);
    if (!byTech.has(tech.id)) byTech.set(tech.id, { tech, list: [] });
    byTech.get(tech.id).list.push({ date, dateFromArrival: !p.invDate, receivedAt: s.received_at, parsed: p, filename: s.filename });
  }

  const out = [];
  const windowStart = addDaysStr(today, -AVG_WINDOW_DAYS);
  for (const { tech, list } of byTech.values()) {
    if (stateFilter && String(tech.home_state || "").toUpperCase() !== stateFilter) continue;
    // newest date first; same date -> later arrival wins
    list.sort((a, b) => (a.date === b.date ? String(b.receivedAt).localeCompare(String(a.receivedAt)) : b.date.localeCompare(a.date)));
    const L = list[0];
    const P = list.find((x) => x.date < L.date) || null;
    const cy = currentYearForms(L.parsed);
    if (!cy || cy.count == null) continue;
    const codeKey = normCode(cy.code);

    const restocksBetween = async (fromExcl, toIncl) => {
      const { data, error } = await supabase.from("site_visits").select("id, started_at, is_restock, included_restock")
        .ilike("tech_name_raw", tech.name).gte("started_at", addDaysStr(fromExcl, 1) + "T00:00:00-05:00")
        .lte("started_at", toIncl + "T23:59:59-04:00").limit(2000);
      if (error) return 0;
      return (data || []).filter((v) => v.is_restock || v.included_restock).filter((v) => {
        const d = etDate(v.started_at); return d > fromExcl && d <= toIncl;
      }).length;
    };

    // Two plain queries (by id, by name) instead of .or(), so names with
    // spaces or punctuation cannot break the filter string.
    const shipCols = "shipped_at, request_date, status, delivered_at, items, tech_name_raw, technician_id";
    const [byId, byName] = await Promise.all([
      supabase.from("consumable_shipments").select(shipCols).eq("technician_id", tech.id),
      supabase.from("consumable_shipments").select(shipCols).ilike("tech_name_raw", tech.name),
    ]);
    const seenShip = new Set();
    const ships = [...(byId.data || []), ...(byName.data || [])].filter((x) => {
      const k = x.shipped_at + "|" + x.tech_name_raw + "|" + JSON.stringify(x.items);
      if (seenShip.has(k)) return false; seenShip.add(k); return true;
    });
    const rollsFor = (sh) => {
      let r = 0;
      for (const it of Array.isArray(sh.items) ? sh.items : []) if (normCode(it.sku) === codeKey) r += Number(it.units) || 0;
      return r;
    };
    const arrivedBetween = (fromDate, toDate) => {
      const got = []; let rolls = 0;
      for (const sh of ships || []) {
        const r = rollsFor(sh);
        if (!r || !sh.shipped_at || sh.status === "cancelled") continue;
        const delivered = sh.status === "delivered";
        const deliveredOn = delivered && sh.delivered_at ? etDate(sh.delivered_at) : null;
        const likely = !delivered && daysBetween(sh.shipped_at, toDate) > LIKELY_ARRIVED_DAYS;
        if (!delivered && !likely) continue;
        if (sh.shipped_at <= addDaysStr(fromDate, -ALREADY_COUNTED_DAYS)) continue; // assumed already in the count
        if (deliveredOn && deliveredOn <= fromDate) continue;
        got.push({ shippedAt: sh.shipped_at, rolls: r, confirmed: delivered });
        rolls += r;
      }
      return { rolls, list: got };
    };

    // Rolls still on the way: requested or shipped, not delivered, not old enough to
    // have been treated as arrived. Reported on its own (see header note).
    const onTheWayFor = (fromDate, toDate) => {
      const list = []; let rolls = 0;
      for (const sh of ships || []) {
        const r = rollsFor(sh);
        if (!r || sh.status === "cancelled" || sh.status === "delivered") continue;
        const isShipped = !!sh.shipped_at;
        const startedOn = isShipped ? sh.shipped_at : sh.request_date;
        if (!startedOn) continue;
        if (isShipped && daysBetween(sh.shipped_at, toDate) > LIKELY_ARRIVED_DAYS) continue;      // treated as arrived
        if (!isShipped && daysBetween(sh.request_date, toDate) > REQUEST_STALE_DAYS) continue;    // never shipped, stale
        if (startedOn <= addDaysStr(fromDate, -ALREADY_COUNTED_DAYS)) continue;                    // assumed in the count
        list.push({ status: isShipped ? "shipped" : "requested", date: startedOn, rolls: r });
        rolls += r;
      }
      list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return { rolls, list };
    };

    const since = await restocksBetween(L.date, today);
    const arr = arrivedBetween(L.date, today);
    const usedSince = since * rollsPerRestock;
    const projected = cy.count - usedSince + arr.rolls;
    const incoming = onTheWayFor(L.date, today);

    const { data: recent } = await supabase.from("site_visits").select("started_at, is_restock, included_restock")
      .ilike("tech_name_raw", tech.name).gte("started_at", windowStart + "T00:00:00-05:00").limit(3000);
    const recentRestocks = (recent || []).filter((v) => v.is_restock || v.included_restock).length;
    const weeklyRestocks = recentRestocks / (AVG_WINDOW_DAYS / 7);
    const weeklyUse = weeklyRestocks * rollsPerRestock;
    const weeksSupply = weeklyUse > 0 ? projected / weeklyUse : null;
    const spare = weeklyUse > 0 ? Math.max(0, Math.floor(projected - weeklyUse * reserveWeeks)) : Math.max(0, Math.floor(projected));

    let calibration = null;
    if (P) {
      const pcy = currentYearForms(P.parsed);
      if (pcy && pcy.count != null && normCode(pcy.code) === codeKey) {
        const rb = await restocksBetween(P.date, L.date);
        const ab = arrivedBetween(P.date, L.date);
        const used = pcy.count + ab.rolls - cy.count;
        // Negative usage means stock rose by more than the shipments we know
        // arrived, usually a shipment whose arrival date is unconfirmed. Report
        // that instead of a nonsense factor.
        const implied = rb > 0 && used >= 0 ? Math.round((used / rb) * 100) / 100 : null;
        calibration = {
          from: P.date, to: L.date, restocks: rb, shippedRolls: ab.rolls, rollsUsed: used, impliedRollsPerRestock: implied,
          note: used < 0 ? "Stock rose more than the known shipments explain. Confirm delivery dates on the shipments list." : (rb === 0 ? "No restocks recorded between the sheets." : null),
        };
      }
    }

    out.push({
      name: tech.name, state: tech.home_state, contractor: !!tech.is_contractor,
      sheetDate: L.date, sheetDateFromArrival: !!L.dateFromArrival, previousSheetDate: P ? P.date : null,
      itemName: cy.name, counted: cy.count, par: cy.par,
      restocksSince: since, estUsedSince: Math.round(usedSince * 10) / 10,
      shipments: arr.list, shippedRollsSince: arr.rolls,
      projectedNow: Math.round(projected * 10) / 10,
      onTheWay: incoming.list, onTheWayRolls: incoming.rolls,
      projectedAfterArrival: Math.round((projected + incoming.rolls) * 10) / 10,
      weeklyRestocks: Math.round(weeklyRestocks * 10) / 10, weeklyUseRolls: Math.round(weeklyUse * 10) / 10,
      weeksSupply: weeksSupply == null ? null : Math.round(weeksSupply * 10) / 10,
      spareRolls: spare,
      comment: (L.parsed.items || []).filter((i) => i.comment && i.comment.trim()).map((i) => i.name + ": " + i.comment.trim()).slice(0, 3),
      calibration,
    });
  }
  out.sort((a, b) => String(a.state).localeCompare(String(b.state)) || a.name.localeCompare(b.name));
  return json(200, {
    ok: true, asOf: today, shadowMode: true,
    assumptions: { rollsPerRestock, reserveWeeks, likelyArrivedDays: LIKELY_ARRIVED_DAYS, alreadyCountedDays: ALREADY_COUNTED_DAYS, usageWindowDays: AVG_WINDOW_DAYS, product: "current-year registration forms (whole rolls)" },
    technicians: out,
  });
};
