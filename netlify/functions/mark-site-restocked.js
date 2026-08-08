/**
 * mark-site-restocked.js — v1 — added 2026-08-08
 *
 * Netlify Function — lets a dispatcher manually confirm a site was
 * actually restocked, even though get-restock-schedule.js's automated
 * calculation only has visibility into confirmed restock-type visits.
 * Built after a real case: GA1112 (Effingham County) showed "Overdue
 * (visited)" -- the "(visited)" already meant the algorithm noticed SOME
 * visit happened since the last confirmed restock (e.g. a trouble
 * ticket), just without confidence it included a restock. Mark's
 * experience is that a site with recent trouble-ticket activity has
 * often been restocked opportunistically during that same visit, and
 * wanted a way to say so directly rather than watch it sit "overdue"
 * indefinitely. Deliberately doesn't touch the actual overdue algorithm
 * or fabricate a fake site_visits row -- this is a separate, visible
 * manual signal the frontend displays alongside the computed status,
 * same pattern as mark-ticket-resolved.js for tickets.
 *
 * POST /.netlify/functions/mark-site-restocked
 * body: { site_code, note (optional) }
 * -> { ok: true } | { ok: false, error }
 *
 * Undo (removes the most recent confirmation for that site):
 * body: { site_code, undo: true }
 * -> { ok: true } | { ok: false, error }
 */
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method Not Allowed" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: "Supabase env vars not configured" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  const { site_code, note, undo } = body;
  if (!site_code) return json(400, { ok: false, error: "site_code is required" });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: site, error: siteErr } = await supabase
      .from("sites").select("id").eq("site_code", site_code).maybeSingle();
    if (siteErr) return json(500, { ok: false, error: siteErr.message });
    if (!site) return json(404, { ok: false, error: `No site found with code ${site_code}` });

    if (undo) {
      const { data: latest, error: latestErr } = await supabase
        .from("site_manual_restock_confirmations")
        .select("id").eq("site_id", site.id)
        .order("confirmed_at", { ascending: false }).limit(1).maybeSingle();
      if (latestErr) return json(500, { ok: false, error: latestErr.message });
      if (!latest) return json(200, { ok: true }); // nothing to undo
      const { error: delErr } = await supabase
        .from("site_manual_restock_confirmations").delete().eq("id", latest.id);
      if (delErr) return json(500, { ok: false, error: delErr.message });
      return json(200, { ok: true });
    }

    const { error: insErr } = await supabase
      .from("site_manual_restock_confirmations")
      .insert({ site_id: site.id, note: note || null, visit_date_covered: new Date().toISOString() });
    if (insErr) return json(500, { ok: false, error: insErr.message });

    return json(200, { ok: true });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
