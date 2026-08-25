// get-site-history.js
//
// Powers the clickable-location-history feature on the dispatch board:
// clicking a location name shows its recent visits (restocks + trouble
// calls) pulled from site_visits, populated by the Closed Tickets import
// (2026-07-22). Read-only.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const code = params.code;
  const offset = parseInt(params.offset || '0', 10);
  const PAGE_SIZE = 15;
  if (!code) return json(400, { ok: false, error: 'Missing ?code=' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, state, site_code')
    .eq('site_code', code)
    .maybeSingle();
  if (siteErr) return json(500, { ok: false, error: siteErr.message });
  if (!site) return json(404, { ok: false, error: 'No site found for code ' + code });

  const { data: visits, error: visitsErr, count: totalVisits } = await supabase
    .from('site_visits')
    .select('started_at, ended_at, duration_min, tech_name_raw, remediation, remediation_detail, is_restock, wo_number, appointment_number, needs_review, ticket_id', { count: 'exact' })
    .eq('site_id', site.id)
    .order('started_at', { ascending: false, nullsFirst: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (visitsErr) return json(500, { ok: false, error: visitsErr.message });

  // 2026-08-25: click-through from an SA number to its actual source email.
  // Only ever possible for the ~5% of visits that trace back to a real
  // individually-emailed ticket (trouble/maintenance/individual-restock) --
  // tickets.inbound_email_id has 100% coverage on those (confirmed
  // 2026-08-24), but the other ~95% (routine bulk-restock-list volume)
  // never had their own ticket row OR their own email to begin with, so
  // there's genuinely nothing to link for most rows. inboundEmailId comes
  // back null for those -- the frontend just doesn't render a click target.
  const visitTicketIds = [...new Set((visits || []).map((v) => v.ticket_id).filter(Boolean))];
  let inboundEmailIdByTicketId = {};
  if (visitTicketIds.length) {
    const { data: ticketRows, error: ticketErr } = await supabase
      .from('tickets')
      .select('id, inbound_email_id')
      .in('id', visitTicketIds);
    if (ticketErr) return json(500, { ok: false, error: ticketErr.message });
    (ticketRows || []).forEach((t) => { if (t.inbound_email_id) inboundEmailIdByTicketId[t.id] = t.inbound_email_id; });
  }
  const visitsWithEmail = (visits || []).map((v) => ({
    ...v,
    inbound_email_id: v.ticket_id ? (inboundEmailIdByTicketId[v.ticket_id] || null) : null,
  }));

  // Related shipments: rma_shipments.site_id is only populated on a small
  // fraction of real rows (the inbound RMA email parser was never wired
  // up to resolve it the way the closed-ticket import now does for
  // site_visits) -- so cross-reference by WO number against the visits
  // just fetched instead, plus a direct site_id match as a belt-and-
  // suspenders check for the rows that do have it.
  const woNumbers = [...new Set((visits || []).map((v) => v.wo_number).filter(Boolean))];
  let shipments = [];
  if (woNumbers.length) {
    const { data: byWo, error: shipErr } = await supabase
      .from('rma_shipments')
      .select('wo_number, warehouse_name, outbound_tracking, inbound_tracking, return_broken_part, returned_at, received_at')
      .in('wo_number', woNumbers)
      .order('received_at', { ascending: false, nullsFirst: false });
    if (shipErr) return json(500, { ok: false, error: shipErr.message });
    shipments = byWo || [];
  }

  return json(200, {
    ok: true,
    site: { name: site.name, state: site.state, code: site.site_code },
    visits: visitsWithEmail,
    shipments,
    offset,
    pageSize: PAGE_SIZE,
    totalVisits: totalVisits != null ? totalVisits : visitsWithEmail.length,
    hasMore: offset + visitsWithEmail.length < (totalVisits != null ? totalVisits : 0),
  });
};
