/**
 * get-rma-shipments.js — v1 — added 2026-07-22
 *
 * Read-only listing of rma_shipments, joined to technician name and site
 * code for display. Supports filtering by state, technician, site, and a
 * "needs return" view (return_broken_part=true and not yet marked returned)
 * for the case that actually has a real cost if it slips.
 *
 * GET /.netlify/functions/get-rma-shipments
 *   ?state=NV
 *   ?technicianId=<uuid>
 *   ?siteId=<uuid>
 *   ?needsReturn=true   -- only rows where return_broken_part is true and
 *                          returned_at is still null
 *   ?limit=200          -- optional, defaults to 200, capped at 500
 *
 * -> { shipments: [ { id, caseNumber, parentCaseNumber, woNumber, ticketId,
 *        siteId, siteCode, accountName, state, warehouseName, technicianId,
 *        technicianName, outboundTracking, inboundTracking, transferId,
 *        requestDetails, returnBrokenPart, returnedAt, receivedAt } ] }
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

  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit, 10) || 200, 500);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    let query = supabase
      .from('rma_shipments')
      .select('id, case_number, parent_case_number, wo_number, ticket_id, site_id, account_name, state, warehouse_name, technician_id, outbound_tracking, inbound_tracking, transfer_id, request_details, return_broken_part, returned_at, received_at, technicians(name), sites(site_code)')
      .order('received_at', { ascending: false })
      .limit(limit);

    if (params.state) query = query.eq('state', params.state);
    if (params.technicianId) query = query.eq('technician_id', params.technicianId);
    if (params.siteId) query = query.eq('site_id', params.siteId);
    if (params.needsReturn === 'true') query = query.eq('return_broken_part', true).is('returned_at', null);

    const { data, error } = await query;
    if (error) return json(500, { error: "Query failed: " + error.message });

    const shipments = (data || []).map(row => ({
      id: row.id,
      caseNumber: row.case_number,
      parentCaseNumber: row.parent_case_number,
      woNumber: row.wo_number,
      ticketId: row.ticket_id,
      siteId: row.site_id,
      siteCode: row.sites ? row.sites.site_code : null,
      accountName: row.account_name,
      state: row.state,
      warehouseName: row.warehouse_name,
      technicianId: row.technician_id,
      technicianName: row.technicians ? row.technicians.name : null,
      outboundTracking: row.outbound_tracking,
      inboundTracking: row.inbound_tracking,
      transferId: row.transfer_id,
      requestDetails: row.request_details,
      returnBrokenPart: row.return_broken_part,
      returnedAt: row.returned_at,
      receivedAt: row.received_at,
    }));

    return json(200, { shipments });
  } catch (err) {
    return json(500, { error: "Unexpected error: " + err.message });
  }
};
