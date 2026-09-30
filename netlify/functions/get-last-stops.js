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
//      estimated } ] }

const { createClient } = require('@supabase/supabase-js');

const WINDOW_HOURS = 36;

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

  const username = String(body.username || '').trim().toLowerCase();
  const pin = String(body.pin || '').trim();
  if (!username || !pin) return json(400, { ok: false, error: 'Username and PIN are required.' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: disp, error: dErr } = await supabase
      .from('dispatchers')
      .select('username, role, states, active')
      .ilike('username', username)
      .eq('pin', pin)
      .eq('active', true)
      .maybeSingle();
    if (dErr) return json(500, { ok: false, error: 'Login check failed: ' + dErr.message });
    if (!disp) return json(401, { ok: false, error: 'Invalid username or PIN.' });
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
      .select('id, name, home_state, additional_states, active')
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

    const out = visible.map((t) => {
      const base = { technician_id: t.id, name: t.name, state: t.home_state, arrived_at: null };
      const hit = latest[t.id];
      if (!hit) return base;
      const leg = hit.leg;
      const site = leg.to_site_id ? sites[leg.to_site_id] : null;
      return Object.assign(base, {
        arrived_at: new Date(hit.t).toISOString(),
        kind: leg.to_kind || null,
        stop: leg.to_print || leg.to_picker || '',
        site_code: site ? site.site_code : null,
        site_name: site ? site.name : null,
        lat: site ? site.lat : null,
        lng: site ? site.lng : null,
        estimated: !!leg.estimated
      });
    });

    return json(200, { ok: true, generated_at: new Date(now).toISOString(), techs: out });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
