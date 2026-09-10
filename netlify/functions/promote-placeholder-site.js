/**
 * promote-placeholder-site.js — new 2026-09-10
 *
 * Confirms (or dismisses) a pending placeholder promotion surfaced by
 * get-pending-promotions.js. Confirming renames the placeholder's
 * site_code to the real Neumo code and clears is_placeholder -- since
 * everything else (assignments, tickets, site_visits) references the site
 * by its UUID, not its code, history stays attached automatically, same
 * as every other site_code correction made during the collision-cleanup
 * campaign (see dispatch-platform.md).
 *
 * POST /.netlify/functions/promote-placeholder-site
 * body: { siteId, action: "confirm" | "reject", newName? }
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
  if (!siteId) return json(400, { error: "siteId is required" });

  const action = String(payload.action || "").trim();
  if (!["confirm", "reject"].includes(action)) {
    return json(400, { error: 'action must be "confirm" or "reject"' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: placeholder, error: fetchErr } = await supabase
      .from("sites")
      .select("id, site_code, is_placeholder, promotion_candidate_code, promotion_candidate_wo_number")
      .eq("id", siteId)
      .maybeSingle();
    if (fetchErr) return json(500, { error: "Site lookup failed: " + fetchErr.message });
    if (!placeholder) return json(400, { error: "No site found for that id" });
    if (!placeholder.is_placeholder) return json(400, { error: "That site is not a placeholder" });
    if (!placeholder.promotion_candidate_code) {
      return json(400, { error: "That placeholder has no pending promotion" });
    }

    if (action === "reject") {
      const { error: clearErr } = await supabase
        .from("sites")
        .update({ promotion_candidate_code: null, promotion_candidate_wo_number: null })
        .eq("id", siteId);
      if (clearErr) return json(500, { error: "Failed to dismiss: " + clearErr.message });
      return json(200, { ok: true, dismissed: true });
    }

    // action === 'confirm'
    const realCode = placeholder.promotion_candidate_code;

    // Safety check mirroring the duplicate-address confirm() in index.html's
    // "new location from ticket" toast -- the real code should never
    // already belong to a DIFFERENT site row (site_code has a unique
    // constraint; this just gives a clear error instead of a raw DB
    // constraint-violation message if it somehow does).
    const { data: collision, error: collisionErr } = await supabase
      .from("sites")
      .select("id, name")
      .eq("site_code", realCode)
      .neq("id", siteId)
      .maybeSingle();
    if (collisionErr) return json(500, { error: "Collision check failed: " + collisionErr.message });
    if (collision) {
      return json(400, {
        error: `${realCode} already belongs to a different site ("${collision.name}") -- this needs a manual look, not a straight rename.`,
      });
    }

    const updateFields = {
      site_code: realCode,
      is_placeholder: false,
      promotion_candidate_code: null,
      promotion_candidate_wo_number: null,
    };
    if (payload.newName && String(payload.newName).trim()) {
      updateFields.name = String(payload.newName).trim();
    }

    const { data: updated, error: updateErr } = await supabase
      .from("sites")
      .update(updateFields)
      .eq("id", siteId)
      .select("id, site_code, name, address, state")
      .single();
    if (updateErr) return json(500, { error: "Promotion update failed: " + updateErr.message });

    console.log(`[promote-placeholder-site] ${placeholder.site_code} -> ${realCode} (WO ${placeholder.promotion_candidate_wo_number})`);
    return json(200, { ok: true, site: updated });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
