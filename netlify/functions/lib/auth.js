/**
 * lib/auth.js -- shared sign-in logic for the dispatch platform.
 *
 * One place for: PIN/passphrase hashing, the sign-in cookie, lockout after
 * repeated wrong tries, and checking who is calling.
 *
 * Sign-in cookie: after a good login, login.js sets an HttpOnly cookie
 * (mcr_auth). The browser sends it on every request to the site, including
 * links opened from the address bar. Page scripts cannot read it.
 *
 * The edge gate (netlify/edge-functions/gate.js) checks the same cookie in
 * front of every function. Functions that handle their own sign-in (the ones
 * that take username + pin in the request body) call verifyCredentials().
 *
 * Passphrases: 8 to 64 characters, letters, digits and symbols, case
 * sensitive. Older 4-8 digit PINs keep working until changed; the first
 * successful login converts the stored PIN to a salted hash and blanks the
 * plain-text copy.
 */

const crypto = require('crypto');

const COOKIE_NAME = 'mcr_auth';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;                 // wrong tries before a lock
const LOCK_MS = 10 * 60 * 1000;      // lock length
const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX_FAILS = 20;             // wrong tries per address in the window
const MIN_NEW_PIN = 8;
const MAX_PIN = 64;

// ---------- keys and encoding ----------

function secretMaterial() {
  return process.env.AUTH_SECRET || ('board-auth:' + (process.env.SUPABASE_SERVICE_ROLE_KEY || ''));
}

function signingKey() {
  return crypto.createHash('sha256').update(secretMaterial()).digest();
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64u(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ---------- passphrase hashing ----------

function normPin(pin) {
  return String(pin == null ? '' : pin).normalize('NFKC').trim();
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(normPin(pin), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + dk.toString('hex');
}

function verifyPinHash(pin, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const want = Buffer.from(parts[2], 'hex');
    const got = crypto.scryptSync(normPin(pin), salt, want.length);
    return crypto.timingSafeEqual(got, want);
  } catch (e) {
    return false;
  }
}

const DUMMY_HASH = 'scrypt$' + '00'.repeat(16) + '$' + '00'.repeat(64);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// Rules for a NEW passphrase (set by admin or by the person). Returns an
// error message, or '' when it is fine.
function pinProblem(pin) {
  const p = normPin(pin);
  if (p.length < MIN_NEW_PIN) return 'Use at least ' + MIN_NEW_PIN + ' characters.';
  if (p.length > MAX_PIN) return 'Use at most ' + MAX_PIN + ' characters.';
  if (/^(.)\1+$/.test(p)) return 'Do not repeat one character.';
  if (/^(?:0123456789|1234567890|12345678|87654321|23456789|98765432)/.test(p)) return 'That is too easy to guess.';
  if (/^(password|qwerty|letmein|dispatch|mcrdispatch)/i.test(p)) return 'That is too easy to guess.';
  return '';
}

// ---------- tokens ----------

function pinVersion(row) {
  const t = row && (row.pin_changed_at || row.created_at);
  const ms = t ? new Date(t).getTime() : 0;
  return String(isFinite(ms) ? ms : 0);
}

function makeToken(row) {
  const payload = b64u(JSON.stringify({
    u: row.username,
    r: row.role || 'dispatcher',
    v: pinVersion(row),
    e: Date.now() + TOKEN_TTL_MS,
  }));
  const sig = b64u(crypto.createHmac('sha256', signingKey()).update(payload).digest());
  return payload + '.' + sig;
}

function readToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const want = b64u(crypto.createHmac('sha256', signingKey()).update(payload).digest());
    if (!safeEqual(sig, want)) return null;
    const obj = JSON.parse(fromB64u(payload).toString('utf8'));
    if (!obj || !obj.u || !obj.e || obj.e < Date.now()) return null;
    return obj;
  } catch (e) {
    return null;
  }
}

function cookieHeader(token) {
  return COOKIE_NAME + '=' + token + '; Path=/; Max-Age=' + Math.floor(TOKEN_TTL_MS / 1000) + '; HttpOnly; Secure; SameSite=Strict';
}

function clearCookieHeader() {
  return COOKIE_NAME + '=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict';
}

function getHeader(event, name) {
  const h = (event && event.headers) || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
  return '';
}

function tokenFromEvent(event) {
  const cookie = getHeader(event, 'cookie');
  if (cookie) {
    const m = cookie.split(/;\s*/).find((c) => c.startsWith(COOKIE_NAME + '='));
    if (m) return m.slice(COOKIE_NAME.length + 1);
  }
  const auth = getHeader(event, 'authorization');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

function clientIp(event) {
  return String(getHeader(event, 'x-nf-client-connection-ip') || getHeader(event, 'x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

// ---------- calls from one function to another ----------

function internalValue() {
  return crypto.createHmac('sha256', signingKey()).update('internal-call').digest('hex');
}

function internalHeaders() {
  return { 'x-mcr-internal': internalValue() };
}

function isInternal(event) {
  const v = getHeader(event, 'x-mcr-internal');
  return !!v && safeEqual(v, internalValue());
}

// ---------- database side ----------

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (c) => '\\' + c);
}

function cleanUsername(u) {
  return String(u || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

const USER_COLS = 'id, username, role, states, active, technician_id, pin, pin_hash, pin_changed_at, created_at, failed_attempts, locked_until, must_change_pin';

async function logAttempt(sb, ip, username, ok, reason) {
  try {
    await sb.from('login_attempts').insert({ ip: ip || null, username: username || null, ok: !!ok, reason: reason || null });
  } catch (e) { /* best effort */ }
}

async function tooManyFromIp(sb, ip) {
  if (!ip || ip === 'unknown') return false;
  try {
    const since = new Date(Date.now() - IP_WINDOW_MS).toISOString();
    const { count } = await sb
      .from('login_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('ip', ip)
      .eq('ok', false)
      .gte('at', since);
    return (count || 0) >= IP_MAX_FAILS;
  } catch (e) {
    return false;
  }
}

function publicRow(row) {
  return {
    mustChange: row.must_change_pin === true,
    id: row.id,
    username: row.username,
    role: row.role || 'dispatcher',
    states: row.states || [],
    active: row.active !== false,
    technician_id: row.technician_id || null,
    pin_changed_at: row.pin_changed_at || null,
    created_at: row.created_at || null,
  };
}

/**
 * Check a username + passphrase. Returns { user } (row without secrets),
 * or { error, status }. Counts wrong tries and locks the login after
 * MAX_FAILS. opts.ip is the caller's address (for the per-address limit).
 */
async function verifyCredentials(sb, usernameRaw, pinRaw, opts) {
  const ip = (opts && opts.ip) || '';
  const username = cleanUsername(usernameRaw);
  const pin = normPin(pinRaw);
  if (!username || !pin) return { error: 'Username and PIN are required', status: 400 };

  if (await tooManyFromIp(sb, ip)) {
    await logAttempt(sb, ip, username, false, 'ip-limit');
    return { error: 'Too many attempts. Wait a few minutes and try again.', status: 429 };
  }

  const { data: row, error } = await sb
    .from('dispatchers')
    .select(USER_COLS)
    .ilike('username', escapeLike(username))
    .maybeSingle();
  if (error) return { error: 'Login check failed', status: 500 };

  if (!row) {
    verifyPinHash(pin, DUMMY_HASH); // keep timing similar
    await logAttempt(sb, ip, username, false, 'unknown-user');
    return { error: 'Invalid username or PIN', status: 401 };
  }

  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    const mins = Math.max(1, Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 60000));
    await logAttempt(sb, ip, row.username, false, 'locked');
    return { error: 'Too many wrong tries. This login is locked for about ' + mins + ' more minute' + (mins === 1 ? '' : 's') + '.', status: 429 };
  }

  let good = false;
  let legacy = false;
  if (row.pin_hash) {
    good = verifyPinHash(pin, row.pin_hash);
  } else if (row.pin) {
    good = safeEqual(String(row.pin).trim(), pin);
    legacy = good;
  } else {
    verifyPinHash(pin, DUMMY_HASH);
  }
  if (good && row.active !== true) good = false;

  if (!good) {
    const fails = (row.failed_attempts || 0) + 1;
    const patch = { failed_attempts: fails };
    if (fails >= MAX_FAILS) {
      patch.locked_until = new Date(Date.now() + LOCK_MS).toISOString();
      patch.failed_attempts = 0;
    }
    try { await sb.from('dispatchers').update(patch).eq('id', row.id); } catch (e) { /* ignore */ }
    await logAttempt(sb, ip, row.username, false, row.active === true ? 'bad-pin' : 'inactive');
    return { error: 'Invalid username or PIN', status: 401 };
  }

  const patch = { failed_attempts: 0, locked_until: null, last_seen_at: new Date().toISOString() };
  if (legacy) {
    // First good login on an old plain-text PIN: store a hash, blank the PIN.
    patch.pin_hash = hashPin(pin);
    patch.pin = '';
    patch.pin_changed_at = row.pin_changed_at || new Date().toISOString();
  }
  try { await sb.from('dispatchers').update(patch).eq('id', row.id); } catch (e) { /* ignore */ }
  if (legacy) row.pin_changed_at = patch.pin_changed_at;
  await logAttempt(sb, ip, row.username, true, legacy ? 'ok-upgraded' : 'ok');
  if (row.must_change_pin === true && !(opts && opts.allowMustChange)) {
    return { error: 'Choose a new password first: sign in on the main dispatch page and you will be asked for one.', status: 403, mustChange: true };
  }
  return { user: publicRow(row) };
}

// Short-lived memory of who is still allowed, so a burst of requests does not
// hit the database every time. A deactivated login or changed passphrase is
// noticed within this window.
const seen = new Map();
const SEEN_MS = 30 * 1000;

/**
 * Who is calling, from the sign-in cookie / bearer token. Returns { user } or
 * { error, status }. A call from another function (internal header) returns
 * { internal: true }.
 */
async function requireUser(sb, event, opts) {
  if (isInternal(event)) return { internal: true, user: { username: 'system', role: 'admin', states: [] } };
  const tk = readToken(tokenFromEvent(event));
  if (!tk) return { error: 'Sign in required', status: 401 };
  let row;
  const hit = seen.get(tk.u);
  if (hit && hit.until > Date.now()) {
    row = hit.row;
  } else {
    const { data, error } = await sb
      .from('dispatchers')
      .select('id, username, role, states, active, technician_id, pin_changed_at, created_at')
      .ilike('username', escapeLike(cleanUsername(tk.u)))
      .maybeSingle();
    if (error) return { error: 'Login check failed', status: 500 };
    row = data || null;
    seen.set(tk.u, { row, until: Date.now() + SEEN_MS });
  }
  if (!row || row.active !== true || pinVersion(row) !== tk.v) return { error: 'Sign in required', status: 401 };
  const roles = opts && opts.roles;
  if (roles && !roles.includes(row.role)) return { error: 'Not allowed for this login', status: 403 };
  return { user: publicRow(row) };
}

/**
 * For functions whose callers send username + pin in the body (older pages).
 * Accepts the sign-in cookie first; falls back to the body credentials.
 */
async function authenticateRequest(sb, event, body, opts) {
  const viaCookie = await requireUser(sb, event, opts);
  if (viaCookie.user) return viaCookie;
  if (body && body.username && body.pin) {
    const r = await verifyCredentials(sb, body.username, body.pin, { ip: clientIp(event) });
    if (r.user) {
      const roles = opts && opts.roles;
      if (roles && !roles.includes(r.user.role)) return { error: 'Not allowed for this login', status: 403 };
    }
    return r;
  }
  return viaCookie;
}

function clearSeen(username) {
  if (username) seen.delete(username); else seen.clear();
}

module.exports = {
  COOKIE_NAME, TOKEN_TTL_MS, MIN_NEW_PIN, MAX_PIN,
  hashPin, verifyPinHash, pinProblem, normPin,
  makeToken, readToken, cookieHeader, clearCookieHeader, tokenFromEvent, getHeader, clientIp,
  internalHeaders, isInternal,
  verifyCredentials, requireUser, authenticateRequest, clearSeen,
  escapeLike, cleanUsername,
};
