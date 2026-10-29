// release-held-texts.js -- 2026-10-29
// Runs every 5 minutes (netlify.toml). Sends held messages whose time has come. Each row is claimed
// (held -> sending) before it is sent so two overlapping runs can never send the same message twice.
const { createClient } = require('@supabase/supabase-js');
const { sendMessage } = require('./lib/send-message.js');

exports.handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: due, error } = await supabase.from('held_texts').select('id').eq('status', 'held').lte('deliver_at', new Date().toISOString()).order('deliver_at', { ascending: true }).limit(50);
  if (error) { console.error('[release-held-texts] read failed', error.message); return { statusCode: 500, body: error.message }; }
  let sent = 0, failed = 0;
  for (const r of due || []) {
    const { data: claimed } = await supabase.from('held_texts').update({ status: 'sending' }).eq('id', r.id).eq('status', 'held').select('id, payload');
    if (!claimed || !claimed.length) continue; // someone else (send-now) got it
    try {
      const out = await sendMessage(claimed[0].payload || {});
      await supabase.from('held_texts').update({ status: out.allOk ? 'sent' : 'failed', sent_at: new Date().toISOString(), result: { results: out.results } }).eq('id', r.id);
      out.allOk ? sent++ : failed++;
    } catch (e) {
      failed++;
      await supabase.from('held_texts').update({ status: 'failed', result: { error: e.message } }).eq('id', r.id);
    }
  }
  console.log(`[release-held-texts] due=${(due || []).length} sent=${sent} failed=${failed}`);
  return { statusCode: 200, body: JSON.stringify({ due: (due || []).length, sent, failed }) };
};
