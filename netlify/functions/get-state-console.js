// get-state-console.js
//
// Powers the new state.html console (2026-07-25) -- a dispatcher-facing,
// non-admin page pulling together what's useful to see at a glance for one
// state: who's out today, and what's come in recently. Restock Schedule
// data is NOT duplicated here -- state.html calls get-restock-schedule.js
// directly for that, since it already exists and is already state-scoped.
// Repeat Issues likewise stays a separate call. This function only covers
// the two pieces that didn't already have a state-scoped endpoint:
// today's technician availability, and a recent-tickets feed.
//
// v2 (2026-07-27): recentTickets now includes an open/closed status,
// inferred from whether a site_visit (from the closed-ticket Salesforce
// import) has already linked back to that ticket -- tickets.status itself
// is set to 'open' at creation and never updated anywhere in the app, so
// it isn't a usable signal on its own. "Closed" here means "confirmed
// closed by the imported report," not "still genuinely open" -- a ticket
// that's actually been resolved in the field will still show as open here
// until the closed-ticket report is re-imported. That's exactly why
// lastImportedAt (the real closed-ticket import freshness for this state,
// same source as restock tracker's freshness banner) is now returned
// alongside it -- state.html shows it so a dispatcher can judge whether an
// "open" ticket is trustworthy or just pending the next import.
//
// Deliberately excludes anything related to restock-to-trouble ratios --
// Mark wants that admin-only, not shown to the dispatcher/state it's about.
//
// GET /.netlify/functions/get-state-console?state=GA
// -> { technicians: [...], recentTickets: [{..., status, closedOn}], lastImportedAt }

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const state = String(params.state || '').trim().toUpperCase();
  if (!state) return json(400, { ok: false, error: 'state is required' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Technicians in this state + today's availability
  const { data: techs, error: techErr } = await supabase
    .from('technicians')
    .select('id, name')
    .eq('home_state', state)
    .order('name');
  if (techErr) return json(500, { ok: false, error: 'technicians fetch failed: ' + techErr.message });

  const techIds = (techs || []).map(t => t.id);
  let unavailableToday = {};
  if (techIds.length) {
    const { data: avail, error: availErr } = await supabase
      .from('technician_availability')
      .select('technician_id, reason, note')
      .in('technician_id', techIds)
      .eq('day', todayStr)
      .eq('available', false);
    if (availErr) return json(500, { ok: false, error: 'availability fetch failed: ' + availErr.message });
    for (const row of (avail || [])) unavailableToday[row.technician_id] = { reason: row.reason, note: row.note };
  }

  const technicians = (techs || []).map(t => ({
    id: t.id,
    name: t.name,
    available: !unavailableToday[t.id],
    reason: unavailableToday[t.id] ? unavailableToday[t.id].reason : null,
    note: unavailableToday[t.id] ? unavailableToday[t.id].note : null,
  }));

  // Recent tickets (trouble/maintenance) for sites in this state, last 3 days
  const { data: sites, error: sitesErr } = await supabase
    .from('sites')
    .select('id, site_code, name')
    .eq('state', state)
    .eq('active', true);
  if (sitesErr) return json(500, { ok: false, error: 'sites fetch failed: ' + sitesErr.message });
  const siteById = {};
  for (const s of (sites || [])) siteById[s.id] = s;
  const siteIds = Object.keys(siteById);

  let recentTickets = [];
  let lastImportedAt = null;
  if (siteIds.length) {
    const sinceDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { data: tickets, error: ticketsErr } = await supabase
      .from('tickets')
      .select('id, site_id, issue_category, issue_detail, ticket_kind, wo_number, received_at, due_at, sla_ends_at, deadline_source, manually_resolved_at, manually_resolved_note')
      .in('site_id', siteIds)
      .in('ticket_kind', ['trouble', 'maintenance'])
      .gte('received_at', sinceDate)
      .order('received_at', { ascending: false })
      .limit(20);
    if (ticketsErr) return json(500, { ok: false, error: 'tickets fetch failed: ' + ticketsErr.message });

    // Closed = a site_visit from the closed-ticket import has already
    // linked back to this ticket (import-service-appointments.js sets
    // site_visits.ticket_id by matching WO number). Take the earliest
    // matching visit if more than one somehow references the same ticket.
    const ticketIds = (tickets || []).map(t => t.id);
    let closedByTicketId = {};
    if (ticketIds.length) {
      const { data: closingVisits, error: closingErr } = await supabase
        .from('site_visits')
        .select('ticket_id, started_at')
        .in('ticket_id', ticketIds)
        .order('started_at', { ascending: true });
      if (closingErr) return json(500, { ok: false, error: 'closing-visit fetch failed: ' + closingErr.message });
      for (const v of (closingVisits || [])) {
        if (!closedByTicketId[v.ticket_id]) closedByTicketId[v.ticket_id] = v.started_at;
      }
    }

    // Overall closed-ticket import freshness for this state -- independent
    // of whether any specific ticket above has matched yet, so "still open"
    // can be judged against how current the import itself is.
    const { data: freshRows, error: freshErr } = await supabase
      .from('site_visits')
      .select('imported_at')
      .in('site_id', siteIds)
      .order('imported_at', { ascending: false })
      .limit(1);
    if (freshErr) return json(500, { ok: false, error: 'import-freshness fetch failed: ' + freshErr.message });
    lastImportedAt = (freshRows && freshRows[0]) ? freshRows[0].imported_at : null;

    recentTickets = (tickets || []).map(t => {
      const site = siteById[t.site_id];
      const closedOn = closedByTicketId[t.id] || null;
      // 2026-08-08: status now recognizes a local manual resolution too,
      // not just Salesforce's own closed-ticket confirmation -- a ticket
      // resolved through some other path (a cancelled SA with no closing
      // notes, a dispatcher confirming completion by phone) previously had
      // no way to ever stop showing as "open" here. Both signals stay
      // distinct: 'closed' means Salesforce confirmed it; 'resolved_local'
      // means a dispatcher marked it done without that confirmation.
      const status = closedOn ? 'closed' : (t.manually_resolved_at ? 'resolved_local' : 'open');
      const dueAt = t.ticket_kind === 'trouble'
        ? (t.sla_ends_at || t.due_at || t.received_at)
        : (t.due_at || t.received_at);
      return {
        siteCode: site ? site.site_code : null,
        siteName: site ? site.name : '(unknown site)',
        issueCategory: t.issue_category,
        issueDetail: t.issue_detail,
        ticketKind: t.ticket_kind,
        woNumber: t.wo_number,
        receivedAt: t.received_at,
        dueAt,
        status,
        closedOn,
        manuallyResolvedAt: t.manually_resolved_at,
        manuallyResolvedNote: t.manually_resolved_note,
      };
    });
  }

  return json(200, { ok: true, state, technicians, recentTickets, lastImportedAt, generatedAt: new Date().toISOString() });
};
