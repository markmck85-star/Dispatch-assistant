/**
 * diagnose-appointments-variants.js — ONE-TIME DIAGNOSTIC, safe to delete after use
 *
 * Both prior hypotheses (date format, userId mismatch) checked out clean --
 * the request matches BlueFolder's documented format exactly, and the
 * stored userId values were all confirmed as real, valid BlueFolder users.
 * Yet appointments/list.aspx still 404s "Data not found" for every single
 * technician. Rather than guess a third single change, this tries several
 * variants of the same call against one known-good userId (Aaron Schrop,
 * 33546928, already confirmed to exist) to isolate which piece actually
 * matters: the userId filter itself, the date range, or something at the
 * account/permission level unrelated to the request shape at all.
 *
 * Visit once in a browser:
 *   https://mcrdispatch.net/.netlify/functions/diagnose-appointments-variants?confirm=yes
 */
const { XMLParser } = require('fast-xml-parser');

const BF_BASE = 'https://app.bluefolder.com/api/2.0';
const xmlParser = new XMLParser({ ignoreAttributes: false });
const TEST_USER_ID = '33546928'; // Aaron Schrop -- confirmed to exist in BlueFolder

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

async function bfRequestRaw(endpoint, bodyXml) {
  const token = process.env.BLUEFOLDER_API_TOKEN;
  const auth = Buffer.from(`${token}:x`).toString('base64');
  const res = await fetch(`${BF_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'text/xml' },
    body: bodyXml,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = xmlParser.parse(text); } catch (e) { /* leave null, raw text still returned below */ }
  return { httpStatus: res.status, raw: text.slice(0, 400), parsed };
}

exports.handler = async (event) => {
  const confirm = (event.queryStringParameters || {}).confirm;
  if (confirm !== 'yes') return json(400, { error: 'Add ?confirm=yes to the URL to run this.' });

  const today = new Date();
  const in60 = new Date();
  in60.setDate(in60.getDate() + 60);
  const yyyy = today.getUTCFullYear(), mm = String(today.getUTCMonth() + 1).padStart(2, '0'), dd = String(today.getUTCDate()).padStart(2, '0');
  const yyyy2 = in60.getUTCFullYear(), mm2 = String(in60.getUTCMonth() + 1).padStart(2, '0'), dd2 = String(in60.getUTCDate()).padStart(2, '0');

  const variants = [
    {
      name: 'A: full request as currently built (dot-format dates + userId)',
      body: `<request><appointmentList><dateRangeStart>${yyyy}.${mm}.${dd} 12:00 AM</dateRangeStart><dateRangeEnd>${yyyy2}.${mm2}.${dd2} 11:59 PM</dateRangeEnd><userId>${TEST_USER_ID}</userId></appointmentList></request>`,
    },
    {
      name: 'B: same but WITHOUT userId filter (date range only, all techs)',
      body: `<request><appointmentList><dateRangeStart>${yyyy}.${mm}.${dd} 12:00 AM</dateRangeStart><dateRangeEnd>${yyyy2}.${mm2}.${dd2} 11:59 PM</dateRangeEnd></appointmentList></request>`,
    },
    {
      name: 'C: same but hyphen/ISO date format instead of dots',
      body: `<request><appointmentList><dateRangeStart>${yyyy}-${mm}-${dd}</dateRangeStart><dateRangeEnd>${yyyy2}-${mm2}-${dd2}</dateRangeEnd><userId>${TEST_USER_ID}</userId></appointmentList></request>`,
    },
    {
      name: 'D: no wrapping <appointmentList>, params directly under <request>',
      body: `<request><dateRangeStart>${yyyy}.${mm}.${dd} 12:00 AM</dateRangeStart><dateRangeEnd>${yyyy2}.${mm2}.${dd2} 11:59 PM</dateRangeEnd><userId>${TEST_USER_ID}</userId></request>`,
    },
    {
      name: 'E: minimal -- just an empty appointmentList element',
      body: `<request><appointmentList></appointmentList></request>`,
    },
  ];

  const results = [];
  for (const v of variants) {
    try {
      const r = await bfRequestRaw('appointments/list.aspx', v.body);
      results.push({ variant: v.name, sentBody: v.body, httpStatus: r.httpStatus, rawResponse: r.raw, parsedStatus: r.parsed?.response?.['@_status'] || null });
    } catch (e) {
      results.push({ variant: v.name, sentBody: v.body, fetchError: e.message });
    }
  }

  return json(200, { results });
};
