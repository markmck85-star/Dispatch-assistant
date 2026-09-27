// save-mileage-log.js
// Saves a draft/submitted mileage log and flags legs that are negative
// or far over the known matrix distance. Never blocks save.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function milesBetweenOdo(start, end) {
  const a = Number(start);
  const b = Number(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) * 10) / 10;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const technicianId = body.technician_id;
  const periodStart = body.period_start;
  const periodEnd = body.period_end;
  const status = body.status === 'submitted' ? 'submitted' : 'draft';
  const notes = body.notes || null;
  const legs = Array.isArray(body.legs) ? body.legs : [];
  if (!technicianId || !periodStart || !periodEnd) {
    return json(400, { ok: false, error: 'technician_id, period_start, period_end required' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const flagged = [];
    const siteIds = [];
    for (const leg of legs) {
      if (leg.from_site_id) siteIds.push(leg.from_site_id);
      if (leg.to_site_id) siteIds.push(leg.to_site_id);
      const claimed = milesBetweenOdo(leg.odo_start, leg.odo_end);
      leg.miles = claimed;
      if (claimed != null && claimed < 0) {
        flagged.push({ date: leg.date, reason: 'negative', claimed });
        leg.flag = 'negative';
      }
    }

    const uniqueSites = [...new Set(siteIds)];
    const expected = {};
    if (uniqueSites.length) {
      const { data: homeRows } = await supabase
        .from('tech_site_distances')
        .select('site_id, distance_mi')
        .eq('technician_id', technicianId)
        .in('site_id', uniqueSites);
      for (const r of homeRows || []) expected['HOME|' + r.site_id] = Number(r.distance_mi);

      const { data: pairRows } = await supabase
        .from('site_site_distances')
        .select('site_a, site_b, distance_mi')
        .in('site_a', uniqueSites)
        .in('site_b', uniqueSites);
      for (const r of pairRows || []) {
        if (r.site_a && r.site_b && r.distance_mi != null) {
          expected[r.site_a + '|' + r.site_b] = Number(r.distance_mi);
          expected[r.site_b + '|' + r.site_a] = Number(r.distance_mi);
        }
      }
    }

    for (const leg of legs) {
      if (leg.flag === 'negative') continue;
      const claimed = leg.miles;
      if (claimed == null) continue;
      let key = null;
      if (leg.from_kind === 'home' && leg.to_site_id) key = 'HOME|' + leg.to_site_id;
      else if (leg.to_kind === 'home' && leg.from_site_id) key = 'HOME|' + leg.from_site_id;
      else if (leg.from_site_id && leg.to_site_id) key = leg.from_site_id + '|' + leg.to_site_id;
      const exp = key ? expected[key] : null;
      if (exp != null) leg.expected_mi = exp;
      if (exp != null && claimed > exp + 100) {
        leg.flag = 'over';
        flagged.push({ date: leg.date, reason: 'over', claimed, expected: exp });
      } else if (exp != null && claimed > exp + 50) {
        leg.flag = 'check';
        flagged.push({ date: leg.date, reason: 'check', claimed, expected: exp });
      } else if (claimed > 400) {
        leg.flag = 'over';
        flagged.push({ date: leg.date, reason: 'over', claimed, expected: exp });
      } else if (exp == null && claimed > 150) {
        leg.flag = 'check';
        flagged.push({ date: leg.date, reason: 'check', claimed });
      } else if (!leg.flag) {
        leg.flag = null;
      }
    }

    const row = {
      technician_id: technicianId,
      period_start: periodStart,
      period_end: periodEnd,
      status,
      legs,
      notes,
      updated_at: new Date().toISOString(),
    };

    const { data: saved, error } = await supabase
      .from('technician_mileage_logs')
      .upsert(row, { onConflict: 'technician_id,period_start' })
      .select('id, status, legs, notes, updated_at')
      .single();
    if (error) return json(500, { ok: false, error: error.message });

    return json(200, { ok: true, log: saved, flagged });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
