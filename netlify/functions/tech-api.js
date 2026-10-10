// tech-api.js
//
// Backend for tech-portal.html (MCR employee technicians only).
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
//  - Fields returned are trimmed: no site notes, no contractor info, no
//    internal flags, no home addresses.
//
// POST JSON { action, token?, ... }
//   login            { username, password }
//   me               {}
//   search           { q }
//   site             { code }
//   shipments        {}
//   change_password  { current, next }

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

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

function makeToken(tid, pv) {
  const payload = b64u(JSON.stringify({ t: tid, p: pv, e: Date.now() + TOKEN_TTL_MS }));
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

async function authenticate(supabase, token) {
  const tk = readToken(token);
  if (!tk) return null;
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
  return { acct, tech, states: statesFor(tech) };
}

function cleanQuery(q) {
  // Keep only characters safe to embed in a PostgREST or() filter.
  return String(q || '').replace(/[^A-Za-z0-9 #&'.\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// ---------- actions ----------

async function doLogin(supabase, body) {
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const fail = () => json(401, { ok: false, error: 'Incorrect username or password.' });
  if (!username || !password) return fail();

  const { data: acct } = await supabase
    .from('tech_accounts')
    .select('technician_id, username, password_hash, failed_attempts, locked_until, created_at, password_changed_at')
    .eq('username', username)
    .maybeSingle();

  if (!acct) {
    verifyPw(password, DUMMY_HASH); // keep timing similar
    return fail();
  }
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
    await supabase.from('tech_accounts').update(patch).eq('technician_id', acct.technician_id);
    return fail();
  }

  const { data: tech } = await supabase
    .from('technicians')
    .select('id, name, home_state, additional_states, is_contractor, active')
    .eq('id', acct.technician_id)
    .maybeSingle();
  if (!eligible(tech)) return json(403, { ok: false, error: 'This account is not active.' });

  await supabase
    .from('tech_accounts')
    .update({ failed_attempts: 0, locked_until: null, last_login_at: new Date().toISOString() })
    .eq('technician_id', acct.technician_id);

  return json(200, {
    ok: true,
    token: makeToken(acct.technician_id, pwVersion(acct)),
    me: { name: tech.name, states: statesFor(tech) },
  });
}

async function doSearch(supabase, ctx, body) {
  const q = cleanQuery(body.q);
  if (q.length < 2) return json(200, { ok: true, sites: [] });
  const pat = '%' + q + '%';
  const { data, error } = await supabase
    .from('sites')
    .select('site_code, name, address, state, county, machine_type')
    .in('state', ctx.states)
    .eq('active', true)
    .eq('is_placeholder', false)
    .or('name.ilike.' + pat + ',site_code.ilike.' + pat + ',address.ilike.' + pat + ',county.ilike.' + pat)
    .order('name', { ascending: true })
    .limit(30);
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
  if (!site || !ctx.states.includes(String(site.state || '').toUpperCase())) {
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

async function doShipments(supabase, ctx) {
  const tid = ctx.tech.id;
  const [rmaR, conR] = await Promise.all([
    supabase
      .from('rma_shipments')
      .select('account_name, wo_number, case_number, warehouse_name, request_details, outbound_tracking, inbound_tracking, return_broken_part, returned_at, received_at')
      .eq('technician_id', tid)
      .order('received_at', { ascending: false, nullsFirst: false })
      .limit(40),
    supabase
      .from('consumable_shipments')
      .select('request_date, shipped_at, ship_method, boxes_shipped, items, tracking, status, delivered_at')
      .eq('technician_id', tid)
      .order('request_date', { ascending: false, nullsFirst: false })
      .limit(25),
  ]);
  if (rmaR.error || conR.error) return json(500, { ok: false, error: 'Could not load shipments.' });

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
      };
    }),
  });
}

async function doChangePassword(supabase, ctx, body) {
  const current = String(body.current || '');
  const next = String(body.next || '');
  if (normPw(next).length < 8) return json(400, { ok: false, error: 'New password must be at least 8 characters.' });
  if (normPw(next) === normPw(current)) return json(400, { ok: false, error: 'New password must be different.' });

  const { data: acct } = await supabase
    .from('tech_accounts')
    .select('password_hash')
    .eq('technician_id', ctx.tech.id)
    .maybeSingle();
  if (!acct || !verifyPw(current, acct.password_hash)) {
    return json(401, { ok: false, error: 'Current password is incorrect.' });
  }
  const changedAt = new Date().toISOString();
  const { error } = await supabase
    .from('tech_accounts')
    .update({ password_hash: hashPw(next), password_changed_at: changedAt, failed_attempts: 0, locked_until: null })
    .eq('technician_id', ctx.tech.id);
  if (error) return json(500, { ok: false, error: 'Could not save the new password.' });
  return json(200, {
    ok: true,
    token: makeToken(ctx.tech.id, String(new Date(changedAt).getTime())),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only.' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'Bad request.' }); }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const action = body.action;

  try {
    if (action === 'login') return await doLogin(supabase, body);

    const ctx = await authenticate(supabase, body.token);
    if (!ctx) return json(401, { ok: false, error: 'Session expired. Please sign in again.', expired: true });

    if (action === 'me') return json(200, { ok: true, me: { name: ctx.tech.name, states: ctx.states } });
    if (action === 'search') return await doSearch(supabase, ctx, body);
    if (action === 'site') return await doSite(supabase, ctx, body);
    if (action === 'shipments') return await doShipments(supabase, ctx);
    if (action === 'change_password') return await doChangePassword(supabase, ctx, body);
    return json(400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    return json(500, { ok: false, error: 'Something went wrong.' });
  }
};

exports._test = { normPw, hashPw, verifyPw, makeToken, readToken, statesFor, eligible, cleanQuery };
