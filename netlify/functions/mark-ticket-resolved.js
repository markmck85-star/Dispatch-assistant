/**
 * mark-ticket-resolved.js — v1 — added 2026-08-08
 *
 * Netlify Function — marks a ticket as resolved locally, independent of
 * whether Salesforce's own closed-ticket report has confirmed it. Built
 * after a real gap: the state console's "Open (per last import)" label is
 * deliberately tied ONLY to Salesforce's own closed-ticket data, which
 * means a ticket that's genuinely resolved through some other path --
 * Neumo cancelling a now-redundant SA with no closing notes, a dispatcher
 * confirming completion by phone, etc. -- has no way to ever stop showing
 * as "open." This gives dispatchers a way to say "I know this is actually
 * done" without pretending Salesforce confirmed it -- both signals stay
 * visible and distinct on the state console rather than one overwriting
 * the other.
 *
 * POST /.netlify/functions/mark-ticket-resolved
 * body: { wo_number, note (optional), resolvedBy (optional) }
 * -> { ok: true } | { ok: false, error }
 *
 * Also supports un-marking (for correcting a mistaken click):
 * body: { wo_number, undo: true }
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

  const { wo_number, note, resolvedBy, undo } = body;
  if (!wo_number) {
    return json(400, { ok: false, error: "wo_number is required" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const updateFields = undo
      ? { manually_resolved_at: null, manually_resolved_note: null }
      : {
          manually_resolved_at: new Date().toISOString(),
          manually_resolved_note: [resolvedBy, note].filter(Boolean).join(": ") || null,
        };

    const { data, error } = await supabase
      .from("tickets")
      .update(updateFields)
      .eq("wo_number", wo_number)
      .select("id")
      .maybeSingle();

    if (error) return json(500, { ok: false, error: error.message });
    if (!data) return json(404, { ok: false, error: `No ticket found with WO number ${wo_number}` });

    return json(200, { ok: true });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
