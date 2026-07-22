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
 *                        ticket: { woNumber, issueCategory, issueDetail, slaEndsAt } | null } ] }
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
      .select("status, assigned_by, sequence_order, locked, sites(site_code), technicians(name), tickets(wo_number, issue_category, issue_detail, sla_ends_at)")
      .eq("dispatch_date", dispatchDate);

    if (error) return json(500, { error: "Query failed: " + error.message });

    const assignments = (data || [])
      .filter(row => row.sites && row.technicians) // defensive: skip any row with a dangling reference
      .map(row => ({
        siteCode: row.sites.site_code,
        techName: row.technicians.name,
        status: row.status,
        assignedBy: row.assigned_by,
        sequenceOrder: row.sequence_order,
        locked: row.locked,
        ticket: row.tickets ? {
          woNumber: row.tickets.wo_number,
          issueCategory: row.tickets.issue_category,
          issueDetail: row.tickets.issue_detail,
          slaEndsAt: row.tickets.sla_ends_at,
        } : null,
      }));

    return json(200, { assignments });
  } catch (err) {
    return json(500, { error: "Unexpected error: " + err.message });
  }
};
