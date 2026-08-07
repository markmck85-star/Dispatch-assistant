/**
 * get-unmatched-tickets.js — v2 — updated 2026-08-07
 *
 * Netlify Function — surfaces open trouble/maintenance tickets that never
 * matched an existing site (site_id IS NULL), so the dispatch board can
 * automatically trigger the "Add Location" toast for them instead of
 * requiring the dispatcher to notice one is missing and manually paste its
 * code into the Location Codes box first. Built after a real backlog of
 * these was found sitting invisible (CO - Fremont County Canon City MV,
 * several MI SOS offices, OH - Salem BMV, etc.) with nowhere in the app
 * surfacing them.
 *
 * v2: Mark pointed out the toast only pre-filled the location NAME, even
 * though every real trouble/maintenance ticket also includes the site's
 * PC Name/code and street address -- he'd been manually re-opening the
 * same ticket email to find both and retype them. Checked and confirmed:
 * the code was already being captured into attributes.rawSiteCode this
 * whole time (site_id is null because that code doesn't match an EXISTING
 * site yet -- a genuinely new location -- not because no code was found),
 * it just was never exposed here. Address genuinely wasn't captured
 * anywhere before this -- added to mailgun-inbound.js's parser and a new
 * tickets.address column same day. Now exposes both, so the toast can be
 * close to fully pre-filled rather than just the name.
 *
 * Scoped to ticket_kind IN ('trouble','maintenance') only -- site_survey
 * tickets are deliberately excluded. Mark's plan for those is a separate,
 * not-yet-built "temporary category, promoted to a real site once the
 * install happens" concept -- auto-prompting to create a permanent site
 * record from a survey (which may never become a real install) would be
 * premature.
 *
 * GET /.netlify/functions/get-unmatched-tickets?state=CO
 * -> { unmatched: [ { ticketId, woNumber, siteText, suggestedName,
 *                      suggestedCode, suggestedAddress, issueCategory,
 *                      issueDetail, receivedAt } ] }
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
      .from("tickets")
      .select("id, wo_number, site_text, ticket_kind, issue_category, issue_detail, address, attributes, received_at")
      .is("site_id", null)
      .in("ticket_kind", ["trouble", "maintenance"])
      .eq("status", "open")
      .order("received_at", { ascending: false });

    if (error) return json(500, { error: error.message });

    const unmatched = (data || [])
      .filter((t) => t.site_text && t.site_text.slice(0, 2).toUpperCase() === state)
      .map((t) => {
        // site_text is either "CO - Fremont County Canon City MV" (state
        // name prefix) or "FL1123 – Hillsborough County US 301 Publix" (a
        // site code that didn't actually match anything) -- strip
        // whichever prefix style is present so the toast's name field
        // starts clean instead of repeating the state/code.
        const suggestedName = t.site_text
          .replace(/^[A-Z]{2}\d{3,5}\s*[-\u2013]\s*/, "")
          .replace(/^[A-Z]{2}\s*[-\u2013]\s*/, "")
          .trim();
        // rawSiteCode is Neumo's own PC Name/code for this ticket -- present
        // for nearly every real trouble/maintenance ticket. site_id is null
        // not because no code was found, but because that code doesn't
        // match any EXISTING site yet (a genuinely new location Neumo has
        // already assigned a number to, that MCR just hasn't onboarded).
        const suggestedCode = (t.attributes && t.attributes.rawSiteCode) || "";
        return {
          ticketId: t.id,
          woNumber: t.wo_number,
          siteText: t.site_text,
          suggestedName,
          suggestedCode,
          suggestedAddress: t.address || "",
          issueCategory: t.issue_category,
          issueDetail: t.issue_detail,
          receivedAt: t.received_at,
        };
      });

    return json(200, { unmatched });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
