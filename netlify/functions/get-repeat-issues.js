// get-repeat-issues.js
//
// Flags sites with repeated trouble tickets for the SAME issue_category
// within a rolling window — standard field practice is to replace the
// hardware on the 3rd trip for the same complaint, so this exists to
// surface that pattern without having to click into each site individually
// (see Effingham County Kroger - S Columbia, GA1112, 2026-07-24).
//
// Deliberately scoped to same-site + same-issue_category, not just "3+
// troubleshooting visits" in general — different unrelated issues at one
// site aren't a signal of a single point of failure (Mark: EPCs/USB
// hubs/switches are reliable in practice, and a failing UPS is obvious and
// gets addressed immediately, so that broad edge case isn't worth flagging
// noisily). Read-only.

const { createClient } = require('@supabase/supabase-js');

// These issue_category values are scheduling or investigative requests, not
// reported hardware malfunctions — grouping them the same way as a real
// fault category produces false positives (e.g. an unrelated switch-install
// job and an unrelated cell signal test both filed under "Technician
// Request" looking like a repeat complaint). Found 2026-07-24 via OH1008.
const NON_FAULT_CATEGORIES = new Set(['Technician Request', 'Research']);

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const state = params.state; // optional — omit for all states
  const days = parseInt(params.days || '90', 10);
  const minCount = parseInt(params.minCount || '3', 10);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Sites first (optionally filtered by state), so ticket rows can be
  // joined in JS rather than relying on a cross-table Supabase filter.
  let sitesQuery = supabase.from('sites').select('id, site_code, name, state');
  if (state) sitesQuery = sitesQuery.eq('state', state);
  const { data: sites, error: sitesErr } = await sitesQuery;
  if (sitesErr) return json(500, { ok: false, error: sitesErr.message });
  const siteById = {};
  for (const s of sites) siteById[s.id] = s;

  const { data: tickets, error } = await supabase
    .from('tickets')
    .select('id, site_id, issue_category, issue_detail, description, received_at, wo_number, inbound_email_id')
    .eq('ticket_kind', 'trouble')
    .not('issue_category', 'is', null)
    .not('site_id', 'is', null)
    .gte('received_at', sinceDate);
  if (error) return json(500, { ok: false, error: error.message });

  // Group by site_id + issue_category
  const groups = {};
  for (const t of tickets) {
    const site = siteById[t.site_id];
    if (!site) continue; // filtered out by state, or orphaned site_id
    if (NON_FAULT_CATEGORIES.has(t.issue_category)) continue; // scheduling/investigative, not a fault report
    const key = t.site_id + '|' + t.issue_category;
    if (!groups[key]) {
      groups[key] = {
        site_id: t.site_id,
        site_code: site.site_code,
        site_name: site.name,
        state: site.state,
        issue_category: t.issue_category,
        tickets: [],
      };
    }
    groups[key].tickets.push({
      id: t.id || null,
      wo_number: t.wo_number || null,
      received_at: t.received_at || null,
      issue_detail: t.issue_detail || null,
      description: t.description || null,
      inbound_email_id: t.inbound_email_id || null,
      appointment_number: null,
      closing_note: null,
      tech_name_raw: null,
    });
  }

  // Attach SA numbers + closing notes from site_visits (same source as
  // the dispatch-console visit history overlay). Match by ticket_id first,
  // then fall back to site_id + WO so older imports still line up.
  const flagged = Object.values(groups).filter(g => g.tickets.length >= minCount);
  const siteIds = [...new Set(flagged.map(g => g.site_id))];
  const visitByTicketId = {};
  const visitBySiteWo = {};
  if (siteIds.length) {
    const { data: visits, error: visitErr } = await supabase
      .from('site_visits')
      .select('ticket_id, site_id, wo_number, appointment_number, closing_note, tech_name_raw, started_at')
      .in('site_id', siteIds)
      .gte('started_at', sinceDate);
    if (!visitErr && visits) {
      for (const v of visits) {
        if (v.ticket_id) visitByTicketId[v.ticket_id] = v;
        if (v.site_id && v.wo_number) visitBySiteWo[v.site_id + '|' + v.wo_number] = v;
      }
    }
  }
  for (const g of flagged) {
    for (const t of g.tickets) {
      const v = (t.id && visitByTicketId[t.id]) ||
        (t.wo_number && visitBySiteWo[g.site_id + '|' + t.wo_number]) ||
        null;
      if (!v) continue;
      t.appointment_number = v.appointment_number || null;
      t.closing_note = v.closing_note || null;
      t.tech_name_raw = v.tech_name_raw || null;
    }
  }

  const results = Object.values(groups)
    .filter(g => g.tickets.length >= minCount)
    .map(g => {
      const sorted = g.tickets.slice().sort((a, b) => (a.received_at || '').localeCompare(b.received_at || ''));
      return {
        ...g,
        count: g.tickets.length,
        tickets: sorted,
        first_seen: sorted.length ? sorted[0].received_at : null,
        last_seen: sorted.length ? sorted[sorted.length - 1].received_at : null,
      };
    })
    .sort((a, b) => b.count - a.count);

  return json(200, { ok: true, days, minCount, results });
};
