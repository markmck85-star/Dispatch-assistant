/**
 * get-watchdog-log.js — new 2026-08-12
 *
 * Netlify Function — surfaces EVERY open ticket that never matched an
 * existing site (site_id IS NULL), for a given state. This is a superset
 * of get-unmatched-tickets.js: that one only returns ticket_kind IN
 * ('trouble','maintenance') because it feeds the "Add Location" toast,
 * which deliberately excludes site_survey and anything else that doesn't
 * fit the normal onboarding flow.
 *
 * This function has no such restriction -- it returns everything,
 * regardless of ticket_kind. The reason: these tickets are the exact set
 * the SMS watchdog already alerts on at receipt time (see sendSms() in
 * mailgun-inbound.js), but once that text is sent there is currently
 * nowhere in the app to see them again -- not the dispatch board (needs
 * a site match), not the state console (site_id-null tickets aren't
 * queried there at all). This function just re-surfaces what's already
 * sitting in `tickets`, no new storage needed.
 *
 * GET /.netlify/functions/get-watchdog-log?state=CO
 * -> { entries: [ { ticketId, woNumber, siteText, ticketKind,
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

    const { data, error } = await supabase
      .from("tickets")
      .select("id, wo_number, site_text, ticket_kind, issue_category, issue_detail, description, address, due_at, sla_ends_at, received_at, status")
      .is("site_id", null)
      .eq("status", "open")
      .order("received_at", { ascending: false });

    if (error) return json(500, { error: error.message });

    const entries = (data || [])
      .filter((t) => t.site_text && t.site_text.slice(0, 2).toUpperCase() === state)
      .map((t) => ({
        ticketId: t.id,
        woNumber: t.wo_number,
        siteText: t.site_text,
        ticketKind: t.ticket_kind,
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
