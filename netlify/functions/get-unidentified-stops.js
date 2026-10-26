/**
 * netlify/functions/get-unidentified-stops.js  (v1.1, 2026-10-26)
 * SAVE AS: netlify/functions/get-unidentified-stops.js
 *
 * GET ?days=120  (default 120, 7 to 400)   &state=GA (optional)
 *
 * Feeds mileage-aliases.html: every stop name on the technicians' mileage sheets that the
 * mileage check could not identify, grouped by technician and counted, with up to five suggested
 * sites each. Saving what a name means is done by save-stop-alias.js (per technician).
 *
 * v1.1: suggestions now come from the miles. For each time a name appears, the other end of that
 * hop is looked up (the technician's home, or a stop that IS recognized); every site in the
 * technician's states is then scored by how close its stored driving distance from that other end
 * is to the miles claimed. Sites that were on the dispatch list or had a trouble ticket that day or
 * the day before are listed first (restock lists and most trouble tickets go out the day before
 * the visit). Name similarity fills any remaining slots. Names saved for the technician
 * (technician_stop_aliases) are left out of the list.
 *
 * Reads the stored reports only (technician_mileage_reports.unmatched_legs), newest report per
 * technician and pay period. A name is left out when it is now recognized: the technician's own
 * home, an errand word (UPS, shop...), an alias on file (shared or the technician's own), or a
 * clear name match to a site in that technician's states.
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
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const MODE_PRIORITY = { driving: 0, 'haversine-fallback': 1, haversine: 2 };
const better = (a, b) => (MODE_PRIORITY[a.mode] ?? 9) < (MODE_PRIORITY[b.mode] ?? 9);
const dayBefore = (ymd) => new Date(Date.parse(ymd + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
const etDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const GENERIC = new Set(['kroger', 'publix', 'walmart', 'target', 'county', 'tag', 'office', 'dmv', 'mv', 'department', 'motor', 'vehicle', 'tax', 'collector', 'market', 'store', 'the', 'of']);

/** Up to three sites whose name or aliases share the most distinctive words with the label. */
function suggestByName(label, sites) {
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
  return scored.slice(0, 3).map((x) => ({ id: x.site.id, code: x.site.site_code, name: x.site.name, state: x.site.state, onList: false, note: 'similar name' }));
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

    // names already saved for one technician (v1.1)
    const techAliasRows = [];
    try {
      for (const ids of chunk(techIds, 60)) {
        const rows = await fetchAll(() => supabase.from('technician_stop_aliases').select('technician_id, alias, site_id').in('technician_id', ids));
        techAliasRows.push(...rows);
      }
    } catch (e) { /* table not there yet: nothing saved per technician */ }
    const techAliasMap = new Map(); // techId -> Map(lower alias -> site row or {id})
    for (const r of techAliasRows) {
      const m = techAliasMap.get(r.technician_id) || new Map();
      m.set(String(r.alias).toLowerCase(), siteById.get(r.site_id) || { id: r.site_id });
      techAliasMap.set(r.technician_id, m);
    }

    // ---- group the unidentified names, keeping where each one appeared ----
    const groups = new Map(); // techId -> Map(key -> item)
    for (const r of newest.values()) {
      const tech = techById.get(r.technician_id);
      if (!tech) continue;
      if (stateFilter && statesOf(tech).indexOf(stateFilter) < 0) continue;
      const cand = statesOf(tech).flatMap((st) => sitesByState[st] || []);
      const mine = techAliasMap.get(tech.id) || new Map();
      for (const u of r.unmatched_legs || []) {
        if (u.reason === 'errand_stop' || u.reason === 'same_label_both_ends' || u.reason === 'no_distance_data') continue;
        for (const [raw, other] of [[u.fromRaw, u.toRaw], [u.toRaw, u.fromRaw]]) {
          const label = mc.normalizePlaceLabel(raw);
          if (!label) continue;
          const key = label.toLowerCase();
          if (mc.isErrandLabel(label)) continue;
          if (mc.isHomeLabel(label, tech.home_address, tech.home_aliases)) continue;
          if (mine.has(key) || aliasToSite.has(key)) continue;
          if (mc.matchSiteByName(label, cand)) continue;
          const g = groups.get(tech.id) || new Map();
          groups.set(tech.id, g);
          const it = g.get(key) || { label, count: 0, miles: 0, dates: new Set(), occ: [], addressLike: mc.looksLikeStreetAddress(label) };
          it.count += 1;
          it.miles += Number(u.claimedMiles) || 0;
          if (u.date) it.dates.add(u.date);
          if (u.date && it.occ.length < 8) it.occ.push({ date: u.date, otherRaw: other, miles: Number(u.claimedMiles) || 0 });
          g.set(key, it);
        }
      }
    }

    // ---- resolve the other end of each hop: home, or a recognized stop ----
    const refs = []; // { tech, item, occ, ref }
    const refSiteIds = new Set();
    const allDates = new Set();
    for (const [techId, g] of groups) {
      const tech = techById.get(techId);
      const cand = statesOf(tech).flatMap((st) => sitesByState[st] || []);
      const mine = techAliasMap.get(techId) || new Map();
      // a street address that shows up on two or more hops is very likely his own home
      const homeKeys = new Set(Array.from(g.values()).filter((i) => i.addressLike && i.count >= 2).map((i) => mc.addressKey(i.label)));
      for (const it of g.values()) {
        for (const occ of it.occ) {
          const other = mc.normalizePlaceLabel(occ.otherRaw);
          let ref = null;
          if (!other) ref = null;
          else if (mc.isHomeLabel(other, tech.home_address, tech.home_aliases) || (mc.looksLikeStreetAddress(other) && homeKeys.has(mc.addressKey(other)))) ref = { type: 'home' };
          else if (mc.isErrandLabel(other)) ref = null;
          else {
            const lk = other.toLowerCase();
            const hit = mine.get(lk) || aliasToSite.get(lk) || mc.matchSiteByName(other, cand);
            if (hit && hit.id) ref = { type: 'site', id: hit.id, name: hit.name || other };
          }
          occ.ref = ref;
          if (ref && ref.type === 'site') refSiteIds.add(ref.id);
          allDates.add(occ.date); allDates.add(dayBefore(occ.date));
          refs.push({ techId, it, occ });
        }
      }
    }

    // ---- stored distances ----
    const techDist = new Map(); // techId -> Map(site_id -> miles)
    for (const techId of groups.keys()) {
      const rows = await fetchAll(() => supabase.from('tech_site_distances').select('site_id, mode, distance_mi').eq('technician_id', techId));
      const best = new Map();
      for (const r of rows) { const cur = best.get(r.site_id); if (!cur || better(r, cur)) best.set(r.site_id, r); }
      techDist.set(techId, new Map(Array.from(best.entries()).map(([k, v]) => [k, Number(v.distance_mi)])));
    }
    const pairDist = new Map(); // "a|b" sorted -> {mode, miles}
    for (const ids of chunk(Array.from(refSiteIds), 80)) {
      const [ra, rb] = await Promise.all([
        fetchAll(() => supabase.from('site_site_distances').select('site_a, site_b, mode, distance_mi').in('site_a', ids)),
        fetchAll(() => supabase.from('site_site_distances').select('site_a, site_b, mode, distance_mi').in('site_b', ids)),
      ]);
      for (const r of [...ra, ...rb]) {
        const k = [r.site_a, r.site_b].sort().join('|');
        const cur = pairDist.get(k);
        if (!cur || better(r, cur)) pairDist.set(k, { mode: r.mode, miles: Number(r.distance_mi) });
      }
    }

    // ---- what was on the list those days (the day before counts too) ----
    const dateList = Array.from(allDates).sort();
    const onListBy = new Map(); // "techId|date" -> Set(site_id) ; "any|date" -> Set(site_id)
    const addList = (key, siteId) => { const s = onListBy.get(key) || new Set(); s.add(siteId); onListBy.set(key, s); };
    if (dateList.length) {
      try {
        const asg = await fetchAll(() => supabase.from('assignments').select('dispatch_date, site_id, technician_id').in('dispatch_date', dateList));
        for (const a of asg) { if (!a.site_id) continue; addList(a.technician_id + '|' + a.dispatch_date, a.site_id); addList('any|' + a.dispatch_date, a.site_id); }
        const from = new Date(Date.parse(dateList[0] + 'T00:00:00Z') - 86400000).toISOString();
        const tix = await fetchAll(() => supabase.from('tickets').select('site_id, received_at').gte('received_at', from));
        for (const t of tix) { if (!t.site_id) continue; addList('any|' + etDay(t.received_at), t.site_id); }
      } catch (e) { /* suggestions fall back to miles and names alone */ }
    }
    const onList = (techId, date, siteId) => {
      for (const d of [date, dayBefore(date)]) {
        if ((onListBy.get(techId + '|' + d) || new Set()).has(siteId)) return true;
        if ((onListBy.get('any|' + d) || new Set()).has(siteId)) return true;
      }
      return false;
    };
    const distFrom = (techId, ref, siteId) => {
      if (!ref) return null;
      if (ref.type === 'home') { const v = (techDist.get(techId) || new Map()).get(siteId); return v == null ? null : v; }
      if (ref.id === siteId) return null;
      const p = pairDist.get([ref.id, siteId].sort().join('|'));
      return p ? p.miles : null;
    };

    // ---- build the answer ----
    const techs = [];
    for (const [techId, g] of groups) {
      const tech = techById.get(techId);
      const cand = statesOf(tech).flatMap((st) => sitesByState[st] || []);
      const items = Array.from(g.values()).sort((a, b) => b.count - a.count || b.miles - a.miles).map((it) => {
        let suggestions = [];
        if (!it.addressLike) {
          const withRef = it.occ.filter((o) => o.ref && o.miles > 0);
          const scored = [];
          if (withRef.length) {
            for (const site of cand) {
              let errSum = 0, n = 0, listed = false, note = '';
              for (const o of withRef) {
                const d = distFrom(techId, o.ref, site.id);
                if (d == null) continue;
                errSum += Math.abs(o.miles - d) / Math.max(o.miles, d, 5);
                n += 1;
                if (onList(techId, o.date, site.id)) listed = true;
                if (!note) note = 'about ' + Math.round(d) + ' mi from ' + (o.ref.type === 'home' ? 'home' : o.ref.name) + ', claimed ' + o.miles;
              }
              if (!n) continue;
              const err = errSum / n;
              if (err > (listed ? 0.35 : 0.2)) continue;
              scored.push({ site, err, listed, note });
            }
            scored.sort((a, b) => (b.listed ? 1 : 0) - (a.listed ? 1 : 0) || a.err - b.err);
          }
          suggestions = scored.slice(0, 5).map((x) => ({ id: x.site.id, code: x.site.site_code, name: x.site.name, state: x.site.state, onList: x.listed, note: x.note + (x.listed ? ' (on that day\'s list)' : '') }));
          for (const s of suggestByName(it.label, cand)) { if (suggestions.length >= 5) break; if (!suggestions.some((x) => x.id === s.id)) suggestions.push(s); }
        }
        return {
          label: it.label, count: it.count, miles: Math.round(it.miles * 10) / 10,
          dates: Array.from(it.dates).sort().slice(0, 6), addressLike: it.addressLike, suggestions,
        };
      });
      techs.push({ id: tech.id, name: tech.name, state: tech.home_state, states: statesOf(tech), homeAddress: tech.home_address || null, homeAliases: tech.home_aliases || [], total: items.reduce((s, i) => s + i.count, 0), items });
    }
    techs.sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name)));

    const neededStates = new Set(techs.flatMap((t) => t.states));
    const sites = {};
    for (const st of neededStates) sites[st] = (sitesByState[st] || []).map((s) => ({ id: s.id, code: s.site_code, name: s.name })).sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return json(200, { ok: true, days, techs, sites });
  } catch (e) {
    return json(500, { error: e.message || 'Unexpected error' });
  }
};
