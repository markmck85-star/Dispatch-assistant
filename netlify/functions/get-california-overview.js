/**
 * get-california-overview.js -- 2026-10-29
 *
 * Everything the California page shows, in one call:
 *   team      technicians with home state CA (plus roster-only staff)
 *   sites     active CA sites with default/backup technician and driving miles
 *   restock   rows from the newest California dispatch list email, with how many
 *             days past the list's "Restock By" date each one is
 *   tickets   open CA tickets (trouble, maintenance, other)
 *   visits    the most recent California closed visits
 *
 * Neumo's "Restock By" date is the date the call was first requested, so a date in
 * the past means the stop is that many days late.
 *
 * GET /.netlify/functions/get-california-overview
 */
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) };
}

async function fetchAll(makeQuery) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await makeQuery().range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

const DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
const pad = (n) => String(n).padStart(2, "0");

function etToday() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return p; // YYYY-MM-DD
}
function dayDiff(a, b) { // a - b in whole days, both YYYY-MM-DD
  return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
}

// Reads the California rows out of one dispatch list email body. A row starts at its
// site code and runs to the next site code. Quantity cells are plain numbers, the
// consumables cell is the text, and every M/D/YYYY in the row is a date; the last one is
// the Restock By date. If an earlier date also appears (a request date shown in the
// consumables column) it is returned as requestedOn.
function parseCaRows(text) {
  const rows = [];
  const body = String(text || "").replace(/\r/g, "");
  const matches = [...body.matchAll(/\b(CA\d{3,5})\b/g)];
  for (let i = 0; i < matches.length; i++) {
    const code = matches[i][1];
    const start = matches[i].index + code.length;
    let end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    let span = body.slice(start, end);
    // the next row begins with the state cell and the location name, which sit before the next code
    const cut = span.search(/\n\s*CA\s*\n/);
    if (cut > -1) span = span.slice(0, cut);
    const sig = body.slice(start).search(/\n\s*(Thank you|Thanks|Regards)/i);
    if (i + 1 >= matches.length && sig > -1) span = body.slice(start, start + sig);
    const dates = [...span.matchAll(DATE_RE)].map((m) => `${m[3]}-${pad(m[1])}-${pad(m[2])}`);
    const cells = span.split(/\n/).map((s) => s.trim()).filter(Boolean)
      .filter((s) => !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s) && !/^\d{1,6}$/.test(s) && !/^-+$/.test(s));
    const nums = span.split(/\n/).map((s) => s.trim()).filter((s) => /^\d{1,6}$/.test(s)).map(Number);
    let consumables = cells.join(", ").replace(/\s+/g, " ").slice(0, 160);
    consumables = consumables.replace(/^[-–]\s*/, "");
    rows.push({
      code,
      lf: nums[0] ?? null, lr: nums[1] ?? null, rf: nums[2] ?? null, rr: nums[3] ?? null, journal: nums[4] ?? null,
      consumables,
      restockBy: dates.length ? dates[dates.length - 1] : null,
      requestedOn: dates.length > 1 ? dates[0] : null,
    });
  }
  return rows;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Supabase env vars not configured" });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    const [techs, sites] = await Promise.all([
      fetchAll(() => supabase.from("technicians").select("id, name, title, phone, email, city, is_contractor, roster_only, active").eq("home_state", "CA").eq("active", true).order("name")),
      fetchAll(() => supabase.from("sites").select("id, site_code, name, address, county, lat, lng, machine_type, primary_tech_id, fallback_tech_id").eq("state", "CA").eq("active", true).order("site_code")),
    ]);
    const techById = new Map(techs.map((t) => [t.id, t]));
    // primary/fallback technicians may live outside the CA list in odd cases; look them up too
    const missing = [...new Set(sites.flatMap((s) => [s.primary_tech_id, s.fallback_tech_id]).filter((id) => id && !techById.has(id)))];
    if (missing.length) {
      const { data } = await supabase.from("technicians").select("id, name").in("id", missing);
      (data || []).forEach((t) => techById.set(t.id, t));
    }
    const siteIds = sites.map((s) => s.id);
    const siteByCode = new Map(sites.map((s) => [s.site_code, s]));
    const siteById = new Map(sites.map((s) => [s.id, s]));

    // stored distances: prefer driving over straight-line
    const chunks = [];
    for (let i = 0; i < siteIds.length; i += 60) chunks.push(siteIds.slice(i, i + 60));
    const dists = (await Promise.all(chunks.map((c) => fetchAll(() => supabase.from("tech_site_distances").select("technician_id, site_id, distance_mi, mode").in("site_id", c))))).flat();
    const distMap = new Map();
    for (const d of dists) {
      const k = d.technician_id + "|" + d.site_id;
      const cur = distMap.get(k);
      if (!cur || (d.mode === "driving" && cur.mode !== "driving")) distMap.set(k, d);
    }
    const mi = (tid, sid) => { const d = distMap.get(tid + "|" + sid); return d ? Math.round(d.distance_mi) : null; };

    const siteRows = sites.map((s) => ({
      code: s.site_code, name: (s.name || "").replace(/^CA - /, ""), address: s.address, county: s.county, machine: s.machine_type || null,
      primary: techById.get(s.primary_tech_id)?.name || null, primaryMi: s.primary_tech_id ? mi(s.primary_tech_id, s.id) : null,
      fallback: techById.get(s.fallback_tech_id)?.name || null, fallbackMi: s.fallback_tech_id ? mi(s.fallback_tech_id, s.id) : null,
    }));

    // newest California dispatch list
    const since = new Date(Date.now() - 120 * 86400000).toISOString();
    const { data: mails } = await supabase.from("inbound_emails").select("id, subject, body_text, received_at")
      .eq("classified_as", "dispatch_list").gte("received_at", since).order("received_at", { ascending: false }).limit(60);
    let list = null;
    for (const m of mails || []) {
      if (!/Consumables Needed/i.test(m.body_text || "")) continue;
      const rows = parseCaRows(m.body_text);
      if (rows.length >= 1) { list = { receivedAt: m.received_at, rows }; break; }
    }

    // last restock visit per site, for the restock rows
    const lastVisit = new Map();
    const visitsAll = await fetchAll(() => supabase.from("site_visits").select("site_id, started_at, is_restock, included_restock, tech_name_raw, remediation, closing_note, appointment_number, wo_number").eq("state", "CA").order("started_at", { ascending: false }));
    for (const v of visitsAll) {
      if ((v.is_restock || v.included_restock) && !lastVisit.has(v.site_id)) lastVisit.set(v.site_id, v.started_at);
    }

    const today = etToday();
    let restock = [];
    if (list) {
      restock = list.rows.map((r) => {
        const s = siteByCode.get(r.code);
        const due = r.requestedOn || r.restockBy; // a request date in the consumables column is the true age
        return {
          code: r.code, name: s ? (s.name || "").replace(/^CA - /, "") : null, county: s?.county || null,
          primary: s ? techById.get(s.primary_tech_id)?.name || null : null,
          consumables: r.consumables, requestedOn: r.requestedOn || r.restockBy, restockBy: r.restockBy,
          counts: { lf: r.lf, lr: r.lr, rf: r.rf, rr: r.rr, journal: r.journal },
          daysLate: due ? dayDiff(today, due) : null,
          lastRestock: s ? (lastVisit.get(s.id) || null) : null,
        };
      }).sort((a, b) => (b.daysLate ?? -9999) - (a.daysLate ?? -9999));
    }

    // open tickets
    const tickets = (await Promise.all(chunks.map((c) => fetchAll(() => supabase.from("tickets").select("id, wo_number, site_id, ticket_kind, status, priority, issue_category, issue_detail, received_at, due_at, sla_ends_at, manually_resolved_at").eq("status", "open").in("site_id", c))))).flat()
      .filter((t) => !t.manually_resolved_at)
      .map((t) => {
        const s = siteById.get(t.site_id);
        return {
          wo: t.wo_number, code: s?.site_code || null, site: s ? (s.name || "").replace(/^CA - /, "") : null,
          kind: t.ticket_kind, issue: [t.issue_category, t.issue_detail].filter(Boolean).join(" - ") || null,
          receivedAt: t.received_at, dueAt: t.sla_ends_at || t.due_at || null,
          primary: s ? techById.get(s.primary_tech_id)?.name || null : null,
        };
      }).sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));

    const visits = visitsAll.slice(0, 40).map((v) => {
      const s = siteById.get(v.site_id);
      return {
        at: v.started_at, code: s?.site_code || null, site: s ? (s.name || "").replace(/^CA - /, "") : null,
        tech: v.tech_name_raw, restock: !!(v.is_restock || v.included_restock), remediation: v.remediation, note: (v.closing_note || "").slice(0, 240),
      };
    });

    return json(200, {
      ok: true, today,
      team: techs.map((t) => ({ name: t.name, title: t.title, phone: t.phone, email: t.email, city: t.city, contractor: !!t.is_contractor, rosterOnly: !!t.roster_only })),
      sites: siteRows,
      restock: { listReceivedAt: list ? list.receivedAt : null, rows: restock },
      tickets, visits, visitCount: visitsAll.length,
    });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
