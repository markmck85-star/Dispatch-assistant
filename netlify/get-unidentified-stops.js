/**
 * netlify/functions/get-unidentified-stops.js  (v1.0, 2026-10-26)
 * SAVE AS: netlify/functions/get-unidentified-stops.js
 *
 * GET ?days=120  (default 120, 7 to 400)   &state=GA (optional)
 *
 * Feeds mileage-aliases.html: every stop name on the technicians' mileage sheets that the
 * mileage check could not identify, grouped by technician and counted, with up to three
 * suggested sites each. Saving what a name means is done by save-stop-alias.js.
 *
 * Reads the stored reports only (technician_mileage_reports.unmatched_legs), newest report per
 * technician and pay period. A name is left out when it is now recognized: the technician's own
 * home, an errand word (UPS, shop...), an alias already on file, or a clear name match to a site
 * in that technician's states. So a name disappears from this list once it is taught.
 *
 * Admin only (see gate.js).
 */
const { createClient } = require('@supabase/supabase-js');
const mc = require('./lib/mileage-check.js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

async function fetchAll(buildQuery) {
  const pageSize = 1000, all = [];
  for (let from = 0; from < 100000; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}

const GENERIC = new Set(['kroger', 'publix', 'walmart', 'target', 'county', 'tag', 'office', 'dmv', 'mv', 'department', 'motor', 'vehicle', 'tax', 'collector', 'market', 'store', 'the', 'of']);

/** Up to three sites whose name or aliases share the most distinctive words with the label. */
function suggest(label, sites) {
  const want = Array.from(new Set(mc.tokenize(label))).filter((t) => t.length > 1);
  if (!want.length) return [];
  const weight = (t) => (GENERIC.has(t) ? 0.15 : 1);
  const total = want.reduce((s, t) => s + weight(t), 0);
  const scored = [];
  for (const site of sites) {
    let best = 0;
    for (const name of [site.name, ...(site.aliases || [])]) {
      const have = new Set(mc.tokenize(name));
      const hit = want.filter((t) => have.has(t)).reduce((s, t) => s + weight(t), 0);
      if (hit > best) best = hit;
    }
    const score = total > 0 ? best / total : 0;
    // at least one distinctive word must be shared, not only "kroger"
    if (score >= 0.34 && want.some((t) => !GENERIC.has(t) && [site.name, ...(site.aliases || [])].some((n) => mc.tokenize(n).includes(t)))) {
      scored.push({ score, site });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((x) => ({ id: x.site.id, code: x.site.site_code, name: x.site.name, state: x.site.state }));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Supabase env vars not configured' });

  const params = event.queryStringParameters || {};
  const days = Math.min(400, Math.max(7, parseInt(params.days, 10) || 120));
  const stateFilter = String(params.state || '').trim().toUpperCase();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const reports = await fetchAll(() =>
      supabase.from('technician_mileage_reports')
        .select('id, technician_id, pay_period_end, processed_at, unmatched_legs')
        .gte('processed_at', since).not('technician_id', 'is', null).order('processed_at', { ascending: false }));

    // newest report per technician and pay period
    const newest = new Map();
    for (const r of reports) {
      const key = r.technician_id + '|' + (r.pay_period_end || r.id);
      if (!newest.has(key)) newest.set(key, r);
    }

    const techIds = Array.from(new Set(Array.from(newest.values()).map((r) => r.technician_id)));
    if (!techIds.length) return json(200, { ok: true, days, techs: [], note: 'No mileage reports in this window.' });

    const { data: techRows, error: tErr } = await supabase.from('technicians')
      .select('id, name, home_state, additional_states, home_address, home_aliases').in('id', techIds);
    if (tErr) throw new Error(tErr.message);
    const techById = new Map((techRows || []).map((t) => [t.id, t]));

    const statesOf = (t) => [t.home_state, ...(t.additional_states || [])].filter(Boolean);
    const allStates = Array.from(new Set((techRows || []).flatMap(statesOf)));
    const siteRows = allStates.length ? await fetchAll(() => supabase.from('sites').select('id, name, site_code, state').in('state', allStates)) : [];
    const aliasRows = await fetchAll(() => supabase.from('site_aliases').select('alias, site_id'));
    const siteById = new Map(siteRows.map((s) => [s.id, { ...s, aliases: [] }]));
    for (const a of aliasRows) { const s = siteById.get(a.site_id); if (s) s.aliases.push(a.alias); }
    const sitesByState = {};
    for (const s of siteById.values()) (sitesByState[s.state] = sitesByState[s.state] || []).push(s);
    const aliasToSite = new Map();
    for (const s of siteById.values()) for (const a of s.aliases) aliasToSite.set(a.toLowerCase(), s);

    const groups = new Map(); // techId -> Map(key -> item)
    for (const r of newest.values()) {
      const tech = techById.get(r.technician_id);
      if (!tech) continue;
      if (stateFilter && statesOf(tech).indexOf(stateFilter) < 0) continue;
      const cand = statesOf(tech).flatMap((st) => sitesByState[st] || []);
      for (const u of r.unmatched_legs || []) {
        if (u.reason === 'errand_stop' || u.reason === 'same_label_both_ends' || u.reason === 'no_distance_data') continue;
        for (const raw of [u.fromRaw, u.toRaw]) {
          const label = mc.normalizePlaceLabel(raw);
          if (!label) continue;
          const key = label.toLowerCase();
          if (mc.isErrandLabel(label)) continue;
          if (mc.isHomeLabel(label, tech.home_address, tech.home_aliases)) continue;
          if (aliasToSite.has(key)) continue;
          if (mc.matchSiteByName(label, cand)) continue;
          const g = groups.get(tech.id) || new Map();
          groups.set(tech.id, g);
          const it = g.get(key) || { label, count: 0, miles: 0, dates: new Set(), addressLike: mc.looksLikeStreetAddress(label) };
          it.count += 1;
          it.miles += Number(u.claimedMiles) || 0;
          if (u.date) it.dates.add(u.date);
          g.set(key, it);
        }
      }
    }

    const techs = [];
    const neededStates = new Set();
    for (const [techId, g] of groups) {
      const tech = techById.get(techId);
      const cand = statesOf(tech).flatMap((st) => sitesByState[st] || []);
      statesOf(tech).forEach((s) => neededStates.add(s));
      const items = Array.from(g.values()).sort((a, b) => b.count - a.count || b.miles - a.miles).map((it) => ({
        label: it.label, count: it.count, miles: Math.round(it.miles * 10) / 10,
        dates: Array.from(it.dates).sort().slice(0, 6), addressLike: it.addressLike,
        suggestions: it.addressLike ? [] : suggest(it.label, cand),
      }));
      techs.push({ id: tech.id, name: tech.name, state: tech.home_state, states: statesOf(tech), homeAddress: tech.home_address || null, homeAliases: tech.home_aliases || [], total: items.reduce((s, i) => s + i.count, 0), items });
    }
    techs.sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name)));

    const sites = {};
    for (const st of neededStates) sites[st] = (sitesByState[st] || []).map((s) => ({ id: s.id, code: s.site_code, name: s.name })).sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return json(200, { ok: true, days, techs, sites });
  } catch (e) {
    return json(500, { error: e.message || 'Unexpected error' });
  }
};
