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

// 2026-08-08: ported directly from index.html -- this GA on-call/comp-day
// schedule lives ONLY as hardcoded client-side JS there, not in any
// database table, which is why the state console could never show comp
// days correctly no matter how the date/timezone handling was fixed.
// Known tradeoff: this is now duplicated in two places rather than one
// shared source -- if Mark extends the schedule in index.html, this copy
// needs the same update or the two pages will disagree again. Worth
// eventually moving into a real table both pages read from instead.
const ONCALL_SCHEDULE_GA = {
  '2026-05-02': ['Omari Williams',  'Robert Medley'],
  '2026-05-09': ['Nyzier Moore',    'Sean Reich'],
  '2026-05-16': ['Omari Williams',  'Robert Medley'],
  '2026-05-23': ['Nyzier Moore',    'Sean Reich'],
  '2026-05-30': ['Omari Williams',  'Robert Medley'],
  '2026-06-06': ['Nyzier Moore',    'Sean Reich'],
  '2026-06-13': ['Omari Williams',  'Robert Medley'],
  '2026-06-20': ['Nyzier Moore',    'Sean Reich'],
  '2026-06-27': ['Omari Williams',  'Robert Medley'],
  '2026-07-04': ['Nyzier Moore',    'Sean Reich'],
  '2026-07-11': ['Omari Williams',  'Robert Medley'],
  '2026-07-18': ['Nyzier Moore',    'Sean Reich'],
  '2026-07-25': ['Omari Williams',  'Robert Medley'],
  '2026-08-01': ['Nyzier Moore',    'Sean Reich'],
  '2026-08-08': ['Omari Williams',  'Robert Medley'],
  '2026-08-15': ['Nyzier Moore',    'Sean Reich'],
  '2026-08-22': ['Omari Williams',  'Robert Medley'],
  '2026-08-29': ['Nyzier Moore',    'Sean Reich'],
  '2026-09-05': ['Omari Williams',  'Robert Medley'],
  '2026-09-12': ['Nyzier Moore',    'Sean Reich'],
  '2026-09-19': ['Omari Williams',  'Robert Medley'],
  '2026-09-26': ['Nyzier Moore',    'Sean Reich'],
  '2026-10-03': ['Omari Williams',  'Robert Medley'],
  '2026-10-10': ['Nyzier Moore',    'Sean Reich'],
  '2026-10-17': ['Omari Williams',  'Robert Medley'],
  '2026-10-24': ['Nyzier Moore',    'Sean Reich'],
  '2026-10-31': ['Omari Williams',  'Robert Medley'],
  '2026-11-07': ['Nyzier Moore',    'Sean Reich'],
  '2026-11-14': ['Omari Williams',  'Robert Medley'],
  '2026-11-21': ['Nyzier Moore',    'Sean Reich'],
  '2026-11-28': ['Omari Williams',  'Robert Medley'],
  '2026-12-05': ['Nyzier Moore',    'Sean Reich'],
  '2026-12-12': ['Omari Williams',  'Robert Medley'],
  '2026-12-19': ['Nyzier Moore',    'Sean Reich'],
  '2026-12-26': ['Omari Williams',  'Robert Medley'],
  '2027-01-02': ['Nyzier Moore',    'Sean Reich'],
};
const THURSDAY_COMP_TECHS = ['Robert Medley']; // takes Thu comp day before his on-call Sat; all other on-call techs take Mon.

function getCompDaysForDate(dateStr) {
  const results = [];
  Object.entries(ONCALL_SCHEDULE_GA).forEach(([satStr, techs]) => {
    const satDate = new Date(satStr + 'T12:00:00Z');
    techs.forEach(tech => {
      const offset = THURSDAY_COMP_TECHS.includes(tech) ? -2 : -5; // Thu=Sat-2, Mon=Sat-5
      const compDate = new Date(satDate);
      compDate.setUTCDate(satDate.getUTCDate() + offset);
      const compStr = compDate.toISOString().split('T')[0];
      if (compStr === dateStr) {
        const dayName = THURSDAY_COMP_TECHS.includes(tech) ? 'Thursday' : 'Monday';
        results.push({ tech, saturdayDateStr: satStr, dayName, reason: `Comp day — on call Sat ${satStr}` });
      }
    });
  });
  return results;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // 2026-08-21: this endpoint's response was never covered by the
      // earlier _headers no-cache fix (that only applies to HTML pages,
      // not /.netlify/functions/* calls) -- meaning a genuinely stale
      // cached response could sit around even after a real backend
      // change (like adding the `county` field) had already deployed.
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const state = String(params.state || '').trim().toUpperCase();
  if (!state) return json(400, { ok: false, error: 'state is required' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // 2026-08-08: was `new Date()` + local getFullYear/getMonth/getDate,
  // which builds the date string using the SERVER's own timezone --
  // Netlify runs in UTC, not Eastern, so for several hours a day this
  // would silently compute "today" as tomorrow relative to any US state.
  // Also had no way to check a different day at all, which Mark ran into
  // directly trying to verify whether "everyone available" was real or a
  // date bug. Now explicitly anchors to Eastern time as a reasonable
  // single reference across all US states (this is calendar-day-level
  // info, not an exact-time calculation, so the few hours of difference
  // between Eastern and Pacific near midnight is an acceptable edge case
  // here), and accepts an optional ?date=YYYY-MM-DD override.
  const requestedDate = (event.queryStringParameters || {}).date;
  const todayStr = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate || '')
    ? requestedDate
    : new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // en-CA locale formats as YYYY-MM-DD

  // Technicians in this state + availability for the requested/today's date
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

  // GA-only comp-day schedule (see ONCALL_SCHEDULE_GA above) -- only
  // applied where a BlueFolder-synced reason isn't already present, same
  // priority index.html itself uses.
  if (state === 'GA') {
    const compDays = getCompDaysForDate(todayStr);
    const nameToId = {};
    (techs || []).forEach(t => { nameToId[t.name] = t.id; });
    compDays.forEach(c => {
      const id = nameToId[c.tech];
      if (id && !unavailableToday[id]) unavailableToday[id] = { reason: 'comp_day', note: c.reason };
    });

    // Saturday-only-on-call rule (2026-08-23) -- this file only ever had
    // the COMP DAY half of the on-call schedule (the weekday before a
    // Saturday), never the Saturday itself. On an actual on-call Saturday,
    // getCompDaysForDate() correctly returns nothing (a comp day always
    // lands on a weekday, never the Saturday it's compensating for), so
    // this state console was showing every technician as available with
    // no code path that could ever mark the non-on-call ones out --
    // meanwhile index.html has always correctly handled this via its own
    // separate isSaturday/onCallTechs check. Mirrored here exactly: parse
    // todayStr as a real Date rather than assume the caller only ever asks
    // about a Saturday, since ?date= can request any day.
    const requestedDow = new Date(todayStr + 'T12:00:00Z').getUTCDay();
    if (requestedDow === 6 && ONCALL_SCHEDULE_GA[todayStr]) {
      const onCallSet = new Set(ONCALL_SCHEDULE_GA[todayStr]);
      (techs || []).forEach(t => {
        if (!onCallSet.has(t.name) && !unavailableToday[t.id]) {
          unavailableToday[t.id] = { reason: 'not_on_call', note: `Not on call Sat ${todayStr}` };
        }
      });
    }
  }

  const onCallToday = (state === 'GA' && new Date(todayStr + 'T12:00:00Z').getUTCDay() === 6 && ONCALL_SCHEDULE_GA[todayStr])
    ? new Set(ONCALL_SCHEDULE_GA[todayStr])
    : new Set();

  const technicians = (techs || []).map(t => ({
    id: t.id,
    name: t.name,
    available: !unavailableToday[t.id],
    reason: unavailableToday[t.id] ? unavailableToday[t.id].reason : null,
    note: unavailableToday[t.id] ? unavailableToday[t.id].note : null,
    onCall: onCallToday.has(t.name),
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

  // Open (not-yet-returned) RMA shipments per site (2026-08-23) -- flags a
  // ticket card when its site has a pending shipment sitting around, so a
  // dispatcher handling a NEW call at a site doesn't miss that a
  // technician still needs to bring back a bad part (or that a part is
  // already en route) from a PREVIOUS visit. Deliberately keyed by site,
  // not by matching this exact ticket's own id -- the value here is
  // "does this site have unfinished shipment business," which matters
  // regardless of which specific ticket originally generated the
  // shipment. Known limitation, same one already documented on the RMA
  // page itself: this only ever works when the shipping email's WO number
  // successfully linked to site_id in the first place -- a shipment tied
  // to a ticket that didn't exist yet when the email arrived stays
  // invisible here, same as everywhere else this data is used.
  let openShipmentsBySite = {};
  if (siteIds.length) {
    const { data: shipments, error: shipErr } = await supabase
      .from('rma_shipments')
      .select('site_id, return_broken_part, warehouse_name')
      .in('site_id', siteIds)
      .is('returned_at', null);
    if (shipErr) return json(500, { ok: false, error: 'rma_shipments fetch failed: ' + shipErr.message });
    (shipments || []).forEach(s => {
      if (!s.site_id) return;
      if (!openShipmentsBySite[s.site_id]) openShipmentsBySite[s.site_id] = { count: 0, needsReturn: false };
      openShipmentsBySite[s.site_id].count++;
      if (s.return_broken_part) openShipmentsBySite[s.site_id].needsReturn = true;
    });
  }

  let recentTickets = [];
  let lastImportedAt = null;
  if (siteIds.length) {
    // Raised from 20 to 150 (2026-08-21) -- confirmed via a real case that
    // 20 was actively hiding genuine tickets on an ordinary busy Friday:
    // GA1005 (Cobb County Canton, WO 00150203) showed correctly as "Open"
    // earlier the same evening, then vanished entirely -- not flipped to
    // closed, just gone -- once enough newer restock tickets had arrived
    // to push it past the top-20-by-received_at cutoff. It was never a
    // data/ingestion problem (confirmed via the original dispatch email
    // and its neighboring WO numbers importing fine); the query itself was
    // silently discarding real, current information. 150 gives a state
    // like GA (which saw 28+ restock tickets alone in one 3-day window
    // during testing) comfortable headroom without querying an unbounded
    // amount.
    const sinceDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { data: tickets, error: ticketsErr } = await supabase
      .from('tickets')
      .select('id, site_id, issue_category, issue_detail, ticket_kind, wo_number, received_at, due_at, sla_ends_at, deadline_source, manually_resolved_at, manually_resolved_note')
      .in('site_id', siteIds)
      .in('ticket_kind', ['trouble', 'maintenance'])
      .gte('received_at', sinceDate)
      .order('received_at', { ascending: false })
      .limit(150);
    if (ticketsErr) return json(500, { ok: false, error: 'tickets fetch failed: ' + ticketsErr.message });

    // Closed = a site_visit from the closed-ticket import has already
    // linked back to this ticket (import-service-appointments.js sets
    // site_visits.ticket_id by matching WO number). Take the earliest
    // matching visit if more than one somehow references the same ticket.
    //
    // Fixed 2026-08-21: the DISPLAYED date used to read started_at
    // (Salesforce's "Actual Start" -- when the tech arrived) and label it
    // "Closed on", which could show a completion time earlier than the
    // ticket's own received time -- a real bug, not just a display quirk
    // (arrival can't logically follow closure). ended_at ("Actual End",
    // already captured by perform-import.js but never used here) is the
    // field that actually means "closed" -- used now, with started_at kept
    // only as a fallback for the rare row where ended_at itself is missing.
    // Deliberately does NOT change what counts as "closed" at all -- that
    // still just means "a linked visit exists," true even if this specific
    // visit is missing one of its two timestamps; the actual work has
    // clearly already happened either way.
    const ticketIds = (tickets || []).map(t => t.id);
    let closedByTicketId = {};
    if (ticketIds.length) {
      const { data: closingVisits, error: closingErr } = await supabase
        .from('site_visits')
        .select('ticket_id, started_at, ended_at')
        .in('ticket_id', ticketIds)
        .order('started_at', { ascending: true });
      if (closingErr) return json(500, { ok: false, error: 'closing-visit fetch failed: ' + closingErr.message });
      for (const v of (closingVisits || [])) {
        if (!(v.ticket_id in closedByTicketId)) closedByTicketId[v.ticket_id] = v.ended_at || v.started_at;
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

    // Best-effort county extraction from the site name for grouping on the
    // frontend (2026-08-21) -- there's no dedicated county column on
    // `sites`, just the free-text name MCR already uses everywhere else
    // ("Cobb County Canton DMV", "Hall County Kroger Jesse Jewell"). Sites
    // that don't literally contain the word "County" (e.g. "Gwinnett
    // Kroger Lawrenceville") fall back to null and get grouped separately
    // on the frontend rather than guessed at -- a wrong guess here would
    // be worse than an honest "couldn't tell."
    function extractCounty(name) {
      if (!name) return null;
      const m = name.match(/^([A-Za-z.]+(?:\s[A-Za-z.]+)?\sCounty)\b/i);
      return m ? m[1] : null;
    }

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
        county: extractCounty(site ? site.name : null),
        issueCategory: t.issue_category,
        issueDetail: t.issue_detail,
        ticketKind: t.ticket_kind,
        woNumber: t.wo_number,
        receivedAt: t.received_at,
        dueAt,
        status,
        closedOn,
        openShipment: openShipmentsBySite[t.site_id] || null,
        manuallyResolvedAt: t.manually_resolved_at,
        manuallyResolvedNote: t.manually_resolved_note,
        source: 'ticket_email',
      };
    });

    // 2026-08-25: bulk-list restocks (the routine daily Location-Codes
    // paste volume) never get a `tickets` row at all -- Phase 2 Stage 1
    // only inserts into `tickets` for individually-emailed trouble/
    // maintenance tickets, so until now this console only ever showed a
    // small slice of the real daily restock volume (whatever happened to
    // also arrive as its own WO email), while the dispatch board itself
    // shows the full bulk list. Mark wants the state console to become the
    // semi-live "what's actually going on" view and the dispatch board to
    // stay focused on dispatching -- so pull the bulk stops directly from
    // `assignments` here and merge them in with the same shape as a
    // ticket, deriving status from the board's own planned/completed/
    // removed rather than a Salesforce closed-ticket-report match (there
    // is none for these -- no WO number exists for a bulk-list stop).
    // ticket_id IS NULL excludes anything already represented above via
    // the tickets query (a bulk stop that also matched an individually-
    // emailed ticket already appears once, with the more authoritative
    // Salesforce-confirmed status).
    const sinceDateOnly = sinceDate.slice(0, 10);
    const { data: bulkAssignments, error: bulkErr } = await supabase
      .from('assignments')
      .select('id, site_id, technician_id, dispatch_date, status, updated_at')
      .in('site_id', siteIds)
      .is('ticket_id', null)
      .gte('dispatch_date', sinceDateOnly)
      .order('dispatch_date', { ascending: false })
      .limit(150);
    if (bulkErr) return json(500, { ok: false, error: 'bulk assignments fetch failed: ' + bulkErr.message });

    const bulkTechIds = [...new Set((bulkAssignments || []).map(a => a.technician_id).filter(Boolean))];
    let bulkTechNameById = {};
    if (bulkTechIds.length) {
      const { data: bulkTechs, error: bulkTechErr } = await supabase
        .from('technicians')
        .select('id, name')
        .in('id', bulkTechIds);
      if (bulkTechErr) return json(500, { ok: false, error: 'bulk assignment technicians fetch failed: ' + bulkTechErr.message });
      (bulkTechs || []).forEach(t => { bulkTechNameById[t.id] = t.name; });
    }

    const bulkStatusMap = { planned: 'open', completed: 'closed', removed: 'cancelled' };
    const bulkEntries = (bulkAssignments || []).map(a => {
      const site = siteById[a.site_id];
      const status = bulkStatusMap[a.status] || 'open';
      return {
        siteCode: site ? site.site_code : null,
        siteName: site ? site.name : '(unknown site)',
        county: extractCounty(site ? site.name : null),
        issueCategory: 'Restock',
        issueDetail: null,
        ticketKind: 'maintenance', // reuses the existing 📦 RESTOCK tag/sort/grouping
        woNumber: null,
        receivedAt: a.updated_at,
        dueAt: a.dispatch_date,
        status,
        closedOn: status === 'closed' ? a.updated_at : null,
        openShipment: openShipmentsBySite[a.site_id] || null,
        manuallyResolvedAt: null,
        manuallyResolvedNote: null,
        source: 'bulk_dispatch_list',
        technicianName: a.technician_id ? (bulkTechNameById[a.technician_id] || null) : null,
      };
    });

    recentTickets = recentTickets.concat(bulkEntries);
  }

  return json(200, { ok: true, state, date: todayStr, technicians, recentTickets, lastImportedAt, generatedAt: new Date().toISOString() });
};
