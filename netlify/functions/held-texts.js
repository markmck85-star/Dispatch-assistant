// held-texts.js -- 2026-10-29
// GET            -> the messages currently held (waiting for their release time)
// POST {action:'cancel'|'send-now', id}
const { createClient } = require('@supabase/supabase-js');
const { sendMessage } = require('./lib/send-message.js');

exports.handler = async (event) => {
  const json = (code, o) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    if (event.httpMethod === 'GET') {
      const { data, error } = await supabase.from('held_texts').select('id, created_at, deliver_at, tech_name, payload').eq('status', 'held').order('deliver_at', { ascending: true }).limit(200);
      if (error) return json(500, { ok: false, error: error.message });
      return json(200, { ok: true, held: (data || []).map(r => ({ id: r.id, techName: r.tech_name, deliverAt: r.deliver_at, createdAt: r.created_at, preview: String((r.payload && r.payload.body) || '').slice(0, 140) })) });
    }
    if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method Not Allowed' });
    const { action, id } = JSON.parse(event.body || '{}');
    if (!id || !['cancel', 'send-now'].includes(action)) return json(400, { ok: false, error: 'action and id required' });
    if (action === 'cancel') {
      const { data, error } = await supabase.from('held_texts').update({ status: 'cancelled' }).eq('id', id).eq('status', 'held').select('id');
      if (error) return json(500, { ok: false, error: error.message });
      return json(200, { ok: true, cancelled: (data || []).length === 1 });
    }
    // send-now: claim it first so the releaser can't also send it
    const { data: claimed, error: cErr } = await supabase.from('held_texts').update({ status: 'sending' }).eq('id', id).eq('status', 'held').select('id, payload');
    if (cErr) return json(500, { ok: false, error: cErr.message });
    if (!claimed || !claimed.length) return json(200, { ok: false, error: 'That message was already sent or cancelled.' });
    let out;
    try { out = await sendMessage(claimed[0].payload || {}); }
    catch (e) { await supabase.from('held_texts').update({ status: 'failed', result: { error: e.message } }).eq('id', id); return json(500, { ok: false, error: e.message }); }
    await supabase.from('held_texts').update({ status: out.allOk ? 'sent' : 'failed', sent_at: new Date().toISOString(), result: { results: out.results } }).eq('id', id);
    return json(200, { ok: out.allOk, results: out.results });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
