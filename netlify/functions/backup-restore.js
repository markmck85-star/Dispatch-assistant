const { createClient } = require('@supabase/supabase-js');
const auth = require('./lib/auth');

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

exports.handler = async (event) => {
  const supabase = getSupabase();

  // v2 (2026-10-15): backups hold everything -- admin logins only. (The gate in
  // front of all functions checks this too; this is the second lock.)
  if (process.env.AUTH_ENFORCE !== '0') {
    const who = await auth.requireUser(supabase, event, { roles: ['admin'] });
    if (who.error) return json(who.status || 401, { error: who.error, code: who.status === 403 ? 'forbidden' : 'auth_required' });
  }

  const params = event.queryStringParameters || {};
  const action = params.action || (event.httpMethod === 'GET' ? 'list' : '');

  if (event.httpMethod === 'GET' && action === 'list') {
    const { data, error } = await supabase
      .from('backups')
      .select('id, created_at, trigger, state')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return json(500, { error: error.message });
    return json(200, { backups: data });
  }

  if (event.httpMethod === 'GET' && action === 'download') {
    const id = params.id;
    if (!id) return json(400, { error: 'Missing id' });
    const { data, error } = await supabase.from('backups').select('*').eq('id', id).single();
    if (error) return json(500, { error: error.message });
    if (!data) return json(404, { error: 'Backup not found' });
    return json(200, data);
  }

  if (event.httpMethod === 'POST' && action === 'snapshot') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body' }); }

    const trigger = body.trigger || 'manual';
    const state = body.state || null;

    try {
      const [sitesRes, visitsRes, aliasesRes] = await Promise.all([
        supabase.from('sites').select('*'),
        supabase.from('site_visits').select('*'),
        supabase.from('site_aliases').select('*'),
      ]);
      if (sitesRes.error) throw sitesRes.error;
      if (visitsRes.error) throw visitsRes.error;
      if (aliasesRes.error) throw aliasesRes.error;

      const snapshot = {
        sites: sitesRes.data,
        site_visits: visitsRes.data,
        site_aliases: aliasesRes.data,
      };

      const { data: inserted, error: insertErr } = await supabase
        .from('backups')
        .insert({ trigger, state, snapshot })
        .select('id, created_at')
        .single();
      if (insertErr) throw insertErr;

      return json(200, {
        ok: true,
        backupId: inserted.id,
        createdAt: inserted.created_at,
        counts: {
          sites: snapshot.sites.length,
          site_visits: snapshot.site_visits.length,
          site_aliases: snapshot.site_aliases.length,
        },
      });
    } catch (err) {
      return json(500, { error: 'Backup failed: ' + err.message });
    }
  }

  return json(405, { error: 'Method Not Allowed or missing action param' });
};
