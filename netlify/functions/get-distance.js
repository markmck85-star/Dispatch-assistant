// get-distance.js
//
// Read-only lookup of driving distance/time between two sites, for the
// search_emails-style "how far is X from Y" question. Reads the SAME
// precomputed matrix compute-site-distance-matrix.js already builds and
// caches in Blobs (store "dispatch", key "distance-matrix/{STATE}",
// entries keyed "{siteCodeA}|{siteCodeB}" alphabetically) -- this function
// does NOT call the Google Maps API itself and has zero per-query cost,
// it just reads what's already been built.
//
// GET /.netlify/functions/get-distance?state=GA&from=GA1067&to=GA1090
// -> { from, to, distanceMi, durationMin, durationText, source }
//
// If the pair isn't in the precomputed matrix yet (state not built, or a
// site added since the last build), falls back to a live haversine
// (straight-line) estimate from the sites table's own lat/lng -- clearly
// labeled as an estimate, not a driving distance, same honesty the
// precomputed matrix itself already uses for its own "haversine-fallback"
// entries when Google's API didn't have a route for a pair.

const { getStore, connectLambda } = require('@netlify/blobs');
const { createClient } = require('@supabase/supabase-js');

const R_MI = 3958.8;

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

  // 1. Try the precomputed matrix first -- free, instant, already-verified data.
  //
  // BUG FIX (2026-09-07): connectLambda(event) reads event.blobs (base64
  // decoded) and event.headers['x-nf-deploy-id'/'x-nf-site-id'] -- NEITHER
  // of which exist on mcp-server.js's callHandler synthetic event
  // ({httpMethod, queryStringParameters} only). That's not a maybe -- it
  // throws unconditionally on that path, on its very first line, which
  // means the ENTIRE Blobs read below it never even ran -- every single
  // get_distance call made through the Claude connector has been landing
  // on the live haversine fallback regardless of whether real matrix data
  // existed, ever since this function was written. connectLambda is only
  // needed to manually set the Blobs context for cases where Netlify's
  // runtime doesn't already auto-populate process.env.NETLIFY_BLOBS_CONTEXT
  // -- on a normal deployed function (real request OR this synthetic one),
  // that env var is already there, so getStore() below works fine on its
  // own. Isolating connectLambda's own failure into its own try/catch, so
  // it no longer gates the real read that follows it.
  try {
    connectLambda(event);
  } catch (e) {
    // Expected/harmless on the MCP synthetic event path -- getStore()
    // below still works via the runtime's own auto-injected Blobs context.
  }
  let blobsErrorForDebug = null;
  try {
    const store = getStore('dispatch');
    const matrix = await store.get('distance-matrix/' + state, { type: 'json' });
    if (matrix) {
      // BUG FIX (2026-09-07): this used to look up only the alphabetically
      // SORTED key ([from, to].sort().join('|')), but the site-to-site
      // builder (compute-site-distance-matrix.js) always stores keys as
      // "originCode|destCode" -- whichever order the origin/destination
      // batching happened to process them in, NOT sorted. That function's
      // own header comment always documented "lookups should check both
      // orderings" -- this reader just never actually did that, so roughly
      // half of every real computed pair (whichever direction didn't
      // happen to land in alphabetical order) was silently unreachable
      // here and fell back to a haversine estimate despite the real
      // driving data already existing, already paid for, sitting in the
      // matrix under the other key order the whole time.
      const entry = matrix[from + '|' + to] || matrix[to + '|' + from];
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
  } catch (e) {
    console.error('get-distance: Blobs lookup failed, falling back to live haversine:', e.message);
    // TEMPORARY DIAGNOSTIC (2026-09-07) -- surfacing the real error in the
    // response itself so it's visible through the MCP connector, which has
    // no access to Netlify's server-side function logs. Remove once the
    // persistent-fallback issue is actually diagnosed.
    blobsErrorForDebug = e.message;
  }

  // 2. Not in the matrix (state never built, or a site added since) -- fall
  // back to a live haversine estimate from the sites table's own coordinates.
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: sites, error } = await supabase
    .from('sites')
    .select('site_code, lat, lng')
    .in('site_code', [from, to]);
  if (error) return json(500, { error: 'Site lookup failed: ' + error.message });

  const siteA = (sites || []).find((s) => s.site_code === from);
  const siteB = (sites || []).find((s) => s.site_code === to);
  if (!siteA) return json(404, { error: 'Site ' + from + ' not found' });
  if (!siteB) return json(404, { error: 'Site ' + to + ' not found' });
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
    _debugBlobsError: blobsErrorForDebug,
  });
};
