/**
 * netlify/functions/admin-tech-logins.js  (v1.0, 2026-10-26)
 * SAVE AS: netlify/functions/admin-tech-logins.js
 *
 * Admin only (see gate.js). Runs the technician portal logins (tech_accounts), which tech-api.js
 * reads. Passwords are stored only as salted hashes, so nobody can read one; a reset makes a new
 * temporary password that is shown ONCE in the answer.
 *
 * GET                 every technician with his login status
 * POST { action, ... }
 *   reset        { technician_id }                 new temporary password; signs out his phones
 *   set_password { technician_id, password }       choose the password yourself (8+ characters)
 *   unlock       { technician_id }                 clear a lockout after wrong tries
 *   disable      { technician_id }                 turn the login off (signs out his phones)
 *   enable       { technician_id }
 *   create       { technician_id, username? }      login for a technician who has none
 *   rename       { technician_id, username }       change the username
 *   create_test  { state, username? }              a test technician + login, kept inactive so
 *                                                  dispatchers never see him
 *   add_sample   { technician_id }                 test technicians only: a sample mileage sheet with
 *                                                  unidentified stop names, to try the Stop names tab
 *   remove_test  { technician_id }                 delete a test technician, his login and sample data
 *
 * Password rules match tech-api.js (normPw/hashPw): letters, digits and symbols; case and spaces
 * and hyphens are ignored when checking, so "Maple-River-4821" and "maple river 4821" are the same.
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}
const UUID = /^[0-9a-f-]{36}$/i;

// ---- same hashing as tech-api.js ----
function normPw(pw) { return String(pw || '').trim().toLowerCase().replace(/[\s-]+/g, ''); }
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(normPw(pw), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + dk.toString('hex');
}
const WORDS = ['maple', 'river', 'cedar', 'harbor', 'copper', 'meadow', 'falcon', 'summit', 'willow', 'ember', 'canyon', 'orchard', 'lantern', 'prairie', 'granite', 'sparrow', 'timber', 'valley', 'bridge', 'anchor', 'pebble', 'thunder', 'walnut', 'horizon'];
function tempPassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  return pick() + '-' + pick() + '-' + String(crypto.randomInt(1000, 10000));
}
function baseUsername(name) {
  const parts = String(name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!parts.length) return 'tech';
  return parts.length === 1 ? parts[0] : parts[0][0] + parts[parts.length - 1];
}
async function freeUsername(supabase, want) {
  let name = want, n = 1;
  for (;;) {
    const [a, b] = await Promise.all([
      supabase.from('tech_accounts').select('username').eq('username', name).maybeSingle(),
      supabase.from('staff_accounts').select('username').eq('username', name).maybeSingle(),
    ]);
    if (!a.data && !b.data) return name;
    n += 1; name = want + n;
  }
}
const cleanUser = (u) => String(u || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');

exports.handler = async (event) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Supabase env vars not configured' });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (event.httpMethod === 'GET') {
      const [{ data: techs, error: tErr }, { data: accts, error: aErr }] = await Promise.all([
        supabase.from('technicians').select('id, name, home_state, additional_states, active, is_contractor, is_test').order('name', { ascending: true }).limit(2000),
        supabase.from('tech_accounts').select('technician_id, username, disabled, locked_until, failed_attempts, last_login_at, password_changed_at, created_at').limit(5000),
      ]);
      if (tErr) return json(500, { error: tErr.message });
      if (aErr) return json(500, { error: aErr.message });
      const byTech = new Map((accts || []).map((a) => [a.technician_id, a]));
      const now = Date.now();
      const rows = (techs || []).map((t) => {
        const a = byTech.get(t.id) || null;
        return {
          technician_id: t.id, name: t.name, state: t.home_state, states: [t.home_state, ...(t.additional_states || [])].filter(Boolean),
          active: t.active !== false, contractor: t.is_contractor === true, test: t.is_test === true,
          username: a ? a.username : null, hasLogin: !!a, disabled: !!(a && a.disabled),
          locked: !!(a && a.locked_until && new Date(a.locked_until).getTime() > now), lockedUntil: a ? a.locked_until : null,
          lastLoginAt: a ? a.last_login_at : null, passwordChangedAt: a ? a.password_changed_at : null,
          everChangedPassword: !!(a && a.password_changed_at && a.created_at && new Date(a.password_changed_at).getTime() - new Date(a.created_at).getTime() > 60000),
        };
      });
      return json(200, { ok: true, rows });
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
    const action = String(body.action || '');

    // ---- a test technician ----
    if (action === 'create_test') {
      const state = String(body.state || 'GA').trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(state)) return json(400, { error: 'A two-letter state is required' });
      const slug = 'test-' + crypto.randomBytes(4).toString('hex');
      const { data: tech, error } = await supabase.from('technicians').insert({
        slug, name: 'Test Technician ' + state, home_state: state, additional_states: [], is_contractor: false, active: false, is_test: true,
      }).select('id, name').single();
      if (error) return json(500, { error: error.message });
      const username = await freeUsername(supabase, cleanUser(body.username) || 'testtech' + state.toLowerCase());
      const password = tempPassword();
      const now = new Date().toISOString();
      const { error: aErr } = await supabase.from('tech_accounts').insert({ technician_id: tech.id, username, password_hash: hashPw(password), password_changed_at: now });
      if (aErr) { await supabase.from('technicians').delete().eq('id', tech.id); return json(500, { error: aErr.message }); }
      return json(200, { ok: true, technician_id: tech.id, name: tech.name, username, password });
    }

    const techId = String(body.technician_id || '');
    if (!UUID.test(techId)) return json(400, { error: 'Valid technician_id required' });
    const { data: tech, error: tErr } = await supabase.from('technicians').select('id, name, home_state, is_test').eq('id', techId).maybeSingle();
    if (tErr) return json(500, { error: tErr.message });
    if (!tech) return json(404, { error: 'Technician not found' });
    const { data: acct } = await supabase.from('tech_accounts').select('technician_id, username').eq('technician_id', techId).maybeSingle();

    if (action === 'create') {
      if (acct) return json(409, { error: tech.name + ' already has a login (' + acct.username + ').' });
      const username = await freeUsername(supabase, cleanUser(body.username) || baseUsername(tech.name));
      const password = tempPassword();
      const { error } = await supabase.from('tech_accounts').insert({ technician_id: techId, username, password_hash: hashPw(password), password_changed_at: new Date().toISOString() });
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true, username, password });
    }

    if (action === 'remove_test') {
      if (!tech.is_test) return json(403, { error: 'Only test technicians can be removed here.' });
      await supabase.from('technician_stop_aliases').delete().eq('technician_id', techId);
      await supabase.from('technician_mileage_reports').delete().eq('technician_id', techId);
      await supabase.from('tech_accounts').delete().eq('technician_id', techId);
      const { error } = await supabase.from('technicians').delete().eq('id', techId).eq('is_test', true);
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true });
    }

    if (action === 'add_sample') {
      if (!tech.is_test) return json(403, { error: 'Sample sheets can only be added to a test technician.' });
      const today = new Date().toISOString().slice(0, 10);
      const d = (off) => new Date(Date.now() - off * 86400000).toISOString().slice(0, 10);
      const legs = [
        { date: d(3), fromRaw: 'Home', toRaw: 'The Kroger by the mall', claimedMiles: 14, reason: 'site_not_matched' },
        { date: d(3), fromRaw: 'The Kroger by the mall', toRaw: 'Downtown tag office', claimedMiles: 6, reason: 'site_not_matched' },
        { date: d(3), fromRaw: 'Downtown tag office', toRaw: 'Home', claimedMiles: 15, reason: 'site_not_matched' },
        { date: d(2), fromRaw: 'Home', toRaw: 'Northside Walmart', claimedMiles: 22, reason: 'site_not_matched' },
        { date: d(2), fromRaw: 'Northside Walmart', toRaw: 'Home', claimedMiles: 22, reason: 'site_not_matched' },
        { date: d(1), fromRaw: 'Home', toRaw: 'The Kroger by the mall', claimedMiles: 14, reason: 'site_not_matched' },
      ];
      await supabase.from('technician_mileage_reports').delete().eq('technician_id', techId).eq('source', 'test_sample');
      const { error } = await supabase.from('technician_mileage_reports').insert({
        technician_id: techId, technician_name_raw: tech.name, pay_period_end: today, source: 'test_sample', source_filename: 'sample.csv',
        total_legs: legs.length, matched_legs: 0, total_claimed_miles: legs.reduce((s, l) => s + l.claimedMiles, 0),
        flagged_legs: [], unmatched_legs: legs, needs_review: false,
      });
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true, legs: legs.length });
    }

    if (!acct) return json(404, { error: tech.name + ' has no login yet. Create one first.' });
    const now = new Date().toISOString();

    if (action === 'reset') {
      const password = tempPassword();
      const { error } = await supabase.from('tech_accounts').update({ password_hash: hashPw(password), password_changed_at: now, failed_attempts: 0, locked_until: null }).eq('technician_id', techId);
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true, username: acct.username, password });
    }
    if (action === 'set_password') {
      const password = String(body.password || '');
      if (normPw(password).length < 8) return json(400, { error: 'The password must be at least 8 characters.' });
      const { error } = await supabase.from('tech_accounts').update({ password_hash: hashPw(password), password_changed_at: now, failed_attempts: 0, locked_until: null }).eq('technician_id', techId);
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true, username: acct.username });
    }
    if (action === 'unlock') {
      const { error } = await supabase.from('tech_accounts').update({ failed_attempts: 0, locked_until: null }).eq('technician_id', techId);
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true });
    }
    if (action === 'disable' || action === 'enable') {
      const off = action === 'disable';
      const { error } = await supabase.from('tech_accounts').update({ disabled: off, disabled_at: off ? now : null }).eq('technician_id', techId);
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true, disabled: off });
    }
    if (action === 'rename') {
      const username = cleanUser(body.username);
      if (username.length < 3 || username.length > 40) return json(400, { error: 'A username of 3 to 40 letters, digits, dots or dashes is required.' });
      if (username !== acct.username) {
        const [a, b] = await Promise.all([
          supabase.from('tech_accounts').select('technician_id').eq('username', username).maybeSingle(),
          supabase.from('staff_accounts').select('username').eq('username', username).maybeSingle(),
        ]);
        if (a.data || b.data) return json(409, { error: 'That username is taken.' });
      }
      const { error } = await supabase.from('tech_accounts').update({ username }).eq('technician_id', techId);
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true, username });
    }

    return json(400, { error: 'Unknown action' });
  } catch (e) {
    return json(500, { error: e.message || 'Unexpected error' });
  }
};
