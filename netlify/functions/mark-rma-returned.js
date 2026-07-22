/**
 * mark-rma-returned.js — v1 — added 2026-07-22
 *
 * Toggles whether a flagged "return the broken part" shipment has actually
 * been sent back. There's no signal for this in the source emails --
 * Neumo doesn't send a confirmation -- so this is a manual, dispatcher-driven
 * flag rather than anything auto-detected.
 *
 * POST /.netlify/functions/mark-rma-returned
 *   body: { id: "<shipment uuid>", returned: true|false }
 *
 * -> { ok: true, returnedAt: "<iso>"|null }
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
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: "Invalid JSON body" }); }
  if (!body.id) return json(400, { error: "id is required" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const returnedAt = body.returned ? new Date().toISOString() : null;

    const { error } = await supabase
      .from('rma_shipments')
      .update({ returned_at: returnedAt, updated_at: new Date().toISOString() })
      .eq('id', body.id);

    if (error) return json(500, { error: "Update failed: " + error.message });
    return json(200, { ok: true, returnedAt });
  } catch (err) {
    return json(500, { error: "Unexpected error: " + err.message });
  }
};
