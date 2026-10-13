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
//   push_config      {}   staff only; { configured, publicKey } for subscribing this phone
//   push_status      { endpoint }   staff only; the choices saved for this phone
//   push_subscribe   { subscription, selections }   staff only; selections are values
//                    from me.watch.options, expanded to states here
//   push_unsubscribe { endpoint }   staff only
//   push_test        { endpoint }   staff only; sends one test notification
//   change_password  { current, next }

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

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
      .select('username, dispatcher_username, display_name, default_state, created_at, password_changed_at')
      .eq('username', tk.t)
      .maybeSingle();
    if (!acct || pwVersion(acct) !== tk.p) return null;
    const { data: d } = await supabase
      .from('dispatchers')
      .select('username, role, states, active')
      .eq('username', acct.dispatcher_username)
      .maybeSingle();
    if (!staffOk(d)) return null;
    return { kind: 's', name: acct.display_name, states: staffStates(d), role: d.role, key: acct.username, defaultState: acct.default_state || null };
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
      .eq('dispatch_date', date).neq('status', 'removed')
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
    const { data } = await supabase.from('tickets').select('id, wo_number, ticket_kind').in('id', ticketIds);
    (data || []).forEach((t) => { ticketById[t.id] = t; });
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
    });
  });
  const techs = Object.values(groups);
  techs.forEach((g) => g.stops.sort((x, y) => x.seq - y.seq));
  techs.sort((x, y) => (x.tech === 'Unassigned') - (y.tech === 'Unassigned') || x.tech.localeCompare(y.tech));
  return json(200, { ok: true, state: want, date, updatedAt, techs });
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
  if (ctx.kind !== 's') return json(403, { ok: false, error: 'Not available for this account.' });
  const push = require('./lib/push.js');

  if (action === 'push_config') {
    return json(200, { ok: true, configured: push.pushConfigured(), publicKey: process.env.VAPID_PUBLIC_KEY || null });
  }

  if (action === 'push_status') {
    const endpoint = cleanEndpoint(body.endpoint);
    if (!endpoint) return json(200, { ok: true, subscribed: false, selections: [] });
    const { data } = await supabase
      .from('push_subscriptions').select('selections, account_key').eq('endpoint', endpoint).maybeSingle();
    if (!data || data.account_key !== ctx.key) return json(200, { ok: true, subscribed: false, selections: [] });
    return json(200, { ok: true, subscribed: true, selections: data.selections || [] });
  }

  if (action === 'push_subscribe') {
    if (!push.pushConfigured()) return json(503, { ok: false, error: 'Alerts are not set up on the server yet.' });
    const sub = body.subscription || {};
    const endpoint = cleanEndpoint(sub.endpoint);
    const keys = sub.keys || {};
    if (!endpoint || !keys.p256dh || !keys.auth) return json(400, { ok: false, error: 'Bad subscription.' });
    const allowed = watchdogOptionsFor(ctx.role, ctx.states).map((o) => o.value);
    const picked = (Array.isArray(body.selections) ? body.selections : [])
      .map((x) => String(x).toUpperCase())
      .filter((x, i, a) => allowed.indexOf(x) !== -1 && a.indexOf(x) === i);
    if (!picked.length) return json(400, { ok: false, error: 'Pick at least one area.' });
    const states = [];
    picked.forEach((v) => expandWatchSelection(v).forEach((s) => { if (states.indexOf(s) === -1) states.push(s); }));
    const { error } = await supabase.from('push_subscriptions').upsert({
      endpoint,
      p256dh: String(keys.p256dh).slice(0, 200),
      auth: String(keys.auth).slice(0, 100),
      account_key: ctx.key,
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
    .from('push_subscriptions').select('id').eq('endpoint', endpoint).eq('account_key', ctx.key).maybeSingle();

  if (action === 'push_unsubscribe') {
    if (mine) await supabase.from('push_subscriptions').delete().eq('id', mine.id);
    return json(200, { ok: true });
  }

  // push_test
  if (!mine) return json(404, { ok: false, error: 'This phone is not subscribed yet.' });
  const r = await push.notifyEndpoint(supabase, endpoint, { title: 'MCR Watchdog', body: 'Test alert. Alerts are working on this phone.' });
  return json(r.ok ? 200 : 502, r.ok ? { ok: true } : { ok: false, error: r.error || 'The test could not be delivered.' });
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

  try {
    if (action === 'login') return await doLogin(supabase, body);

    const ctx = await authenticate(supabase, body.token);
    if (!ctx) return json(401, { ok: false, error: 'Session expired. Please sign in again.', expired: true });

    if (action === 'me') return json(200, { ok: true, me: await buildMe(supabase, ctx.kind, ctx.name, ctx.states, ctx.defaultState, ctx.role) });
    if (action === 'search') return await doSearch(supabase, ctx, body);
    if (action === 'site') return await doSite(supabase, ctx, body);
    if (action === 'shipments') return await doShipments(supabase, ctx, body);
    if (action === 'watchdog') return await doWatchdog(ctx, body);
    if (action === 'dispatch_summary') return await doDispatchSummary(supabase, ctx, body);
    if (action.indexOf('push_') === 0) return await doPush(supabase, ctx, action, body);
    if (action === 'change_password') return await doChangePassword(supabase, ctx, body);
    return json(400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    return json(500, { ok: false, error: 'Something went wrong.' });
  }
};

exports._test = { normPw, hashPw, verifyPw, makeToken, readToken, statesFor, eligible, cleanQuery, watchdogOptionsFor, watchRegion, expandWatchSelection };
