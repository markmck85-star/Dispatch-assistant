/**
 * confirm-site-activation.js -- new 2026-10-11
 *
 * Confirms (marks the site active) or dismisses (leaves it inactive) a
 * pending activation flag from get-pending-activations.js.
 *
 * POST body: { siteId, action: "confirm" | "dismiss" }
 * -> { ok: true, site } | { ok: true, dismissed: true }
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

  const siteId = String(payload.siteId || "").trim();
  const action = String(payload.action || "").trim();
  if (!siteId) return json(400, { error: "siteId is required" });
  if (!["confirm", "dismiss"].includes(action)) {
    return json(400, { error: 'action must be "confirm" or "dismiss"' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const fields = { activation_candidate_wo_number: null };
    if (action === "confirm") fields.active = true;

    const { data, error } = await supabase
      .from("sites")
      .update(fields)
      .eq("id", siteId)
      .select("id, site_code, name, state, active")
      .maybeSingle();
    if (error) return json(500, { error: error.message });
    if (!data) return json(400, { error: "No site found for that id" });

    console.log(`[confirm-site-activation] ${data.site_code} ${action === "confirm" ? "marked active" : "left inactive (dismissed)"}`);
    return action === "confirm" ? json(200, { ok: true, site: data }) : json(200, { ok: true, dismissed: true });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
