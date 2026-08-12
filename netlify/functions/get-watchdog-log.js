/**
 * get-watchdog-log.js — v2, corrected 2026-08-12
 *
 * Netlify Function — surfaces every open ticket the SMS watchdog already
 * alerts dispatchers about, for a given state, so the same tickets are
 * visible in-app even to a dispatcher who hasn't enabled text alerts.
 *
 * v1 (same day) scoped this to site_id IS NULL, reasoning from the
 * dispatch-board gap (site_survey/Testing-Station tickets with no site
 * match are invisible there). That was too narrow: the SMS watchdog in
 * mailgun-inbound.js sends a text for EVERY dispatchType==='trouble'
 * ticket -- which covers ticket_kind 'trouble', 'install', and
 * 'site_survey' -- regardless of whether the ticket ever matched a real
 * site. A properly-matched, SLA-bound trouble ticket (e.g. WO 00149456,
 * FL1045) already shows up fine on the board/state console, but Mark's
 * actual ask was to mirror the SMS content itself -- these "burn bright"
 * tickets (real service-window/SLA urgency, or the odd install/survey
 * categories that don't fit normal restock/trouble flow) -- not just the
 * subset that also happens to be unmatched. Maintenance/restock tickets
 * never trigger an SMS at all and are correctly excluded here too.
 *
 * GET /.netlify/functions/get-watchdog-log?state=CO
 * -> { entries: [ { ticketId, woNumber, siteText, ticketKind, matched,
 *                    issueCategory, issueDetail, description, address,
 *                    dueAt, slaEndsAt, receivedAt } ] }
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

    // ticket_kind IN ('trouble','install','site_survey') mirrors exactly
    // which tickets mailgun-inbound.js sends an SMS for (dispatchType ===
    // 'trouble', which is the parse-template that produces all three
    // kinds). site_id is intentionally NOT filtered on -- matched and
    // unmatched tickets both belong here.
    const { data, error } = await supabase
      .from("tickets")
      .select("id, wo_number, site_text, site_id, ticket_kind, issue_category, issue_detail, description, address, due_at, sla_ends_at, received_at, status")
      .in("ticket_kind", ["trouble", "install", "site_survey"])
      .eq("status", "open")
      .order("received_at", { ascending: false });

    if (error) return json(500, { error: error.message });

    // site_text always starts with the site code (which starts with the
    // state abbreviation) when a code was found, or the raw "XX - ..."
    // account/location text when it wasn't -- same convention relied on
    // by get-unmatched-tickets.js, and true regardless of match status.
    const entries = (data || [])
      .filter((t) => t.site_text && t.site_text.slice(0, 2).toUpperCase() === state)
      .map((t) => ({
        ticketId: t.id,
        woNumber: t.wo_number,
        siteText: t.site_text,
        ticketKind: t.ticket_kind,
        matched: !!t.site_id,
        issueCategory: t.issue_category,
        issueDetail: t.issue_detail,
        description: t.description,
        address: t.address,
        dueAt: t.due_at,
        slaEndsAt: t.sla_ends_at,
        receivedAt: t.received_at,
      }));

    return json(200, { entries });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
