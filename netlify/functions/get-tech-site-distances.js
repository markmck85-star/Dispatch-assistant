// get-tech-site-distances.js
//
// Looks up each given technician's drive distance/time to one site, from
// the same tech_site_distances table the main dispatch board's own
// routing already reads. Built for the Saturday on-call page's "default
// to the closest on-call tech" behavior -- a site's stored primary/
// fallback tech (what the main board falls back to normally) isn't
// necessarily on call on a given Saturday, so this needs its own
// closest-of-the-actual-candidates lookup instead of reusing that.
//
// GET /.netlify/functions/get-tech-site-distances?siteCode=GA1121&technicianIds=id1,id2
// -> { distances: { [technicianId]: { distanceMi, durationMin, mode } } }
//
// A technician with no row at all (never had a distance-matrix build run
// for them) is simply absent from the result -- the caller treats that as
// unknown/last-resort, not zero.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const siteCode = String(params.siteCode || '').trim().toUpperCase();
  const technicianIds = String(params.technicianIds || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!siteCode || !technicianIds.length) {
    return json(400, { error: 'siteCode and technicianIds are required' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: site, error: siteErr } = await sb
    .from('sites').select('id').eq('site_code', siteCode).maybeSingle();
  if (siteErr) return json(500, { error: siteErr.message });
  if (!site) return json(404, { error: 'No site found for ' + siteCode });

  const { data: rows, error } = await sb
    .from('tech_site_distances')
    .select('technician_id, mode, distance_mi, duration_min')
    .eq('site_id', site.id)
    .in('technician_id', technicianIds);
  if (error) return json(500, { error: error.message });

  // Prefer a real driving-mode row over a haversine estimate when both
  // exist for the same tech; otherwise take whatever's there.
  const distances = {};
  for (const r of (rows || [])) {
    const existing = distances[r.technician_id];
    if (!existing || (existing.mode !== 'driving' && r.mode === 'driving')) {
      distances[r.technician_id] = { distanceMi: r.distance_mi, durationMin: r.duration_min, mode: r.mode };
    }
  }

  return json(200, { distances });
};
