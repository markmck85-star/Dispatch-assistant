/**
 * diagnose-bluefolder-users.js — ONE-TIME DIAGNOSTIC, safe to delete after use
 *
 * bluefolder-sync.js is failing on every single mapped technician with an
 * identical 404 "Data not found" on appointments/list.aspx, even after
 * confirming the request format matches BlueFolder's real documented API
 * exactly (endpoint, field names, date format). That points away from the
 * request shape and toward the userId values themselves -- if what's stored
 * in technicians.bluefolder_user_id doesn't match real current BlueFolder
 * user IDs, every filtered appointment query would fail exactly like this.
 *
 * This fetches BlueFolder's actual user list (users/list.aspx) and Supabase's
 * stored mapping side by side, so we can see directly whether they line up.
 *
 * Visit once in a browser:
 *   https://mcrdispatch.net/.netlify/functions/diagnose-bluefolder-users?confirm=yes
 */
const { createClient } = require('@supabase/supabase-js');
const { XMLParser } = require('fast-xml-parser');

const BF_BASE = 'https://app.bluefolder.com/api/2.0';
const xmlParser = new XMLParser({ ignoreAttributes: false });

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

async function bfRequest(endpoint, bodyXml) {
  const token = process.env.BLUEFOLDER_API_TOKEN;
  const auth = Buffer.from(`${token}:x`).toString('base64');
  const res = await fetch(`${BF_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'text/xml' },
    body: bodyXml,
  });
  const text = await res.text();
  let parsed;
  try { parsed = xmlParser.parse(text); }
  catch (e) { return { rawError: 'Could not parse response as XML', raw: text.slice(0, 500) }; }
  return parsed.response;
}

exports.handler = async (event) => {
  const confirm = (event.queryStringParameters || {}).confirm;
  if (confirm !== 'yes') return json(400, { error: 'Add ?confirm=yes to the URL to run this.' });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: mapped, error: dbErr } = await supabase
      .from('technicians')
      .select('name, bluefolder_user_id')
      .not('bluefolder_user_id', 'is', null)
      .order('name');
    if (dbErr) return json(500, { error: 'Supabase query failed: ' + dbErr.message });

    let bfUsersResp;
    try {
      bfUsersResp = await bfRequest('users/list.aspx', '<request><userList><listType>basic</listType></userList></request>');
    } catch (e) {
      return json(200, {
        note: 'Could not fetch BlueFolder user list -- likely an auth/token issue with BLUEFOLDER_API_TOKEN itself, separate from the userId question.',
        error: e.message,
        supabaseMapping: mapped,
      });
    }

    const bfUsers = bfUsersResp?.user ? [].concat(bfUsersResp.user) : [];
    const bfUserIds = new Set(bfUsers.map(u => String(u.userId ?? u.id ?? '')));
    const bfUserSummary = bfUsers.map(u => ({ userId: String(u.userId ?? u.id ?? ''), userName: u.userName || u.firstName + ' ' + u.lastName || '' }));

    const comparison = mapped.map(t => ({
      name: t.name,
      storedBlueFolderUserId: t.bluefolder_user_id,
      existsInBlueFolder: bfUserIds.has(String(t.bluefolder_user_id)),
    }));

    const mismatches = comparison.filter(c => !c.existsInBlueFolder);

    return json(200, {
      totalMappedInSupabase: mapped.length,
      totalRealBlueFolderUsers: bfUsers.length,
      rawFirstUserRecord: bfUsers[0] || null,
      mismatchCount: mismatches.length,
      mismatches,
      realBlueFolderUsers: bfUserSummary,
      fullComparison: comparison,
    });
  } catch (err) {
    return json(500, { error: 'Diagnostic failed: ' + err.message });
  }
};
