// manage-dispatchers.js
//
// Admin-only user management for dispatcher logins (the same rows
// login.js authenticates against). Add, deactivate, change PIN/role/
// territories without a code deploy.
//
// Every request must include the acting admin's username + PIN.
// Dispatcher-role logins get 403.
//
// POST { adminUsername, adminPin, action, ... }
//   action: 'list' | 'create' | 'update' | 'set-pin' | 'set-active'
// -> { ok: true, users } or { ok: true, user }

const { createClient } = require('@supabase/supabase-js');

const ALL_STATES = ['AL','CA','CO','FL','GA','ID','IL','IN','MI','MN','MS','NC','NV','OH','OR','SC','WV'];
const ROLES = new Set(['admin', 'dispatcher']);

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role || 'dispatcher',
    states: row.states || [],
    active: row.active !== false,
    technicianId: row.technician_id || null,
    phone: row.phone || '',
  };
}

async function requireAdmin(sb, username, pin) {
  const u = String(username || '').trim().toLowerCase();
  const p = String(pin || '').trim();
  if (!u || !p) return { error: 'Admin username and PIN are required', status: 401 };
  const { data, error } = await sb
    .from('dispatchers')
    .select('id, username, role, active')
    .ilike('username', u)
    .eq('pin', p)
    .eq('active', true)
    .maybeSingle();
  if (error) return { error: error.message, status: 500 };
  if (!data) return { error: 'Invalid admin credentials', status: 401 };
  if (data.role !== 'admin') return { error: 'User management is restricted to admin accounts', status: 403 };
  return { admin: data };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: 'Supabase is not configured' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const gate = await requireAdmin(sb, body.adminUsername, body.adminPin);
  if (gate.error) return json(gate.status, { ok: false, error: gate.error });

  const action = body.action || 'list';

  try {
    if (action === 'list') {
      const { data, error } = await sb
        .from('dispatchers')
        .select('id, username, role, states, active, technician_id, phone')
        .order('username', { ascending: true });
      if (error) throw error;
      return json(200, { ok: true, users: (data || []).map(publicUser) });
    }

    if (action === 'create') {
      const username = String(body.username || '').trim().toLowerCase();
      const pin = String(body.pin || '').trim();
      const role = ROLES.has(body.role) ? body.role : 'dispatcher';
      let states = Array.isArray(body.states) ? body.states.map(s => String(s).toUpperCase()).filter(s => ALL_STATES.includes(s)) : [];
      if (role === 'admin' && !states.length) states = ALL_STATES.slice();
      if (!username || !/^[a-z0-9._-]{2,32}$/.test(username)) {
        return json(400, { ok: false, error: 'Username must be 2–32 letters, numbers, dot, dash, or underscore' });
      }
      if (!/^\d{4,8}$/.test(pin)) {
        return json(400, { ok: false, error: 'PIN must be 4–8 digits' });
      }
      const { data: existing } = await sb.from('dispatchers').select('id').ilike('username', username).maybeSingle();
      if (existing) return json(409, { ok: false, error: 'That username already exists' });
      const { data, error } = await sb
        .from('dispatchers')
        .insert({
          username,
          pin,
          role,
          states,
          active: true,
          technician_id: body.technicianId || null,
        })
        .select('id, username, role, states, active, technician_id, phone')
        .single();
      if (error) throw error;
      return json(200, { ok: true, user: publicUser(data) });
    }

    if (action === 'update' || action === 'set-pin' || action === 'set-active') {
      const id = body.id;
      if (!id) return json(400, { ok: false, error: 'id is required' });

      const { data: target, error: lookupErr } = await sb
        .from('dispatchers')
        .select('id, username, role, active')
        .eq('id', id)
        .maybeSingle();
      if (lookupErr) throw lookupErr;
      if (!target) return json(404, { ok: false, error: 'User not found' });

      const patch = {};
      if (action === 'set-pin' || body.pin) {
        const pin = String(body.pin || '').trim();
        if (!/^\d{4,8}$/.test(pin)) return json(400, { ok: false, error: 'PIN must be 4–8 digits' });
        patch.pin = pin;
      }
      if (action === 'set-active' || typeof body.active === 'boolean') {
        const nextActive = body.active !== false;
        if (!nextActive && target.role === 'admin' && target.id === gate.admin.id) {
          return json(400, { ok: false, error: 'You cannot deactivate your own admin login' });
        }
        patch.active = nextActive;
      }
      if (action === 'update') {
        if (body.role && ROLES.has(body.role)) {
          if (body.role !== 'admin' && target.role === 'admin' && target.id === gate.admin.id) {
            return json(400, { ok: false, error: 'You cannot remove admin from your own login' });
          }
          patch.role = body.role;
        }
        if (Array.isArray(body.states)) {
          patch.states = body.states.map(s => String(s).toUpperCase()).filter(s => ALL_STATES.includes(s));
        }
        if ('technicianId' in body) patch.technician_id = body.technicianId || null;
      }

      if (!Object.keys(patch).length) return json(400, { ok: false, error: 'Nothing to update' });

      const { data, error } = await sb
        .from('dispatchers')
        .update(patch)
        .eq('id', id)
        .select('id, username, role, states, active, technician_id, phone')
        .single();
      if (error) throw error;
      return json(200, { ok: true, user: publicUser(data) });
    }

    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    return json(500, { ok: false, error: err.message || 'Server error' });
  }
};
