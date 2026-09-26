// get-dispatchers.js
//
// Read-only list of who can be picked as "today's on-call dispatcher" on
// the Saturday page: every active dispatcher, plus TJ specifically (he
// covers/oversees but isn't role='dispatcher'). Deliberately excludes the
// generic 'admin' login, which isn't a real person. Until real per-
// dispatcher logins exist, this is the whole selectable list -- Mark's
// call was to keep it to this set rather than "anyone" for now.
//
// GET /.netlify/functions/get-dispatchers
// -> { dispatchers: [ { id, username, phone, smsAddress }, ... ] }

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase
    .from('dispatchers')
    .select('id, username, role, active, phone, sms_address')
    .eq('active', true)
    .or('role.eq.dispatcher,username.eq.tj')
    .order('username', { ascending: true });

  if (error) return json(500, { error: error.message });

  const dispatchers = (data || []).map((d) => ({
    id: d.id,
    username: d.username,
    phone: d.phone || '',
    smsAddress: d.sms_address || '',
  }));

  return json(200, { dispatchers });
};
