/**
 * get-distance-matrix.js
 *
 * Returns the pre-computed distance matrix for a state, reshaped into the
 * exact same { meta, matrix } contract the frontend (index.html's
 * getCachedLegInfo/getTechDistance, via _dmCache) has already consumed --
 * matrix keyed "{techSlug}|{siteCode}" for tech-to-site entries and
 * "{siteCodeA}|{siteCodeB}" for site-to-site entries, each value
 * { distanceMi, durationMin, distanceText, durationText, type }.
 *
 * v2 (2026-09-15): switched the primary data source from the Blobs
 * distance-matrix/{STATE} key to the tech_site_distances / site_site_distances
 * Supabase tables.
 *
 * v3 (2026-09-19): page every Supabase select. PostgREST's default max-rows
 * is 1000, and a single unpaged read of site_site_distances / tech_site_distances
 * silently truncated GA -- live payload was exactly 1000 site-site pairs and
 * a partial tech-site list that dropped Gina Ownbey and Omari Williams even
 * though both had driving rows and coordinates. fetchAllPages() walks .range
 * until a short page comes back.
 *
 * TRANSITIONAL BLOBS FALLBACK: states get migrated one at a time, so a state
 * with nothing in Supabase yet falls back to the OLD Blobs key.
 *
 * When a pair has rows in more than one mode, 'driving' wins, then
 * 'haversine-fallback', then 'haversine'.
 *
 * GET /.netlify/functions/get-distance-matrix?state=GA
 */

const { createClient } = require('@supabase/supabase-js');
const { getStore, connectLambda } = require('@netlify/blobs');

const PAGE_SIZE = 1000;

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function fmtDistance(mi) {
  return mi + ' mi';
}

function fmtDuration(min) {
  if (min == null) return null;
  const rounded = Math.round(min);
  return rounded + ' min' + (rounded === 1 ? '' : 's');
}

const MODE_PRIORITY = { driving: 0, 'haversine-fallback': 1, haversine: 2 };
function pickBestRow(rows) {
  return rows.slice().sort((a, b) => (MODE_PRIORITY[a.mode] ?? 9) - (MODE_PRIORITY[b.mode] ?? 9))[0];
}

/**
 * Run a Supabase query builder in 1000-row pages until exhausted.
 * `buildQuery` is called fresh each page so filters stay attached.
 */
async function fetchAllPages(buildQuery) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) return { data: null, error };
    const page = data || [];
    all.push(...page);
    if (page.length < PAGE_SIZE) return { data: all, error: null };
    from += PAGE_SIZE;
    if (from > 100000) return { data: all, error: { message: 'pagination safety cap' } };
  }
}

exports.handler = async (event) => {
  connectLambda(event);

  const params = event.queryStringParameters || {};
  const state = (params.state || '').trim().toUpperCase();

  if (!state || !/^[A-Z]{2}$/.test(state)) {
    return json(400, { error: 'Valid 2-letter state required' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const [{ data: sites, error: sitesErr }, { data: techs, error: techsErr }] = await Promise.all([
      fetchAllPages(() => supabase.from('sites').select('id, site_code').eq('state', state).order('id')),
      fetchAllPages(() => supabase.from('technicians').select('id, slug').eq('home_state', state).order('id')),
    ]);
    if (sitesErr || techsErr) return await blobsFallback(state);

    const siteIds = (sites || []).map((s) => s.id);
    const techIds = (techs || []).map((t) => t.id);
    if (!siteIds.length) return await blobsFallback(state);

    const siteCodeById = Object.fromEntries((sites || []).map((s) => [s.id, s.site_code]));
    const techSlugById = Object.fromEntries((techs || []).map((t) => [t.id, t.slug]));

    const siteOrFilter = `site_a.in.(${siteIds.join(',')}),site_b.in.(${siteIds.join(',')})`;

    const [{ data: siteToSite, error: s2sErr }, { data: techToSite, error: t2sErr }] = await Promise.all([
      fetchAllPages(() =>
        supabase
          .from('site_site_distances')
          .select('site_a, site_b, mode, distance_mi, duration_min')
          .or(siteOrFilter)
          .order('site_a')
          .order('site_b')
          .order('mode')
      ),
      techIds.length
        ? fetchAllPages(() =>
            supabase
              .from('tech_site_distances')
              .select('technician_id, site_id, mode, distance_mi, duration_min')
              .in('technician_id', techIds)
              .order('technician_id')
              .order('site_id')
              .order('mode')
          )
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (s2sErr || t2sErr) return await blobsFallback(state);

    const bySiteToSitePair = {};
    for (const row of siteToSite || []) {
      const k = row.site_a + '|' + row.site_b;
      (bySiteToSitePair[k] = bySiteToSitePair[k] || []).push(row);
    }
    const byTechToSitePair = {};
    for (const row of techToSite || []) {
      const k = row.technician_id + '|' + row.site_id;
      (byTechToSitePair[k] = byTechToSitePair[k] || []).push(row);
    }

    const matrix = {};
    for (const rows of Object.values(bySiteToSitePair)) {
      const best = pickBestRow(rows);
      const codeA = siteCodeById[best.site_a];
      const codeB = siteCodeById[best.site_b];
      if (!codeA || !codeB) continue;
      matrix[codeA + '|' + codeB] = {
        distanceMi: Number(best.distance_mi),
        durationMin: best.duration_min != null ? Number(best.duration_min) : null,
        distanceText: fmtDistance(best.distance_mi),
        durationText: fmtDuration(best.duration_min),
        type: best.mode,
      };
    }
    for (const rows of Object.values(byTechToSitePair)) {
      const best = pickBestRow(rows);
      const slug = techSlugById[best.technician_id];
      const code = siteCodeById[best.site_id];
      if (!slug || !code) continue;
      matrix[slug + '|' + code] = {
        distanceMi: Number(best.distance_mi),
        durationMin: best.duration_min != null ? Number(best.duration_min) : null,
        distanceText: fmtDistance(best.distance_mi),
        durationText: fmtDuration(best.duration_min),
        type: best.mode,
      };
    }

    if (!Object.keys(matrix).length) return await blobsFallback(state);

    return json(200, {
      meta: {
        state,
        source: 'supabase',
        siteCount: siteIds.length,
        techCount: techIds.length,
        pairCount: Object.keys(matrix).length,
      },
      matrix,
    });
  } catch {
    return await blobsFallback(state);
  }
};

async function blobsFallback(state) {
  try {
    const store = getStore('dispatch');
    const data = await store.get('distance-matrix/' + state, { type: 'json' });
    return json(200, data || null);
  } catch {
    return json(200, null);
  }
}
