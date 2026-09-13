/**
 * mark-assignment-resolved.js — v1 — added 2026-09-13
 *
 * Netlify Function — same idea as mark-ticket-resolved.js, but for
 * bulk-list restock stops (assignments with no ticket_id, so there's no
 * wo_number to key off of). Sets the assignment's own status to
 * 'completed' -- the same field/value the board's own "Done" button
 * writes -- so this is indistinguishable from a dispatcher having clicked
 * Done on the board itself, not a separate parallel "resolved" flag like
 * tickets get. That's deliberate: unlike a ticket (which needs to keep
 * Salesforce-confirmed and locally-confirmed as two distinct signals),
 * a bulk-list stop's only status concept IS assignments.status already.
 *
 * POST /.netlify/functions/mark-assignment-resolved
 * body: { assignmentId }
 * -> { ok: true } | { ok: false, error }
 *
 * Also supports un-marking (for correcting a mistaken click) by restoring
 * 'planned' rather than deleting anything:
 * body: { assignmentId, undo: true }
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

  const { assignmentId, undo } = body;
  if (!assignmentId) {
    return json(400, { ok: false, error: "assignmentId is required" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data, error } = await supabase
      .from("assignments")
      .update({ status: undo ? "planned" : "completed" })
      // Only ever touches a genuine bulk-list stop (ticket_id IS NULL) --
      // an assignment that DOES have a ticket should be resolved via
      // mark-ticket-resolved.js instead, so this guard prevents this
      // endpoint from accidentally being pointed at the wrong kind of row.
      .is("ticket_id", null)
      .eq("id", assignmentId)
      .select("id")
      .maybeSingle();

    if (error) return json(500, { ok: false, error: error.message });
    if (!data) return json(404, { ok: false, error: `No bulk-list assignment found with id ${assignmentId}` });

    return json(200, { ok: true });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
