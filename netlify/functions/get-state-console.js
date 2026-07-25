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
// Deliberately excludes anything related to restock-to-trouble ratios --
// Mark wants that admin-only, not shown to the dispatcher/state it's about.
//
// GET /.netlify/functions/get-state-console?state=GA
// -> { technicians: [{id,name,available,reason,note}], recentTickets: [...] }

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
  if (siteIds.length) {
    const sinceDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { data: tickets, error: ticketsErr } = await supabase
      .from('tickets')
      .select('site_id, issue_category, issue_detail, ticket_kind, wo_number, received_at')
      .in('site_id', siteIds)
      .in('ticket_kind', ['trouble', 'maintenance'])
      .gte('received_at', sinceDate)
      .order('received_at', { ascending: false })
      .limit(20);
    if (ticketsErr) return json(500, { ok: false, error: 'tickets fetch failed: ' + ticketsErr.message });
    recentTickets = (tickets || []).map(t => {
      const site = siteById[t.site_id];
      return {
        siteCode: site ? site.site_code : null,
        siteName: site ? site.name : '(unknown site)',
        issueCategory: t.issue_category,
        issueDetail: t.issue_detail,
        ticketKind: t.ticket_kind,
        woNumber: t.wo_number,
        receivedAt: t.received_at,
      };
    });
  }

  return json(200, { ok: true, state, technicians, recentTickets, generatedAt: new Date().toISOString() });
};
