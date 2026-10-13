// manage-states.js
//
// Admin-only management of the states table (which states are active, their
// time zone, Saturday coverage, and the extra codes a state accepts, e.g. GA
// accepts NC and SC). Every request includes the admin's username + PIN, the
// same way manage-dispatchers.js does.
//
// POST { adminUsername, adminPin, action, ... }
//   action 'list'                              -> { ok, states }
//   action 'update', code, [active], [saturday_coverage], [timezone], [name],
//                    [accepts_prefixes]        -> { ok, state }
//   action 'create', code, name, timezone, [active], [saturday_coverage],
//                    [accepts_prefixes]        -> { ok, state }
//
// States are never deleted here. Turning one off (active = false) hides it
// from the pickers but keeps its history.

const { createClient } = require('@supabase/supabase-js');

const COLS = 'code, name, timezone, saturday_coverage, active, accepts_prefixes';

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function validZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

function cleanPrefixes(list, ownCode) {
  if (!Array.isArray(list)) return null;
  const out = [];
  list.forEach((p) => {
    const c = String(p || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(c) && c !== ownCode && !out.includes(c)) out.push(c);
  });
  return out;
}

async function requireAdmin(sb, username, pin) {
  const u = String(username || '').trim().toLowerCase();
  const p = String(pin || '').trim();
  if (!u || !p) return { error: 'Username and PIN are required', status: 401 };
  const { data, error } = await sb
    .from('dispatchers')
    .select('id, username, role, active')
    .ilike('username', u)
    .eq('pin', p)
    .eq('active', true)
    .maybeSingle();
  if (error) return { error: error.message, status: 500 };
  if (!data) return { error: 'Invalid username or PIN', status: 401 };
  if (data.role !== 'admin') return { error: 'State management is restricted to admin accounts', status: 403 };
  return { user: data };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: 'Supabase is not configured' });
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { ok: false, error: 'Invalid JSON body' }); }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const gate = await requireAdmin(sb, body.adminUsername, body.adminPin);
  if (gate.error) return json(gate.status, { ok: false, error: gate.error });

  const action = body.action || 'list';
  try {
    if (action === 'list') {
      const { data, error } = await sb.from('states').select(COLS).order('code', { ascending: true });
      if (error) throw error;
      return json(200, { ok: true, states: data || [] });
    }

    if (action === 'update') {
      const code = String(body.code || '').trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(code)) return json(400, { ok: false, error: 'A two-letter state code is required' });
      const patch = {};
      if (typeof body.active === 'boolean') patch.active = body.active;
      if (typeof body.saturday_coverage === 'boolean') patch.saturday_coverage = body.saturday_coverage;
      if (body.timezone !== undefined) {
        const tz = String(body.timezone || '').trim();
        if (!validZone(tz)) return json(400, { ok: false, error: 'That time zone is not valid' });
        patch.timezone = tz;
      }
      if (body.name !== undefined) {
        const name = String(body.name || '').trim();
        if (!name) return json(400, { ok: false, error: 'Name cannot be blank' });
        patch.name = name;
      }
      if (body.accepts_prefixes !== undefined) {
        const pre = cleanPrefixes(body.accepts_prefixes, code);
        if (pre === null) return json(400, { ok: false, error: 'Accepted codes must be a list' });
        patch.accepts_prefixes = pre;
      }
      if (!Object.keys(patch).length) return json(400, { ok: false, error: 'Nothing to change' });
      const { data, error } = await sb.from('states').update(patch).eq('code', code).select(COLS).maybeSingle();
      if (error) throw error;
      if (!data) return json(404, { ok: false, error: 'No such state' });
      return json(200, { ok: true, state: data });
    }

    if (action === 'create') {
      const code = String(body.code || '').trim().toUpperCase();
      const name = String(body.name || '').trim();
      const tz = String(body.timezone || '').trim();
      if (!/^[A-Z]{2}$/.test(code)) return json(400, { ok: false, error: 'A two-letter state code is required' });
      if (!name) return json(400, { ok: false, error: 'A state name is required' });
      if (!validZone(tz)) return json(400, { ok: false, error: 'Pick a valid time zone' });
      const { data: existing } = await sb.from('states').select('code').eq('code', code).maybeSingle();
      if (existing) return json(409, { ok: false, error: 'That state already exists. Use its toggle instead.' });
      const pre = cleanPrefixes(body.accepts_prefixes, code) || [];
      const { data, error } = await sb
        .from('states')
        .insert({
          code, name, timezone: tz,
          active: body.active !== false,
          saturday_coverage: body.saturday_coverage === true,
          accepts_prefixes: pre,
        })
        .select(COLS)
        .single();
      if (error) throw error;
      return json(200, { ok: true, state: data });
    }

    return json(400, { ok: false, error: 'Unknown action' });
  } catch (e) {
    return json(500, { ok: false, error: (e && e.message) || 'Server error' });
  }
};
