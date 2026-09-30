/**
 * mark-consumable-delivered.js  (v1, 2026-09-30)
 * SAVE AS: netlify/functions/mark-consumable-delivered.js
 *
 * Confirms (or un-confirms) that a consumable shipment actually arrived.
 * There is no delivery signal in the source emails and no UPS feed yet, so
 * this is a manual flag, the same idea as mark-rma-returned.js. Once a UPS
 * lookup exists it can set the same fields automatically.
 *
 * POST /.netlify/functions/mark-consumable-delivered
 *   body: { id: "<shipment uuid>", delivered: true|false, note?: "text" }
 *
 * delivered:true  -> status 'delivered', delivered_at = now
 * delivered:false -> back to 'shipped' (or 'requested' if no tracking yet)
 *
 * -> { ok: true, status, deliveredAt }
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON body" }); }
  if (!body.id || !UUID_RE.test(String(body.id))) return json(400, { error: "A valid shipment id is required" });
  if (typeof body.delivered !== "boolean") return json(400, { error: "delivered must be true or false" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: row, error: getErr } = await supabase
      .from("consumable_shipments").select("id, tracking, status").eq("id", body.id).maybeSingle();
    if (getErr) return json(500, { error: "Lookup failed: " + getErr.message });
    if (!row) return json(404, { error: "Shipment not found" });

    const now = new Date().toISOString();
    let patch;
    if (body.delivered) {
      patch = {
        status: "delivered",
        delivered_at: now,
        delivered_note: body.note ? String(body.note).slice(0, 500) : null,
        updated_at: now,
      };
    } else {
      const hasTracking = Array.isArray(row.tracking) && row.tracking.length > 0;
      patch = {
        status: hasTracking ? "shipped" : "requested",
        delivered_at: null,
        delivered_note: null,
        updated_at: now,
      };
    }

    const { error } = await supabase.from("consumable_shipments").update(patch).eq("id", body.id);
    if (error) return json(500, { error: "Update failed: " + error.message });
    return json(200, { ok: true, status: patch.status, deliveredAt: patch.delivered_at });
  } catch (err) {
    return json(500, { error: "Unexpected error: " + err.message });
  }
};
