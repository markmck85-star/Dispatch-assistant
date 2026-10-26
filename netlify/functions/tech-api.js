// tech-api.js
//
// Backend for tech-portal.html (MCR employee technicians, plus dispatchers/admins
// who have a staff_accounts login).
//
// Security model:
//  - Accounts live in tech_accounts (RLS on, no policies: only this function,
//    using the service-role key, can read them). Passwords are scrypt-hashed.
//  - Login returns an HMAC-signed token (12 h). Every request re-checks that the
//    technician is still active, still a non-contractor, and that the password
//    has not changed since the token was issued.
//  - All scoping (states, own shipments) is enforced here on the server. The
//    page never decides what a tech may see.
//  - Technician scope = home_state + additional_states on the technicians row.
//  - Staff (staff_accounts) have their own portal passwords, separate from their
//    dispatcher PINs. Scope is read live from the dispatchers row: everyone sees
//    only the states on their dispatcher login. Staff get the
//    shipments for their states instead of "my" shipments.
//  - Watchdog tab (staff only): dispatchers see their own state(s) plus the
//    Saturday On-Call group; admins see the full list the dispatch app's
//    watchdog page offers. This is a deliberate exception to the profile-states
//    rule above and applies to the watchdog action only.
//  - Fields returned are trimmed: no site notes, no contractor info, no
//    internal flags, no home addresses.
//
// POST JSON { action, token?, ... }
//   login            { username, password }
//   me               {}
//   search           { q }
//   site             { code }
//   shipments        { state, technician_id? }   technician_id (staff only) filters to one
//                    (v2026-10-13: first brings consumable_shipments up to date, see
//                    refreshConsumableShipments below, so new Neumo emails show without
//                    anyone opening the Inventory board)
//                    employee from the returned techs list for that state
//   watchdog         { state }   staff only; state is a value from me.watch.options
//   notify_tech      { tech, title, body, wo }   dispatch board login (or staff); pushes to that technician's phone if Dispatch alerts are on
//   push_config      {} ;  staff, and technicians for Dispatch alerts; { configured, publicKey } for subscribing this phone
//   push_status      { endpoint }   staff only; the choices saved for this phone
//   push_subscribe   { subscription, selections }   staff only; selections are values
//                    from me.watch.options, expanded to states here
//   oncall           {}             staff only; next Saturday's on-call dispatcher and technicians
//   push_unsubscribe { endpoint }   staff only
//   push_test        { endpoint }   staff only; sends one test notification
//   push_summary_test { endpoint }  staff only; sends a sample morning summary to this phone
//   change_password  { current, next }

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const boardAuthLib = require('./lib/auth');

const TECH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STAFF_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

// ---------- watchdog lists ----------
// Mirrors the state dropdown in watchdog-log.html. Keep in sync if a state is
// added there. GA is the umbrella region for GA + NC + SC (get-watchdog-log.js
// expands it), so NC and SC are not separate options.
const WATCH_REAL_STATES = ['CA', 'CO', 'FL', 'GA', 'ID', 'IL', 'IN', 'MI', 'MN', 'NV', 'OH', 'OR', 'WV'];
// Mirrors SAT_ONCALL_STATES in watchdog-log.html (and SAT_COVERAGE_STATES in
// admin.html / index.html). Keep in sync if a state is added there.
const SAT_ONCALL_STATES = ['GA', 'IN', 'MI', 'NV'];
const WATCH_LABELS = {
  ALL: 'All States',
  SAT_ONCALL: 'Saturday On-Call (GA/IN/MI/NV)',
  CA: 'California',
  CO: 'Colorado',
  FL: 'Florida',
  GA: 'Georgia / NC / SC',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  MI: 'Michigan',
  MN: 'Minnesota',
  NV: 'Nevada',
  OH: 'Ohio',
  OR: 'Oregon',
  WV: 'West Virginia',
};

function watchRegion(st) {
  const s = String(st || '').toUpperCase();
  return (s === 'NC' || s === 'SC') ? 'GA' : s;
}

// Published dates are stored per board region (NC and SC are on the GA board).
function pubRegion(s) { return watchRegion(s); }
// States the dispatch app may publish for when it has no portal token.
const PUBLISH_BOARD_STATES = ['AL', 'AR', 'CA', 'CO', 'FL', 'GA', 'ID', 'IL', 'IN', 'MI', 'MN', 'MS', 'NV', 'OH', 'OR', 'WV'];

// The selections a staff account may request on the watchdog tab.
// admin: everything. dispatcher: their own profile state(s), mapped to the
// watchdog's regions, plus Saturday On-Call.
function watchdogOptionsFor(role, states) {
  const opt = (v) => ({ value: v, label: WATCH_LABELS[v] || v });
  if (role === 'admin') return ['ALL', 'SAT_ONCALL'].concat(WATCH_REAL_STATES).map(opt);
  const own = [];
  (states || []).forEach((s) => {
    const r = watchRegion(s);
    if (r && own.indexOf(r) === -1) own.push(r);
  });
  return own.concat(['SAT_ONCALL']).map(opt);
}

function expandWatchSelection(sel) {
  if (sel === 'ALL') return WATCH_REAL_STATES;
  if (sel === 'SAT_ONCALL') return SAT_ONCALL_STATES;
  return [sel];
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}

// ---------- password + token helpers ----------

function normPw(pw) {
  return String(pw || '').trim().toLowerCase().replace(/[\s-]+/g, '');
}

function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(normPw(pw), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + dk.toString('hex');
}

function verifyPw(pw, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const want = Buffer.from(parts[2], 'hex');
    const got = crypto.scryptSync(normPw(pw), salt, want.length);
    return crypto.timingSafeEqual(got, want);
  } catch (e) {
    return false;
  }
}

const DUMMY_HASH = 'scrypt$' + '00'.repeat(16) + '$' + '00'.repeat(64);

function signingKey() {
  return crypto.createHash('sha256').update('tech-portal:' + (process.env.SUPABASE_SERVICE_ROLE_KEY || '')).digest();
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// kind: 't' (technician, id = technician_id) or 's' (staff, id = staff username)
function makeToken(id, pv, kind) {
  kind = kind || 't';
  const ttl = kind === 's' ? STAFF_TTL_MS : TECH_TTL_MS;
  const payload = b64u(JSON.stringify({ t: id, p: pv, k: kind, e: Date.now() + ttl }));
  const sig = b64u(crypto.createHmac('sha256', signingKey()).update(payload).digest());
  return payload + '.' + sig;
}

function readToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const want = b64u(crypto.createHmac('sha256', signingKey()).update(payload).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const obj = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!obj || !obj.t || !obj.e || obj.e < Date.now()) return null;
    return obj;
  } catch (e) {
    return null;
  }
}

function pwVersion(acct) {
  return String(new Date(acct.password_changed_at || acct.created_at).getTime());
}

// ---------- scoping ----------

function statesFor(tech) {
  const set = new Set();
  if (tech.home_state) set.add(String(tech.home_state).toUpperCase());
  (tech.additional_states || []).forEach((s) => { if (s) set.add(String(s).toUpperCase()); });
  return [...set];
}

function eligible(tech) {
  return !!tech && tech.active !== false && tech.is_contractor === false;
}

// ctx = { kind, name, states (array, or null = all states), tech?, key, role? }
async function authenticate(supabase, token) {
  const tk = readToken(token);
  if (!tk) return null;

  if (tk.k === 's') {
    const { data: acct } = await supabase
      .from('staff_accounts')
      .select('username, dispatcher_username, display_name, default_state, technician_id, created_at, password_changed_at')
      .eq('username', tk.t)
      .maybeSingle();
    if (!acct || pwVersion(acct) !== tk.p) return null;
    const { data: d } = await supabase
      .from('dispatchers')
      .select('username, role, states, active, technician_id')
      .eq('username', acct.dispatcher_username)
      .maybeSingle();
    if (!staffOk(d)) return null;
    return { kind: 's', name: acct.display_name, states: staffStates(d), role: d.role, key: acct.username, defaultState: acct.default_state || null, technicianId: d.technician_id || acct.technician_id || null };
  }

  const { data: acct } = await supabase
    .from('tech_accounts')
    .select('technician_id, username, created_at, password_changed_at')
    .eq('technician_id', tk.t)
    .maybeSingle();
  if (!acct || pwVersion(acct) !== tk.p) return null;
  const { data: tech } = await supabase
    .from('technicians')
    .select('id, name, home_state, additional_states, is_contractor, active')
    .eq('id', acct.technician_id)
    .maybeSingle();
  if (!eligible(tech)) return null;
  return { kind: 't', name: tech.name, states: statesFor(tech), tech, key: acct.technician_id, defaultState: tech.home_state ? String(tech.home_state).toUpperCase() : null };
}

function staffOk(d) {
  return !!d && d.active === true && (d.role === 'admin' || d.role === 'dispatcher');
}

// Admins and dispatchers alike are limited to the states on their dispatcher login.
function staffStates(d) {
  return (d.states || []).map((x) => String(x).toUpperCase());
}

function cleanQuery(q) {
  // Keep only characters safe to embed in a PostgREST or() filter.
  return String(q || '').replace(/[^A-Za-z0-9 #&'.\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// What the page needs to draw itself: the account's states that actually have
// locations (for the state dropdown) and which one to open first. Staff also get
// the watchdog tab's options and default selection.
async function buildMe(supabase, kind, name, states, defaultState, role) {
  let list = states || [];
  if (list.length > 1) {
    const { data } = await supabase
      .from('sites')
      .select('state')
      .in('state', list)
      .eq('active', true)
      .eq('is_placeholder', false)
      .limit(5000);
    const have = new Set((data || []).map((r) => String(r.state || '').toUpperCase()));
    const filtered = list.filter((x) => have.has(x));
    if (filtered.length) list = filtered;
  }
  const home = defaultState && list.includes(defaultState) ? defaultState : (list[0] || null);
  const me = { name, states: list, home, kind };
  if (kind === 's') {
    // Options come from the account's full profile states, not the filtered
    // list above, so a state with no locations loaded still has a watchdog view.
    const options = watchdogOptionsFor(role, states || []);
    const homeRegion = watchRegion(home);
    const watchHome = options.some((o) => o.value === homeRegion) ? homeRegion : options[0].value;
    me.watch = { options, home: watchHome };
  }
  return me;
}

// ---------- actions ----------

async function doLogin(supabase, body) {
  let username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const fail = () => json(401, { ok: false, error: 'Incorrect username or password.' });
  if (!username || !password) return fail();

  // Staff sign in as "<name>.portal" so browsers keep that saved login separate
  // from the main app's (same site, same username otherwise). Plain names still work.
  let staffOnly = false;
  if (username.endsWith('.portal')) { username = username.slice(0, -7); staffOnly = true; }

  let tAcct = null;
  if (!staffOnly) {
    const r = await supabase
      .from('tech_accounts')
      .select('technician_id, username, password_hash, failed_attempts, locked_until, created_at, password_changed_at')
      .eq('username', username)
      .maybeSingle();
    tAcct = r.data;
  }
  let sAcct = null;
  if (!tAcct) {
    const r = await supabase
      .from('staff_accounts')
      .select('username, dispatcher_username, display_name, default_state, password_hash, failed_attempts, locked_until, created_at, password_changed_at')
      .eq('username', username)
      .maybeSingle();
    sAcct = r.data;
  }
  const acct = tAcct || sAcct;
  if (!acct) {
    verifyPw(password, DUMMY_HASH); // keep timing similar
    return fail();
  }
  const table = tAcct ? 'tech_accounts' : 'staff_accounts';
  const keyCol = tAcct ? 'technician_id' : 'username';
  const keyVal = tAcct ? acct.technician_id : acct.username;

  if (acct.locked_until && new Date(acct.locked_until).getTime() > Date.now()) {
    return json(429, { ok: false, error: 'Too many attempts. Try again in a few minutes.' });
  }

  const good = verifyPw(password, acct.password_hash);
  if (!good) {
    const attempts = (acct.failed_attempts || 0) + 1;
    const patch = { failed_attempts: attempts };
    if (attempts >= MAX_FAILS) {
      patch.locked_until = new Date(Date.now() + LOCK_MS).toISOString();
      patch.failed_attempts = 0;
    }
    await supabase.from(table).update(patch).eq(keyCol, keyVal);
    return fail();
  }

  let me;
  if (tAcct) {
    const { data: tech } = await supabase
      .from('technicians')
      .select('id, name, home_state, additional_states, is_contractor, active')
      .eq('id', acct.technician_id)
      .maybeSingle();
    if (!eligible(tech)) return json(403, { ok: false, error: 'This account is not active.' });
    me = await buildMe(supabase, 't', tech.name, statesFor(tech), tech.home_state ? String(tech.home_state).toUpperCase() : null);
  } else {
    const { data: d } = await supabase
      .from('dispatchers')
      .select('username, role, states, active')
      .eq('username', acct.dispatcher_username)
      .maybeSingle();
    if (!staffOk(d)) return json(403, { ok: false, error: 'This account is not active.' });
    me = await buildMe(supabase, 's', acct.display_name, staffStates(d), acct.default_state || null, d.role);
  }

  await supabase
    .from(table)
    .update({ failed_attempts: 0, locked_until: null, last_login_at: new Date().toISOString() })
    .eq(keyCol, keyVal);

  return json(200, {
    ok: true,
    token: makeToken(keyVal, pwVersion(acct), me.kind),
    me,
  });
}

async function doSearch(supabase, ctx, body) {
  const q = cleanQuery(body.q);
  // Empty query returns every site in the caller's scope (the page loads this
  // once and filters on the phone). A typed query is filtered here.
  let sq = supabase
    .from('sites')
    .select('site_code, name, address, state, county, machine_type');
  if (!ctx.states.length) return json(200, { ok: true, sites: [] });
  // One state at a time. The page sends the chosen state; it must be one the
  // account covers, otherwise fall back to the account's first state.
  const want = String(body.state || '').toUpperCase();
  const useState = ctx.states.includes(want) ? want : ctx.states[0];
  sq = sq.eq('state', useState);
  sq = sq.eq('active', true).eq('is_placeholder', false);
  if (q.length >= 2) {
    const pat = '%' + q + '%';
    sq = sq.or('name.ilike.' + pat + ',site_code.ilike.' + pat + ',address.ilike.' + pat + ',county.ilike.' + pat);
  } else if (q.length) {
    return json(200, { ok: true, sites: [] });
  }
  const { data, error } = await sq
    .order('state', { ascending: true })
    .order('name', { ascending: true })
    .limit(q.length ? 60 : 1500);
  if (error) return json(500, { ok: false, error: 'Search failed.' });
  return json(200, { ok: true, sites: data || [] });
}

async function doSite(supabase, ctx, body) {
  const code = String(body.code || '').trim();
  if (!code) return json(400, { ok: false, error: 'Missing site.' });
  const { data: site } = await supabase
    .from('sites')
    .select('id, site_code, name, address, state, county, machine_type')
    .eq('site_code', code)
    .maybeSingle();
  // Out-of-scope sites look exactly like missing ones.
  if (!site || (ctx.states && !ctx.states.includes(String(site.state || '').toUpperCase()))) {
    return json(404, { ok: false, error: 'Site not found.' });
  }

  const [visitsR, ticketsR, bfR] = await Promise.all([
    supabase
      .from('site_visits')
      .select('started_at, tech_name_raw, remediation, remediation_detail, is_restock, wo_number, closing_note')
      .eq('site_id', site.id)
      .order('started_at', { ascending: false, nullsFirst: false })
      .limit(60),
    supabase
      .from('tickets')
      .select('wo_number, ticket_kind, status, issue_category, issue_detail, description, received_at')
      .eq('site_id', site.id)
      .order('received_at', { ascending: false, nullsFirst: false })
      .limit(40),
    supabase
      .from('bluefolder_service_requests')
      .select('service_request_id, description, detailed_description, status, type, date_time_created, date_time_closed')
      .eq('site_id', site.id)
      .order('date_time_closed', { ascending: false, nullsFirst: false })
      .limit(60),
  ]);
  if (visitsR.error) return json(500, { ok: false, error: 'Could not load history.' });

  const visits = (visitsR.data || []).map((v) => ({
    when: v.started_at,
    tech: v.tech_name_raw || null,
    type: v.remediation || 'Visit',
    detail: v.remediation_detail || null,
    note: v.closing_note || null,
    restock: !!v.is_restock,
    wo: v.wo_number || null,
  }));
  const seenWo = new Set(visits.map((v) => v.wo).filter(Boolean).map(String));

  (ticketsR.data || []).forEach((t) => {
    if (t.wo_number && seenWo.has(String(t.wo_number))) return;
    visits.push({
      when: t.received_at,
      tech: null,
      type: t.issue_category || t.ticket_kind || 'Service call',
      detail: [t.issue_detail, t.description].filter(Boolean).join(' - ') || null,
      note: null,
      restock: t.ticket_kind === 'restock',
      wo: t.wo_number || null,
      status: t.status || null,
    });
  });
  (bfR.data || []).forEach((sr) => {
    const wo = sr.service_request_id ? String(sr.service_request_id) : null;
    if (wo && seenWo.has(wo)) return;
    visits.push({
      when: sr.date_time_closed || sr.date_time_created,
      tech: null,
      type: sr.type || sr.status || 'Service request',
      detail: sr.description || null,
      note: sr.detailed_description || null,
      restock: /\b(prevent|preventative|restock)\b/i.test(String(sr.type || '') + ' ' + String(sr.description || '')),
      wo,
    });
  });

  visits.sort((a, b) => (b.when ? new Date(b.when).getTime() : 0) - (a.when ? new Date(a.when).getTime() : 0));

  return json(200, {
    ok: true,
    site: {
      code: site.site_code, name: site.name, address: site.address,
      state: site.state, county: site.county, machine_type: site.machine_type,
    },
    visits: visits.slice(0, 80),
  });
}

// Active technicians whose home or additional states include the given state:
// the employee drop-down on the staff shipments view.
async function rosterForState(supabase, state) {
  const { data } = await supabase
    .from('technicians')
    .select('id, name, home_state, additional_states, active')
    .limit(2000);
  return (data || [])
    .filter((t) => t.active !== false && t.name && statesFor(t).includes(state))
    .map((t) => ({ id: t.id, name: t.name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// ---------- consumable shipment refresh (added 2026-10-13) ----------
// consumable_shipments is only rebuilt from inbound_emails when
// get-consumable-shipments.js runs, which used to happen only when someone
// opened the Inventory board. That left new restock requests and warehouse
// tracking replies invisible in this portal for hours. Now every Shipments
// load makes sure the table is current first.
//
// Cost control (Netlify credits): per warm function instance,
//   - never re-check more often than every 2 minutes;
//   - between 2 and 10 minutes after the last rebuild, rebuild only if a new
//     restock email has arrived since (one tiny query);
//   - after 10 minutes, or on a cold start, rebuild regardless.
// A rebuild is one short run of the same code the Inventory board uses. It can
// never break this page: any error or a slow run (>7 s) is logged and skipped,
// and the page just reads what is already saved.
let lastShipSyncAt = 0;
const SHIP_RECHECK_MS = 2 * 60 * 1000;
const SHIP_MAX_AGE_MS = 10 * 60 * 1000;
const SHIP_SYNC_TIMEOUT_MS = 7000;

async function refreshConsumableShipments(supabase) {
  try {
    const now = Date.now();
    const age = now - lastShipSyncAt;
    if (lastShipSyncAt && age < SHIP_RECHECK_MS) return;
    if (lastShipSyncAt && age < SHIP_MAX_AGE_MS) {
      const { data, error } = await supabase
        .from('inbound_emails')
        .select('id')
        .gte('received_at', new Date(lastShipSyncAt).toISOString())
        .or('subject.ilike.%RESTOCK MCR%,subject.ilike.%DCO MCR%')
        .limit(1);
      if (!error && !(data && data.length)) return; // nothing new since last rebuild
    }
    lastShipSyncAt = now; // set first so concurrent requests on this instance do not pile on
    const shipments = require('./get-consumable-shipments.js');
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), SHIP_SYNC_TIMEOUT_MS); });
    const run = shipments.handler({ httpMethod: 'GET', queryStringParameters: {} });
    const result = await Promise.race([run, timeout]);
    clearTimeout(timer);
    if (result === 'timeout') console.warn('consumable shipment refresh timed out; showing saved rows');
  } catch (e) {
    console.warn('consumable shipment refresh failed:', e && e.message);
  }
}

async function doShipments(supabase, ctx, body) {
  await refreshConsumableShipments(supabase);
  let roster = null;
  let rmaQ = supabase
    .from('rma_shipments')
    .select('account_name, wo_number, case_number, warehouse_name, request_details, outbound_tracking, inbound_tracking, return_broken_part, returned_at, received_at, technician_id, state')
    .order('received_at', { ascending: false, nullsFirst: false })
    .limit(ctx.kind === 's' ? 80 : 40);
  let conQ = supabase
    .from('consumable_shipments')
    .select('request_date, shipped_at, ship_method, boxes_shipped, items, tracking, status, delivered_at, technician_id, tech_name_raw, state')
    .order('request_date', { ascending: false, nullsFirst: false })
    .limit(ctx.kind === 's' ? 50 : 25);
  if (ctx.kind === 't') {
    rmaQ = rmaQ.eq('technician_id', ctx.tech.id);
    conQ = conQ.eq('technician_id', ctx.tech.id);
  } else {
    if (!ctx.states.length) return json(200, { ok: true, rma: [], consumables: [] });
    const want = String((body && body.state) || '').toUpperCase();
    const useState = ctx.states.includes(want) ? want : ctx.states[0];
    rmaQ = rmaQ.eq('state', useState);
    conQ = conQ.eq('state', useState);
    // Employee filter (staff view). Applied in the query, not on the phone, so
    // the row limits above apply to that one employee's shipments.
    roster = await rosterForState(supabase, useState);
    const wantTech = String((body && body.technician_id) || '').trim();
    if (wantTech) {
      if (!roster.some((t) => String(t.id) === wantTech)) return json(400, { ok: false, error: 'Unknown employee.' });
      rmaQ = rmaQ.eq('technician_id', wantTech);
      conQ = conQ.eq('technician_id', wantTech);
    }
  }
  const [rmaR, conR] = await Promise.all([rmaQ, conQ]);
  if (rmaR.error || conR.error) return json(500, { ok: false, error: 'Could not load shipments.' });

  // Staff view labels each shipment with the technician it belongs to.
  const techIds = new Set();
  if (ctx.kind === 's') {
    (rmaR.data || []).forEach((r) => r.technician_id && techIds.add(r.technician_id));
    (conR.data || []).forEach((c) => c.technician_id && techIds.add(c.technician_id));
  }
  const techName = {};
  if (techIds.size) {
    const { data: ts } = await supabase.from('technicians').select('id, name').in('id', [...techIds]);
    (ts || []).forEach((t) => { techName[t.id] = t.name; });
  }

  const rma = rmaR.data || [];
  const con = conR.data || [];

  const nums = new Set();
  rma.forEach((r) => { if (r.outbound_tracking) nums.add(r.outbound_tracking); if (r.inbound_tracking) nums.add(r.inbound_tracking); });
  con.forEach((c) => (Array.isArray(c.tracking) ? c.tracking : []).forEach((n) => n && nums.add(n)));

  const statusByNum = {};
  if (nums.size) {
    const { data: ships } = await supabase
      .from('shipments')
      .select('tracking_number, status, delivered_at, last_event_at')
      .in('tracking_number', [...nums]);
    (ships || []).forEach((s) => { statusByNum[s.tracking_number] = { status: s.status, delivered_at: s.delivered_at, last_event_at: s.last_event_at }; });
  }

  return json(200, {
    ok: true,
    techs: roster || undefined,
    rma: rma.map((r) => ({
      location: r.account_name,
      wo: r.wo_number,
      case_number: r.case_number,
      warehouse: r.warehouse_name,
      details: r.request_details,
      outbound: r.outbound_tracking,
      inbound: r.inbound_tracking,
      outbound_status: r.outbound_tracking ? (statusByNum[r.outbound_tracking] || null) : null,
      inbound_status: r.inbound_tracking ? (statusByNum[r.inbound_tracking] || null) : null,
      return_broken_part: !!r.return_broken_part,
      returned_at: r.returned_at,
      received_at: r.received_at,
      tech: ctx.kind === 's' ? (techName[r.technician_id] || null) : undefined,
      state: ctx.kind === 's' ? r.state : undefined,
    })),
    consumables: con.map((c) => {
      const tr = Array.isArray(c.tracking) ? c.tracking : [];
      return {
        requested: c.request_date,
        shipped: c.shipped_at,
        method: c.ship_method,
        boxes: c.boxes_shipped,
        items: Array.isArray(c.items) ? c.items.map((i) => ({ description: i.description, sku: i.sku, units: i.units, unit: i.unit, boxes: i.boxes })) : [],
        tracking: tr.map((n) => ({ number: n, status: statusByNum[n] || null })),
        status: c.status,
        delivered_at: c.delivered_at,
        tech: ctx.kind === 's' ? (techName[c.technician_id] || c.tech_name_raw || null) : undefined,
        state: ctx.kind === 's' ? c.state : undefined,
      };
    }),
  });
}

// Runs get-watchdog-log.js's own handler in-process for one state code, so the
// ticket selection, staleness cutoff and region expansion stay defined in one
// place. (Lazy require keeps unit tests of this file light.)
async function fetchWatchdogState(state) {
  const watchdog = require('./get-watchdog-log.js');
  const resp = await watchdog.handler({ httpMethod: 'GET', queryStringParameters: { state } });
  let data = {};
  try { data = JSON.parse(resp.body || '{}'); } catch (e) { data = {}; }
  if (resp.statusCode !== 200) throw new Error(data.error || ('watchdog ' + state + ' failed'));
  return data.entries || [];
}

async function doWatchdog(ctx, body) {
  if (ctx.kind !== 's') return json(403, { ok: false, error: 'Not available for this account.' });
  const options = watchdogOptionsFor(ctx.role, ctx.states);
  const want = String((body && body.state) || '').trim().toUpperCase();
  const picked = options.find((o) => o.value === want);
  if (!picked) return json(403, { ok: false, error: 'Not available for this account.' });

  // Each state is its own call because get-watchdog-log.js takes one state at a time.
  const results = await Promise.all(expandWatchSelection(picked.value).map((s) => fetchWatchdogState(s)));
  const seen = new Set();
  const entries = [];
  results.forEach((list) => list.forEach((e) => {
    const k = e.ticketId || (e.woNumber + '|' + e.siteText);
    if (seen.has(k)) return;
    seen.add(k);
    entries.push({
      woNumber: e.woNumber,
      siteText: e.siteText,
      siteCode: e.siteCode,
      siteName: e.siteName,
      ticketKind: e.ticketKind,
      needsReview: !!e.needsReview,
      matched: !!e.matched,
      issueCategory: e.issueCategory,
      issueDetail: e.issueDetail,
      description: e.description,
      address: e.address,
      dueAt: e.dueAt,
      slaEndsAt: e.slaEndsAt,
      receivedAt: e.receivedAt,
      loomisMeetStatus: e.loomisMeetStatus,
      loomisMeetConfirmedAt: e.loomisMeetConfirmedAt,
    });
  }));
  entries.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
  return json(200, { ok: true, state: picked.value, label: picked.label, entries });
}




// The dispatch board signs in with a username and PIN (login.js) and keeps
// both for the session, the same way its tool settings call does. Publishing
// from the board must present them; they are checked here against dispatchers.
async function boardAuth(supabase, body, event) {
  // Signed in by cookie, or by the board's username + PIN in the body
  // (lib/auth.js: hashed, with lockout).
  const r = await boardAuthLib.authenticateRequest(supabase, event || { headers: {} }, body || {});
  if (!r.user) return null;
  const d = r.user;
  if (d.role !== 'admin' && d.role !== 'dispatcher') return null;
  const states = d.role === 'admin' ? PUBLISH_BOARD_STATES : (d.states || []).map((x) => String(x).toUpperCase());
  return { kind: 's', name: d.username, states, role: d.role, key: d.username };
}

// ---------- check if a date/state is published ----------
async function doPublishStatus(supabase, ctx, body) {
  const date = String((body && body.date) || '').trim();
  const state = pubRegion((body && body.state) || '');
  if (!date || !state) return json(200, { ok: true, published: false });
  const { data } = await supabase
    .from('published_dispatches')
    .select('dispatch_date')
    .eq('dispatch_date', date)
    .eq('state', state)
    .limit(1);
  return json(200, { ok: true, published: !!(data && data.length) });
}

// ---------- publish / unpublish today's stops (staff only) ----------
async function doPublishStops(supabase, ctx, body) {
  if (ctx.kind !== 's' && ctx.kind !== 'a' && !(ctx.role === 'admin')) return json(403, { ok: false, error: 'Staff or admin only.' });
  const date = String((body && body.date) || '').trim();
  const state = pubRegion((body && body.state) || '');
  const on = !!(body && body.on);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !state) return json(400, { ok: false, error: 'Date and state required.' });
  if (!(ctx.states || []).map(pubRegion).includes(state)) return json(403, { ok: false, error: 'Not your state.' });

  let err = null;
  if (on) {
    const row = { dispatch_date: date, state, published_at: new Date().toISOString() };
    // Optional: the finished message text per technician, as shown in the
    // dispatch app's Messages view. Plain text only (the portal draws it with
    // textContent). Left out on a plain re-publish so earlier text is kept.
    const rawMsgs = body && body.messages;
    if (rawMsgs && typeof rawMsgs === 'object' && !Array.isArray(rawMsgs)) {
      const clean = {};
      Object.keys(rawMsgs).slice(0, 80).forEach((k) => {
        const v = rawMsgs[k];
        if (typeof v === 'string' && v.trim()) clean[String(k).slice(0, 80)] = v.slice(0, 4000);
      });
      row.messages = clean;
    }
    ({ error: err } = await supabase.from('published_dispatches').upsert(row, { onConflict: 'dispatch_date,state' }));
  } else {
    ({ error: err } = await supabase.from('published_dispatches').delete().eq('dispatch_date', date).eq('state', state));
  }
  if (err) return json(500, { ok: false, error: 'Could not save. Try again.' });
  return json(200, { ok: true, date, state, published: on });
}

// ---------- tech marks a stop done ----------
async function doCompleteStop(supabase, ctx, body) {
  const id = body && body.id;
  if (!id) return json(400, { ok: false, error: 'Missing stop.' });
  // Only the assigned tech (or staff) can complete
  const { data: a } = await supabase.from('assignments').select('id, technician_id, site_id, dispatch_date').eq('id', id).single();
  if (!a) return json(404, { ok: false, error: 'Stop not found.' });
  if (ctx.kind === 't') {
    if (!ctx.tech || ctx.tech.id !== a.technician_id) return json(403, { ok: false, error: 'Not your stop.' });
  }

  // 2026-10-16: optional exact count of forms left on each old roll, typed on the portal's
  // Done prompt. Saved to restock_leftover_counts (one row per assignment; re-entry replaces it).
  // Only whole numbers 0-2000 under known roll names are kept. A failure here never blocks
  // marking the stop done; the reply says whether the counts were saved.
  let leftoversSaved = null;
  const rolls = cleanLeftovers(body && body.leftovers);
  if (rolls) {
    // Update-or-insert by hand (the table's unique index on assignment_id is partial, which
    // supabase-js upsert cannot target).
    let lErr = null;
    const { data: prior, error: pErr } = await supabase.from('restock_leftover_counts').select('id').eq('assignment_id', a.id).limit(1);
    if (pErr) lErr = pErr;
    else if (prior && prior.length) {
      ({ error: lErr } = await supabase.from('restock_leftover_counts')
        .update({ rolls, source: 'portal', entered_at: new Date().toISOString() }).eq('id', prior[0].id));
    } else {
      ({ error: lErr } = await supabase.from('restock_leftover_counts').insert({
        site_id: a.site_id,
        assignment_id: a.id,
        technician_id: a.technician_id || (ctx.tech && ctx.tech.id) || null,
        dispatch_date: a.dispatch_date,
        rolls,
        source: 'portal'
      }));
    }
    leftoversSaved = !lErr;
    if (lErr) console.error('[tech-api] leftover counts not saved:', lErr.message);
  }

  await supabase.from('assignments').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', id);
  return json(200, { ok: true, leftoversSaved });
}

// Roll names the Done prompt can send: LF / RF (left and right forms), P1-P4 (multi-printer sites),
// and J (journal paper, counted in inches; added 2026-10-20, allowed up to 20000 since a journal
// roll runs far longer than a forms roll).
function cleanLeftovers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  ['LF', 'RF', 'P1', 'P2', 'P3', 'P4', 'J'].forEach((k) => {
    const v = raw[k];
    if (v === undefined || v === null || v === '') return;
    const isJ = k === 'J';
    const max = isJ ? 20000 : 2000;
    const re = isJ ? /^\d{1,5}$/ : /^\d{1,4}$/;
    const n = typeof v === 'number' ? v : (re.test(String(v).trim()) ? parseInt(String(v).trim(), 10) : NaN);
    if (Number.isInteger(n) && n >= 0 && n <= max) out[k] = n;
  });
  return Object.keys(out).length ? out : null;
}

// A dispatcher/admin who also works stops is linked to their technicians row
// by staff_accounts.technician_id (set by hand). No link means no stops of
// their own to show; names are never guessed.
async function staffTechId(supabase, ctx) {
  return ctx.technicianId || null;
}

// ---------- stop details shown the way the dispatch app's summary shows them ----------
// The per-state "journal low" cutoff lives in Blobs ("dispatch" store, settings/<STATE>),
// the same place the dispatch board saves it. Falls back to 3000 like the board does.
async function journalLowThreshold(region) {
  try {
    const { getStore } = require('@netlify/blobs');
    const v = await getStore('dispatch').get('settings/' + region, { type: 'json' });
    const n = v && parseInt(v.journalLowThreshold, 10);
    return n > 0 ? n : 3000;
  } catch (e) { return 3000; }
}

// Mirrors the counts rules of the dispatch summary in index.html (LF always, LR only when
// it matters, RF when above zero, Journal when requested or low). Surfboard and Big Hoku
// sites use their own variations on the board and are shown here with the standard rules.
function describeStop(fc, ticket, jLow) {
  const kind = ticket.ticket_kind || '';
  // 2026-10-23: a maintenance-kind ticket is not always a restock (a UPS replacement
  // work order is kind 'maintenance' with category Hardware). Only label it a consumable
  // restock when its category is Maintenance (or has none); otherwise show its real issue.
  const cat = String(ticket.issue_category || '').trim();
  const isRestock = (kind === 'maintenance' || kind === 'restock') && (!cat || /^maintenance$/i.test(cat));
  let issue = '';
  if (isRestock) issue = 'Maintenance – Consumable Restock';
  else if (ticket.issue_category) issue = ticket.issue_category + (ticket.issue_detail ? ' – ' + ticket.issue_detail : '');
  const out = { restockBy: null, issue, items: null, counts: [], printers: 0 };
  if (!fc || typeof fc !== 'object') return out;
  out.restockBy = fc.restockBy || null;
  out.items = fc.consumables || null;
  if (fc.isMultiPrinter) out.printers = 2 + (fc.P3F != null ? 1 : 0) + (fc.P4F != null ? 1 : 0);
  const listed = String(fc.consumables || '').toLowerCase();
  const ribbon = listed.includes('ribbon');
  const leftForms = listed.includes('left forms');
  const journalReq = listed.includes('journal');
  const num = (v) => typeof v === 'number' && !isNaN(v);
  const journalLow = num(fc.Journal) && fc.Journal < jLow;
  const parts = [];
  if (fc.isMultiPrinter) {
    ['P1F', 'P1R', 'P2F', 'P2R', 'P3F', 'P3R', 'P4F', 'P4R'].forEach(k => { if (num(fc[k])) parts.push(k + ': ' + fc[k]); });
    if (num(fc.Journal)) parts.push('J: ' + fc.Journal);
  } else {
    if (num(fc.LF)) parts.push('LF: ' + fc.LF);
    if (!ribbon && num(fc.LR) && ((num(fc.LF) && fc.LR < fc.LF) || (leftForms && fc.LR < 800))) parts.push('LR: ' + fc.LR + ' ⚠️');
    if (num(fc.RF) && fc.RF > 0) parts.push('RF: ' + fc.RF);
    if ((journalReq || journalLow) && num(fc.Journal)) {
      parts.push(fc.Journal < 850 ? 'J: ' + fc.Journal + ' — Journal Paper critically low or out'
        : fc.Journal < jLow ? 'J: ' + fc.Journal + ' — Journal Paper low' : 'J: ' + fc.Journal);
    }
  }
  out.counts = parts;
  return out;
}

// ---------- my stops (tech or staff, own assignments only) ----------
async function doMyStops(supabase, ctx, body) {
  const date = String((body && body.date) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { ok: false, error: 'Pick a date.' });

  // Only show if this date has been published for the tech's state(s)
  const states = ctx.states || [];
  // NC and SC publish under the GA board.
  const normStates = [...new Set(states.map(pubRegion))];
  const { data: pub } = await supabase
    .from('published_dispatches')
    .select('dispatch_date, state, messages')
    .eq('dispatch_date', date)
    .in('state', normStates)
    .limit(20);
  if (ctx.kind !== 's' && (!pub || !pub.length)) return json(200, { ok: true, date, stops: [], published: false });

  // Resolve technician id for this login
  let techId = null;
  if (ctx.kind === 't') {
    techId = ctx.tech && ctx.tech.id ? ctx.tech.id : null;
  } else if (body && body.tech) {
    const { data } = await supabase.from('technicians').select('id').ilike('name', body.tech).limit(1);
    techId = data && data[0] ? data[0].id : null;
  } else {
    techId = await staffTechId(supabase, ctx);
  }
  if (!techId) return json(200, { ok: true, date, stops: [], published: true, noTech: ctx.kind === 's' });

  // The message the dispatcher published for this technician (if any).
  let techName = ctx.kind === 't' ? ctx.name : '';
  if (!techName) {
    const { data: tn } = await supabase.from('technicians').select('name').eq('id', techId).limit(1);
    techName = tn && tn[0] ? tn[0].name : '';
  }
  let message = null;
  const want = String(techName || '').trim().toLowerCase();
  (pub || []).forEach((r) => {
    if (message || !r.messages || typeof r.messages !== 'object') return;
    const k = Object.keys(r.messages).find((x) => String(x).trim().toLowerCase() === want);
    if (k && typeof r.messages[k] === 'string') message = r.messages[k];
  });

  const { data: assigns, error } = await supabase
    .from('assignments')
    .select('id, site_id, ticket_id, sequence_order, status, restock_form_counts')
    .eq('dispatch_date', date)
    .eq('technician_id', techId)
    .in('status', ['planned', 'notified'])
    .order('sequence_order');
  if (error) return json(500, { ok: false, error: 'Could not load stops.' });

  const siteIds = [...new Set((assigns || []).map(a => a.site_id).filter(Boolean))];
  const ticketIds = [...new Set((assigns || []).map(a => a.ticket_id).filter(Boolean))];
  const siteById = {};
  const ticketById = {};
  if (siteIds.length) {
    const { data } = await supabase.from('sites').select('id, site_code, name, address, state').in('id', siteIds);
    (data || []).forEach(s => { siteById[s.id] = s; });
  }
  if (ticketIds.length) {
    const { data } = await supabase.from('tickets').select('id, wo_number, ticket_kind, description, issue_category, issue_detail, sla_ends_at, due_at').in('id', ticketIds);
    (data || []).forEach(t => { ticketById[t.id] = t; });
  }

  // "Journal low" cutoff is a per-state setting on the dispatch board (default 3000).
  const jThreshold = {};
  for (const reg of new Set(Object.values(siteById).map(x => pubRegion(x.state)).filter(Boolean))) {
    jThreshold[reg] = await journalLowThreshold(reg);
  }

  const stops = (assigns || []).map(a => {
    const s = siteById[a.site_id] || {};
    const t = ticketById[a.ticket_id] || {};
    const d = describeStop(a.restock_form_counts, t, jThreshold[pubRegion(s.state)] || 3000);
    return {
      id: a.id,
      seq: a.sequence_order,
      siteCode: s.site_code,
      siteName: s.name,
      address: s.address,
      woNumber: t.wo_number || null,
      ticketKind: t.ticket_kind || null,
      note: t.description || null,
      restockBy: d.restockBy,
      issue: d.issue,
      items: d.items,
      counts: d.counts,
      printers: d.printers,
      due: t.ticket_kind === 'trouble' ? (t.sla_ends_at || t.due_at || null) : null
    };
  });
  return json(200, { ok: true, date, stops, message, techName: techName || '' });
}

// ---------- dispatch summary (staff only, read only) ----------
// Shows the app's own plan for a state and date (default or dispatcher-edited).
// It is NOT a record of what is assigned in Salesforce. Technician logins get 403,
// and the state must be one of the login's own states.
async function doDispatchSummary(supabase, ctx, body) {
  if (ctx.kind !== 's') return json(403, { ok: false, error: 'Not available for this account.' });
  const states = ctx.states || [];
  const want = String((body && body.state) || '').trim().toUpperCase();
  if (!want || !states.includes(want)) return json(403, { ok: false, error: 'Not available for this account.' });
  const date = String((body && body.date) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { ok: false, error: 'Pick a date.' });

  const { data: sites, error: sErr } = await supabase
    .from('sites').select('id, site_code, name, address').eq('state', want).limit(5000);
  if (sErr) return json(500, { ok: false, error: 'Could not load the summary.' });
  const siteById = {};
  (sites || []).forEach((s) => { siteById[s.id] = s; });

  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('assignments')
      .select('id, site_id, ticket_id, technician_id, sequence_order, status, updated_at')
      .eq('dispatch_date', date).in('status', ['planned', 'notified'])
      .order('id').range(from, from + 999);
    if (error) return json(500, { ok: false, error: 'Could not load the summary.' });
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const mine = rows.filter((a) => siteById[a.site_id]);

  const techIds = [...new Set(mine.map((a) => a.technician_id).filter(Boolean))];
  const ticketIds = [...new Set(mine.map((a) => a.ticket_id).filter(Boolean))];
  const techName = {};
  const ticketById = {};
  if (techIds.length) {
    const { data } = await supabase.from('technicians').select('id, name').in('id', techIds);
    (data || []).forEach((t) => { techName[t.id] = t.name; });
  }
  if (ticketIds.length) {
    const { data } = await supabase.from('tickets').select('id, wo_number, ticket_kind, sla_ends_at, due_at, out_of_service').in('id', ticketIds);
    (data || []).forEach((t) => { ticketById[t.id] = t; });
  }

  // Open trouble tickets in this state that nobody has been assigned yet.
  // They have no assignment row, so the plan above cannot list them.
  const openTroubles = [];
  {
    const { data: ot } = await supabase
      .from('tickets')
      .select('id, wo_number, site_id, sla_ends_at, due_at, out_of_service, issue_category')
      .eq('ticket_kind', 'trouble').eq('status', 'open').is('manually_resolved_at', null).limit(500);
    const cand = (ot || []).filter((t) => siteById[t.site_id]);
    if (cand.length) {
      const { data: pa } = await supabase
        .from('assignments').select('ticket_id')
        .in('ticket_id', cand.map((t) => t.id)).in('status', ['planned', 'notified']);
      const taken = new Set((pa || []).map((x) => x.ticket_id));
      cand.filter((t) => !taken.has(t.id)).forEach((t) => {
        const s = siteById[t.site_id];
        openTroubles.push({
          siteCode: s.site_code, siteName: s.name, address: s.address,
          woNumber: t.wo_number || null, due: t.sla_ends_at || t.due_at || null,
          outOfService: !!t.out_of_service, category: t.issue_category || null,
        });
      });
      openTroubles.sort((x, y) => String(x.due || '9').localeCompare(String(y.due || '9')));
    }
  }

  let updatedAt = null;
  const groups = {};
  mine.forEach((a) => {
    if (a.updated_at && (!updatedAt || a.updated_at > updatedAt)) updatedAt = a.updated_at;
    const key = a.technician_id || 'none';
    if (!groups[key]) groups[key] = { tech: a.technician_id ? (techName[a.technician_id] || 'Unknown') : 'Unassigned', stops: [] };
    const s = siteById[a.site_id];
    const t = ticketById[a.ticket_id] || {};
    groups[key].stops.push({
      seq: a.sequence_order == null ? 9999 : a.sequence_order,
      siteCode: s.site_code, siteName: s.name, address: s.address,
      woNumber: t.wo_number || null, ticketKind: t.ticket_kind || null,
      due: t.ticket_kind === 'trouble' ? (t.sla_ends_at || t.due_at || null) : null,
    });
  });
  const techs = Object.values(groups);
  techs.forEach((g) => g.stops.sort((x, y) => x.seq - y.seq));
  techs.sort((x, y) => (x.tech === 'Unassigned') - (y.tech === 'Unassigned') || x.tech.localeCompare(y.tech));
  return json(200, { ok: true, state: want, date, updatedAt, techs, openTroubles });
}

// ---------- Saturday on-call info (staff only, read only) ----------
// The next Saturday (today, if it is Saturday, Eastern time): the on-call
// dispatcher and the on-call technicians per state, from the same tables the
// calendar and the Saturday on-call page use.
async function doOnCall(supabase, ctx) {
  if (ctx.kind !== 's') return json(403, { ok: false, error: 'Not available for this account.' });
  const ps = require('./lib/push-summary.js');
  const lp = ps.localParts(new Date(), 'America/New_York');
  const toSat = (6 - ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(lp.weekday) + 7) % 7;
  const date = new Date(Date.UTC(Number(lp.iso.slice(0, 4)), Number(lp.iso.slice(5, 7)) - 1, Number(lp.iso.slice(8, 10)) + toSat))
    .toISOString().slice(0, 10);
  const c = await ps.saturdayContext(supabase, date);
  const by = {};
  c.techs.forEach((t) => { (by[t.state] = by[t.state] || []).push(t.name); });
  const techs = Object.keys(by).sort().map((st) => ({ state: st, names: by[st] }));
  const dn = c.dispatcher ? c.dispatcher.charAt(0).toUpperCase() + c.dispatcher.slice(1) : '';
  return json(200, { ok: true, date, dispatcher: dn, techs });
}

// ---------- push alerts (staff only) ----------
// A phone subscribes with the choices it picked on the Watchdog tab. Choices are
// checked against the same options list the tab itself uses, so a dispatcher can
// never subscribe to a state the Watchdog tab would not show them.
function cleanEndpoint(v) {
  const e = String(v || '').trim();
  return /^https:\/\/[^\s]{10,1000}$/.test(e) ? e : '';
}

async function doPush(supabase, ctx, action, body) {
  // Staff subscribe to Watchdog alerts. Technicians subscribe to "my dispatch"
  // alerts (a trouble ticket texted to them from the board). Technician rows are
  // stored with account_key 't:<id>' and states ['TECH'], which is not a real state,
  // so the Watchdog and morning-summary senders never match them.
  if (ctx.kind !== 's' && ctx.kind !== 't') return json(403, { ok: false, error: 'Not available for this account.' });
  const isTech = ctx.kind === 't';
  const acctKey = isTech ? 't:' + ctx.key : ctx.key;
  if (isTech && (action === 'push_summary_test')) return json(403, { ok: false, error: 'Not available for this account.' });
  const push = require('./lib/push.js');

  if (action === 'push_config') {
    return json(200, { ok: true, configured: push.pushConfigured(), publicKey: process.env.VAPID_PUBLIC_KEY || null });
  }

  if (action === 'push_status') {
    const endpoint = cleanEndpoint(body.endpoint);
    if (!endpoint) return json(200, { ok: true, subscribed: false, selections: [] });
    const { data } = await supabase
      .from('push_subscriptions').select('selections, account_key').eq('endpoint', endpoint).maybeSingle();
    if (!data || data.account_key !== acctKey) return json(200, { ok: true, subscribed: false, selections: [] });
    return json(200, { ok: true, subscribed: true, selections: data.selections || [] });
  }

  if (action === 'push_subscribe') {
    if (!push.pushConfigured()) return json(503, { ok: false, error: 'Alerts are not set up on the server yet.' });
    const sub = body.subscription || {};
    const endpoint = cleanEndpoint(sub.endpoint);
    const keys = sub.keys || {};
    if (!endpoint || !keys.p256dh || !keys.auth) return json(400, { ok: false, error: 'Bad subscription.' });
    let picked, states;
    if (isTech) {
      picked = ['DISPATCH'];
      states = ['TECH'];
    } else {
      const allowed = watchdogOptionsFor(ctx.role, ctx.states).map((o) => o.value);
      picked = (Array.isArray(body.selections) ? body.selections : [])
        .map((x) => String(x).toUpperCase())
        .filter((x, i, a) => allowed.indexOf(x) !== -1 && a.indexOf(x) === i);
      if (!picked.length) return json(400, { ok: false, error: 'Pick at least one area.' });
      states = [];
      picked.forEach((v) => expandWatchSelection(v).forEach((s) => { if (states.indexOf(s) === -1) states.push(s); }));
    }
    const { error } = await supabase.from('push_subscriptions').upsert({
      endpoint,
      p256dh: String(keys.p256dh).slice(0, 200),
      auth: String(keys.auth).slice(0, 100),
      account_key: acctKey,
      states,
      selections: picked,
      user_agent: String(body.ua || '').slice(0, 200) || null,
      updated_at: new Date().toISOString(),
      fail_count: 0,
    }, { onConflict: 'endpoint' });
    if (error) return json(500, { ok: false, error: 'Could not save alerts.' });
    return json(200, { ok: true, selections: picked });
  }

  const endpoint = cleanEndpoint(body.endpoint);
  if (!endpoint) return json(400, { ok: false, error: 'Bad request.' });
  const { data: mine } = await supabase
    .from('push_subscriptions').select('id').eq('endpoint', endpoint).eq('account_key', acctKey).maybeSingle();

  if (action === 'push_unsubscribe') {
    if (mine) await supabase.from('push_subscriptions').delete().eq('id', mine.id);
    return json(200, { ok: true });
  }

  if (action === 'push_summary_test') {
    // Sends the morning summary to this phone now (ignores the clock).
    if (!mine) return json(404, { ok: false, error: 'This phone is not subscribed yet.' });
    const sr = await require('./lib/push-summary.js').sendSample(supabase, acctKey, endpoint);
    return json(sr.ok ? 200 : 502, sr.ok ? { ok: true } : { ok: false, error: sr.error || 'The sample could not be delivered.' });
  }

  // push_test
  if (!mine) return json(404, { ok: false, error: 'This phone is not subscribed yet.' });
  const r = await push.notifyEndpoint(supabase, endpoint, isTech
    ? { title: 'MCR Dispatch', body: 'Test alert. Dispatch alerts are working on this phone.' }
    : { title: 'MCR Watchdog', body: 'Test alert. Alerts are working on this phone.' });
  return json(r.ok ? 200 : 502, r.ok ? { ok: true } : { ok: false, error: r.error || 'The test could not be delivered.' });
}

// ---------- push to one technician (from the dispatch board) ----------
// The board's "Text this stop" button also calls this so a technician who has
// turned on Dispatch alerts in the portal gets a notification on the phone.
// Authorized the same way as publishing (board username + PIN, or a staff
// token) and limited to technicians in that login's states.
async function doNotifyTech(supabase, ctx, body) {
  if (ctx.kind !== 's' && ctx.kind !== 'a' && ctx.role !== 'admin') return json(403, { ok: false, error: 'Staff or admin only.' });
  const name = String((body && body.tech) || '').trim().slice(0, 80);
  if (!name) return json(400, { ok: false, error: 'Technician required.' });
  const push = require('./lib/push.js');
  if (!push.pushConfigured()) return json(200, { ok: true, sent: 0, subscribed: false, reason: 'not_configured' });
  const esc = name.replace(/[\\%_]/g, (m) => '\\' + m);
  const { data: techs } = await supabase
    .from('technicians').select('id, name, home_state, additional_states').ilike('name', esc).limit(2);
  if (!techs || techs.length !== 1) return json(200, { ok: true, sent: 0, subscribed: false, reason: 'no_match' });
  const t = techs[0];
  if (ctx.role !== 'admin') {
    const mine = (ctx.states || []).map((x) => String(x).toUpperCase());
    const theirs = [t.home_state].concat(t.additional_states || []).filter(Boolean).map((x) => String(x).toUpperCase());
    // NC and SC are covered by the GA umbrella, like everywhere else.
    const covered = theirs.some((x) => mine.indexOf(x) !== -1 || ((x === 'NC' || x === 'SC') && mine.indexOf('GA') !== -1));
    if (!covered) return json(403, { ok: false, error: 'Not your state.' });
  }
  const { data: rows } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, fail_count')
    .eq('account_key', 't:' + t.id).limit(10);
  if (!rows || !rows.length) return json(200, { ok: true, sent: 0, subscribed: false });
  const title = String((body && body.title) || 'MCR Dispatch').slice(0, 80);
  const text = String((body && body.body) || '').slice(0, 300);
  const wo = String((body && body.wo) || '').slice(0, 40);
  const payload = JSON.stringify({ title, body: text, tag: wo ? 'ticket-' + wo : 'dispatch', url: '/tech-portal.html' });
  const webpush = push.getWebPush();
  let sent = 0;
  for (const r of rows) { if (await push.sendOne(webpush, supabase, r, payload)) sent++; }
  return json(200, { ok: true, sent, subscribed: true });
}

// ---------- my stop names (2026-10-26) ----------
// A technician tells the system what the names he writes on his mileage log mean. His answers wait
// as 'pending' (technician_stop_aliases) until approved on the admin page; the mileage check only
// reads approved rows. Scope is the signed-in technician only: his id comes from the token, never
// from the request, and sites are limited to his own states.
async function doMyStopNames(supabase, ctx) {
  if (ctx.kind !== 't') return json(200, { ok: true, items: [], waiting: [], sites: {}, states: [] });
  const { buildUnidentified } = require('./lib/unidentified-stops.js');
  const out = await buildUnidentified(supabase, { days: 120, technicianId: ctx.key, forTech: true, activeOnly: true });
  const t = (out.techs || [])[0];
  const items = ((t && t.items) || []).map((it) => ({
    label: it.label, count: it.count, miles: it.miles, dates: it.dates, addressLike: it.addressLike,
    hops: (it.hops || []).map((h) => ({ date: h.date, miles: h.miles, other: h.other, known: h.known, from: h.from })),
    suggestions: (it.suggestions || []).map((s) => ({ code: s.code, name: s.name, state: s.state, onList: !!s.onList, fits: s.fits || 0, of: s.of || 0, confident: !!s.confident, similar: !!s.similar })),
  }));
  const sites = {};
  Object.keys(out.sites || {}).forEach((st) => {
    if (ctx.states.indexOf(st) < 0) return;
    sites[st] = out.sites[st].map((s) => ({ code: s.code, name: s.name, address: s.address, county: s.county }));
  });
  let waiting = [];
  try {
    const { data } = await supabase.from('technician_stop_aliases')
      .select('alias, kind, sites(name, site_code)').eq('technician_id', ctx.key).eq('status', 'pending').order('created_at', { ascending: false }).limit(100);
    waiting = (data || []).map((r) => ({ alias: r.alias, kind: r.kind, site: r.sites ? r.sites.name : null, code: r.sites ? r.sites.site_code : null }));
  } catch (e) { /* none */ }
  return json(200, { ok: true, items, waiting, sites, states: ctx.states });
}

async function doSaveMyStopName(supabase, ctx, body) {
  if (ctx.kind !== 't') return json(403, { ok: false, error: 'Not available for this account.' });
  const mc = require('./lib/mileage-check.js');
  const { buildUnidentified } = require('./lib/unidentified-stops.js');
  const alias = mc.normalizePlaceLabel(body.alias);
  const kind = String(body.kind || '');
  if (!alias || ['site', 'home', 'not_site'].indexOf(kind) < 0) return json(400, { ok: false, error: 'Missing answer.' });

  // The name must be one that is actually waiting on his own sheets.
  const out = await buildUnidentified(supabase, { days: 120, technicianId: ctx.key, forTech: true, activeOnly: true });
  const t = (out.techs || [])[0];
  const item = t && t.items.find((i) => i.label.toLowerCase() === alias.toLowerCase());
  const { data: have } = await supabase.from('technician_stop_aliases')
    .select('id, status').eq('technician_id', ctx.key).ilike('alias', alias.replace(/[\\%_]/g, (c) => '\\' + c));
  const mine = (have || [])[0] || null;
  if (mine && mine.status === 'approved') return json(200, { ok: true, already: true });
  if (!item && !mine) return json(404, { ok: false, error: 'That name is not on your list anymore. Refresh and try again.' });

  let siteId = null, evidence = { count: item ? item.count : 0, miles: item ? item.miles : 0, dates: item ? item.dates : [], hops: item ? item.hops.length : 0 };
  if (kind === 'site') {
    const code = String(body.site_code || '').trim();
    if (!code) return json(400, { ok: false, error: 'Pick a location.' });
    const { data: site } = await supabase.from('sites').select('id, state, active, is_placeholder').eq('site_code', code).maybeSingle();
    if (!site || ctx.states.indexOf(String(site.state || '').toUpperCase()) < 0 || site.active === false || site.is_placeholder) {
      return json(404, { ok: false, error: 'Location not found.' });
    }
    siteId = site.id;
    const sugg = item ? item.suggestions.find((s) => s.id === site.id) : null;
    if (sugg) evidence = { ...evidence, fits: sugg.fits || 0, of: sugg.of || 0, confident: !!sugg.confident, onList: !!sugg.onList };
  }

  const row = { kind, site_id: siteId, status: 'pending', evidence, answered_by: 'tech' };
  if (mine) {
    const { error } = await supabase.from('technician_stop_aliases').update(row).eq('id', mine.id).eq('status', 'pending');
    if (error) return json(500, { ok: false, error: 'Could not save.' });
  } else {
    const { count } = await supabase.from('technician_stop_aliases').select('id', { count: 'exact', head: true }).eq('technician_id', ctx.key).eq('status', 'pending');
    if ((count || 0) >= 150) return json(429, { ok: false, error: 'Too many answers are waiting. Try again after they are approved.' });
    const { error } = await supabase.from('technician_stop_aliases')
      .insert({ ...row, technician_id: ctx.key, alias, source: 'portal' });
    if (error) return json(500, { ok: false, error: 'Could not save.' });
  }
  return json(200, { ok: true });
}

async function doChangePassword(supabase, ctx, body) {
  const current = String(body.current || '');
  const next = String(body.next || '');
  if (normPw(next).length < 8) return json(400, { ok: false, error: 'New password must be at least 8 characters.' });
  if (normPw(next) === normPw(current)) return json(400, { ok: false, error: 'New password must be different.' });

  const table = ctx.kind === 's' ? 'staff_accounts' : 'tech_accounts';
  const keyCol = ctx.kind === 's' ? 'username' : 'technician_id';
  const { data: acct } = await supabase
    .from(table)
    .select('password_hash')
    .eq(keyCol, ctx.key)
    .maybeSingle();
  if (!acct || !verifyPw(current, acct.password_hash)) {
    return json(401, { ok: false, error: 'Current password is incorrect.' });
  }
  const changedAt = new Date().toISOString();
  const { error } = await supabase
    .from(table)
    .update({ password_hash: hashPw(next), password_changed_at: changedAt, failed_attempts: 0, locked_until: null })
    .eq(keyCol, ctx.key);
  if (error) return json(500, { ok: false, error: 'Could not save the new password.' });
  return json(200, {
    ok: true,
    token: makeToken(ctx.key, String(new Date(changedAt).getTime()), ctx.kind),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only.' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'Bad request.' }); }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const action = String(body.action || '');
  // 2026-10-16: my_stops reads the per-state "journal low" setting from Blobs.
  try { require('@netlify/blobs').connectLambda(event); } catch (e) { /* not available: the default is used */ }

  try {
    if (action === 'login') return await doLogin(supabase, body);

    // Publishing needs either a portal token (staff) or the dispatch board's
    // username + PIN, and is limited to that login's states. Checking whether
    // a date is published is read only and stays open so the board can ask.
    if (action === 'publish_status') {
      return await doPublishStatus(supabase, {}, body);
    }
    if (action === 'notify_tech') {
      const nCtx = (body.token ? await authenticate(supabase, body.token) : null) || (await boardAuth(supabase, body, event));
      if (!nCtx) return json(401, { ok: false, error: 'Sign in again on the dispatch board, then retry.' });
      return await doNotifyTech(supabase, nCtx, body);
    }
    if (action === 'publish_stops') {
      const pubCtx = (body.token ? await authenticate(supabase, body.token) : null) || (await boardAuth(supabase, body, event));
      if (!pubCtx) return json(401, { ok: false, error: 'Sign in again on the dispatch board, then retry.' });
      return await doPublishStops(supabase, pubCtx, body);
    }
    const ctx = await authenticate(supabase, body.token);
    if (!ctx) return json(401, { ok: false, error: 'Session expired. Please sign in again.', expired: true });

    if (action === 'me') return json(200, { ok: true, me: await buildMe(supabase, ctx.kind, ctx.name, ctx.states, ctx.defaultState, ctx.role) });
    if (action === 'search') return await doSearch(supabase, ctx, body);
    if (action === 'site') return await doSite(supabase, ctx, body);
    if (action === 'shipments') return await doShipments(supabase, ctx, body);
    if (action === 'my_stops') return await doMyStops(supabase, ctx, body);
    if (action === 'publish_stops') return await doPublishStops(supabase, ctx, body);
    if (action === 'publish_status') return await doPublishStatus(supabase, ctx, body);
    if (action === 'complete_stop') return await doCompleteStop(supabase, ctx, body);


    if (action === 'watchdog') return await doWatchdog(ctx, body);
    if (action === 'oncall') return await doOnCall(supabase, ctx);
    if (action === 'dispatch_summary') return await doDispatchSummary(supabase, ctx, body);
    if (action.indexOf('push_') === 0) return await doPush(supabase, ctx, action, body);
    if (action === 'my_stop_names') return await doMyStopNames(supabase, ctx);
    if (action === 'save_my_stop_name') return await doSaveMyStopName(supabase, ctx, body);
    if (action === 'change_password') return await doChangePassword(supabase, ctx, body);
    return json(400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    return json(500, { ok: false, error: 'Something went wrong.' });
  }
};

exports._test = { doMyStopNames, doSaveMyStopName, normPw, hashPw, verifyPw, makeToken, readToken, statesFor, eligible, cleanQuery, watchdogOptionsFor, watchRegion, expandWatchSelection };
