// get-journal-status.js
//
// Journal paper (counted in INCHES on the kiosk) status per site, for the restock tracker's
// Journal view. Added 2026-10-20 because North Carolina no longer issues registration decals,
// so NC restocks are expected to become journal-only and the forms-cycle view stops telling
// dispatch which sites are close to needing paper.
//
// Readings come from three places:
//   1. dispatch_list_history  - counts printed on Neumo's daily list (a site only appears when
//                               something on it is due, so readings are sparse and uneven)
//   2. assignments.restock_form_counts - the same list counts for lists dispatched since
//   3. restock_leftover_counts rolls.J - exact inches left on the old roll, typed by the
//                               technician on the portal Done prompt (the best source going
//                               forward; it also marks the day the roll was replaced)
//
// Model (deliberately simple, every assumption is returned so the page can show it):
//   - A listing whose consumables include journal paper means the roll was replaced right
//     after that list day, so the count resets to a full roll (assumed length, adjustable).
//   - Burn per day = median of (reading1 - reading2) / days over consecutive readings where
//     the first listing did NOT replace journal paper and the count went down.
//   - Estimated inches now = base - burn * days since the base date.
//   - overdue = estimate at or under the trigger (Neumo lists journal around 2,200 in NC);
//     soon = estimate falls to the trigger within 7 days; otherwise ok. No reading and no
//     replacement on record = unknown.
//
// GET ?state=NC[&capacity=7000][&trigger=2200]

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(obj),
  };
}

const IN_CHUNK = 100;
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const DAY_MS = 86400000;
function dayNum(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS);
}
function isoOf(n) { return new Date(n * DAY_MS).toISOString().slice(0, 10); }
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  const params = event.queryStringParameters || {};
  const state = String(params.state || 'NC').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) return json(400, { ok: false, error: 'state must be a 2-letter code' });
  const capacity = Math.min(Math.max(num(params.capacity) || 7000, 1000), 20000);
  const trigger = Math.min(Math.max(num(params.trigger) || 2200, 100), 10000);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: sites, error: sitesErr } = await supabase
    .from('sites').select('id, site_code, name, state').eq('active', true).eq('state', state);
  if (sitesErr) return json(500, { ok: false, error: 'sites fetch failed: ' + sitesErr.message });
  if (!sites || !sites.length) return json(200, { ok: true, state, capacity, trigger, locations: [] });

  const byId = {}, byCode = {};
  for (const s of sites) { byId[s.id] = s; byCode[s.site_code] = s; }
  const ids = sites.map((s) => s.id);
  const codes = sites.map((s) => s.site_code);

  const [histRes, asgRes, leftRes] = await Promise.all([
    Promise.all(chunk(codes, IN_CHUNK).map((c) => supabase
      .from('dispatch_list_history').select('code, list_day, journal, consumables').in('code', c))),
    Promise.all(chunk(ids, IN_CHUNK).map((c) => supabase
      .from('assignments').select('site_id, dispatch_date, status, restock_form_counts').in('site_id', c)
      .not('restock_form_counts', 'is', null))),
    Promise.all(chunk(ids, IN_CHUNK).map((c) => supabase
      .from('restock_leftover_counts').select('site_id, dispatch_date, rolls').in('site_id', c))),
  ]);
  const firstErr = [...histRes, ...asgRes, ...leftRes].find((r) => r.error);
  if (firstErr) return json(500, { ok: false, error: 'readings fetch failed: ' + firstErr.error.message });

  // events[siteId] = [{ day, inches (nullable), replaced (bool), source }]
  const events = {};
  const push = (siteId, ev) => { if (siteId && ev.day != null) (events[siteId] = events[siteId] || []).push(ev); };

  for (const r of histRes.flatMap((x) => x.data || [])) {
    const s = byCode[r.code]; if (!s) continue;
    push(s.id, {
      day: dayNum(r.list_day), inches: num(r.journal),
      replaced: /journal/i.test(r.consumables || ''), source: 'dispatch list',
    });
  }
  for (const r of asgRes.flatMap((x) => x.data || [])) {
    if (r.status === 'removed') continue;
    const c = r.restock_form_counts || {};
    const replaced = /journal/i.test(String(c.consumables || '')) && r.status === 'completed';
    const inches = num(c.Journal);
    if (inches === null && !replaced) continue;
    push(r.site_id, { day: dayNum(r.dispatch_date), inches, replaced, source: 'dispatch board' });
  }
  for (const r of leftRes.flatMap((x) => x.data || [])) {
    const j = num(r.rolls && r.rolls.J);
    if (j === null) continue;
    // Old roll's remaining inches at the replacement; the new roll starts full the same day.
    push(r.site_id, { day: dayNum(r.dispatch_date), inches: j, replaced: true, source: 'technician', oldRoll: true });
  }

  const today = Math.floor(Date.now() / DAY_MS);

  const rows = sites.map((s) => {
    const evs = (events[s.id] || []).filter((e) => e.day != null).sort((a, b) => a.day - b.day);
    const rates = [];
    for (let i = 0; i < evs.length - 1; i++) {
      const a = evs[i], b = evs[i + 1];
      if (a.oldRoll || a.replaced || a.inches === null || b.inches === null || b.oldRoll) continue;
      const days = b.day - a.day;
      if (days >= 2 && days <= 120 && b.inches < a.inches) rates.push((a.inches - b.inches) / days);
    }
    return { s, evs, rates };
  });

  // State-wide fallback burn for sites with no pair of their own (flagged as such).
  const allRates = rows.flatMap((r) => r.rates);
  const stateRate = median(allRates);

  const locations = rows.map(({ s, evs, rates }) => {
    const readings = evs.filter((e) => e.inches !== null);
    const lastReading = readings.length ? readings[readings.length - 1] : null;
    const lastReplaced = evs.filter((e) => e.replaced).slice(-1)[0] || null;
    let burn = rates.length ? median(rates) : null;
    let burnSource = rates.length ? 'site' : null;
    if (burn === null && stateRate !== null) { burn = stateRate; burnSource = 'state'; }

    // Base for the estimate: the latest thing we know, a fresh roll or a reading.
    let base = null, baseDay = null, baseKind = null;
    const lastEv = evs.length ? evs[evs.length - 1] : null;
    if (lastEv && lastEv.replaced) { base = capacity; baseDay = lastEv.day; baseKind = 'new roll'; }
    else if (lastReading) { base = lastReading.inches; baseDay = lastReading.day; baseKind = 'reading'; }

    let est = null, status = 'unknown', daysOld = null;
    if (base !== null) {
      daysOld = Math.max(0, today - baseDay);
      est = burn !== null ? Math.max(0, Math.round(base - burn * daysOld)) : (baseKind === 'reading' ? base : null);
      if (est !== null) {
        if (est <= trigger) status = 'overdue';
        else if (burn !== null && est - burn * 7 <= trigger) status = 'soon';
        else status = 'ok';
      }
    }
    const confidence = base === null ? 'none'
      : (daysOld <= 14 && burnSource === 'site') ? 'high'
      : (daysOld <= 45 && burn !== null) ? 'medium' : 'low';

    return {
      site_code: s.site_code, name: s.name, state: s.state,
      status, estInches: est, confidence,
      lastReading: lastReading ? { date: isoOf(lastReading.day), inches: lastReading.inches, source: lastReading.source, oldRoll: !!lastReading.oldRoll } : null,
      lastReplaced: lastReplaced ? { date: isoOf(lastReplaced.day), source: lastReplaced.source } : null,
      burnPerDay: burn !== null ? Math.round(burn) : null, burnSource, burnPairs: rates.length,
      readings: readings.length,
    };
  });

  return json(200, {
    ok: true, state, generatedAt: new Date().toISOString(),
    capacity, trigger, stateBurnPerDay: stateRate !== null ? Math.round(stateRate) : null,
    assumptions: 'Assumes a full roll of ' + capacity + ' in and a low-paper trigger of about ' + trigger + ' in (both adjustable above).',
    locations,
  });
};
