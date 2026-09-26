// get-dispatchers.js
//
// Who can be picked as "today's on-call dispatcher" on the Saturday page:
// every active dispatcher or admin login except the generic 'admin'
// account (not a real person). TJ is included via role=admin.
//
// v2 (2026-09-26): linked technicians(phone, sms_address) win when present.
// v3 (2026-09-26): include role=admin so Mark (and any other admin who
// actually covers a Saturday) appears in the dropdown. Previously only
// role=dispatcher plus the hardcoded username=tj made the list.

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
    .order('username', { ascending: true });

  if (error) return json(500, { error: error.message });

  const dispatchers = (data || [])
    .filter((d) => String(d.username || '').toLowerCase() !== 'admin')
    .map((d) => {
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
