// netlify/functions/special-projects.js
//
// Dispatcher-maintained special projects: ribbon cuttings, installs, site
// surveys, armored truck meets and anything else that gets arranged outside
// the ticket flow (e.g. over email between a dispatcher and a Neumo contact),
// plus status / hold tracking for installs and surveys that DO have a ticket
// but get delayed for reasons the app cannot see (store remodel, etc.).
//
// Reads/writes public.special_projects with the Supabase service-role key,
// same reasoning as save-tech-availability.js: the table's write RLS needs an
// authenticated admin/dispatcher session and the browser only holds the anon
// key, so all access goes through this function.
//
//   GET  /.netlify/functions/special-projects?state=GA[&includeClosed=1]
//        -> { ok, projects: [...] }   (open ones; with includeClosed also done/cancelled from the last 3 days)
//
//   POST /.netlify/functions/special-projects
//        { action: 'save', id?, state, project_type, title, location, scheduled_date,
//          scheduled_time, status, hold_until, note, ticket_id }
//          - no id: creates (state, project_type and title are required)
//          - id:    updates only the fields that are present in the body
//        { action: 'delete', id }
//        -> { ok, project }
//
// scheduled_time is free text as the dispatcher typed it ("10:00 AM") and is
// treated as local wall-clock time -- never converted between timezones.

const { createClient } = require('@supabase/supabase-js');

const TYPES = ['ribbon_cutting', 'install', 'site_survey', 'armored_truck_meet', 'other'];
const STATUSES = ['planned', 'confirmed', 'waiting', 'on_hold', 'rescheduled', 'cancelled', 'done'];
const CLOSED = ['done', 'cancelled'];

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify(obj),
  };
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// '' / null / undefined -> null; otherwise trimmed and length-limited string.
function text(v, max) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: 'Supabase env vars not configured' });
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // ------------------------------------------------------------- GET
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const state = String(params.state || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) return json(400, { ok: false, error: 'state is required' });

    let q = sb.from('special_projects').select('*').eq('state', state)
      .order('scheduled_date', { ascending: true, nullsFirst: false });
    if (params.includeClosed) {
      const since = new Date(Date.now() - 3 * 86400000).toISOString();
      q = q.or(`status.not.in.(${CLOSED.join(',')}),last_update_at.gte.${since}`);
    } else {
      q = q.not('status', 'in', `(${CLOSED.join(',')})`);
    }
    const { data, error } = await q;
    if (error) return json(500, { ok: false, error: error.message });
    return json(200, { ok: true, projects: data || [] });
  }

  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  // ------------------------------------------------------------- POST
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { ok: false, error: 'Invalid JSON body' }); }

  const action = body.action || 'save';

  if (action === 'delete') {
    if (!isUuid(body.id)) return json(400, { ok: false, error: 'id is required' });
    const { error } = await sb.from('special_projects').delete().eq('id', body.id);
    if (error) return json(500, { ok: false, error: error.message });
    return json(200, { ok: true });
  }

  if (action !== 'save') return json(400, { ok: false, error: 'Unknown action' });

  // Build the field set from whatever was sent.
  const f = {};
  if (body.state !== undefined) {
    const st = String(body.state || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(st)) return json(400, { ok: false, error: 'state must be a 2-letter code' });
    f.state = st;
  }
  if (body.project_type !== undefined) {
    if (!TYPES.includes(body.project_type)) return json(400, { ok: false, error: 'Invalid project_type' });
    f.project_type = body.project_type;
  }
  if (body.title !== undefined) {
    const t = text(body.title, 120);
    if (!t) return json(400, { ok: false, error: 'title cannot be empty' });
    f.title = t;
  }
  if (body.location !== undefined) f.location = text(body.location, 160);
  if (body.scheduled_date !== undefined) {
    if (body.scheduled_date === null || body.scheduled_date === '') f.scheduled_date = null;
    else if (isDate(body.scheduled_date)) f.scheduled_date = body.scheduled_date;
    else return json(400, { ok: false, error: 'scheduled_date must be YYYY-MM-DD' });
  }
  if (body.scheduled_time !== undefined) f.scheduled_time = text(body.scheduled_time, 20);
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return json(400, { ok: false, error: 'Invalid status' });
    f.status = body.status;
  }
  if (body.hold_until !== undefined) {
    if (body.hold_until === null || body.hold_until === '') f.hold_until = null;
    else if (isDate(body.hold_until)) f.hold_until = body.hold_until;
    else return json(400, { ok: false, error: 'hold_until must be YYYY-MM-DD' });
  }
  // A hold date only means something while the project is on hold.
  if (f.status && f.status !== 'on_hold') f.hold_until = null;
  if (body.note !== undefined) f.note = text(body.note, 500);
  if (body.ticket_id !== undefined) {
    if (body.ticket_id === null || body.ticket_id === '') f.ticket_id = null;
    else if (isUuid(body.ticket_id)) f.ticket_id = body.ticket_id;
    else return json(400, { ok: false, error: 'ticket_id is not valid' });
  }

  const nowIso = new Date().toISOString();

  if (body.id) {
    if (!isUuid(body.id)) return json(400, { ok: false, error: 'id is not valid' });
    if (!Object.keys(f).length) return json(400, { ok: false, error: 'Nothing to update' });
    f.updated_at = nowIso;
    f.last_update_at = nowIso;
    const { data, error } = await sb.from('special_projects').update(f).eq('id', body.id).select().single();
    if (error) return json(500, { ok: false, error: error.message });
    return json(200, { ok: true, project: data });
  }

  if (!f.state || !f.project_type || !f.title) {
    return json(400, { ok: false, error: 'state, project_type and title are required' });
  }
  // Linking a ticket twice would double-list it: reuse the existing row instead.
  if (f.ticket_id) {
    const { data: existing } = await sb.from('special_projects').select('id').eq('ticket_id', f.ticket_id).limit(1);
    if (existing && existing.length) {
      f.updated_at = nowIso;
      f.last_update_at = nowIso;
      const { data, error } = await sb.from('special_projects').update(f).eq('id', existing[0].id).select().single();
      if (error) return json(500, { ok: false, error: error.message });
      return json(200, { ok: true, project: data });
    }
  }
  f.updated_at = nowIso;
  f.last_update_at = nowIso;
  const { data, error } = await sb.from('special_projects').insert(f).select().single();
  if (error) return json(500, { ok: false, error: error.message });
  return json(200, { ok: true, project: data });
};
