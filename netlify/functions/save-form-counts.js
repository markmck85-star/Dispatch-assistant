/**
 * save-form-counts.js -- added 2026-09-17
 *
 * Netlify Function -- narrow companion to save-assignment.js.
 *
 * Why this exists: save-assignment.js's caller in index.html
 * (_processDispatchCore) has two deliberate skip guards -- one to avoid
 * clobbering assigned_by provenance when the tech assignment is unchanged,
 * one to avoid silently creating phantom assignments on a page-load
 * auto-run. Both are correct and stay in place. But together they mean the
 * normal sync call almost never actually fires for a routine daily
 * restock (same tech every day, often loaded via the silent auto-load
 * path) -- so restock_form_counts, added earlier tonight, was staying
 * null for nearly every real assignment even though the counts fix
 * itself was deployed correctly.
 *
 * This endpoint does exactly one narrow thing, safe to call
 * unconditionally whenever a fresh parse produces form counts for a code
 * that already has an assignment row: UPDATE restock_form_counts on the
 * existing row. It never inserts a row, never touches technician_id,
 * assigned_by, or status -- so it cannot reproduce either bug the two
 * guards above were built to prevent. If no matching row exists yet,
 * it's a no-op (nothing to attach counts to; a genuinely new assignment
 * still goes through save-assignment.js's own guarded path as before).
 *
 * POST /.netlify/functions/save-form-counts
 * body: { dispatchDate: 'YYYY-MM-DD', siteCode: 'GA1040', formCounts: {...} }
 * -> { ok: true, updated: true|false }
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

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid JSON body" }); }

  const dispatchDate = String(payload.dispatchDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dispatchDate)) {
    return json(400, { error: "dispatchDate is required, format YYYY-MM-DD" });
  }

  const siteCode = String(payload.siteCode || "").trim().toUpperCase();
  if (!siteCode) return json(400, { error: "siteCode is required" });

  if (!payload.formCounts || typeof payload.formCounts !== "object") {
    return json(400, { error: "formCounts (object) is required" });
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

    // Plain UPDATE, not upsert -- deliberately does nothing if no
    // assignment row exists yet for this date/site, and touches no
    // column but restock_form_counts/updated_at on the row it does find.
    const { data, error } = await supabase
      .from("assignments")
      .update({ restock_form_counts: payload.formCounts, updated_at: new Date().toISOString() })
      .eq("dispatch_date", dispatchDate)
      .eq("site_id", siteRow.id)
      .select("id");

    if (error) return json(500, { error: "Counts update failed: " + error.message });

    return json(200, { ok: true, updated: (data || []).length > 0 });
  } catch (err) {
    return json(500, { error: "Unexpected error: " + err.message });
  }
};
