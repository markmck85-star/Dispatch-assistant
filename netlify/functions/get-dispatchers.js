// get-dispatchers.js
//
// Read-only list of who can be picked as "today's on-call dispatcher" on
// the Saturday page: every active dispatcher, plus TJ specifically (he
// covers/oversees but isn't role='dispatcher'). Deliberately excludes the
// generic 'admin' login, which isn't a real person. Until real per-
// dispatcher logins exist, this is the whole selectable list -- Mark's
// call was to keep it to this set rather than "anyone" for now.
//
// v2 (2026-09-26): some dispatchers (Gina, Caleb) are also a real field
// technician, via the new dispatchers.technician_id link -- their phone/
// carrier lives on that technicians row (the one main-dispatch messaging
// already reads), not on dispatchers itself. When technician_id is set,
// this resolves phone/smsAddress from there so the Saturday page's alerts
// toggle sees whatever's already on file and doesn't prompt for a carrier
// that already exists under their technician profile.
//
// GET /.netlify/functions/get-dispatchers
// -> { dispatchers: [ { id, username, phone, smsAddress, technicianId } ] }

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase
    .from('dispatchers')
    .select('id, username, role, active, phone, sms_address, technician_id, technicians(phone, sms_address)')
    .eq('active', true)
    .or('role.eq.dispatcher,username.eq.tj')
    .order('username', { ascending: true });

  if (error) return json(500, { error: error.message });

  const dispatchers = (data || []).map((d) => {
    // A linked technician's own contact info wins when present -- it's
    // the one real record other parts of the app already message through.
    const linked = d.technicians || null;
    return {
      id: d.id,
      username: d.username,
      technicianId: d.technician_id || null,
      phone: (linked && linked.phone) || d.phone || '',
      smsAddress: (linked && linked.sms_address) || d.sms_address || '',
    };
  });

  return json(200, { dispatchers });
};
