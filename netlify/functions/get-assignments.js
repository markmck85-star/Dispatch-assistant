/**
 * get-assignments.js — v1 — added 2026-07-19
 *
 * Netlify Function — Phase 2 Stage 2b (the "read" half of persistence).
 * Returns every assignment row already in Supabase for a given dispatch
 * date, joined to site_code and technician name so the frontend doesn't
 * need to do its own id lookups.
 *
 * GET /.netlify/functions/get-assignments?dispatchDate=YYYY-MM-DD
 * -> { assignments: [ { siteCode, techName, status, assignedBy, sequenceOrder, locked,
 *                        ticket: { woNumber, issueCategory, issueDetail, slaEndsAt,
 *                                  computedSlaDeadline } | null } ] }
 */
const { createClient } = require("@supabase/supabase-js");
const { computeSlaDeadline } = require("./slaCalculator.js");

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

  const dispatchDate = String((event.queryStringParameters || {}).dispatchDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dispatchDate)) {
    return json(400, { error: "dispatchDate query param is required, format YYYY-MM-DD" });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data, error } = await supabase
      .from("assignments")
      .select("status, assigned_by, sequence_order, locked, sites(site_code, state), technicians(name), tickets(wo_number, issue_category, issue_detail, ticket_kind, sla_ends_at, received_at, address)")
      .eq("dispatch_date", dispatchDate);

    if (error) return json(500, { error: "Query failed: " + error.message });

    const assignments = (data || [])
      .filter(row => row.sites && row.technicians) // defensive: skip any row with a dangling reference
      .map(row => {
        const t = row.tickets;
        // computedSlaDeadline (2026-09-07): the same fix already applied to
        // get-watchdog-log.js and get-state-console.js, extended here --
        // this endpoint was the one live board display still hadn't gotten
        // it, which is why "SAME DAY / Due: Mon 12:00 PM" kept showing on a
        // ticket already correctly pushed to Tuesday's board. Only trouble
        // tickets get a computed value; maintenance/restock and site_survey
        // keep using their own dueAt/slaEndsAt, matching every other place
        // this distinction is made today.
        let computedSlaDeadline = null;
        if (t && t.ticket_kind === "trouble" && t.received_at) {
          try {
            computedSlaDeadline = computeSlaDeadline(t.received_at, t.address, row.sites.state);
          } catch (e) {
            computedSlaDeadline = null;
          }
        }
        return {
          siteCode: row.sites.site_code,
          techName: row.technicians.name,
          status: row.status,
          assignedBy: row.assigned_by,
          sequenceOrder: row.sequence_order,
          locked: row.locked,
          ticket: t ? {
            woNumber: t.wo_number,
            issueCategory: t.issue_category,
            issueDetail: t.issue_detail,
            slaEndsAt: t.sla_ends_at,
            computedSlaDeadline,
          } : null,
        };
      });

    return json(200, { assignments });
  } catch (err) {
    return json(500, { error: "Unexpected error: " + err.message });
  }
};
