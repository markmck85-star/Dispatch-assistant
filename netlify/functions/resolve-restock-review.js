/**
 * POST /.netlify/functions/resolve-restock-review
 * body: { id, decision: "confirmed" | "rejected" }
 * Resolves an ambiguous closing-note restock review on site_visits.
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

  const id = body.id;
  const raw = String(body.decision || "").toLowerCase();
  const confirmed = raw === "confirmed" || raw === "confirm" || raw === "yes";
  const rejected = raw === "rejected" || raw === "reject" || raw === "no" || raw === "not_restock";
  if (!id) return json(400, { ok: false, error: "id is required" });
  if (!confirmed && !rejected) return json(400, { ok: false, error: "decision must be confirmed or rejected" });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    // is_restock is a generated column — only included_restock is writable.
    const patch = {
      restock_review_pending: false,
      restock_review_decision: confirmed ? "confirmed" : "rejected",
      restock_review_resolved_at: new Date().toISOString(),
      included_restock: confirmed,
      included_restock_source: "manual",
    };
    const { data, error } = await supabase
      .from("site_visits")
      .update(patch)
      .eq("id", id)
      .select("id, appointment_number")
      .maybeSingle();
    if (error) return json(500, { ok: false, error: error.message });
    if (!data) return json(404, { ok: false, error: "Visit not found" });
    return json(200, { ok: true, id: data.id, appointmentNumber: data.appointment_number, decision: patch.restock_review_decision });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
