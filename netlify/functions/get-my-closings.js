// get-my-closings.js
// A technician's own completed visits (Salesforce closings that have landed
// in site_visits) for a date range, so the mileage log can point out visits
// that have no stop logged. Read-only, one technician at a time.
//
// GET /.netlify/functions/get-my-closings?technician_id=...&from=YYYY-MM-DD&to=YYYY-MM-DD
// -> { ok, visits: [ { id, site_id, site_code, site_name, ended_at, wo_number } ] }

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

const SAFE_ID = /^[0-9A-Za-z_-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  if (!p.technician_id || !SAFE_ID.test(p.technician_id)) return json(400, { ok: false, error: 'technician_id required' });
  if (!DATE.test(p.from || '') || !DATE.test(p.to || '')) return json(400, { ok: false, error: 'from and to (YYYY-MM-DD) required' });

  // a day of slack each side so local-time dates near midnight still match
  const start = new Date(p.from + 'T00:00:00Z'); start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(p.to + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 2);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    const { data: visits, error } = await supabase
      .from('site_visits')
      .select('id, site_id, wo_number, ended_at')
      .eq('technician_id', p.technician_id)
      .not('site_id', 'is', null)
      .not('ended_at', 'is', null)
      .gte('ended_at', start.toISOString())
      .lt('ended_at', end.toISOString())
      .order('ended_at', { ascending: true })
      .limit(500);
    if (error) return json(500, { ok: false, error: error.message });

    const siteIds = [...new Set((visits || []).map((v) => v.site_id))];
    const sites = {};
    for (let i = 0; i < siteIds.length; i += 150) {
      const { data: rows, error: sErr } = await supabase
        .from('sites')
        .select('id, site_code, name')
        .in('id', siteIds.slice(i, i + 150));
      if (sErr) return json(500, { ok: false, error: sErr.message });
      for (const r of rows || []) sites[r.id] = r;
    }

    return json(200, {
      ok: true,
      visits: (visits || []).map((v) => ({
        id: v.id,
        site_id: v.site_id,
        site_code: sites[v.site_id] ? sites[v.site_id].site_code : null,
        site_name: sites[v.site_id] ? sites[v.site_id].name : null,
        ended_at: v.ended_at,
        wo_number: v.wo_number || null,
      })),
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
