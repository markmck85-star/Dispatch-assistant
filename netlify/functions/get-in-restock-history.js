/**
 * get-in-restock-history.js
 *
 * Optional Netlify function that returns the most common historical
 * restock technician for each Indiana site (from site_visits).
 *
 * GET /.netlify/functions/get-in-restock-history
 * -> { ok: true, prefs: { "IN1056": "Kevin Demlow", ... } }
 *
 * The client planner falls back gracefully if this endpoint is missing.
 */

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

exports.handler = async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(200, { ok: true, prefs: {} });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Most recent ~120 days of restock visits for IN
    const since = new Date();
    since.setDate(since.getDate() - 120);
    const sinceIso = since.toISOString();

    const { data, error } = await supabase
      .from('site_visits')
      .select('site_id, technician_id, is_restock, included_restock, started_at, sites(site_code), technicians(name)')
      .eq('state', 'IN')
      .or('is_restock.eq.true,included_restock.eq.true')
      .gte('started_at', sinceIso)
      .limit(2000);

    if (error || !data) return json(200, { ok: true, prefs: {} });

    const counts = {}; // code -> { techName: count }
    data.forEach(row => {
      const code = row.sites && row.sites.site_code;
      const tech = row.technicians && row.technicians.name;
      if (!code || !tech) return;
      if (!counts[code]) counts[code] = {};
      counts[code][tech] = (counts[code][tech] || 0) + 1;
    });

    const prefs = {};
    Object.entries(counts).forEach(([code, techCounts]) => {
      const best = Object.entries(techCounts).sort((a, b) => b[1] - a[1])[0];
      if (best) prefs[code] = best[0];
    });

    return json(200, { ok: true, prefs });
  } catch (err) {
    return json(200, { ok: true, prefs: {} });
  }
};
