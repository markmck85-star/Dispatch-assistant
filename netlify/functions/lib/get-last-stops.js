// get-last-stops.js
// Dispatcher view: each technician's most recent logged stop (from the
// mileage log's Add stop taps), with the time it was logged.
//
// Uses only what the tech chose to log: the stop and the time. No GPS,
// no location between stops. Only stops from the last 36 hours are
// considered, so nothing old is ever shown as "current".
//
// POST { username, pin, states?: ["GA", ...] }
// Requires an active dispatcher or admin login (techs are refused).
// -> { ok, generated_at, techs: [ { technician_id, name, state,
//      arrived_at|null, kind, stop, site_code, site_name, lat, lng,
//      estimated,
//      last_kind ('arrived'|'closed'|'enroute'|'home'), last_at, last_name, last_site_code,
//      lat, lng, home_lat, home_lng, tz } ] }
//
// Map layer fields: last_* is whichever is newest of the tech's logged stop or
// their newest closed ticket (site_visits.ended_at). A closed ticket is not an
// exact departure time (closings lag), so the page labels it differently.
// A logged stop at home reports last_kind 'home' with the tech's home point.
// The page decides how to draw "home" (see comments there); this only reports.

const { createClient } = require('@supabase/supabase-js');
const auth = require('./lib/auth');

const WINDOW_HOURS = 36;

const STATE_TZ = {
  CT:'America/New_York',DE:'America/New_York',FL:'America/New_York',GA:'America/New_York',IN:'America/Indiana/Indianapolis',
  KY:'America/New_York',ME:'America/New_York',MD:'America/New_York',MA:'America/New_York',MI:'America/Detroit',
  NH:'America/New_York',NJ:'America/New_York',NY:'America/New_York',NC:'America/New_York',OH:'America/New_York',
  PA:'America/New_York',RI:'America/New_York',SC:'America/New_York',VT:'America/New_York',VA:'America/New_York',
  WV:'America/New_York',DC:'America/New_York',
  AL:'America/Chicago',AR:'America/Chicago',IL:'America/Chicago',IA:'America/Chicago',KS:'America/Chicago',
  LA:'America/Chicago',MN:'America/Chicago',MS:'America/Chicago',MO:'America/Chicago',NE:'America/Chicago',
  ND:'America/Chicago',OK:'America/Chicago',SD:'America/Chicago',TN:'America/Chicago',TX:'America/Chicago',WI:'America/Chicago',
  AZ:'America/Phoenix',CO:'America/Denver',ID:'America/Boise',MT:'America/Denver',NM:'America/Denver',UT:'America/Denver',WY:'America/Denver',
  CA:'America/Los_Angeles',NV:'America/Los_Angeles',OR:'America/Los_Angeles',WA:'America/Los_Angeles',
  AK:'America/Anchorage',HI:'Pacific/Honolulu'
};

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const who = await auth.authenticateRequest(supabase, event, body);
    if (who.error) return json(who.status || 401, { ok: false, error: who.error });
    const disp = who.user;
    if (disp.role === 'tech') return json(403, { ok: false, error: 'This login cannot use the dispatch view.' });

    const isAdmin = disp.role === 'admin';
    let allowed = isAdmin ? null : (disp.states || []);
    if (Array.isArray(body.states) && body.states.length) {
      const want = body.states.map((x) => String(x).toUpperCase());
      allowed = allowed ? allowed.filter((x) => want.includes(x)) : want;
    }

    const now = Date.now();
    const since = now - WINDOW_HOURS * 3600 * 1000;

    const { data: techs, error: tErr } = await supabase
      .from('technicians')
      .select('id, name, home_state, additional_states, active, lat, lng')
      .eq('active', true);
    if (tErr) return json(500, { ok: false, error: tErr.message });

    const visible = (techs || []).filter((t) => {
      if (!t.name || /^unassigned/i.test(t.name)) return false;
      if (!allowed) return true;
      const st = [t.home_state].concat(t.additional_states || []).filter(Boolean);
      return st.some((x) => allowed.includes(x));
    });

    const { data: logs, error: lErr } = await supabase
      .from('technician_mileage_logs')
      .select('technician_id, legs, period_start, period_end')
      .gte('period_end', isoDate(now - 3 * 86400000))
      .lte('period_start', isoDate(now + 86400000));
    if (lErr) return json(500, { ok: false, error: lErr.message });

    // latest recent stop per technician
    const latest = {};
    for (const log of logs || []) {
      for (const leg of Array.isArray(log.legs) ? log.legs : []) {
        if (!leg || !leg.arrived_at) continue;
        const t = Date.parse(leg.arrived_at);
        if (!Number.isFinite(t) || t < since || t > now + 5 * 60000) continue;
        const cur = latest[log.technician_id];
        if (!cur || t > cur.t) latest[log.technician_id] = { t, leg };
      }
    }

    const siteIds = [...new Set(Object.values(latest).map((x) => x.leg.to_site_id).filter(Boolean))];
    const sites = {};
    for (let i = 0; i < siteIds.length; i += 150) {
      const { data: rows, error: sErr } = await supabase
        .from('sites')
        .select('id, site_code, name, state, lat, lng')
        .in('id', siteIds.slice(i, i + 150));
      if (sErr) return json(500, { ok: false, error: sErr.message });
      for (const r of rows || []) sites[r.id] = r;
    }

    // newest closed ticket per technician inside the window
    const closedBy = {};
    const visibleIds = visible.map((t) => t.id);
    for (let i = 0; i < visibleIds.length; i += 100) {
      const { data: vrows, error: vErr } = await supabase
        .from('site_visits')
        .select('technician_id, site_id, ended_at')
        .in('technician_id', visibleIds.slice(i, i + 100))
        .not('site_id', 'is', null)
        .not('ended_at', 'is', null)
        .gte('ended_at', new Date(since).toISOString())
        .order('ended_at', { ascending: false })
        .limit(1000);
      if (vErr) return json(500, { ok: false, error: vErr.message });
      for (const v of vrows || []) {
        const t = Date.parse(v.ended_at);
        if (!Number.isFinite(t) || t > now + 5 * 60000) continue;
        if (!closedBy[v.technician_id] || t > closedBy[v.technician_id].t) closedBy[v.technician_id] = { t, site_id: v.site_id };
      }
    }
    const closedSiteIds = [...new Set(Object.values(closedBy).map((x) => x.site_id))].filter((id) => !sites[id]);
    for (let i = 0; i < closedSiteIds.length; i += 150) {
      const { data: rows, error: sErr } = await supabase
        .from('sites')
        .select('id, site_code, name, state, lat, lng')
        .in('id', closedSiteIds.slice(i, i + 150));
      if (sErr) return json(500, { ok: false, error: sErr.message });
      for (const r of rows || []) sites[r.id] = r;
    }

    // appointment statuses read from the Salesforce Gantt (only present while the status pass is on)
    const statusBy = {};
    try {
      const { data: srows } = await supabase
        .from('sa_live_status')
        .select('technician_id, status, status_category, account_name, lat, lng, actual_start, actual_end, sf_last_modified, sched_start')
        .in('technician_id', visibleIds.slice(0, 200))
        .gte('seen_at', new Date(since).toISOString());
      for (const r of srows || []) {
        const cat = String(r.status_category || r.status || '').toLowerCase();
        const stName = String(r.status || '').toLowerCase();
        let kind = null, at = null;
        if (/in ?progress/.test(cat) || /in ?progress/.test(stName)) { kind = 'arrived'; at = r.actual_start || r.sf_last_modified; }
        else if (/complet/.test(cat) || /complet/.test(stName)) { kind = 'closed'; at = r.actual_end || r.sf_last_modified; }
        else if (/dispatch|travel|route|way/.test(cat + ' ' + stName)) { kind = 'enroute'; at = r.sf_last_modified; }
        if (!kind || !at || r.lat == null || r.lng == null) continue;
        const t = Date.parse(at);
        if (!Number.isFinite(t) || t < since || t > now + 5 * 60000) continue;
        if (kind === 'enroute' && now - t > 3 * 3600 * 1000) continue;   // an old "on the way" is not news
        const cur = statusBy[r.technician_id];
        // newest wins; on a tie an in-progress record beats a completed one
        if (!cur || t > cur.t || (t === cur.t && kind === 'arrived')) {
          statusBy[r.technician_id] = { t, kind, name: r.account_name, lat: r.lat, lng: r.lng, status: r.status };
        }
      }
    } catch (e) { /* status table not there or empty: the map just falls back to logged stops and closings */ }

    const out = visible.map((t) => {
      const base = {
        technician_id: t.id, name: t.name, state: t.home_state, arrived_at: null,
        tz: STATE_TZ[String(t.home_state || '').toUpperCase()] || 'America/New_York',
        home_lat: t.lat, home_lng: t.lng
      };
      const hit = latest[t.id];
      const closed = closedBy[t.id];
      if (hit) {
        const leg = hit.leg;
        const site = leg.to_site_id ? sites[leg.to_site_id] : null;
        Object.assign(base, {
          arrived_at: new Date(hit.t).toISOString(),
          kind: leg.to_kind || null,
          stop: leg.to_print || leg.to_picker || '',
          site_code: site ? site.site_code : null,
          site_name: site ? site.name : null,
          lat: site ? site.lat : null,
          lng: site ? site.lng : null,
          estimated: !!leg.estimated
        });
      }
      // a Salesforce appointment status newer than everything else wins (real start / finish times)
      const st = statusBy[t.id];
      const newestOther = Math.max(hit ? hit.t : 0, closed ? closed.t : 0);
      if (st && st.t >= newestOther) {
        return Object.assign(base, {
          last_kind: st.kind, last_at: new Date(st.t).toISOString(),
          last_name: st.name, last_site_code: null, last_status: st.status,
          lat: st.lat, lng: st.lng
        });
      }
      // newest of the logged stop and the newest closed ticket
      if (closed && (!hit || closed.t > hit.t)) {
        const cs = sites[closed.site_id];
        if (cs && cs.lat != null && cs.lng != null) {
          return Object.assign(base, {
            last_kind: 'closed', last_at: new Date(closed.t).toISOString(),
            last_name: cs.name || cs.site_code, last_site_code: cs.site_code,
            lat: cs.lat, lng: cs.lng
          });
        }
      }
      if (hit) {
        const isHome = base.kind === 'home';
        return Object.assign(base, {
          last_kind: isHome ? 'home' : 'arrived', last_at: base.arrived_at,
          last_name: isHome ? 'Home' : (base.site_name || base.stop),
          last_site_code: base.site_code,
          lat: isHome ? t.lat : base.lat, lng: isHome ? t.lng : base.lng
        });
      }
      return base;
    });

    return json(200, { ok: true, generated_at: new Date(now).toISOString(), techs: out });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
