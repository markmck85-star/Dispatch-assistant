/**
 * lib/inventory-transit.js  (v1, 2026-10-06)
 * SAVE AS: netlify/functions/lib/inventory-transit.js
 *
 * "In Transit" check for inventory count sheets. A technician whose sheet leaves
 * the In Transit column empty for an item that Neumo has already requested or
 * shipped to them gets flagged, the same way a bad date does: the sheet is held
 * (not "ready to send"), listed on the checks panel, and can be texted back for a
 * resubmit. Without it the sheet's "To Be Ordered" number comes out too high and
 * Neumo's inventory analyst finds out about the shipment by herself.
 *
 * Pure functions only; callers fetch the shipments (consumable_shipments).
 *
 * A shipment counts as "on the way when the count was taken" when ALL are true:
 *   - it is not cancelled and has a tracked item with the same product code as a
 *     sheet line (forms, ribbon, journal paper; leading zeros ignored)
 *   - it was requested / shipped STRICTLY BEFORE the sheet's count date (a request
 *     emailed the same day as the count may not have been seen yet)
 *   - shipped but not delivered: shipped no more than SHIPPED_WINDOW_DAYS before
 *     the count (older ones are treated as already arrived, same as the projection)
 *   - requested but not shipped yet: requested no more than REQUEST_WINDOW_DAYS
 *     before the count (older ones are assumed never to have shipped)
 *   - delivered: only if it was delivered AFTER the count date (so it really was in
 *     transit on the count day)
 * and the sheet's In Transit cell for that item is empty or 0. Any number there
 * (even a different one) is accepted: this checks "left blank", not the quantity.
 */
const SHIPPED_WINDOW_DAYS = 7;
const REQUEST_WINDOW_DAYS = 14;
const CHECKED_KINDS = new Set(["forms", "ribbon", "journal"]);

const normCode = (v) => {
  const s = String(v == null ? "" : v).replace(/\s+/g, "");
  return /^\d{5,}$/.test(s) ? s.replace(/^0+/, "") : null;
};
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const dayDiff = (a, b) => Math.round((new Date(a + "T12:00:00Z") - new Date(b + "T12:00:00Z")) / 86400000);
const etDate = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const shortDate = (ymd) => { const m = String(ymd || "").match(/^\d{4}-(\d{2})-(\d{2})/); return m ? Number(m[1]) + "/" + Number(m[2]) : String(ymd || ""); };

/** The shipments that belong to one technician (by id, or by the name on the request). */
function shipmentsForTech(tech, shipments) {
  if (!tech) return [];
  const n = normName(tech.name);
  return (shipments || []).filter((s) => s.technician_id === tech.id || (n && normName(s.tech_name_raw) === n));
}

function isBlank(v) {
  if (v == null || v === "") return true;
  const n = Number(v);
  return Number.isFinite(n) ? n === 0 : false;
}

/**
 * @param items      parsed sheet lines ({ code, name, kind, inTransit })
 * @param sheetDate  YYYY-MM-DD count date from the sheet (skip the check if unknown)
 * @param shipments  this technician's consumable_shipments rows
 * @returns [{ code, itemCode, itemName, units, unit, boxes, status, since, text }]
 */
function transitProblems(items, sheetDate, shipments) {
  const out = [];
  if (!sheetDate || !/^\d{4}-\d{2}-\d{2}$/.test(sheetDate)) return out;
  const seenCode = new Set();
  for (const it of items || []) {
    if (!it || !CHECKED_KINDS.has(it.kind)) continue;
    const key = normCode(it.code);
    if (!key || seenCode.has(key) || !isBlank(it.inTransit)) continue;
    seenCode.add(key);

    let units = 0, boxes = 0, unit = null, earliest = null, anyShipped = false;
    for (const sh of shipments || []) {
      if (!sh || sh.status === "cancelled") continue;
      const shipped = !!sh.shipped_at;
      const start = shipped ? sh.shipped_at : sh.request_date;
      if (!start || !(start < sheetDate)) continue;                                    // strictly before the count
      if (sh.status === "delivered") {
        const deliveredOn = sh.delivered_at ? etDate(sh.delivered_at) : null;
        if (!deliveredOn || deliveredOn <= sheetDate) continue;                        // had already arrived
      } else if (shipped) {
        if (dayDiff(sheetDate, sh.shipped_at) > SHIPPED_WINDOW_DAYS) continue;         // treated as arrived
      } else if (dayDiff(sheetDate, sh.request_date) > REQUEST_WINDOW_DAYS) continue;  // never shipped
      for (const li of Array.isArray(sh.items) ? sh.items : []) {
        if (normCode(li.sku) !== key) continue;
        units += Number(li.units) || 0;
        boxes += Number(li.boxes) || 0;
        if (!unit && li.unit) unit = String(li.unit).toLowerCase();
        if (!earliest || start < earliest) earliest = start;
        if (shipped) anyShipped = true;
      }
    }
    if (units > 0) {
      const what = anyShipped ? "shipped" : "requested";
      const unitWord = unit || "units";
      out.push({
        code: "transit_missing",
        itemCode: it.code, itemName: it.name, units, unit: unitWord, boxes, status: what, since: earliest,
        text: `${it.name}: In Transit is empty, but ${units} ${unitWord}` + (boxes ? ` (${boxes} box${boxes === 1 ? "" : "es"})` : "") +
          (anyShipped ? ` shipped ${shortDate(earliest)} are on the way` : ` were requested ${shortDate(earliest)}`),
      });
    }
  }
  return out;
}

module.exports = { transitProblems, shipmentsForTech, SHIPPED_WINDOW_DAYS, REQUEST_WINDOW_DAYS, _normCode: normCode };
