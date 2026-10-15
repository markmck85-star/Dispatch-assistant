/**
 * login.js -- v4 -- server-side sign-in
 *
 * Checks username + PIN/passphrase against dispatchers (lib/auth.js), counts
 * wrong tries (5 wrong = 10 minute lock, plus a per-address limit), and sets
 * the HttpOnly sign-in cookie the edge gate checks on every function call.
 * The old hard-coded backup logins are gone.
 *
 * POST { username, pin }            -> { ok, username, role, states, technician_id } + cookie
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

  const r = await auth.verifyCredentials(sb, payload.username, payload.pin, { ip: auth.clientIp(event) });
  if (!r.user) return json(r.status || 401, { error: r.error || 'Invalid username or PIN' });

  const token = auth.makeToken(r.user);
  return json(200, {
    ok: true,
    username: r.user.username,
    role: r.user.role,
    states: r.user.states,
    technician_id: r.user.technician_id,
  }, { 'Set-Cookie': auth.cookieHeader(token) });
};
