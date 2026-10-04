// manage-dispatchers.js
//
// User management for dispatcher logins (the same rows login.js uses).
// Every request includes username + current PIN.
//
// Dispatcher role: change-own-pin only.
// Admin role: list / create / update / set-pin / set-active.
// Email is stored on the dispatchers row only. It never creates or edits a technician.
//
// POST { adminUsername, adminPin, action, ... }

const { createClient } = require('@supabase/supabase-js');

const ALL_STATES = ['AL','CA','CO','FL','GA','ID','IL','IN','MI','MN','MS','NC','NV','OH','OR','SC','WV'];
const ROLES = new Set(['admin', 'dispatcher']);
const USER_COLS = 'id, username, role, states, active, technician_id, phone, pin, last_seen_at, email';

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function missingEmailColumn(err) {
  const msg = String((err && err.message) || err || '');
  return /email/i.test(msg) && /column|schema cache|does not exist/i.test(msg);
}

function fail(err) {
  if (missingEmailColumn(err)) {
    return json(500, {
      ok: false,
      error: 'The email column does not exist on the dispatchers table. Add a text column named email on dispatchers, then save again. This login was not turned into a technician record.'
    });
  }
  return json(500, { ok: false, error: (err && err.message) || 'Server error' });
}

function cleanEmail(value) {
  const email = String(value || '').trim();
  if (!email) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'Email must look like name@company.com' };
  }
  return email;
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
    email: row.email || '',
    pin: row.pin || '',
    lastSeenAt: row.last_seen_at || null,
  };
}

async function requireLogin(sb, username, pin) {
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
  return { user: data };
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
  const gate = await requireLogin(sb, body.adminUsername, body.adminPin);
  if (gate.error) return json(gate.status, { ok: false, error: gate.error });

  const action = body.action || 'list';
  const isAdmin = gate.user.role === 'admin';

  try {
    if (action === 'change-own-pin') {
      const newPin = String(body.pin || body.newPin || '').trim();
      if (!/^\d{4,8}$/.test(newPin)) return json(400, { ok: false, error: 'New PIN must be 4–8 digits' });
      const { data, error } = await sb
        .from('dispatchers')
        .update({ pin: newPin })
        .eq('id', gate.user.id)
        .select(USER_COLS)
        .single();
      if (error) throw error;
      return json(200, { ok: true, user: publicUser(data) });
    }

    if (!isAdmin) return json(403, { ok: false, error: 'User management is restricted to admin accounts' });

    if (action === 'list') {
      const { data, error } = await sb
        .from('dispatchers')
        .select(USER_COLS)
        .order('username', { ascending: true });
      if (error) throw error;
      return json(200, { ok: true, users: (data || []).map(publicUser) });
    }

    if (action === 'from-technician') {
      const slug = String(body.technicianSlug || '').trim().toLowerCase();
      const username = String(body.username || '').trim().toLowerCase();
      const pin = String(body.pin || '').trim();
      const role = ROLES.has(body.role) ? body.role : 'dispatcher';
      let states = Array.isArray(body.states) ? body.states.map(s => String(s).toUpperCase()).filter(s => ALL_STATES.includes(s)) : [];
      if (!slug) return json(400, { ok: false, error: 'technicianSlug is required' });
      if (!username || !/^[a-z0-9._-]{2,32}$/.test(username)) {
        return json(400, { ok: false, error: 'Username must be 2–32 letters, numbers, dot, dash, or underscore' });
      }
      if (!/^\d{4,8}$/.test(pin)) return json(400, { ok: false, error: 'PIN must be 4–8 digits' });
      const { data: tech, error: techErr } = await sb
        .from('technicians')
        .select('id, name, home_state, additional_states')
        .eq('slug', slug)
        .maybeSingle();
      if (techErr) throw techErr;
      if (!tech) return json(404, { ok: false, error: 'No technician row found for that employee. Save them first.' });
      if (!states.length) {
        states = [tech.home_state].concat(tech.additional_states || []).filter(Boolean);
      }
      const { data: existingLink } = await sb.from('dispatchers').select('id').eq('technician_id', tech.id).maybeSingle();
      const { data: existingUser } = await sb.from('dispatchers').select('id').ilike('username', username).maybeSingle();
      if (existingLink) {
        const { data, error } = await sb
          .from('dispatchers')
          .update({ username, pin, role, states, active: true, technician_id: tech.id })
          .eq('id', existingLink.id)
          .select(USER_COLS)
          .single();
        if (error) throw error;
        return json(200, { ok: true, user: publicUser(data), updated: true });
      }
      if (existingUser) {
        const { data, error } = await sb
          .from('dispatchers')
          .update({ pin, role, states, active: true, technician_id: tech.id })
          .eq('id', existingUser.id)
          .select(USER_COLS)
          .single();
        if (error) throw error;
        return json(200, { ok: true, user: publicUser(data), updated: true });
      }
      const { data, error } = await sb
        .from('dispatchers')
        .insert({ username, pin, role, states, active: true, technician_id: tech.id })
        .select(USER_COLS)
        .single();
      if (error) throw error;
      return json(200, { ok: true, user: publicUser(data) });
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
      const email = cleanEmail(body.email);
      if (email && email.error) return json(400, { ok: false, error: email.error });
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
          email: email || null,
        })
        .select(USER_COLS)
        .single();
      if (error) throw error;
      return json(200, { ok: true, user: publicUser(data) });
    }

    if (action === 'update' || action === 'set-pin' || action === 'set-active') {
      const id = body.id;
      if (!id) return json(400, { ok: false, error: 'id is required' });

      const { data: target, error: lookupErr } = await sb
        .from('dispatchers')
        .select('id, username, role, active, technician_id')
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
        if (!nextActive && target.role === 'admin' && target.id === gate.user.id) {
          return json(400, { ok: false, error: 'You cannot deactivate your own admin login' });
        }
        patch.active = nextActive;
      }
      if (action === 'update') {
        if (body.role && ROLES.has(body.role)) {
          if (body.role !== 'admin' && target.role === 'admin' && target.id === gate.user.id) {
            return json(400, { ok: false, error: 'You cannot remove admin from your own login' });
          }
          patch.role = body.role;
        }
        if (Array.isArray(body.states)) {
          patch.states = body.states.map(s => String(s).toUpperCase()).filter(s => ALL_STATES.includes(s));
        }
        if ('technicianId' in body) patch.technician_id = body.technicianId || null;
        if ('email' in body) {
          const email = cleanEmail(body.email);
          if (email && email.error) return json(400, { ok: false, error: email.error });
          patch.email = email || null;
        }
      }

      if (!Object.keys(patch).length) return json(400, { ok: false, error: 'Nothing to update' });

      const { data, error } = await sb
        .from('dispatchers')
        .update(patch)
        .eq('id', id)
        .select(USER_COLS)
        .single();
      if (error) throw error;
      return json(200, { ok: true, user: publicUser(data) });
    }

    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    return fail(err);
  }
};
