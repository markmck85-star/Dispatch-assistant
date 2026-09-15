// get-distance.js
//
// Read-only lookup of driving distance/time between two sites, for the
// MCP connector's get_distance tool ("how far is X from Y").
//
// v2 (2026-09-15): switched from reading the Blobs distance-matrix/{STATE}
// key to reading site_site_distances directly -- see
// migrate-distance-matrix-to-supabase.js for the one-time backfill and
// compute-site-distance-matrix.js for the writer, both switched the same
// day.
//
// TRANSITIONAL BLOBS FALLBACK: a state that hasn't been migrated to
// Supabase yet (migration happens one state at a time, Mark's own call)
// falls back to the old Blobs lookup below rather than jumping straight to
// a haversine estimate -- so deployment/migration order across states
// doesn't matter. Safe to delete once every state with real Blobs data is
// confirmed migrated. Keeps the manual siteID/token getStore() config this
// file used to need throughout, since mcp-server.js's synthetic event still
// has no real event.blobs/event.headers for connectLambda to pick up.
//
// GET /.netlify/functions/get-distance?state=GA&from=GA1067&to=GA1090
// -> { from, to, distanceMi, durationMin, durationText, source }
//
// If the pair isn't in site_site_distances OR the Blobs fallback (state's
// site-to-site matrix never built, or a site added since), falls back to a
// live haversine (straight-line) estimate from the sites table's own
// lat/lng -- clearly labeled as an estimate, not a driving distance.

const { createClient } = require('@supabase/supabase-js');
const { getStore } = require('@netlify/blobs');

const R_MI = 3958.8;
const MODE_PRIORITY = { driving: 0, 'haversine-fallback': 1, haversine: 2 };

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R_MI * 2 * Math.asin(Math.sqrt(a));
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const state = String(params.state || '').trim().toUpperCase();
  const from = String(params.from || '').trim().toUpperCase();
  const to = String(params.to || '').trim().toUpperCase();

  if (!state || !/^[A-Z]{2}$/.test(state)) return json(400, { error: 'Valid 2-letter state required' });
  if (!from || !to) return json(400, { error: 'Both from and to site codes are required' });
  if (from === to) return json(400, { error: 'from and to must be different sites' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: sites, error: sitesErr } = await supabase
    .from('sites')
    .select('id, site_code, lat, lng')
    .in('site_code', [from, to]);
  if (sitesErr) return json(500, { error: 'Site lookup failed: ' + sitesErr.message });

  const siteA = (sites || []).find((s) => s.site_code === from);
  const siteB = (sites || []).find((s) => s.site_code === to);
  if (!siteA) return json(404, { error: 'Site ' + from + ' not found' });
  if (!siteB) return json(404, { error: 'Site ' + to + ' not found' });

  // 1. Try the precomputed matrix first -- free, instant, already-verified data.
  const { data: rows, error: rowsErr } = await supabase
    .from('site_site_distances')
    .select('mode, distance_mi, duration_min')
    .or(`and(site_a.eq.${siteA.id},site_b.eq.${siteB.id}),and(site_a.eq.${siteB.id},site_b.eq.${siteA.id})`);
  if (!rowsErr && rows && rows.length) {
    const best = rows.slice().sort((a, b) => (MODE_PRIORITY[a.mode] ?? 9) - (MODE_PRIORITY[b.mode] ?? 9))[0];
    return json(200, {
      from, to,
      distanceMi: Number(best.distance_mi),
      durationMin: best.duration_min != null ? Number(best.duration_min) : null,
      durationText: best.duration_min != null ? Math.round(best.duration_min) + ' min' + (Math.round(best.duration_min) === 1 ? '' : 's') : null,
      source: best.mode === 'driving' ? 'precomputed-driving' : 'precomputed-haversine-fallback',
    });
  }

  // 2. Not in Supabase (state not migrated yet, or a site added since) --
  // try the old Blobs matrix directly as a transitional fallback. See file
  // header note. Checks both key orderings, matching how the writer stores
  // (and this file used to read) site-to-site pairs.
  try {
    const siteID = process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) {
      const store = getStore({ name: 'dispatch', siteID, token });
      const stored = await store.get('distance-matrix/' + state, { type: 'json' });
      const matrix = stored && stored.matrix;
      const entry = matrix && (matrix[from + '|' + to] || matrix[to + '|' + from]);
      if (entry) {
        return json(200, {
          from, to,
          distanceMi: entry.distanceMi,
          durationMin: entry.durationMin ?? null,
          durationText: entry.durationText ?? null,
          source: entry.type === 'haversine-fallback' ? 'precomputed-haversine-fallback' : 'precomputed-driving',
        });
      }
    }
  } catch {
    // Blobs fallback is best-effort -- fall through to live haversine below.
  }

  // 3. Not in either store -- fall back to a live haversine estimate from
  // the sites table's own coordinates.
  if (siteA.lat == null || siteB.lat == null) {
    return json(404, {
      error: 'One or both sites have no coordinates yet -- run geocode-addresses for ' + state + ' first.',
    });
  }

  const distanceMi = Math.round(haversineDistance(siteA.lat, siteA.lng, siteB.lat, siteB.lng) * 10) / 10;
  return json(200, {
    from, to,
    distanceMi,
    durationMin: null,
    durationText: null,
    source: 'live-haversine-fallback',
    note: 'Straight-line estimate, not a driving distance -- this pair is not yet in the precomputed matrix for ' + state + '.',
  });
};
