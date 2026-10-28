/**
 * get-pending-activations.js -- new 2026-10-11
 *
 * Lists sites flagged by mailgun-inbound.js because a ticket arrived for a
 * site that is marked inactive (sites.activation_candidate_wo_number set).
 * index.html shows a "mark active?" toast for each.
 *
 * GET /.netlify/functions/get-pending-activations?state=GA
 * -> { pending: [ { siteId, siteCode, name, address, woNumber } ] }
 * GA covers GA + NC + SC, matching the board's territory grouping.
 */
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });

  const state = String((event.queryStringParameters || {}).state || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    return json(400, { error: "state query param (2-letter code) is required" });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const states = state === "GA" ? ["GA", "NC", "SC", "AL"] : [state];
    const { data, error } = await supabase
      .from("sites")
      .select("id, site_code, name, address, activation_candidate_wo_number")
      .in("state", states)
      .eq("active", false)
      .eq("is_placeholder", false)
      .not("activation_candidate_wo_number", "is", null);
    if (error) return json(500, { error: error.message });

    return json(200, {
      pending: (data || []).map((s) => ({
        siteId: s.id,
        siteCode: s.site_code,
        name: s.name,
        address: s.address,
        woNumber: s.activation_candidate_wo_number,
      })),
    });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
