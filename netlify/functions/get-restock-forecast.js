/**
 * get-restock-forecast.js — v1, 2026-10-17
 *
 * Estimated forms-roll counts per site for a chosen date, from each site's
 * own usage rate (site_usage_rates) and its last restock that mentioned forms
 * (Postgres function estimate_site_counts). Also flags sites that already
 * have a stop on the board that day.
 *
 * GET /.netlify/functions/get-restock-forecast?date=YYYY-MM-DD
 * -> { date, rows: [ { siteCode, name, state, formsPerDay, lastRestock,
 *                      daysSince, estCount, planned } ] }
 */
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });
  const date = String((event.queryStringParameters || {}).date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: "date query param required, YYYY-MM-DD" });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const est = await supabase.rpc("estimate_site_counts", { on_date: date });
    if (est.error) return json(500, { error: "Forecast failed: " + est.error.message });

    const sites = await supabase.from("sites").select("site_code, name");
    const names = {};
    (sites.data || []).forEach((s) => { names[s.site_code] = s.name; });

    const asg = await supabase
      .from("assignments")
      .select("status, sites(site_code), tickets(ticket_kind)")
      .eq("dispatch_date", date);
    const planned = {};
    (asg.data || []).forEach((a) => {
      if (a.status === "cancelled" || a.status === "removed") return;
      const code = a.sites && a.sites.site_code;
      if (code) planned[code] = (a.tickets && a.tickets.ticket_kind) || "stop";
    });

    const rows = (est.data || []).map((r) => ({
      siteCode: r.site_code,
      name: names[r.site_code] || "",
      state: r.state,
      formsPerDay: Number(r.forms_per_day),
      lastRestock: r.last_forms_restock,
      daysSince: r.days_since,
      estCount: r.est_count,
      planned: planned[r.site_code] || null,
    }));
    rows.sort((a, b) => a.estCount - b.estCount);
    return json(200, { date, rows });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
