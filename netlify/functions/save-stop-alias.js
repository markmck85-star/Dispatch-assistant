/**
 * netlify/functions/save-stop-alias.js  (v1.0, 2026-10-26)
 * SAVE AS: netlify/functions/save-stop-alias.js
 *
 * POST, from mileage-aliases.html. Two actions:
 *   { action: "site", alias: "Kroger Rincon", site_id: "<uuid>" }
 *       teaches that a name a technician writes means that site (site_aliases, source
 *       'mileage_unidentified'). The mileage check reads these on every later sheet.
 *   { action: "home", technician_id: "<uuid>", alias: "131 Tappan Zee Dr" }
 *       adds the name to that technician's home_aliases (what he writes for his own home).
 *
 * Never overwrites: a name already pointing at a different site is refused (409), the same rule
 * save-site-aliases.js uses, so two sites can never share one name by accident.
 * Admin only (see gate.js).
 */
const { createClient } = require('@supabase/supabase-js');
const { normalizePlaceLabel } = require('./lib/mileage-check.js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
const UUID = /^[0-9a-f-]{36}$/i;
const escLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Supabase env vars not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const alias = normalizePlaceLabel(body.alias);
  if (!alias || alias.length < 3 || alias.length > 120) return json(400, { error: 'A name of 3 to 120 characters is required' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (body.action === 'site') {
      const siteId = String(body.site_id || '');
      if (!UUID.test(siteId)) return json(400, { error: 'Valid site_id required' });
      const { data: site, error: sErr } = await supabase.from('sites').select('id, name, site_code').eq('id', siteId).maybeSingle();
      if (sErr) return json(500, { error: sErr.message });
      if (!site) return json(404, { error: 'Site not found' });

      const { data: existing, error: eErr } = await supabase.from('site_aliases').select('id, site_id, alias').ilike('alias', escLike(alias));
      if (eErr) return json(500, { error: eErr.message });
      const exact = (existing || []).filter((r) => String(r.alias).toLowerCase() === alias.toLowerCase());
      if (exact.some((r) => r.site_id !== siteId)) {
        return json(409, { error: 'That name already points to a different site. Make it more specific (add the town) and try again.' });
      }
      if (exact.length) return json(200, { ok: true, already: true, site: { code: site.site_code, name: site.name } });

      const { error: iErr } = await supabase.from('site_aliases').insert({ alias, site_id: siteId, source: 'mileage_unidentified' });
      if (iErr) return json(500, { error: iErr.message });
      return json(200, { ok: true, site: { code: site.site_code, name: site.name } });
    }

    if (body.action === 'home') {
      const techId = String(body.technician_id || '');
      if (!UUID.test(techId)) return json(400, { error: 'Valid technician_id required' });
      const { data: tech, error: tErr } = await supabase.from('technicians').select('id, name, home_aliases').eq('id', techId).maybeSingle();
      if (tErr) return json(500, { error: tErr.message });
      if (!tech) return json(404, { error: 'Technician not found' });
      const have = Array.isArray(tech.home_aliases) ? tech.home_aliases : [];
      if (have.some((a) => normalizePlaceLabel(a).toLowerCase() === alias.toLowerCase())) return json(200, { ok: true, already: true });
      const { error: uErr } = await supabase.from('technicians').update({ home_aliases: [...have, alias] }).eq('id', techId);
      if (uErr) return json(500, { error: uErr.message });
      return json(200, { ok: true });
    }

    return json(400, { error: 'action must be "site" or "home"' });
  } catch (e) {
    return json(500, { error: e.message || 'Unexpected error' });
  }
};
