/**
 * netlify/functions/lib/town-legs.js  (v1.0, 2026-10-26)
 * SAVE AS: netlify/functions/lib/town-legs.js
 *
 * Town-level distance estimates for the mileage check. A technician who writes stops as bare town
 * names ("Brinkley", "Helena") on a route where no site has been set up for that town yet leaves the
 * check with nothing to compare. This asks Google for the driving miles between the two places
 * (town to town, town to a known site, or town to the technician's home address) and caches every
 * answer in town_leg_distances, so a repeated pair is never looked up twice.
 *
 * It is an estimate: a town center is a few miles from the actual office, so the caller judges these
 * legs with a wider band than a leg between two known sites.
 *
 * Needs GOOGLE_MAPS_API_KEY (the same key the distance matrix build uses). Without it, or on any
 * failure, it returns nothing and the legs stay unidentified exactly as before. Never throws.
 */

const MAX_NEW_LOOKUPS = 60;
const TIMEOUT_MS = 8000;
// A driving distance between two places in one state is never this long; anything over it means
// Google matched a name to the wrong place, so the answer is thrown away and never cached.
const MAX_PLAUSIBLE_MI = 300;

function clean(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9.,#\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// One end of a leg: { kind: 'town', text: 'Brinkley' } | { kind: 'site', lat, lng } | { kind: 'home', text: address }
function endKey(end, state) {
  if (end.kind === 'site') return end.lat.toFixed(4) + ',' + end.lng.toFixed(4);
  if (end.kind === 'home') return 'home:' + clean(end.text);
  return 'town:' + clean(end.text) + '|' + String(state || '').toLowerCase();
}

function endQuery(end, state) {
  if (end.kind === 'site') return end.lat + ',' + end.lng;
  if (end.kind === 'home') return end.text;
  return end.text + ', ' + state + ', USA';
}

async function googleMiles(origin, destination, apiKey) {
  const url = 'https://maps.googleapis.com/maps/api/distancematrix/json?units=imperial&origins=' + encodeURIComponent(origin) +
    '&destinations=' + encodeURIComponent(destination) + '&key=' + encodeURIComponent(apiKey);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    const el = j && j.rows && j.rows[0] && j.rows[0].elements && j.rows[0].elements[0];
    if (!el || el.status !== 'OK' || !el.distance || typeof el.distance.value !== 'number') return null;
    const mi = Math.round((el.distance.value / 1609.344) * 10) / 10;
    return mi > MAX_PLAUSIBLE_MI ? null : mi;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * items: [{ idx, from: end, to: end }]; state: two-letter state the towns are in.
 * Returns a Map idx -> driving miles for every item it could answer.
 */
async function estimateTownLegs(supabase, items, state) {
  const out = new Map();
  try {
    if (!items || !items.length || !state) return out;
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;

    const pairs = items.map((it) => {
      const ka = endKey(it.from, state), kb = endKey(it.to, state);
      return { it, a: ka < kb ? ka : kb, b: ka < kb ? kb : ka, flip: ka >= kb };
    });
    const keyOf = (p) => p.a + '\u0001' + p.b;

    // cache
    const cached = new Map();
    const allA = [...new Set(pairs.map((p) => p.a))];
    for (let i = 0; i < allA.length; i += 50) {
      const { data, error } = await supabase.from('town_leg_distances').select('a, b, distance_mi').in('a', allA.slice(i, i + 50));
      if (error) break; // table missing or unreadable: carry on without a cache
      for (const r of data || []) cached.set(r.a + '\u0001' + r.b, Number(r.distance_mi));
    }

    // lookups for what is not cached (each distinct pair once)
    const need = [];
    const seen = new Set();
    for (const p of pairs) {
      const k = keyOf(p);
      if (cached.has(k) || seen.has(k)) continue;
      seen.add(k);
      need.push(p);
    }
    if (apiKey) {
      const todo = need.slice(0, MAX_NEW_LOOKUPS);
      for (let i = 0; i < todo.length; i += 6) {
        const batch = todo.slice(i, i + 6);
        const miles = await Promise.all(batch.map((p) => googleMiles(endQuery(p.it.from, state), endQuery(p.it.to, state), apiKey)));
        const rows = [];
        batch.forEach((p, j) => {
          if (miles[j] == null) return;
          cached.set(keyOf(p), miles[j]);
          rows.push({ a: p.a, b: p.b, distance_mi: miles[j] });
        });
        if (rows.length) {
          const { error } = await supabase.from('town_leg_distances').upsert(rows, { onConflict: 'a,b', ignoreDuplicates: true });
          if (error) console.error('[town-legs] cache write failed (non-fatal):', error.message);
        }
      }
    }

    for (const p of pairs) {
      const v = cached.get(keyOf(p));
      if (v != null) out.set(p.it.idx, v);
    }
  } catch (e) {
    console.error('[town-legs] failed (non-fatal):', e && e.message);
  }
  return out;
}

module.exports = { estimateTownLegs, endKey };
