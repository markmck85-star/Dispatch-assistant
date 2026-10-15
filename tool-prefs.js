// tool-prefs.js
//
// Per-login choices for which tools show on the dispatch board (the Simple and
// Everything views, plus personal stars). Stored on dispatchers.tool_prefs (jsonb)
// so a login's picks follow the person across devices.
//
// Deliberately separate from login.js: if the tool_prefs column does not exist
// yet this returns { ok: true, prefs: null, persisted: false } and the board
// keeps working from its browser copy. Sign-in is never touched.
//
// POST { username, pin, action: 'get' | 'save', prefs? }
//   get  -> { ok, prefs, persisted }
//   save -> { ok, persisted }

const { createClient } = require('@supabase/supabase-js');
const auth = require('./lib/auth');

const PRESETS = new Set(['simple', 'everything']);
const MAX_IDS = 60;

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function missingColumn(err) {
  const msg = String((err && err.message) || err || '');
  return /tool_prefs/i.test(msg) && /column|schema cache|does not exist/i.test(msg);
}

function cleanIds(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const id of list) {
    const s = String(id || '').trim();
    if (/^[a-z0-9_-]{1,40}$/.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

function cleanPrefs(p) {
  const src = p && typeof p === 'object' ? p : {};
  return {
    v: 1,
    preset: PRESETS.has(src.preset) ? src.preset : null,
    pinned: cleanIds(src.pinned),
    unpinned: cleanIds(src.unpinned),
  };
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (c) => '\\' + c);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }

  const action = String(body.action || '');
  if (action !== 'get' && action !== 'save') return json(400, { ok: false, error: 'Unknown action' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(200, { ok: true, prefs: null, persisted: false });
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const who = await auth.authenticateRequest(supabase, event, body);
  if (who.error) return json(who.status || 401, { ok: false, error: who.error });
  const me = who.user;

  if (action === 'get') {
    const { data, error } = await supabase.from('dispatchers').select('tool_prefs').eq('id', me.id).maybeSingle();
    if (error) {
      if (missingColumn(error)) return json(200, { ok: true, prefs: null, persisted: false });
      return json(500, { ok: false, error: error.message });
    }
    const raw = data && data.tool_prefs;
    return json(200, { ok: true, prefs: raw ? cleanPrefs(raw) : null, persisted: true });
  }

  const { error } = await supabase.from('dispatchers').update({ tool_prefs: cleanPrefs(body.prefs) }).eq('id', me.id);
  if (error) {
    if (missingColumn(error)) return json(200, { ok: true, persisted: false });
    return json(500, { ok: false, error: error.message });
  }
  return json(200, { ok: true, persisted: true });
};
