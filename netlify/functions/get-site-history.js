// get-site-history.js
//
// Powers the clickable-location-history feature on the dispatch board:
// clicking a location name shows its recent visits (restocks + trouble
// calls) pulled from site_visits, populated by the Closed Tickets import
// (2026-07-22). Read-only.
//
// 2026-09-22: also surface tickets that arrived by email but never got a
// site_visits row (testing-station / TechWeb / SOS sites that are not in
// the Salesforce closed-ticket report). Deduped by WO against existing
// visits so kiosk sites don't show the same job twice.
//
// 2026-10-07: each closed-ticket visit now also carries manual_restock,
// manual_nonrestock and counts_as_restock so the restock tracker's history
// popup can show (and let the user change) how that visit is counted.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// Same resolution rule as get-restock-schedule.js: which visit (ms) a manual
// confirmation refers to. visitTimes ascending.
function resolveConfirmationVisit(conf, visitTimes) {
  const vdc = conf.visit_date_covered ? new Date(conf.visit_date_covered).getTime() : null;
  if (vdc != null && visitTimes.includes(vdc)) return vdc;
  const at = conf.confirmed_at ? new Date(conf.confirmed_at).getTime() : null;
  if (at == null) return null;
  let best = null;
  for (const t of visitTimes) { if (t <= at) best = t; else break; }
  return best;
}

function ticketAsVisit(t) {
  const detail = [t.issue_detail, t.description].filter(Boolean).join(' — ');
  return {
    started_at: t.received_at,
    ended_at: null,
    duration_min: null,
    tech_name_raw: t.technician_name || null,
    remediation: t.issue_category || t.ticket_kind || 'Service',
    remediation_detail: detail || null,
    is_restock: t.ticket_kind === 'restock',
    wo_number: t.wo_number || null,
    appointment_number: null,
    needs_review: !!t.needs_review,
    ticket_id: t.id,
    // Dispatch-email body is not a closing note. Keep it in
    // remediation_detail so the UI does not label it "Closing Note".
    closing_note: null,
    inbound_email_id: t.inbound_email_id || null,
    source: 'email_ticket',
    ticket_status: t.status || null,
    ticket_kind: t.ticket_kind || null,
  };
}

function bfAsVisit(sr) {
  const note = sr.detailed_description || sr.description || null;
  const when = sr.date_time_closed || sr.date_time_created;
  return {
    started_at: when,
    ended_at: sr.date_time_closed || null,
    duration_min: null,
    tech_name_raw: null,
    remediation: sr.type || sr.status || 'BlueFolder',
    remediation_detail: sr.description || null,
    is_restock: /\b(prevent|preventative|restock)\b/i.test(String(sr.type || '') + ' ' + String(sr.description || '')),
    wo_number: sr.service_request_id ? String(sr.service_request_id) : null,
    appointment_number: null,
    needs_review: !!sr.needs_review,
    ticket_id: null,
    closing_note: note,
    inbound_email_id: null,
    source: 'bluefolder',
    ticket_status: sr.status || null,
    ticket_kind: sr.type || null,
  };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const code = params.code;
  const offset = parseInt(params.offset || '0', 10);
  const PAGE_SIZE = 15;
  if (!code) return json(400, { ok: false, error: 'Missing ?code=' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, state, site_code')
    .eq('site_code', code)
    .maybeSingle();
  if (siteErr) return json(500, { ok: false, error: siteErr.message });
  if (!site) return json(404, { ok: false, error: 'No site found for code ' + code });

  const { data: visits, error: visitsErr, count: totalVisits } = await supabase
    .from('site_visits')
    .select('started_at, ended_at, duration_min, tech_name_raw, remediation, remediation_detail, is_restock, included_restock, wo_number, appointment_number, needs_review, ticket_id, closing_note', { count: 'exact' })
    .eq('site_id', site.id)
    .order('started_at', { ascending: false, nullsFirst: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (visitsErr) return json(500, { ok: false, error: visitsErr.message });

  const visitTicketIds = [...new Set((visits || []).map((v) => v.ticket_id).filter(Boolean))];
  let inboundEmailIdByTicketId = {};
  if (visitTicketIds.length) {
    const { data: ticketRows, error: ticketErr } = await supabase
      .from('tickets')
      .select('id, inbound_email_id')
      .in('id', visitTicketIds);
    if (ticketErr) return json(500, { ok: false, error: ticketErr.message });
    (ticketRows || []).forEach((t) => { if (t.inbound_email_id) inboundEmailIdByTicketId[t.id] = t.inbound_email_id; });
  }
  const visitsWithEmail = (visits || []).map((v) => ({
    ...v,
    inbound_email_id: v.ticket_id ? (inboundEmailIdByTicketId[v.ticket_id] || null) : null,
    source: 'site_visit',
  }));

  // Manual counting state. Non-fatal: if any of this fails the history still
  // loads, just without the flags.
  try {
    const { data: confs } = await supabase
      .from('site_manual_restock_confirmations')
      .select('confirmed_at, visit_date_covered')
      .eq('site_id', site.id);
    const { data: acks } = await supabase
      .from('site_nonrestock_acks')
      .select('appointment_number')
      .eq('site_id', site.id);
    const times = [];
    let from = 0;
    while (true) {
      const { data: page } = await supabase
        .from('site_visits')
        .select('started_at')
        .eq('site_id', site.id)
        .not('started_at', 'is', null)
        .order('started_at', { ascending: true })
        .range(from, from + 999);
      if (!page || !page.length) break;
      for (const r of page) times.push(new Date(r.started_at).getTime());
      if (page.length < 1000) break;
      from += 1000;
    }
    const manualTimes = new Set();
    for (const c of (confs || [])) {
      const t = resolveConfirmationVisit(c, times);
      if (t != null) manualTimes.add(t);
    }
    const ackedAppts = new Set((acks || []).map((a) => String(a.appointment_number || '').trim()).filter(Boolean));
    for (const v of visitsWithEmail) {
      const t = v.started_at ? new Date(v.started_at).getTime() : null;
      const appt = String(v.appointment_number || '').trim();
      v.manual_restock = t != null && manualTimes.has(t);
      v.manual_nonrestock = !!appt && ackedAppts.has(appt);
      v.counts_as_restock = !v.manual_nonrestock && (!!v.is_restock || !!v.included_restock || v.manual_restock);
    }
  } catch (e) {
    // leave flags undefined
  }

  // Email tickets with no matching closed-ticket visit (testing locations).
  let extraFromTickets = [];
  if (offset === 0) {
    const { data: ticketRows, error: allTickErr } = await supabase
      .from('tickets')
      .select('id, wo_number, ticket_kind, status, issue_category, issue_detail, description, received_at, inbound_email_id, needs_review')
      .eq('site_id', site.id)
      .order('received_at', { ascending: false, nullsFirst: false })
      .limit(200);
    if (allTickErr) return json(500, { ok: false, error: allTickErr.message });

    const { data: visitWos, error: woErr } = await supabase
      .from('site_visits')
      .select('wo_number')
      .eq('site_id', site.id)
      .not('wo_number', 'is', null);
    if (woErr) return json(500, { ok: false, error: woErr.message });
    const visitWoSet = new Set((visitWos || []).map((r) => String(r.wo_number)));

    extraFromTickets = (ticketRows || [])
      .filter((t) => !t.wo_number || !visitWoSet.has(String(t.wo_number)))
      .map(ticketAsVisit);
  }

  let extraFromBf = [];
  if (offset === 0) {
    const { data: bfRows, error: bfErr } = await supabase
      .from('bluefolder_service_requests')
      .select('service_request_id, description, detailed_description, status, type, date_time_created, date_time_closed, needs_review')
      .eq('site_id', site.id)
      .order('date_time_closed', { ascending: false, nullsFirst: false })
      .limit(500);
    if (bfErr) return json(500, { ok: false, error: bfErr.message });
    extraFromBf = (bfRows || []).map(bfAsVisit);
  }

  const merged = [...extraFromTickets, ...extraFromBf, ...visitsWithEmail].sort((a, b) => {
    const da = a.started_at ? new Date(a.started_at).getTime() : 0;
    const db = b.started_at ? new Date(b.started_at).getTime() : 0;
    return db - da;
  });

  const woNumbers = [...new Set(merged.map((v) => v.wo_number).filter(Boolean))];
  let shipments = [];
  if (woNumbers.length) {
    const { data: byWo, error: shipErr } = await supabase
      .from('rma_shipments')
      .select('wo_number, warehouse_name, outbound_tracking, inbound_tracking, return_broken_part, returned_at, received_at')
      .in('wo_number', woNumbers)
      .order('received_at', { ascending: false, nullsFirst: false });
    if (shipErr) return json(500, { ok: false, error: shipErr.message });
    shipments = byWo || [];
  }

  const visitCount = totalVisits != null ? totalVisits : visitsWithEmail.length;
  const extraCount = extraFromTickets.length + extraFromBf.length;
  const totalShownBase = visitCount + extraCount;

  return json(200, {
    ok: true,
    site: { name: site.name, state: site.state, code: site.site_code },
    visits: merged,
    shipments,
    offset,
    pageSize: PAGE_SIZE,
    totalVisits: totalShownBase,
    hasMore: offset + visitsWithEmail.length < visitCount,
  });
};
