// get-monthly-calls.js
// SAVE AS: netlify/functions/get-monthly-calls.js
//
// Closed-visit counts by state and month, split into restock vs trouble/service,
// for the admin "Issue Trends > Monthly calls by state" view. Read-only.
//
// Source: site_visits (closed Salesforce visits), grouped by the visit start time in
// Eastern time. Classification:
//   restock       = is_restock true
//   trouble       = not restock, remediation is Hardware / Connectivity / Software
//                   Troubleshooting, Expected Functionality or Service Call
//   other_pm      = not restock, remediation starts with "Preventative Maint"
//   unclassified  = not restock, no remediation recorded
// GET ?year=2026 (default: current year, Eastern)

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric' });
function etYearMonth(iso) {
  const parts = ET.formatToParts(new Date(iso));
  let y = 0, m = 0;
  for (const p of parts) { if (p.type === 'year') y = +p.value; if (p.type === 'month') m = +p.value; }
  return { y, m };
}

const TROUBLE_KEYS = [
  ['hardware', /^hardware/i],
  ['connectivity', /^connectivity/i],
  ['software', /^software/i],
  ['expected', /^expected functionality/i],
  ['service_call', /^service call/i],
];

function classify(v) {
  if (v.is_restock === true) return { bucket: 'restock' };
  const r = String(v.remediation || '').trim();
  if (!r) return { bucket: 'unclassified' };
  for (const [key, re] of TROUBLE_KEYS) if (re.test(r)) return { bucket: 'trouble', sub: key };
  if (/^preventative maint/i.test(r)) return { bucket: 'other_pm' };
  return { bucket: 'unclassified' };
}

async function fetchPage(supabase, fromIso, toIso, offset) {
  const { data, error } = await supabase
    .from('site_visits')
    .select('id, state, started_at, is_restock, remediation')
    .gte('started_at', fromIso)
    .lt('started_at', toIso)
    .order('id', { ascending: true })
    .range(offset, offset + 999);
  if (error) throw new Error(error.message);
  return data || [];
}

exports.handler = async (event) => {
  const params = (event && event.queryStringParameters) || {};
  const nowEt = etYearMonth(new Date().toISOString());
  const year = Math.min(Math.max(parseInt(params.year || String(nowEt.y), 10) || nowEt.y, 2025), nowEt.y);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: 'Supabase is not configured' });
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Pad the range by a day each side, then keep only visits whose Eastern year matches.
    const fromIso = new Date(Date.UTC(year, 0, 1) - 24 * 3600 * 1000).toISOString();
    const toIso = new Date(Date.UTC(year + 1, 0, 1) + 24 * 3600 * 1000).toISOString();

    const rowsMap = {};
    const troubleByMonth = {};
    let total = 0;
    let offset = 0;
    for (let guard = 0; guard < 60; guard++) {
      const page = await fetchPage(supabase, fromIso, toIso, offset);
      for (const v of page) {
        if (!v.started_at || !v.state) continue;
        const { y, m } = etYearMonth(v.started_at);
        if (y !== year) continue;
        const st = String(v.state).toUpperCase();
        const k = st + '|' + m;
        const row = rowsMap[k] || (rowsMap[k] = { state: st, month: m, restock: 0, trouble: 0, other_pm: 0, unclassified: 0 });
        const c = classify(v);
        row[c.bucket] += 1;
        total += 1;
        if (c.sub) {
          const t = troubleByMonth[m] || (troubleByMonth[m] = { month: m, hardware: 0, connectivity: 0, software: 0, expected: 0, service_call: 0 });
          t[c.sub] += 1;
        }
      }
      if (page.length < 1000) break;
      offset += 1000;
    }

    const rows = Object.values(rowsMap).sort((a, b) => a.state.localeCompare(b.state) || a.month - b.month);
    const trouble_detail = Object.values(troubleByMonth).sort((a, b) => a.month - b.month);
    const lastMonth = year === nowEt.y ? nowEt.m : 12;

    return json(200, {
      ok: true,
      year,
      last_month: lastMonth,
      partial_month: year === nowEt.y ? nowEt.m : null,
      total,
      rows,
      trouble_detail,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
