// get-restock-review-queue.js
//
// Backs the "needs review" toast on restock-tracker.html: lists site_visits
// rows where a closing note's restock language was ambiguous enough that
// lib/closing-notes.js's classifyRestockConfirmation() (see
// lib/detect-restock-in-note.js) set restock_review_pending=true instead of
// auto-applying included_restock. A dispatcher confirms or rejects each one
// via resolve-restock-review.js.
//
// Query params:
//   state (optional) - 2-letter state code; omit for all states

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});

  const params = event.queryStringParameters || {};
  const state = params.state || null;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let query = supabase
    .from('site_visits')
    .select('id, appointment_number, site_id, state, started_at, tech_name_raw, closing_note, restock_review_reason, tickets(inbound_email_id)')
    .eq('restock_review_pending', true)
    .order('started_at', { ascending: false });
  if (state) query = query.eq('state', state);

  const { data: visits, error } = await query;
  if (error) return json(500, { ok: false, error: 'site_visits fetch failed: ' + error.message });

  // Sites fetched separately and joined in JS -- same convention as
  // get-restock-schedule.js, rather than assuming a configured embed
  // relationship name for site_id -> sites.
  const siteIds = [...new Set((visits || []).map((v) => v.site_id).filter(Boolean))];
  let siteById = {};
  if (siteIds.length) {
    const { data: sites, error: sitesErr } = await supabase
      .from('sites')
      .select('id, site_code, name, state')
      .in('id', siteIds);
    if (sitesErr) return json(500, { ok: false, error: 'sites fetch failed: ' + sitesErr.message });
    siteById = Object.fromEntries((sites || []).map((s) => [s.id, s]));
  }

  const items = (visits || []).map((v) => {
    const site = siteById[v.site_id] || null;
    return {
      id: v.id,
      appointmentNumber: v.appointment_number,
      siteId: v.site_id,
      siteCode: site ? site.site_code : null,
      siteName: site ? site.name : null,
      state: v.state,
      startedAt: v.started_at,
      tech: v.tech_name_raw,
      closingNote: v.closing_note,
      reason: v.restock_review_reason,
      emailId: v.tickets ? v.tickets.inbound_email_id : null,
    };
  });

  return json(200, { ok: true, items, count: items.length });
};
