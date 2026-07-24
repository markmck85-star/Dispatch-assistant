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
    .select('site_id, issue_category, received_at, wo_number')
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
    const key = t.site_id + '|' + t.issue_category;
    if (!groups[key]) {
      groups[key] = {
        site_id: t.site_id,
        site_code: site.site_code,
        site_name: site.name,
        state: site.state,
        issue_category: t.issue_category,
        count: 0,
        wo_numbers: [],
        dates: [],
      };
    }
    groups[key].count++;
    if (t.wo_number) groups[key].wo_numbers.push(t.wo_number);
    if (t.received_at) groups[key].dates.push(t.received_at);
  }

  const results = Object.values(groups)
    .filter(g => g.count >= minCount)
    .map(g => ({
      ...g,
      first_seen: g.dates.length ? g.dates.reduce((a, b) => a < b ? a : b) : null,
      last_seen: g.dates.length ? g.dates.reduce((a, b) => a > b ? a : b) : null,
    }))
    .sort((a, b) => b.count - a.count);

  return json(200, { ok: true, days, minCount, results });
};
