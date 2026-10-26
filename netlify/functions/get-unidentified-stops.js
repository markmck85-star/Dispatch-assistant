/**
 * netlify/functions/get-unidentified-stops.js  (v2.0, 2026-10-26)
 * SAVE AS: netlify/functions/get-unidentified-stops.js
 *
 * GET ?days=120  (default 120, 7 to 400)   &state=GA (optional)
 *
 * Feeds mileage-aliases.html: every stop name on the technicians' mileage sheets that the mileage
 * check could not identify, grouped by technician, with ranked site suggestions. The work is done in
 * lib/unidentified-stops.js (shared with the technician portal). This wrapper adds `pending`: the
 * answers technicians have given from the portal that are waiting for approval.
 *
 * Admin only (see gate.js).
 */
const { createClient } = require('@supabase/supabase-js');
const { buildUnidentified } = require('./lib/unidentified-stops.js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Supabase env vars not configured' });

  const params = event.queryStringParameters || {};
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const out = await buildUnidentified(supabase, { days: params.days, stateFilter: params.state });

    let pending = [];
    try {
      const { data, error } = await supabase.from('technician_stop_aliases')
        .select('id, technician_id, alias, kind, site_id, evidence, answered_by, created_at, technicians(name, home_state), sites(name, site_code, state, address)')
        .eq('status', 'pending').order('created_at', { ascending: true }).limit(500);
      if (error) throw new Error(error.message);
      pending = (data || []).map((r) => ({
        id: r.id, technicianId: r.technician_id, tech: r.technicians ? r.technicians.name : '', state: r.technicians ? r.technicians.home_state : '',
        alias: r.alias, kind: r.kind, evidence: r.evidence || null, createdAt: r.created_at,
        site: r.sites ? { name: r.sites.name, code: r.sites.site_code, state: r.sites.state, address: r.sites.address || '' } : null,
      }));
    } catch (e) { /* nothing waiting, or the columns are not there yet */ }

    return json(200, { ok: true, ...out, pending });
  } catch (e) {
    return json(500, { error: e.message || 'Unexpected error' });
  }
};
