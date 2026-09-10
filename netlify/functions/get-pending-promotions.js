/**
 * get-pending-promotions.js — new 2026-09-10
 *
 * Companion to get-unmatched-tickets.js, but for the other end of the
 * site-survey/install placeholder feature (lib/placeholder-sites.js): once
 * a real-coded ticket address-matches a placeholder site, mailgun-inbound.js
 * flags it (promotion_candidate_code/promotion_candidate_wo_number) rather
 * than silently renaming it. This surfaces those flags per state so
 * index.html can trigger a "replace placeholder with real code?" toast,
 * the same auto-toast pattern already used for unmatched tickets.
 *
 * GET /.netlify/functions/get-pending-promotions?state=GA
 * -> { pending: [ { siteId, placeholderCode, placeholderName, address,
 *                    realCode, woNumber } ] }
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

    const { data, error } = await supabase
      .from("sites")
      .select("id, site_code, name, address, promotion_candidate_code, promotion_candidate_wo_number")
      .eq("state", state)
      .eq("is_placeholder", true)
      .not("promotion_candidate_code", "is", null);

    if (error) return json(500, { error: error.message });

    const pending = (data || []).map((s) => ({
      siteId: s.id,
      placeholderCode: s.site_code,
      placeholderName: s.name,
      address: s.address,
      realCode: s.promotion_candidate_code,
      woNumber: s.promotion_candidate_wo_number,
    }));

    return json(200, { pending });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
