// gate.js -- the front door for every server function.
//
// Runs in front of /.netlify/functions/* . A request gets through only if it
// carries a valid sign-in cookie (set by login.js), or the function is on the
// short public list below (webhooks, the technician portal with its own
// sign-in, and the inventory pages Neumo staff use without an account).
//
// Levels:
//   public      anyone may call (PUBLIC)
//   admin only  sign-in with role admin (ADMIN_ONLY)
//   technician  role "tech" can only reach the mileage log functions (TECH_OK)
//   everything else: any active dispatcher or admin login
//
// Emergency switch: set the environment variable AUTH_ENFORCE to 0 in Netlify
// (and redeploy) to let everything through while still logging what would have
// been refused. Remove it to enforce again.

const COOKIE_NAME = 'mcr_auth';

// Functions anyone can reach. Each has a reason; revisit one at a time.
const PUBLIC = new Set([
  'login',                          // the sign-in itself
  'tech-api',                       // technician portal: its own sign-in
  'confirm-receipt',                // /ack link technicians tap (signed token inside)
  'get-watchdog-log',               // open by design (watchdog page)
  'mailgun-inbound',                // Mailgun webhook
  'mcp-server',                     // has its own shared secret
  'salesforce-report-sync-background', // called by its own scheduler
  // Inventory pages used by Neumo staff without accounts:
  'get-consumable-shipments',
  'get-inventory-detail',
  'get-inventory-history',
  'get-inventory-projection',
  'get-inventory-receipts',
  'get-inventory-sheet-checks',
  'mark-consumable-delivered',
  'send-inventory-set',
  'preview-inventory-date-text',
  'recover-inventory-mail',
]);

// Admin accounts only.
const ADMIN_ONLY = new Set([
  'adjust-distance-matrix-usage', 'apply-site-match', 'backfill-site-distance-gaps', 'backup-restore',
  'bluefolder-attachments-probe', 'bluefolder-service-requests-backfill', 'clear-distance-matrix-cooldown',
  'compute-distance-matrix', 'compute-site-distance-matrix', 'delete-location', 'delete-mileage-report',
  'delete-technician', 'geocode-addresses', 'geocode-unmatched-name', 'get-issue-trends',
  'get-mileage-reports', 'get-monthly-calls', 'get-repeat-issues', 'get-site-aliases', 'get-states',
  'get-unmatched-sites', 'manage-dispatchers', 'manage-states', 'migrate-distance-matrix-to-supabase',
  'process-mileage-timesheet', 'rematch-site-visits', 'save-site-aliases', 'seed-users',
  'backfill-co-blobs', 'backfill-locations-to-supabase', 'backfill-rma-site-id',
  'backfill-technicians-to-supabase', 'assign-default-techs-co', 'cleanup-duplicate-assignments',
  'cleanup-duplicate-oncall', 'diagnose-appointments-variants', 'diagnose-bluefolder-users',
  'view-sync-screenshot', 'distance-matrix-usage',
  // Mailbox pulls and syncs that are only ever run by hand:
  'pull-shipments-now', 'pull-mailbox', 'pull-shipments-mailbox', 'pull-state-closings', 'closings-sync',
  'bluefolder-sync', 'bluefolder-service-requests-sync', 'match-mailbox-closings', 'match-meet-replies',
  'send-morning-summary', 'send-notification-digests',
]);

// What a technician (role "tech") sign-in may call: the mileage log page.
const TECH_OK = new Set([
  'get-mileage-log', 'save-mileage-log', 'get-leg-distance', 'get-my-closings',
]);

const SEEN_MS = 60 * 1000;
const seen = new Map(); // username -> { row, until }

function b64uToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

function bytesToB64u(buf) {
  let s = '';
  const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function keyBytes() {
  const material = Netlify.env.get('AUTH_SECRET')
    ? Netlify.env.get('AUTH_SECRET')
    : 'board-auth:' + (Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || '');
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return new Uint8Array(d);
}

async function hmacHex(bytes, text) {
  const k = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function readToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const kb = await keyBytes();
    const k = await crypto.subtle.importKey('raw', kb, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(parts[0]));
    if (!sameString(bytesToB64u(sig), parts[1])) return null;
    const obj = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[0])));
    if (!obj || !obj.u || !obj.e || obj.e < Date.now()) return null;
    return obj;
  } catch (e) {
    return null;
  }
}

function cookieToken(request) {
  const c = request.headers.get('cookie') || '';
  const m = c.split(/;\s*/).find((x) => x.startsWith(COOKIE_NAME + '='));
  if (m) return m.slice(COOKIE_NAME.length + 1);
  const a = request.headers.get('authorization') || '';
  if (/^Bearer\s+/i.test(a)) return a.replace(/^Bearer\s+/i, '').trim();
  return '';
}

// Still allowed? (active, passphrase not changed since the cookie was issued.)
// Returns the current row, or null when it can be checked and fails. When the
// database cannot be reached the cookie is trusted for that moment.
async function currentRow(username) {
  const hit = seen.get(username);
  if (hit && hit.until > Date.now()) return hit.row;
  const url = Netlify.env.get('SUPABASE_URL');
  const key = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return undefined;
  try {
    const q = url + '/rest/v1/dispatchers?select=active,role,pin_changed_at,created_at&username=eq.' + encodeURIComponent(username) + '&limit=1';
    const r = await fetch(q, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    if (!r.ok) return undefined;
    const rows = await r.json();
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    seen.set(username, { row, until: Date.now() + SEEN_MS });
    return row;
  } catch (e) {
    return undefined;
  }
}

function pinVersion(row) {
  const t = row && (row.pin_changed_at || row.created_at);
  const ms = t ? new Date(t).getTime() : 0;
  return String(isFinite(ms) ? ms : 0);
}

function deny(status, code, message, fn) {
  console.log('[gate] ' + code + ' ' + fn);
  return new Response(JSON.stringify({ ok: false, error: message, code }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'x-mcr-gate': 'deny' },
  });
}

export default async (request) => {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/\.netlify\/functions\/([^\/]+)/);
  if (!m) return;
  const fn = m[1].replace(/\.(js|mjs|ts)$/, '');
  if (request.method === 'OPTIONS') return;
  if (PUBLIC.has(fn)) return;

  const enforce = Netlify.env.get('AUTH_ENFORCE') !== '0';

  // If this runtime cannot see the key the cookies are signed with, it cannot
  // check them. Let the request through (each function still has its own
  // checks where it matters) rather than lock everyone out, and say so in the log.
  if (!Netlify.env.get('AUTH_SECRET') && !Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    console.error('[gate] no signing key visible to edge functions; letting ' + fn + ' through');
    return;
  }

  // Calls from one function to another carry a value only the server can make.
  const internal = request.headers.get('x-mcr-internal');
  if (internal) {
    const want = await hmacHex(await keyBytes(), 'internal-call');
    if (sameString(internal, want)) return;
  }

  const tk = await readToken(cookieToken(request));
  let problem = null;
  if (!tk) {
    problem = ['auth_required', 401, 'Sign in required'];
  } else {
    const row = await currentRow(tk.u);
    if (row === null || (row && (row.active !== true || pinVersion(row) !== tk.v))) {
      problem = ['auth_required', 401, 'Sign in required'];
    } else {
      const role = (row && row.role) || tk.r;
      if (role === 'tech' && !TECH_OK.has(fn)) problem = ['forbidden', 403, 'Not allowed for this login'];
      else if (ADMIN_ONLY.has(fn) && role !== 'admin') problem = ['forbidden', 403, 'Admin login required'];
    }
  }

  if (!problem) return;
  if (!enforce) {
    console.log('[gate] WOULD DENY (' + problem[0] + ') ' + fn);
    return;
  }
  return deny(problem[1], problem[0], problem[2], fn);
};

export const config = {
  path: '/.netlify/functions/*',
};
