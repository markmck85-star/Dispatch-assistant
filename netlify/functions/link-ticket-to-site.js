/**
 * link-ticket-to-site.js — v1 — added 2026-08-06
 *
 * Netlify Function — updates a single ticket's site_id, used right after
 * the auto-triggered "Add Location" toast (for a previously-unmatched
 * ticket) successfully creates a new site record. Deliberately minimal --
 * just the one UPDATE -- rather than duplicating any of the board-
 * assignment-creation logic that already exists elsewhere: once the
 * ticket has a real site_id, the existing auto-surface logic in
 * index.html's _processDispatchCore (built 2026-08-05) picks it up and
 * creates the board assignment on the very next dispatch generation, the
 * same way it already does for any other ticket-linked stop.
 *
 * POST /.netlify/functions/link-ticket-to-site
 * body: { ticketId, siteCode }
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

  const { ticketId, siteCode } = body;
  if (!ticketId || !siteCode) {
    return json(400, { ok: false, error: "ticketId and siteCode are both required" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: site, error: siteErr } = await supabase
      .from("sites")
      .select("id")
      .eq("site_code", siteCode)
      .maybeSingle();
    if (siteErr) return json(500, { ok: false, error: siteErr.message });
    if (!site) return json(404, { ok: false, error: `No site found with code ${siteCode}` });

    const { error } = await supabase.from("tickets").update({ site_id: site.id }).eq("id", ticketId);
    if (error) return json(500, { ok: false, error: error.message });
    return json(200, { ok: true });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
