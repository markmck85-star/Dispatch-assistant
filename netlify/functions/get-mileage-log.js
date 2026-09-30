// get-mileage-log.js
// Context + draft load for the optional technician mileage log.
// Reuses technicians.home_address, site list, aliases, primary/fallback
// assignments, and the existing distance tables.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function cityFromAddress(addr) {
  if (!addr) return null;
  const s = String(addr).replace(/\s+/g, ' ').trim();
  const m = s.match(/,\s*([^,]+),\s*[A-Z]{2}\s+\d{5}/i);
  if (m) return m[1].trim();
  const m2 = s.match(/([^,]+),\s*[A-Z]{2}\s+\d{5}/i);
  if (m2) return m2[1].replace(/^\d+\s+/, '').split(' ').slice(-3).join(' ').replace(/^\d+\s+/, '');
  // "510 Sartain Ct Johns Creek GA 30097"
  const m3 = s.match(/([A-Za-z][A-Za-z .]+)\s+[A-Z]{2}\s+\d{5}/);
  if (m3) {
    const chunk = m3[1].trim();
    const parts = chunk.split(' ');
    if (parts.length >= 2) return parts.slice(-2).join(' ');
    return chunk;
  }
  return null;
}

function currentPeriod(ref) {
  const d = ref ? new Date(ref) : new Date();
  const day = d.getDay(); // 0 Sun
  const start = new Date(d);
  start.setDate(d.getDate() - day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 13);
  const iso = (x) => x.toISOString().slice(0, 10);
  return { period_start: iso(start), period_end: iso(end) };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    let techId = params.technician_id || null;
    const nameQ = params.name || null;
    const usernameQ = params.username || null;
    if (!techId && usernameQ) {
      const { data: d } = await supabase.from('dispatchers').select('technician_id').ilike('username', usernameQ).maybeSingle();
      if (d && d.technician_id) techId = d.technician_id;
    }
    if (!techId && nameQ) {
      const { data: techs } = await supabase.from('technicians').select('id, name').ilike('name', '%' + nameQ + '%').limit(5);
      if (techs && techs.length === 1) techId = techs[0].id;
    }
    if (!techId) return json(400, { ok: false, error: 'technician_id required' });

    const { data: tech, error: tErr } = await supabase
      .from('technicians')
      .select('id, name, home_state, home_address, lat, lng, additional_states')
      .eq('id', techId)
      .single();
    if (tErr || !tech) return json(404, { ok: false, error: 'Technician not found' });

    const homeCity = cityFromAddress(tech.home_address) || tech.home_state;
    const filterState = String(params.state || '').toUpperCase();
    const states = [tech.home_state].concat(tech.additional_states || []).filter(Boolean);

    let sitesQuery = supabase.from('sites').select('id, site_code, name, state, sst_name, lat, lng, primary_tech_id, fallback_tech_id');
    if (/^[A-Z]{2}$/.test(filterState)) sitesQuery = sitesQuery.eq('state', filterState);
    else if (states.length === 1) sitesQuery = sitesQuery.eq('state', states[0]);
    else if (states.length > 1) sitesQuery = sitesQuery.in('state', states);
    const { data: sites, error: sErr } = await sitesQuery;
    if (sErr) return json(500, { ok: false, error: sErr.message });

    const siteIds = (sites || []).map((s) => s.id);
    const aliases = [];
    for (let i = 0; i < siteIds.length; i += 200) {
      const chunk = siteIds.slice(i, i + 200);
      const { data: a } = await supabase.from('site_aliases').select('site_id, alias').in('site_id', chunk);
      for (const row of a || []) aliases.push(row);
    }
    const aliasBySite = {};
    for (const a of aliases) {
      if (!aliasBySite[a.site_id]) aliasBySite[a.site_id] = [];
      aliasBySite[a.site_id].push(a.alias);
    }

    const usual = [];
    const rest = [];
    for (const s of sites || []) {
      const item = {
        id: s.id,
        site_code: s.site_code,
        name: s.name,
        state: s.state,
        sst_name: s.sst_name,
        aliases: aliasBySite[s.id] || [],
        usual: s.primary_tech_id === tech.id || s.fallback_tech_id === tech.id,
      };
      if (item.usual) usual.push(item);
      else rest.push(item);
    }

    let periodStart = params.period_start;
    let periodEnd = params.period_end;
    if (!periodStart || !periodEnd) {
      const p = currentPeriod();
      periodStart = periodStart || p.period_start;
      periodEnd = periodEnd || p.period_end;
    }

    const { data: log } = await supabase
      .from('technician_mileage_logs')
      .select('id, status, legs, notes, period_start, period_end, updated_at')
      .eq('technician_id', tech.id)
      .eq('period_start', periodStart)
      .maybeSingle();

    // last stop of the most recent earlier pay period, so a new period can start where the last one ended
    let prevLast = null;
    try {
      const { data: prevLogs } = await supabase
        .from('technician_mileage_logs')
        .select('period_start, legs')
        .eq('technician_id', tech.id)
        .lt('period_start', periodStart)
        .order('period_start', { ascending: false })
        .limit(3);
      for (const pl of prevLogs || []) {
        const ls = Array.isArray(pl.legs) ? pl.legs : [];
        let best = null;
        for (const l of ls) {
          if (l && l.date && l.odo_end != null && (!best || l.date >= best.date)) best = l;
        }
        if (best) {
          prevLast = {
            date: best.date,
            to_kind: best.to_kind || null,
            to_site_id: best.to_site_id || null,
            to_print: best.to_print || null,
            to_picker: best.to_picker || null,
            odo_end: best.odo_end,
          };
          break;
        }
      }
    } catch (e) { /* carry-over is a convenience; never block the page */ }

    return json(200, {
      ok: true,
      technician: {
        id: tech.id,
        name: tech.name,
        home_state: tech.home_state,
        home_address: tech.home_address,
        home_city: homeCity,
        home_label_picker: homeCity + ' (Home)',
        home_label_print: homeCity,
        has_geo: tech.lat != null && tech.lng != null,
      },
      period_start: periodStart,
      period_end: periodEnd,
      sites_usual: usual,
      sites_other: rest,
      log: log || { status: 'draft', legs: [], notes: null },
      prev_last: prevLast,
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
