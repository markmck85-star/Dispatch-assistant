/**
 * get-rma-shipments.js — v1 — added 2026-07-22
 * v2 — 2026-08-27: expose the source email(s) so shipments.html can offer
 * a clickable link to read the original dispatch/ticket email (where the
 * part was actually requested) -- the real motivation, per Mark: a part
 * often arrives well after the fact, and whoever unpacks it has no easy
 * way to recall which site/job it belongs to without digging through
 * email manually. Two different emails can exist here and either can be
 * missing independently, so both are returned and the frontend picks:
 *   - dispatchInboundEmailId: the ORIGINAL ticket's email (via
 *     rma_shipments.ticket_id -> tickets.inbound_email_id) -- this is the
 *     one that actually describes the service call/part need, so it's
 *     preferred when present.
 *   - shipmentInboundEmailId: rma_shipments' own inbound_email_id --
 *     Neumo's shipping-notification email itself, used as a fallback when
 *     no ticket link exists (e.g. a proactive stock-up shipment with no
 *     specific ticket behind it).
 * Not resolved via Supabase's embedded-relation syntax (tickets(...))
 * since that depends on a declared FK Supabase can introspect -- a plain
 * second query + JS-side map sidesteps that assumption entirely, same
 * pattern as perform-import.js's ticketByWo lookup.
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
 *        requestDetails, returnBrokenPart, returnedAt, receivedAt,
 *        dispatchInboundEmailId, shipmentInboundEmailId } ],
 *      technicians: [ { id, name, state } ] }  -- full active roster,
 *        independent of which techs already have a shipment row; `state`
 *        is the tech's home state, so a consumer can narrow the roster to
 *        whatever state is currently selected. Use this (not the
 *        shipments themselves) to populate a technician filter/picker.
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
      .select('id, case_number, parent_case_number, wo_number, ticket_id, site_id, account_name, state, warehouse_name, technician_id, outbound_tracking, inbound_tracking, transfer_id, request_details, return_broken_part, returned_at, received_at, inbound_email_id, technicians(name), sites(site_code)')
      .order('received_at', { ascending: false })
      .limit(limit);

    if (params.state) query = query.eq('state', params.state);
    if (params.technicianId) query = query.eq('technician_id', params.technicianId);
    if (params.siteId) query = query.eq('site_id', params.siteId);
    if (params.needsReturn === 'true') query = query.eq('return_broken_part', true).is('returned_at', null);

    const { data, error } = await query;
    if (error) return json(500, { error: "Query failed: " + error.message });

    // 2026-08-27: resolve each shipment's linked ticket's inbound_email_id
    // separately (see file header) -- a plain second query rather than an
    // embedded-relation select, so this doesn't depend on Supabase having
    // a declared FK it can introspect for rma_shipments.ticket_id.
    const ticketIds = [...new Set((data || []).map(r => r.ticket_id).filter(Boolean))];
    let ticketEmailById = {};
    if (ticketIds.length) {
      const { data: ticketRows, error: ticketErr } = await supabase
        .from('tickets')
        .select('id, inbound_email_id')
        .in('id', ticketIds);
      if (ticketErr) console.error('[get-rma-shipments] ticket email lookup failed (non-fatal):', ticketErr.message);
      for (const t of ticketRows || []) ticketEmailById[t.id] = t.inbound_email_id;
    }

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
      dispatchInboundEmailId: row.ticket_id ? (ticketEmailById[row.ticket_id] || null) : null,
      shipmentInboundEmailId: row.inbound_email_id || null,
    }));

    // Full active-technician roster, independent of which techs happen to
    // already have a shipment row. Without this, the tech filter dropdown
    // on shipments.html could only ever show techs who'd already been
    // assigned at least one RMA -- so anyone who'd never had one (Nyzier,
    // and potentially others) was invisible in the dropdown even though
    // they're a real active tech. Confirmed 2026-08-15.
    const { data: techRows, error: techErr } = await supabase
      .from('technicians')
      .select('id, name, home_state')
      .eq('active', true)
      .order('name');
    if (techErr) console.error('[get-rma-shipments] technician roster fetch failed (non-fatal):', techErr.message);
    const technicians = (techRows || []).map(t => ({ id: t.id, name: t.name, state: t.home_state }));

    return json(200, { shipments, technicians });
  } catch (err) {
    return json(500, { error: "Unexpected error: " + err.message });
  }
};
