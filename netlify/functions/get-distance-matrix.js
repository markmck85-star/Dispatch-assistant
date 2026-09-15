/**
 * get-distance-matrix.js
 *
 * Returns the pre-computed distance matrix for a state, reshaped into the
 * exact same { meta, matrix } contract the frontend (index.html's
 * getCachedLegInfo/getTechDistance, via _dmCache) has always consumed --
 * matrix keyed "{techSlug}|{siteCode}" for tech-to-site entries and
 * "{siteCodeA}|{siteCodeB}" for site-to-site entries, each value
 * { distanceMi, durationMin, distanceText, durationText, type }.
 *
 * v2 (2026-09-15): switched the primary data source from the Blobs
 * distance-matrix/{STATE} key to the tech_site_distances / site_site_distances
 * Supabase tables (see migrate-distance-matrix-to-supabase.js for the
 * one-time backfill and compute-distance-matrix.js / compute-site-distance-matrix.js
 * for the writers, both switched the same day).
 *
 * TRANSITIONAL BLOBS FALLBACK: states get migrated one at a time (Mark's
 * own call, no forced all-or-nothing cutover), so a state with nothing in
 * Supabase yet falls back to reading the OLD Blobs key directly rather than
 * silently degrading to client-side haversine -- avoids any accuracy
 * regression for a not-yet-migrated state regardless of what order the
 * migration script / these readers / the writers get deployed and run in.
 * Safe to delete this fallback block (and the @netlify/blobs import) once
 * every state with real Blobs data has been confirmed migrated.
 *
 * When a pair has rows in more than one mode (e.g. a real driving result
 * alongside an older haversine-fallback from before it was recomputed --
 * expected, not a bug, since the composite primary key is (ids, mode)),
 * 'driving' wins, then 'haversine-fallback', then 'haversine'.
 *
 * Returns null (200) if nothing has been migrated/computed yet for this
 * state -- the frontend already handles this gracefully by falling back
 * to client-side haversine, same as when the old Blobs key was empty.
 *
 * GET /.netlify/functions/get-distance-matrix?state=GA
 */

const { createClient } = require('@supabase/supabase-js');
const { getStore, connectLambda } = require('@netlify/blobs');

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

// Given however many rows a pair has (one per mode), pick the single best
// one to expose -- same preference order documented at the top of this file.
const MODE_PRIORITY = { driving: 0, 'haversine-fallback': 1, haversine: 2 };
function pickBestRow(rows) {
  return rows.slice().sort((a, b) => (MODE_PRIORITY[a.mode] ?? 9) - (MODE_PRIORITY[b.mode] ?? 9))[0];
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
      supabase.from('sites').select('id, site_code').eq('state', state),
      supabase.from('technicians').select('id, slug').eq('home_state', state),
    ]);
    if (sitesErr || techsErr) return await blobsFallback(state);

    const siteIds = (sites || []).map((s) => s.id);
    const techIds = (techs || []).map((t) => t.id);
    if (!siteIds.length) return await blobsFallback(state);

    const siteCodeById = Object.fromEntries((sites || []).map((s) => [s.id, s.site_code]));
    const techSlugById = Object.fromEntries((techs || []).map((t) => [t.id, t.slug]));

    const [{ data: siteToSite, error: s2sErr }, { data: techToSite, error: t2sErr }] = await Promise.all([
      supabase.from('site_site_distances').select('site_a, site_b, mode, distance_mi, duration_min').or(`site_a.in.(${siteIds.join(',')}),site_b.in.(${siteIds.join(',')})`),
      techIds.length
        ? supabase.from('tech_site_distances').select('technician_id, site_id, mode, distance_mi, duration_min').in('technician_id', techIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (s2sErr || t2sErr) return await blobsFallback(state);

    // Group by pair (ignoring mode), then pick the best row per pair.
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
      if (!codeA || !codeB) continue; // one side outside this state or missing -- skip
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
      meta: { state, source: 'supabase', siteCount: siteIds.length, techCount: techIds.length },
      matrix,
    });
  } catch {
    return await blobsFallback(state);
  }
};

// Transitional only -- see file header. Reproduces the exact old
// get-distance-matrix.js behavior for a state that hasn't been migrated
// (or migrated-but-empty) yet.
async function blobsFallback(state) {
  try {
    const store = getStore('dispatch');
    const data = await store.get('distance-matrix/' + state, { type: 'json' });
    return json(200, data || null);
  } catch {
    return json(200, null);
  }
}
