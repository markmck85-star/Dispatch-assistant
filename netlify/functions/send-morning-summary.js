// send-morning-summary.js -- scheduled every 15 minutes (see netlify.toml).
//
// Sends each subscribed dispatcher phone its one-a-day summary of open Watchdog
// tickets at 8:00 AM in that dispatcher's own time zone. The real work, and the
// rules for who is due, live in lib/push-summary.js.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async () => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Supabase is not configured.' }) };
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const result = await require('./lib/push-summary.js').runDue(supabase, new Date());
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.log('[send-morning-summary] error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Summary run failed.' }) };
  }
};
