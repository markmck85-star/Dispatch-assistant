/**
 * get-traffic.js — v1 — 2026-10-06
 *
 * Netlify Function — Georgia traffic from the 511GA (Georgia DOT) developer
 * API, matched to the stops and tickets a Georgia dispatcher is working.
 *
 * GET /.netlify/functions/get-traffic?state=GA[&radius=10][&refresh=1]
 *
 * WHAT IT DOES
 *  1. Keeps ONE cached copy of the statewide 511GA event list (Netlify Blobs,
 *     key traffic/ga-events). A request reuses the copy if it is under
 *     FRESH_MS old; otherwise it refreshes from 511GA first. So the feed is
 *     called at most about once every few minutes no matter how many people
 *     have the page open, and never more than once a minute even when a
 *     refresh fails. If 511GA is down, the last good copy is served and
 *     flagged stale instead of breaking the page.
 *  2. Finds the sites that matter right now: today's planned/notified restock
 *     stops, plus open trouble tickets received in the last few days, for the
 *     requested territory (GA = Georgia + NC + SC, same umbrella as the rest of
 *     the app; 511GA only reports Georgia roads, so NC/SC sites simply have
 *     nothing nearby).
 *  3. For each of those sites, lists active incidents, closures, special
 *     events and full road closures within the radius (default 10 miles,
 *     measured to the nearest point of the event's route line, not just its
 *     starting point).
 *
 * Routine roadwork is counted but not listed against sites unless it is a
 * full closure with no recurring schedule (most roadwork is overnight or
 * partial-lane and would only add noise).
 *
 * SECRETS: the 511GA key is read from the GDOT_511_API_KEY environment
 * variable. It is never returned to the browser and is scrubbed from any
 * error text.
 *
 * Read-only: nothing here writes to Supabase.
 */
const { createClient } = require('@supabase/supabase-js');

const FEED_URL = 'https://511ga.org/api/v2/get/event';
const CACHE_KEY = 'traffic/ga-events';
const MI_FEED_URL = 'https://mdotridedata.state.mi.us/api/v1/organization/michigan_department_of_transportation/dataset/incidents/query';
const MI_CACHE_KEY = 'traffic/mi-events';
const MI_DIR = { 1: 'NB', 2: 'SB', 3: 'both', 4: 'WB', 5: 'EB' };
const FRESH_MS = 3 * 60 * 1000;          // reuse the stored copy this long
const MIN_RETRY_MS = 60 * 1000;          // never call 511GA more than once a minute
const STALE_AFTER_MS = 10 * 60 * 1000;   // older than this = tell the viewer it is stale
const FEED_TIMEOUT_MS = 8000;
const REGION_STATES = { GA: ['GA', 'NC', 'SC'], MI: ['MI'] };
const TIMEZONE = 'America/New_York';
const DEFAULT_RADIUS_MI = 10;
const MAX_RADIUS_MI = 25;
const TROUBLE_WINDOW_DAYS = 4;           // older open trouble tickets are assumed closed in reality
const MAX_SITES = 40;
const MAX_EVENTS_PER_SITE = 5;
const MAX_STATEWIDE = 30;
const MI_PER_DEG_LAT = 69.0;

const memCache = { GA: null, MI: null }; // fallback if Blobs is unavailable (survives warm invocations only)

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify(obj),
  };
}

// ---------------------------------------------------------------- feed
function num(v) {
  const n = Number(v);
  return (v === null || v === undefined || v === '' || !Number.isFinite(n)) ? null : n;
}
function secToIso(s) {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}
function normalizeEvent(e) {
  return {
    id: e.ID,
    roadway: e.RoadwayName || '',
    direction: e.DirectionOfTravel || '',
    description: e.Description || '',
    eventType: e.EventType || '',
    subtype: e.Subtype || '',
    severity: e.Severity == null ? '' : String(e.Severity),
    isFullClosure: e.IsFullClosure === true || String(e.IsFullClosure).toLowerCase() === 'true',
    lanes: e.LanesAffected || '',
    lat: num(e.Latitude), lng: num(e.Longitude),
    lat2: num(e.LatitudeSecondary), lng2: num(e.LongitudeSecondary),
    polyline: e.EncodedPolyline || '',
    start: secToIso(e.StartDate),
    end: secToIso(e.PlannedEndDate),
    updated: secToIso(e.LastUpdated || e.Reported),
    recurrence: String(e.Recurrence || '').trim(),
  };
}

function scrub(message, key) {
  let m = String(message || 'unknown error');
  if (key) m = m.split(key).join('***');
  return m;
}


function field(row, name) {
  if (row[name] != null) return row[name];
  const dashed = name.replace(/_/g, '-');
  return row[dashed];
}
function miDirection(row) {
  const n = Number(field(row, 'dir_of_travel'));
  if (MI_DIR[n]) return MI_DIR[n];
  const loc = String(field(row, 'location_desc') || '');
  const m = loc.match(/^(NB|SB|EB|WB)\b/i);
  return m ? m[1].toUpperCase() : '';
}
function miClosed(text) {
  return /\b(closed|closure|all lanes)\b/i.test(text);
}
function normalizeMichigan(row) {
  const end = String(field(row, 'enddatetime') || '').trim();
  if (end) return null;
  const desc = String(field(row, 'description') || '').trim();
  const loc = String(field(row, 'location_desc') || '').trim();
  const text = desc || loc;
  const crash = /\b(crash|accident|incident|disabled)\b/i.test(text);
  const full = miClosed(text) || Number(field(row, 'bothdir')) === 1;
  const start = String(field(row, 'startdatetime') || '').trim();
  const updated = String(field(row, 'actdatetime') || start).trim();
  return {
    id: field(row, 'closure_id') || field(row, 'job_id'),
    roadway: String(field(row, 'roadway') || ''),
    direction: miDirection(row),
    description: text,
    eventType: crash ? 'accidentsAndIncidents' : 'closures',
    subtype: crash ? 'confirmed' : '',
    severity: '',
    isFullClosure: full,
    lanes: full ? 'All lanes closed' : '',
    lat: num(field(row, 'latitude')),
    lng: num(field(row, 'longitude')),
    lat2: null,
    lng2: null,
    polyline: '',
    start: start ? start.replace(' ', 'T') + 'Z' : null,
    end: null,
    updated: updated ? updated.replace(' ', 'T') + 'Z' : null,
    recurrence: '',
  };
}
function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.rows)) return data.rows;
  return null;
}
async function fetchMichigan(key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  try {
    const url = MI_FEED_URL + '?limit=500&_format=json';
    const res = await fetch(url, {
      headers: { api_key: key, Accept: 'application/json', 'User-Agent': 'MCR Dispatch (mckelvey@mcrtechservice.com)' },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) throw new Error('MDOT RIDE rejected the key (HTTP ' + res.status + ')');
    if (!res.ok) throw new Error('MDOT RIDE returned HTTP ' + res.status);
    const data = await res.json();
    const rows = rowsOf(data);
    if (!rows) throw new Error('MDOT RIDE returned an unexpected response');
    return rows.map(normalizeMichigan).filter((e) => e && e.id != null && e.lat != null && e.lng != null);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFeed(key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(`${FEED_URL}?key=${encodeURIComponent(key)}&format=json`, {
      headers: { 'User-Agent': 'MCR Dispatch (mckelvey@mcrtechservice.com)', Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (res.status === 429) throw new Error('511GA is rate limiting requests (HTTP 429)');
    if (!res.ok) throw new Error('511GA returned HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('511GA returned an unexpected response');
    return data.map(normalizeEvent)
      .filter((e) => e.id != null && ((e.lat != null && e.lng != null) || e.polyline));
  } finally {
    clearTimeout(timer);
  }
}

async function openStore(event) {
  try {
    const blobs = require('@netlify/blobs');
    blobs.connectLambda(event);
    return blobs.getStore('dispatch');
  } catch (e) {
    return null;
  }
}

// Returns { events, fetchedAt, error }. Never throws.
async function getEvents(event, forceRefresh, which) {
  const michigan = which === 'MI';
  const cacheKey = michigan ? MI_CACHE_KEY : CACHE_KEY;
  const envName = michigan ? 'MDOT_RIDE_API_KEY' : 'GDOT_511_API_KEY';
  const down = michigan ? 'MDOT RIDE' : '511GA';
  const store = await openStore(event);
  let cache = null;
  if (store) {
    try { cache = await store.get(cacheKey, { type: 'json' }); } catch (e) { cache = null; }
  }
  if (!cache) cache = memCache[michigan ? 'MI' : 'GA'];

  const now = Date.now();
  const age = cache && cache.fetchedAt ? now - Date.parse(cache.fetchedAt) : Infinity;
  const sinceAttempt = cache && cache.lastAttemptAt ? now - Date.parse(cache.lastAttemptAt) : Infinity;
  const needRefresh = (age > FRESH_MS || forceRefresh) && sinceAttempt > MIN_RETRY_MS;

  let error = null;
  if (needRefresh) {
    const key = process.env[envName];
    const attemptIso = new Date().toISOString();
    if (!key) {
      error = 'The ' + down + ' key (' + envName + ') is not set in Netlify.';
    } else {
      try {
        const events = michigan ? await fetchMichigan(key) : await fetchFeed(key);
        cache = { fetchedAt: attemptIso, lastAttemptAt: attemptIso, lastError: null, events };
      } catch (e) {
        error = e && e.name === 'AbortError' ? down + ' did not respond in time.' : scrub(e && e.message, key);
        cache = Object.assign({ events: [], fetchedAt: null }, cache || {}, { lastAttemptAt: attemptIso, lastError: error });
      }
      memCache[michigan ? 'MI' : 'GA'] = cache;
      if (store) { try { await store.setJSON(cacheKey, cache); } catch (e) { /* non-fatal */ } }
    }
  } else if (cache && cache.lastError && age > FRESH_MS) {
    error = cache.lastError; // a recent attempt failed; still inside the retry cooldown
  }

  return {
    events: (cache && cache.events) || [],
    fetchedAt: (cache && cache.fetchedAt) || null,
    error,
  };
}

// ---------------------------------------------------------------- geometry
function decodePolyline(str) {
  const pts = [];
  let index = 0, lat = 0, lng = 0;
  try {
    while (index < str.length) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && index <= str.length);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && index <= str.length);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      pts.push([lat / 1e5, lng / 1e5]);
    }
  } catch (e) { return []; }
  return pts;
}

function geometryFor(e) {
  let pts = e.polyline ? decodePolyline(e.polyline) : [];
  pts = pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
  if (pts.length < 2) {
    pts = [];
    if (e.lat != null && e.lng != null) pts.push([e.lat, e.lng]);
    if (e.lat2 != null && e.lng2 != null) pts.push([e.lat2, e.lng2]);
  }
  if (!pts.length) return null;
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const p of pts) {
    if (p[0] < minLat) minLat = p[0];
    if (p[0] > maxLat) maxLat = p[0];
    if (p[1] < minLng) minLng = p[1];
    if (p[1] > maxLng) maxLng = p[1];
  }
  return { pts, minLat, maxLat, minLng, maxLng };
}

function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Miles from (lat0,lng0) to the nearest point of a polyline/point set.
function distMiles(lat0, lng0, pts) {
  const kLng = MI_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180);
  const xy = pts.map((p) => [(p[1] - lng0) * kLng, (p[0] - lat0) * MI_PER_DEG_LAT]);
  if (xy.length === 1) return Math.hypot(xy[0][0], xy[0][1]);
  let best = Infinity;
  for (let i = 1; i < xy.length; i++) {
    best = Math.min(best, pointSegDist(0, 0, xy[i - 1][0], xy[i - 1][1], xy[i][0], xy[i][1]));
  }
  return best;
}

// ---------------------------------------------------------------- event rules
function isActive(e, nowMs) {
  const start = e.start ? Date.parse(e.start) : null;
  const end = e.end ? Date.parse(e.end) : null;
  if (start != null && start > nowMs + 15 * 60 * 1000) return false;   // not started yet
  if (end != null && end < nowMs) return false;                          // already over
  return true;
}
// What is worth showing a dispatcher: incidents, closures, special events, and
// full closures that are not on a recurring (e.g. overnight) schedule.
function isAttention(e) {
  if (e.eventType !== 'roadwork') return true;
  return e.isFullClosure && !e.recurrence;
}
function typeRank(e) {
  if (e.eventType === 'accidentsAndIncidents') return 0;
  if (e.eventType === 'closures') return 1;
  if (e.eventType === 'specialEvents') return 3;
  return 2; // full-closure roadwork
}
function levelFor(e, d) {
  if (e.isFullClosure && d <= 5) return 'high';
  if ((e.eventType === 'accidentsAndIncidents' || e.eventType === 'closures') && d <= 3) return 'high';
  return 'info';
}
function brief(e) {
  return {
    id: e.id,
    roadway: e.roadway,
    direction: e.direction,
    eventType: e.eventType,
    subtype: e.subtype,
    severity: e.severity,
    isFullClosure: e.isFullClosure,
    lanes: e.lanes,
    description: String(e.description || '').slice(0, 220),
    updated: e.updated,
    end: e.end,
  };
}

// ---------------------------------------------------------------- data helpers
async function fetchAll(build) {
  const out = [];
  const page = 1000;
  for (let from = 0; from < 30000; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}

async function loadStops(supabase, regionStates, todayStr, now) {
  const sites = await fetchAll((from, to) => supabase
    .from('sites')
    .select('id, site_code, name, state, lat, lng')
    .in('state', regionStates).eq('active', true)
    .order('id').range(from, to));
  const siteById = {};
  sites.forEach((s) => { siteById[s.id] = s; });

  // today's restock stops that are still ahead of the technician
  const assignments = await fetchAll((from, to) => supabase
    .from('assignments')
    .select('id, site_id, technician_id, status, dispatch_date')
    .eq('dispatch_date', todayStr).in('status', ['planned', 'notified'])
    .order('id').range(from, to));
  const mine = assignments.filter((a) => siteById[a.site_id]);
  const techIds = [...new Set(mine.map((a) => a.technician_id).filter(Boolean))];
  const techName = {};
  if (techIds.length) {
    const { data } = await supabase.from('technicians').select('id, name').in('id', techIds);
    (data || []).forEach((t) => { techName[t.id] = t.name; });
  }

  // open trouble tickets from the last few days (older ones are assumed closed in reality)
  const cutoff = new Date(now.getTime() - TROUBLE_WINDOW_DAYS * 86400000).toISOString();
  const tickets = await fetchAll((from, to) => supabase
    .from('tickets')
    .select('id, wo_number, site_id, ticket_kind, status, manually_resolved_at, received_at')
    .eq('status', 'open').eq('ticket_kind', 'trouble').gte('received_at', cutoff)
    .order('id').range(from, to));
  const troubles = tickets.filter((t) => t.site_id && siteById[t.site_id] && !t.manually_resolved_at);

  // one entry per site, with every reason it is on the list
  const bySite = {};
  const entry = (siteId) => {
    if (!bySite[siteId]) {
      const s = siteById[siteId];
      bySite[siteId] = { siteId, siteCode: s.site_code, siteName: s.name, lat: s.lat, lng: s.lng, reasons: [] };
    }
    return bySite[siteId];
  };
  mine.forEach((a) => entry(a.site_id).reasons.push({ kind: 'restock', technician: techName[a.technician_id] || null }));
  troubles.forEach((t) => entry(t.site_id).reasons.push({ kind: 'trouble', wo: t.wo_number || null }));
  return Object.values(bySite);
}

// ---------------------------------------------------------------- handler
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const params = event.queryStringParameters || {};
  const state = String(params.state || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) return json(400, { error: 'state query param (2-letter code) is required' });
  if (!REGION_STATES[state]) return json(200, { ok: true, supported: false, state });

  let radius = parseFloat(params.radius);
  if (!(radius > 0)) radius = DEFAULT_RADIUS_MI;
  radius = Math.min(radius, MAX_RADIUS_MI);

  try {
    const now = new Date();
    const nowMs = now.getTime();
    const feed = await getEvents(event, params.refresh === '1', state);
    if (!feed.events.length && feed.error) return json(502, { ok: false, error: feed.error });

    const active = feed.events.filter((e) => isActive(e, nowMs));
    const attention = active.filter(isAttention).map((e) => ({ e, g: geometryFor(e) })).filter((x) => x.g);

    const totals = {
      feedEvents: feed.events.length,
      active: active.length,
      incidents: active.filter((e) => e.eventType === 'accidentsAndIncidents').length,
      closures: active.filter((e) => e.eventType === 'closures').length,
      specialEvents: active.filter((e) => e.eventType === 'specialEvents').length,
      fullClosures: active.filter((e) => e.isFullClosure).length,
      roadwork: active.filter((e) => e.eventType === 'roadwork').length,
    };

    const statewide = attention.map((x) => x.e)
      .sort((a, b) => (Number(b.isFullClosure) - Number(a.isFullClosure))
        || (typeRank(a) - typeRank(b))
        || String(b.updated || '').localeCompare(String(a.updated || '')))
      .slice(0, MAX_STATEWIDE).map(brief);

    // ---- match to the stops and tickets in play today
    let nearSites = [];
    let sitesChecked = 0;
    let sitesWithoutLocation = 0;
    let nearSitesError = null;
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const stops = await loadStops(supabase, REGION_STATES[state], todayStr, now);
        for (const site of stops) {
          if (site.lat == null || site.lng == null) { sitesWithoutLocation++; continue; }
          sitesChecked++;
          const padLat = radius / MI_PER_DEG_LAT;
          const padLng = radius / (MI_PER_DEG_LAT * Math.cos(site.lat * Math.PI / 180));
          const hits = [];
          for (const x of attention) {
            const g = x.g;
            if (site.lat < g.minLat - padLat || site.lat > g.maxLat + padLat
              || site.lng < g.minLng - padLng || site.lng > g.maxLng + padLng) continue;
            const d = distMiles(site.lat, site.lng, g.pts);
            if (d > radius) continue;
            hits.push({ e: x.e, d, level: levelFor(x.e, d) });
          }
          if (!hits.length) continue;
          hits.sort((a, b) => ((a.level === 'high' ? 0 : 1) - (b.level === 'high' ? 0 : 1)) || (a.d - b.d));
          nearSites.push({
            siteCode: site.siteCode,
            siteName: site.siteName,
            reasons: site.reasons,
            level: hits[0].level,
            nearestMiles: Math.round(hits[0].d * 10) / 10,
            totalNearby: hits.length,
            events: hits.slice(0, MAX_EVENTS_PER_SITE).map((h) => Object.assign(brief(h.e), {
              distanceMiles: Math.round(h.d * 10) / 10, level: h.level,
            })),
          });
        }
        nearSites.sort((a, b) => ((a.level === 'high' ? 0 : 1) - (b.level === 'high' ? 0 : 1)) || (a.nearestMiles - b.nearestMiles));
        nearSites = nearSites.slice(0, MAX_SITES);
      } catch (e) {
        nearSites = [];
        nearSitesError = 'Could not load today\'s stops: ' + e.message;
      }
    } else {
      nearSitesError = 'Supabase env vars not configured';
    }

    const stale = !feed.fetchedAt || (nowMs - Date.parse(feed.fetchedAt)) > STALE_AFTER_MS;
    return json(200, {
      ok: true,
      supported: true,
      state,
      source: state === 'MI' ? 'MDOT RIDE' : '511GA',
      date: todayStr,
      generatedAt: now.toISOString(),
      fetchedAt: feed.fetchedAt,
      stale,
      feedError: feed.error || null,
      radiusMiles: radius,
      totals,
      statewide,
      nearSites,
      sitesChecked,
      sitesWithoutLocation,
      nearSitesError,
    });
  } catch (e) {
    return json(500, { ok: false, error: scrub(e.message, process.env.GDOT_511_API_KEY) });
  }
};
