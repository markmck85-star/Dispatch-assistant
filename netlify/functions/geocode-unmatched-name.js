/**
 * geocode-unmatched-name.js
 *
 * Companion to get-unmatched-sites.js. Given one unmatched group's raw
 * name (e.g. "IN - Midtown BMV"), looks it up via Google Places (real
 * place data, not a name-token guess) and finds the nearest EXISTING
 * site already in Supabase for that state by real-world distance.
 *
 * Why this exists: get-unmatched-sites.js's "suggested" match is pure
 * text-token overlap against site NAMES -- it has no idea about location,
 * so five differently-located BMV branches that all contain the word
 * "BMV" can tie at the same score. Grounding in a real geocoded address
 * and comparing physical distance sidesteps that entirely, and also
 * catches the opposite failure (two sites with near-identical names at
 * genuinely different addresses -- the exact GA1070/GA1126 and
 * GA1017/GA1102/GA1050 collision pattern found during the Aug 2026
 * cleanup campaign).
 *
 * One raw name per call, by design -- lets the admin UI show a result
 * per card as the dispatcher reviews them, rather than a single giant
 * batch call that risks a Netlify function timeout across 100+ groups.
 *
 * POST /.netlify/functions/geocode-unmatched-name
 * Body: { state: "IN", accountNameRaw: "IN - Midtown BMV" }
 *
 * Requires env vars: GOOGLE_MAPS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

const FIND_PLACE_URL = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json';

// Full state names read back much better to the Places API than bare
// two-letter codes (which can collide with unrelated abbreviations) --
// only the states MCR actually covers need to be here.
const STATE_NAMES = {
  GA: 'Georgia', NC: 'North Carolina', SC: 'South Carolina', FL: 'Florida',
  OH: 'Ohio', MI: 'Michigan', IN: 'Indiana', WV: 'West Virginia',
  OR: 'Oregon', IL: 'Illinois', MN: 'Minnesota', NV: 'Nevada',
  CO: 'Colorado', ID: 'Idaho', CA: 'California',
};

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function stripStatePrefix(accountName) {
  const m = String(accountName || '').trim().match(/^([A-Za-z]{2})\s*-\s*(.+)$/);
  return m ? m[2] : String(accountName || '').trim();
}

// Same categorical veto as get-unmatched-sites.js: an agency-acronym raw
// name must never be paired with a retail-chain-named site, even as the
// "nearest known site" by pure distance -- a DMV/BMV/SOS/prison and a
// grocery-chain store are never the same physical site regardless of how
// close Google's guess happens to land to one. Kept in sync with the
// same lists used there; update both if the category lists change.
const AGENCY_PATTERNS = [/\bbmv\b/, /\bdmv\b/, /\bsos\b/, /\bsso\b/, /\btc\b/, /\bmv\b/, /\bstate prison\b/];
const RETAIL_CHAINS = [
  'kroger', 'meijer', 'publix', 'walmart', 'albertsons', 'safeway', 'raley',
  'cub foods', 'discount drug', 'harris teeter', 'food lion', 'giant eagle',
  'save-a-lot', 'weis', 'shoprite', 'winn-dixie', 'h-e-b', 'heb', 'fred meyer',
  "fry's", 'king soopers', 'ralphs', 'vons', 'pavilions', 'jewel-osco',
  'stop & shop', 'stop and shop', 'wegmans', "martin's super market",
];
function categorizeName(name) {
  const lower = (name || '').toLowerCase();
  for (const pat of AGENCY_PATTERNS) if (pat.test(lower)) return 'agency';
  for (const chain of RETAIL_CHAINS) if (lower.includes(chain)) return 'retail';
  return null;
}

// Haversine distance in miles between two lat/lng points.
function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method Not Allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const state = (body.state || '').trim().toUpperCase();
  const accountNameRaw = (body.accountNameRaw || '').trim();
  if (!state || !accountNameRaw) return json(400, { ok: false, error: 'state and accountNameRaw are required' });

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return json(500, { ok: false, error: 'GOOGLE_MAPS_API_KEY not configured' });

  const stateName = STATE_NAMES[state] || state;
  const nameOnly = stripStatePrefix(accountNameRaw);
  const query = `${nameOnly}, ${stateName}`;

  // 1. Look up the raw name via Google Places (real place data, not a guess).
  let place;
  try {
    const url =
      FIND_PLACE_URL +
      '?input=' + encodeURIComponent(query) +
      '&inputtype=textquery' +
      '&fields=formatted_address,geometry,name' +
      '&key=' + apiKey;
    const res = await fetch(url);
    if (!res.ok) return json(502, { ok: false, error: 'Places HTTP ' + res.status });
    const data = await res.json();
    if (data.status !== 'OK' || !data.candidates?.length) {
      return json(200, { ok: true, found: false, reason: data.status || 'ZERO_RESULTS', query });
    }
    place = data.candidates[0];
  } catch (e) {
    return json(502, { ok: false, error: 'Places lookup failed: ' + e.message });
  }

  const geoLat = place.geometry.location.lat;
  const geoLng = place.geometry.location.lng;

  // 2. Find the nearest EXISTING site already in Supabase for this state,
  // excluding any site whose category (agency vs retail-chain) conflicts
  // with the raw name's own category -- a categorical veto, not just a
  // distance penalty, same rule as get-unmatched-sites.js.
  const targetCategory = categorizeName(nameOnly);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: sitesRaw, error: sitesErr } = await supabase
    .from('sites')
    .select('id, site_code, name, address, lat, lng')
    .eq('state', state)
    .not('lat', 'is', null)
    .not('lng', 'is', null);
  if (sitesErr) return json(500, { ok: false, error: 'sites fetch failed: ' + sitesErr.message });

  const sites = (sitesRaw || []).filter((s) => {
    const siteCategory = categorizeName(s.name);
    if (!targetCategory || !siteCategory) return true;
    return targetCategory === siteCategory;
  });

  let nearest = null;
  let nearestDist = Infinity;
  for (const s of sites || []) {
    const d = distanceMiles(geoLat, geoLng, s.lat, s.lng);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = s;
    }
  }

  return json(200, {
    ok: true,
    found: true,
    query,
    geocoded: { address: place.formatted_address, name: place.name, lat: geoLat, lng: geoLng },
    nearestSite: nearest
      ? { site_id: nearest.id, site_code: nearest.site_code, name: nearest.name, address: nearest.address, distanceMi: Math.round(nearestDist * 100) / 100 }
      : null,
  });
};
