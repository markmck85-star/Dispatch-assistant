/**
 * import-dispatch-list-history.js -- 2026-10-18 (admin only, see gate.js)
 *
 * Takes old Neumo dispatch lists that were already read in the browser
 * (dispatch-list-backfill.html) and files their rows in dispatch_list_history.
 * Nothing here touches the board, tickets, assignments or texts: it only feeds the
 * "Calls at" columns on the Restock Forecast (site_restock_thresholds).
 *
 * POST { lists: [ { listDay:'YYYY-MM-DD', sentAt:ISO|null, subject,
 *                   rows: [ [code, lf, lr, rf, rr, journal, consumables, 'YYYY-MM-DD'] ] } ],
 *        refresh: true|false }   // refresh = rebuild the thresholds afterwards (send on the last batch)
 */
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) };
}
const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = (v) => (Number.isInteger(v) && Math.abs(v) < 100000 ? v : null);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Supabase env vars not configured" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Bad JSON" }); }
  const lists = Array.isArray(body.lists) ? body.lists : [];
  if (lists.length > 60) return json(400, { error: "Send at most 60 lists per request" });

  const byKey = new Map();
  let skipped = 0;
  for (const l of lists) {
    if (!l || !isDay(l.listDay) || !Array.isArray(l.rows)) { skipped++; continue; }
    const sentAt = l.sentAt && !isNaN(Date.parse(l.sentAt)) ? new Date(l.sentAt).toISOString() : null;
    for (const r of l.rows.slice(0, 2000)) {
      if (!Array.isArray(r)) continue;
      const code = String(r[0] || "").toUpperCase();
      if (!/^[A-Z]{2}\d{3,5}$/.test(code) || !isDay(r[7])) { skipped++; continue; }
      const row = {
        list_day: l.listDay, sent_at: sentAt, subject: String(l.subject || "").slice(0, 200), code,
        lf: num(r[1]), lr: num(r[2]), rf: num(r[3]), rr: num(r[4]), journal: num(r[5]),
        consumables: String(r[6] || "").slice(0, 200), restock_by: r[7],
      };
      byKey.set(code + "|" + r[7] + "|" + l.listDay, row); // same row twice in one list: keep one
    }
  }
  const rows = [...byKey.values()];
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from("dispatch_list_history").upsert(rows.slice(i, i + 500), { onConflict: "code,restock_by,list_day" });
      if (error) return json(500, { error: "Save failed: " + error.message });
    }
    let thresholdSites = null;
    if (body.refresh) {
      const { data, error } = await supabase.rpc("refresh_site_restock_thresholds");
      if (!error) thresholdSites = data;
    }
    return json(200, { ok: true, lists: lists.length, rowsSaved: rows.length, skipped, thresholdSites });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
