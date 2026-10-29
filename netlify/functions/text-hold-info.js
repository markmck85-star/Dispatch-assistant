// text-hold-info.js -- 2026-10-29
// GET ?names=Name One|Name Two  ->  { ok, info: { "Name One": { hold, label, etLabel, deliverAt, localNow, tz } } }
// Tells the board, before a dispatcher sends, whether a text would land before 8:00 AM the
// technician's own time and, if so, when it would be released.
const { createClient } = require('@supabase/supabase-js');
const { techTimezone, computeHold } = require('./lib/text-hold.js');

exports.handler = async (event) => {
  const json = (code, o) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method Not Allowed' });
  const names = String((event.queryStringParameters || {}).names || '').split('|').map(s => s.trim()).filter(Boolean).slice(0, 60);
  if (!names.length) return json(200, { ok: true, info: {} });
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase.from('technicians').select('name, home_state, timezone').in('name', names);
    if (error) return json(500, { ok: false, error: error.message });
    const by = {};
    (data || []).forEach(t => { by[t.name] = t; });
    const now = new Date();
    const info = {};
    for (const n of names) info[n] = computeHold(techTimezone(by[n]), now);
    return json(200, { ok: true, info });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
