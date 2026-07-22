/**
 * save-assignment.js — v1 — added 2026-07-19
 *
 * Netlify Function — Phase 2 Stage 2 (backend piece).
 * Persists a single dispatcher action on one stop (created by dispatch
 * generation, or later marked Done/Cancelled/Reassigned/pushed-to-Tomorrow)
 * to the Supabase `assignments` table.
 *
 * Not yet called from index.html -- this is the standalone backend piece.
 * Wiring processDispatch()/removeStop()/reassignStop()/pushToTomorrow() to
 * call this is the next step, done separately so each call site's exact
 * status/assignedBy mapping can be checked against the live app rather
 * than guessed here.
 *
 * Concurrency: a single Postgres upsert on the (dispatch_date, site_id)
 * unique constraint, not a JS read-modify-write. Only the columns actually
 * present in the request body are written -- Postgres's ON CONFLICT DO
 * UPDATE only SETs columns present in the upserted row, so e.g. calling
 * this with just {status: 'removed'} on an existing row leaves
 * technician_id/sequence_order/locked untouched rather than blanking them.
 * This sidesteps both bug shapes called out in the handoff doc (the
 * read-modify-write race, and accidentally clobbering fields a caller
 * didn't intend to touch).
 *
 * On a genuinely new row (first write for a given site+day), technician_id
 * and assigned_by are NOT NULL in the schema, so those two are required
 * inputs on every call, not optional -- a partial-only call against a row
 * that doesn't exist yet will fail with a clear error rather than silently
 * inserting a broken row.
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

const VALID_STATUS = new Set(["planned", "notified", "completed", "removed"]);
const VALID_ASSIGNED_BY = new Set(["auto", "manual", "fallback_rule", "contractor_rule"]);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid JSON body" }); }

  const dispatchDate = String(payload.dispatchDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dispatchDate)) {
    return json(400, { error: "dispatchDate is required, format YYYY-MM-DD" });
  }

  const siteCode = String(payload.siteCode || "").trim().toUpperCase();
  if (!siteCode) return json(400, { error: "siteCode is required" });

  const techName = String(payload.techName || "").trim();
  if (!techName) return json(400, { error: "techName is required" });

  const status = String(payload.status || "").trim();
  if (!VALID_STATUS.has(status)) {
    return json(400, { error: `status must be one of: ${[...VALID_STATUS].join(", ")}` });
  }

  const assignedBy = String(payload.assignedBy || "").trim();
  if (!VALID_ASSIGNED_BY.has(assignedBy)) {
    return json(400, { error: `assignedBy must be one of: ${[...VALID_ASSIGNED_BY].join(", ")}` });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: siteRow, error: siteErr } = await supabase
      .from("sites")
      .select("id")
      .eq("site_code", siteCode)
      .maybeSingle();
    if (siteErr) return json(500, { error: "Site lookup failed: " + siteErr.message });
    if (!siteRow) return json(400, { error: `No site found for code ${siteCode}` });

    const { data: techRow, error: techErr } = await supabase
      .from("technicians")
      .select("id")
      .eq("name", techName)
      .maybeSingle();
    if (techErr) return json(500, { error: "Technician lookup failed: " + techErr.message });
    if (!techRow) return json(400, { error: `No technician found named "${techName}"` });

    // Ticket linkage is best-effort: if a wo_number is given but no matching
    // ticket exists (e.g. this stop came from a bulk restock list, which
    // Phase 2 Stage 1 doesn't insert into `tickets`), leave ticket_id null
    // rather than failing the whole request.
    let ticketId = null;
    const woNumber = String(payload.ticketWoNumber || "").trim();
    if (woNumber) {
      const { data: ticketRow, error: ticketErr } = await supabase
        .from("tickets")
        .select("id")
        .eq("wo_number", woNumber)
        .maybeSingle();
      if (ticketErr) console.error("[save-assignment] ticket lookup failed (non-fatal):", ticketErr.message);
      else if (ticketRow) ticketId = ticketRow.id;
    }

    const row = {
      dispatch_date: dispatchDate,
      site_id: siteRow.id,
      technician_id: techRow.id,
      assigned_by: assignedBy,
      status,
      updated_at: new Date().toISOString(),
    };
    if (ticketId) row.ticket_id = ticketId;
    if (payload.sequenceOrder !== undefined && payload.sequenceOrder !== null) {
      row.sequence_order = parseInt(payload.sequenceOrder, 10);
    }
    if (payload.locked !== undefined) row.locked = Boolean(payload.locked);

    const { data, error } = await supabase
      .from("assignments")
      .upsert(row, { onConflict: "dispatch_date,site_id" })
      .select()
      .single();

    if (error) return json(500, { error: "Assignment upsert failed: " + error.message });

    return json(200, { ok: true, assignment: data });
  } catch (err) {
    return json(500, { error: "Unexpected error: " + err.message });
  }
};
