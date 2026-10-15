// manage-dispatchers.js
//
// User management for dispatcher logins (the same rows login.js uses).
// Every request is signed in: the sign-in cookie (set by login.js) or
// adminUsername + adminPin in the body.
//
// PINs are now passphrases: 8 to 64 characters, letters, digits and symbols.
// They are stored hashed (lib/auth.js) and can never be shown again; an admin
// sets a new one instead. Changing a passphrase signs that login out of its
// other sessions.
//
// Dispatcher role: change-own-pin only (needs the current PIN).
// Admin role: list / create / update / set-pin / set-active / unlock / require-change.
// Email is stored on the dispatchers row only. It never creates or edits a technician.
//
// POST { adminUsername, adminPin, action, ... }

const { createClient } = require('@supabase/supabase-js');
const auth = require('./lib/auth');

const ALL_STATES = ['AL','CA','CO','FL','GA','ID','IL','IN','MI','MN','MS','NC','NV','OH','OR','SC','WV'];
const ROLES = new Set(['admin', 'dispatcher']);
const USER_COLS = 'id, username, role, states, active, technician_id, phone, pin, pin_hash, last_seen_at, email, locked_until, must_change_pin';

function json(statusCode, obj, extraHeaders) {
  return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extraHeaders || {}), body: JSON.stringify(obj) };
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
    hasPin: !!(row.pin_hash || row.pin),
    lockedUntil: row.locked_until || null,
    mustChange: row.must_change_pin === true,
    lastSeenAt: row.last_seen_at || null,
  };
}

// forceChange: true = the person must choose their own passphrase at next
// sign-in (use for a temporary one an admin typed in); false = they chose it.
function pinPatch(pin, forceChange) {
  return {
    must_change_pin: forceChange === true,
    pin_hash: auth.hashPin(pin),
    pin: '',
    pin_changed_at: new Date().toISOString(),
    failed_attempts: 0,
    locked_until: null,
  };
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
  const action = body.action || 'list';

  // Changing your own PIN always proves the current one, even when signed in.
  let gate;
  if (action === 'change-own-pin') {
    gate = await auth.verifyCredentials(sb, body.adminUsername, body.adminPin, { ip: auth.clientIp(event), allowMustChange: true });
  } else {
    gate = await auth.authenticateRequest(sb, event, { username: body.adminUsername, pin: body.adminPin });
  }
  if (gate.error) return json(gate.status, { ok: false, error: gate.error });
  const isAdmin = gate.user.role === 'admin';

  try {
    if (action === 'change-own-pin') {
      const newPin = String(body.pin || body.newPin || '').trim();
      const bad = auth.pinProblem(newPin);
      if (bad) return json(400, { ok: false, error: 'New PIN: ' + bad });
      const { data, error } = await sb
        .from('dispatchers')
        .update(pinPatch(newPin, false))
        .eq('id', gate.user.id)
        .select(USER_COLS + ', created_at, pin_changed_at')
        .single();
      if (error) throw error;
      auth.clearSeen(data.username);
      return json(200, { ok: true, user: publicUser(data) }, { 'Set-Cookie': auth.cookieHeader(auth.makeToken(data)) });
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
      { const bad = auth.pinProblem(pin); if (bad) return json(400, { ok: false, error: 'PIN: ' + bad }); }
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
          .update(Object.assign({ username, role, states, active: true, technician_id: tech.id }, pinPatch(pin, true)))
          .eq('id', existingLink.id)
          .select(USER_COLS)
          .single();
        if (error) throw error;
        return json(200, { ok: true, user: publicUser(data), updated: true });
      }
      if (existingUser) {
        const { data, error } = await sb
          .from('dispatchers')
          .update(Object.assign({ role, states, active: true, technician_id: tech.id }, pinPatch(pin, true)))
          .eq('id', existingUser.id)
          .select(USER_COLS)
          .single();
        if (error) throw error;
        return json(200, { ok: true, user: publicUser(data), updated: true });
      }
      const { data, error } = await sb
        .from('dispatchers')
        .insert(Object.assign({ username, role, states, active: true, technician_id: tech.id }, pinPatch(pin, true)))
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
      { const bad = auth.pinProblem(pin); if (bad) return json(400, { ok: false, error: 'PIN: ' + bad }); }
      const email = cleanEmail(body.email);
      if (email && email.error) return json(400, { ok: false, error: email.error });
      const { data: existing } = await sb.from('dispatchers').select('id').ilike('username', username).maybeSingle();
      if (existing) return json(409, { ok: false, error: 'That username already exists' });
      const { data, error } = await sb
        .from('dispatchers')
        .insert({
          username,
          ...pinPatch(pin, true),
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

    if (action === 'update' || action === 'set-pin' || action === 'set-active' || action === 'unlock' || action === 'require-change') {
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
        const bad = auth.pinProblem(pin);
        if (bad) return json(400, { ok: false, error: 'PIN: ' + bad });
        // A passphrase an admin types for someone else is temporary: they must
        // choose their own at next sign-in (unless the admin turns that off).
        const force = target.id === gate.user.id ? false : body.forceChange !== false;
        Object.assign(patch, pinPatch(pin, force));
      }
      if (action === 'require-change') patch.must_change_pin = true;
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

      if (action === 'unlock') { patch.failed_attempts = 0; patch.locked_until = null; }
      if (!Object.keys(patch).length) return json(400, { ok: false, error: 'Nothing to update' });

      const { data, error } = await sb
        .from('dispatchers')
        .update(patch)
        .eq('id', id)
        .select(USER_COLS)
        .single();
      if (error) throw error;
      auth.clearSeen(data.username);
      return json(200, { ok: true, user: publicUser(data) });
    }

    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    return fail(err);
  }
};
