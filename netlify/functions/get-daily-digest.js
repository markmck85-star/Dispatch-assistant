// get-daily-digest.js — v1 — added 2026-09-16
//
// Netlify Function -- shared backend for the morning brief and the
// "State of the State" end-of-day digest (see the embedded-AI-panel
// notes: morning covers what's new/due today, evening covers what
// happened today plus a light preview of tomorrow). Deliberately
// returns raw structured data with NO narration/formatting yet --
// Mark wants to see the real output first and decide what to keep,
// cut, or hand to the AI narration layer before that gets built.
//
// Reuses the same query patterns already proven in get-watchdog-log.js
// (open trouble/install/site_survey tickets) and get-state-console.js
// (per-state timezone handling, sites lookup, RMA shipments) rather
// than inventing new conventions. Does NOT duplicate get-state-console's
// full on-call/comp-day technician logic -- this pulls plain
// technician_availability only for v1; on-call/comp-day nuance can be
// folded in later if Mark wants it in the brief specifically.
//
// GET /.netlify/functions/get-daily-digest?state=GA&mode=morning[&date=YYYY-MM-DD]
// mode: 'morning' (default) or 'evening'
//
// -> {
//   ok, state, mode, date, timezone, generatedAt,
//   technicians: [{ id, name, available, reason, note }],
//   openTickets: [{ ticketId, woNumber, siteText, ticketKind, matched,
//                    issueCategory, issueDetail, dueAt, slaEndsAt,
//                    earliestStartAt, receivedAt }],
//   needsReview: [{ ticketId, woNumber, siteText, issueCategory,
//                    issueDetail, receivedAt }],
//   restocks: { completed: [...], stillOpen: [...], removed: [...] },
//   openShipments: [{ siteCode, siteName, needsReturn, warehouseName }],
//   preview: [...]   // evening only -- tomorrow's installs/site_surveys
//                     // plus restocks already queued for tomorrow
// }

const { createClient } = require('@supabase/supabase-js');
const { computeSlaDeadline } = require('./slaCalculator.js');

const STATE_TIMEZONES = {
  GA: 'America/New_York', NC: 'America/New_York', SC: 'America/New_York',
  FL: 'America/New_York', IN: 'America/New_York', OH: 'America/New_York',
  WV: 'America/New_York', MI: 'America/Detroit', IL: 'America/Chicago',
  MN: 'America/Chicago', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles',
  CO: 'America/Denver', ID: 'America/Boise', CA: 'America/Los_Angeles',
  AL: 'America/Chicago',
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify(obj),
  };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const params = event.queryStringParameters || {};
  const state = String(params.state || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    return json(400, { error: 'state query param (2-letter code) is required' });
  }
  const mode = (params.mode === 'evening') ? 'evening' : 'morning';

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase env vars not configured' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const timezone = STATE_TIMEZONES[state] || 'America/New_York';
    const requestedDate = params.date;
    const todayStr = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate || '')
      ? requestedDate
      : new Date().toLocaleDateString('en-CA', { timeZone: timezone });
    const tomorrowStr = addDays(todayStr, 1);

    // Sites in this state, for code/name lookups and RMA scoping.
    const { data: sites, error: sitesErr } = await supabase
      .from('sites')
      .select('id, site_code, name')
      .eq('state', state)
      .eq('active', true);
    if (sitesErr) return json(500, { error: 'sites fetch failed: ' + sitesErr.message });
    const siteById = {};
    (sites || []).forEach(s => { siteById[s.id] = s; });
    const siteIds = Object.keys(siteById);

    // Technicians + today's availability (plain technician_availability
    // only for v1 -- see file header re: on-call/comp-day nuance).
    const { data: techs, error: techErr } = await supabase
      .from('technicians')
      .select('id, name')
      .or(`home_state.eq.${state},additional_states.cs.{${state}}`)
      .eq('active', true)
      .order('name');
    if (techErr) return json(500, { error: 'technicians fetch failed: ' + techErr.message });
    const techIds = (techs || []).map(t => t.id);
    let unavailableToday = {};
    if (techIds.length) {
      const { data: avail, error: availErr } = await supabase
        .from('technician_availability')
        .select('technician_id, reason, note')
        .in('technician_id', techIds)
        .eq('day', todayStr)
        .eq('available', false);
      if (availErr) return json(500, { error: 'availability fetch failed: ' + availErr.message });
      (avail || []).forEach(row => { unavailableToday[row.technician_id] = { reason: row.reason, note: row.note }; });
    }
    const technicians = (techs || []).map(t => ({
      id: t.id,
      name: t.name,
      available: !unavailableToday[t.id],
      reason: unavailableToday[t.id] ? unavailableToday[t.id].reason : null,
      note: unavailableToday[t.id] ? unavailableToday[t.id].note : null,
    }));

    // Open trouble/install/site_survey tickets -- same shape as
    // get-watchdog-log.js, minus its 4-day staleness grace (this is a
    // right-now snapshot, not a rolling alert feed).
    const { data: openTicketRows, error: openErr } = await supabase
      .from('tickets')
      .select('id, wo_number, site_text, site_id, ticket_kind, needs_review, issue_category, issue_detail, address, due_at, sla_ends_at, earliest_start_at, received_at, status')
      .or('ticket_kind.in.(trouble,install,site_survey),needs_review.eq.true')
      .eq('status', 'open')
      .order('received_at', { ascending: false });
    if (openErr) return json(500, { error: 'open tickets fetch failed: ' + openErr.message });

    const stateTickets = (openTicketRows || []).filter(
      t => t.site_text && t.site_text.slice(0, 2).toUpperCase() === state
    );

    const openTickets = stateTickets
      .filter(t => t.ticket_kind === 'trouble' || t.ticket_kind === 'install' || t.ticket_kind === 'site_survey')
      .map(t => {
        let computedSlaDeadline = null;
        if (t.ticket_kind === 'trouble' && t.received_at) {
          try { computedSlaDeadline = computeSlaDeadline(t.received_at, t.address, state); }
          catch (e) { computedSlaDeadline = null; }
        }
        return {
          ticketId: t.id,
          woNumber: t.wo_number,
          siteText: t.site_text,
          ticketKind: t.ticket_kind,
          matched: !!t.site_id,
          issueCategory: t.issue_category,
          issueDetail: t.issue_detail,
          dueAt: t.due_at,
          slaEndsAt: t.sla_ends_at,
          earliestStartAt: t.earliest_start_at,
          computedSlaDeadline,
          receivedAt: t.received_at,
        };
      });

    const needsReview = stateTickets
      .filter(t => t.needs_review)
      .map(t => ({
        ticketId: t.id,
        woNumber: t.wo_number,
        siteText: t.site_text,
        issueCategory: t.issue_category,
        issueDetail: t.issue_detail,
        receivedAt: t.received_at,
      }));

    // Today's restock/dispatch assignments, grouped by status. Queried
    // directly against `assignments` (not reused from get-state-console's
    // 3-day recentTickets feed) so "completed vs still open vs removed"
    // reflects exactly today's dispatch_date, not a rolling window.
    async function fetchAssignmentsFor(dateStr) {
      if (!siteIds.length) return [];
      const { data, error } = await supabase
        .from('assignments')
        .select('id, site_id, technician_id, status, dispatch_date')
        .in('site_id', siteIds)
        .eq('dispatch_date', dateStr);
      if (error) throw new Error('assignments fetch failed (' + dateStr + '): ' + error.message);
      return data || [];
    }

    const todaysAssignments = await fetchAssignmentsFor(todayStr);
    const assignmentTechIds = [...new Set(todaysAssignments.map(a => a.technician_id).filter(Boolean))];
    let techNameById = {};
    if (assignmentTechIds.length) {
      const { data: aTechs, error: aTechErr } = await supabase
        .from('technicians')
        .select('id, name')
        .in('id', assignmentTechIds);
      if (aTechErr) return json(500, { error: 'assignment technicians fetch failed: ' + aTechErr.message });
      (aTechs || []).forEach(t => { techNameById[t.id] = t.name; });
    }

    function describeAssignment(a) {
      const site = siteById[a.site_id];
      return {
        siteCode: site ? site.site_code : null,
        siteName: site ? site.name : '(unknown site)',
        technicianName: a.technician_id ? (techNameById[a.technician_id] || null) : null,
      };
    }

    const restocks = {
      completed: todaysAssignments.filter(a => a.status === 'completed').map(describeAssignment),
      stillOpen: todaysAssignments.filter(a => a.status === 'planned').map(describeAssignment),
      removed: todaysAssignments.filter(a => a.status === 'removed').map(describeAssignment),
    };

    // Open (not-yet-returned) RMA shipments for this state.
    let openShipments = [];
    if (siteIds.length) {
      const { data: shipments, error: shipErr } = await supabase
        .from('rma_shipments')
        .select('site_id, return_broken_part, warehouse_name')
        .in('site_id', siteIds)
        .is('returned_at', null);
      if (shipErr) return json(500, { error: 'rma_shipments fetch failed: ' + shipErr.message });
      openShipments = (shipments || []).map(s => {
        const site = siteById[s.site_id];
        return {
          siteCode: site ? site.site_code : null,
          siteName: site ? site.name : '(unknown site)',
          needsReturn: !!s.return_broken_part,
          warehouseName: s.warehouse_name || null,
        };
      });
    }

    // Evening-only: light preview of tomorrow -- installs/site_surveys
    // scheduled tomorrow (via earliest_start_at), plus any restock
    // already queued for tomorrow's dispatch_date (e.g. from a
    // pushToTomorrow action taken earlier today).
    let preview = null;
    if (mode === 'evening') {
      const tomorrowInstalls = stateTickets
        .filter(t => (t.ticket_kind === 'install' || t.ticket_kind === 'site_survey') && t.status === 'open')
        .filter(t => t.earliest_start_at && t.earliest_start_at.slice(0, 10) === tomorrowStr)
        .map(t => ({
          ticketId: t.id,
          woNumber: t.wo_number,
          siteText: t.site_text,
          ticketKind: t.ticket_kind,
          earliestStartAt: t.earliest_start_at,
        }));

      const tomorrowsAssignments = await fetchAssignmentsFor(tomorrowStr);
      const tomorrowRestocks = tomorrowsAssignments
        .filter(a => a.status === 'planned')
        .map(a => {
          const site = siteById[a.site_id];
          return { siteCode: site ? site.site_code : null, siteName: site ? site.name : '(unknown site)' };
        });

      preview = { date: tomorrowStr, installs: tomorrowInstalls, restocksQueued: tomorrowRestocks };
    }

    return json(200, {
      ok: true,
      state,
      mode,
      date: todayStr,
      timezone,
      generatedAt: new Date().toISOString(),
      technicians,
      openTickets,
      needsReview,
      restocks,
      openShipments,
      preview,
    });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
