/**
 * netlify/functions/save-stop-alias.js  (v2.0, 2026-10-26)
 * SAVE AS: netlify/functions/save-stop-alias.js
 *
 * POST, from mileage-aliases.html (admin only, see gate.js). Actions:
 *   { action: "site", technician_id, alias, site_id }
 *       teaches that, for THAT technician only, the name means that site. Saved as approved.
 *       If the technician already answered that name from the portal (waiting), this replaces
 *       his answer with yours and approves it.
 *   { action: "home", technician_id, alias }
 *       adds the name to that technician's home_aliases.
 *   { action: "not_site", technician_id, alias }
 *       that name is not a site for that technician (errand, lunch...). Approved.
 *   { action: "approve", id }           approve one answer a technician gave from the portal
 *   { action: "reject", id }            throw one away (the technician can answer again)
 *   { action: "approve_confident" }     approve every waiting site answer the page marked confident
 *
 * Technician answers wait as status 'pending' in technician_stop_aliases; the mileage check only
 * reads 'approved' rows. Nothing is ever overwritten silently: a name already pointing at a
 * different site for the same technician is refused (409), except a waiting answer being decided.
 */
const { createClient } = require('@supabase/supabase-js');
const { normalizePlaceLabel } = require('./lib/mileage-check.js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
const UUID = /^[0-9a-f-]{36}$/i;
const escLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

async function appendHomeAlias(supabase, techId, alias) {
  const { data: tech, error } = await supabase.from('technicians').select('id, home_aliases').eq('id', techId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!tech) throw new Error('Technician not found');
  const have = Array.isArray(tech.home_aliases) ? tech.home_aliases : [];
  if (have.some((a) => normalizePlaceLabel(a).toLowerCase() === alias.toLowerCase())) return;
  const { error: uErr } = await supabase.from('technicians').update({ home_aliases: [...have, alias] }).eq('id', techId);
  if (uErr) throw new Error(uErr.message);
}

async function approveRow(supabase, row) {
  if (row.kind === 'home') {
    await appendHomeAlias(supabase, row.technician_id, row.alias);
    const { error } = await supabase.from('technician_stop_aliases').delete().eq('id', row.id);
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase.from('technician_stop_aliases')
    .update({ status: 'approved', decided_at: new Date().toISOString() }).eq('id', row.id);
  if (error) throw new Error(error.message);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Supabase env vars not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
  const action = String(body.action || '');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // ---- decisions on answers technicians gave from the portal ----
    if (action === 'approve' || action === 'reject') {
      const id = String(body.id || '');
      if (!UUID.test(id)) return json(400, { error: 'Valid id required' });
      const { data: row, error } = await supabase.from('technician_stop_aliases')
        .select('id, technician_id, alias, kind, site_id, status').eq('id', id).maybeSingle();
      if (error) return json(500, { error: error.message });
      if (!row) return json(404, { error: 'That answer is already gone.' });
      if (row.status !== 'pending') return json(200, { ok: true, already: true });
      if (action === 'reject') {
        const { error: dErr } = await supabase.from('technician_stop_aliases').delete().eq('id', id).eq('status', 'pending');
        if (dErr) return json(500, { error: dErr.message });
        return json(200, { ok: true });
      }
      await approveRow(supabase, row);
      return json(200, { ok: true });
    }

    if (action === 'approve_confident') {
      const { data: rows, error } = await supabase.from('technician_stop_aliases')
        .select('id, technician_id, alias, kind, site_id, status, evidence').eq('status', 'pending').eq('kind', 'site').limit(1000);
      if (error) return json(500, { error: error.message });
      const sure = (rows || []).filter((r) => r.evidence && r.evidence.confident === true);
      for (const r of sure) await approveRow(supabase, r);
      return json(200, { ok: true, approved: sure.length });
    }

    // ---- answers you give directly ----
    const alias = normalizePlaceLabel(body.alias);
    if (!alias || alias.length < 3 || alias.length > 120) return json(400, { error: 'A name of 3 to 120 characters is required' });
    const techId = String(body.technician_id || '');
    if (!UUID.test(techId)) return json(400, { error: 'Valid technician_id required' });
    const { data: tech, error: tErr } = await supabase.from('technicians').select('id, name, home_aliases').eq('id', techId).maybeSingle();
    if (tErr) return json(500, { error: tErr.message });
    if (!tech) return json(404, { error: 'Technician not found' });

    const { data: existing, error: eErr } = await supabase.from('technician_stop_aliases')
      .select('id, site_id, alias, status, kind').eq('technician_id', techId).ilike('alias', escLike(alias));
    if (eErr) return json(500, { error: eErr.message });
    const exact = (existing || []).filter((r) => String(r.alias).toLowerCase() === alias.toLowerCase());
    const waiting = exact.find((r) => r.status === 'pending');
    const decided = exact.filter((r) => r.status === 'approved');

    if (action === 'home') {
      await appendHomeAlias(supabase, techId, alias);
      if (waiting) await supabase.from('technician_stop_aliases').delete().eq('id', waiting.id);
      return json(200, { ok: true });
    }

    if (action === 'not_site') {
      if (decided.length) return json(200, { ok: true, already: true });
      if (waiting) {
        const { error } = await supabase.from('technician_stop_aliases')
          .update({ kind: 'not_site', site_id: null, status: 'approved', decided_at: new Date().toISOString() }).eq('id', waiting.id);
        if (error) return json(500, { error: error.message });
        return json(200, { ok: true });
      }
      const { error } = await supabase.from('technician_stop_aliases')
        .insert({ technician_id: techId, alias, kind: 'not_site', site_id: null, status: 'approved', source: 'mileage_unidentified', answered_by: 'admin', decided_at: new Date().toISOString() });
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true });
    }

    if (action === 'site') {
      const siteId = String(body.site_id || '');
      if (!UUID.test(siteId)) return json(400, { error: 'Valid site_id required' });
      const { data: site, error: sErr } = await supabase.from('sites').select('id, name, site_code').eq('id', siteId).maybeSingle();
      if (sErr) return json(500, { error: sErr.message });
      if (!site) return json(404, { error: 'Site not found' });
      const out = { code: site.site_code, name: site.name };

      if (decided.some((r) => r.kind === 'site' && r.site_id !== siteId)) {
        return json(409, { error: tech.name + ' already has that name pointing to a different site.' });
      }
      if (decided.some((r) => r.kind === 'site')) return json(200, { ok: true, already: true, site: out });
      if (decided.length) return json(409, { error: tech.name + ' already has that name marked as not a site.' });

      if (waiting) {
        const { error } = await supabase.from('technician_stop_aliases')
          .update({ kind: 'site', site_id: siteId, status: 'approved', decided_at: new Date().toISOString() }).eq('id', waiting.id);
        if (error) return json(500, { error: error.message });
        return json(200, { ok: true, site: out });
      }
      const { error: iErr } = await supabase.from('technician_stop_aliases')
        .insert({ technician_id: techId, alias, site_id: siteId, kind: 'site', status: 'approved', source: 'mileage_unidentified', answered_by: 'admin', decided_at: new Date().toISOString() });
      if (iErr) return json(500, { error: iErr.message });
      return json(200, { ok: true, site: out });
    }

    return json(400, { error: 'Unknown action' });
  } catch (e) {
    return json(500, { error: e.message || 'Unexpected error' });
  }
};
