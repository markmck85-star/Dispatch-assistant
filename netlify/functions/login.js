/**
 * login.js -- v4 -- server-side sign-in
 *
 * Checks username + PIN/passphrase against dispatchers (lib/auth.js), counts
 * wrong tries (5 wrong = 10 minute lock, plus a per-address limit), and sets
 * the HttpOnly sign-in cookie the edge gate checks on every function call.
 * The old hard-coded backup logins are gone.
 *
 * POST { username, pin }            -> { ok, username, role, states, technician_id } + cookie
 * POST { username, pin, newPin }  -> when the login is flagged "must change", sets the new
 *                                     passphrase and signs in (no cookie until it is changed)
 * POST { action: 'logout' }         -> clears the cookie
 * GET                               -> { ok, signedIn, ...user } for the current cookie
 */

const { createClient } = require('@supabase/supabase-js');
const auth = require('./lib/auth');

function json(statusCode, obj, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extraHeaders || {}),
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Sign-in is not available right now' });
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (event.httpMethod === 'GET') {
    const r = await auth.requireUser(sb, event);
    if (!r.user) return json(200, { ok: true, signedIn: false });
    return json(200, { ok: true, signedIn: true, username: r.user.username, role: r.user.role, states: r.user.states, technician_id: r.user.technician_id });
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'Invalid JSON body' }); }

  if (payload.action === 'logout') {
    return json(200, { ok: true }, { 'Set-Cookie': auth.clearCookieHeader() });
  }

  const r = await auth.verifyCredentials(sb, payload.username, payload.pin, { ip: auth.clientIp(event), allowMustChange: true });
  if (!r.user) return json(r.status || 401, { error: r.error || 'Invalid username or PIN' });

  if (r.user.mustChange) {
    // No cookie until the person has chosen their own passphrase.
    const next = auth.normPin(payload.newPin);
    if (!next) {
      return json(403, { ok: false, mustChange: true, username: r.user.username, error: 'Choose a new password to continue.' });
    }
    if (next === auth.normPin(payload.pin)) {
      return json(400, { ok: false, mustChange: true, username: r.user.username, error: 'The new password must be different from the old one.' });
    }
    const bad = auth.pinProblem(next);
    if (bad) return json(400, { ok: false, mustChange: true, username: r.user.username, error: bad });
    const { data, error } = await sb
      .from('dispatchers')
      .update({
        pin_hash: auth.hashPin(next), pin: '', must_change_pin: false,
        pin_changed_at: new Date().toISOString(), failed_attempts: 0, locked_until: null,
      })
      .eq('id', r.user.id)
      .select('id, username, role, states, active, technician_id, pin_changed_at, created_at, must_change_pin')
      .single();
    if (error) return json(500, { error: 'Could not save the new password. Try again.' });
    auth.clearSeen(data.username);
    r.user = Object.assign({}, r.user, { pin_changed_at: data.pin_changed_at, mustChange: false });
  }

  const token = auth.makeToken(r.user);
  return json(200, {
    ok: true,
    username: r.user.username,
    role: r.user.role,
    states: r.user.states,
    technician_id: r.user.technician_id,
  }, { 'Set-Cookie': auth.cookieHeader(token) });
};
