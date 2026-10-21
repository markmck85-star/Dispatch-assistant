// dco-status.js
//
// Decal change-out (DCO) tracker. Added 2026-10-21 ahead of Georgia's change from the green 2026 forms to
// the yellow 2028 forms (Ohio and Illinois ran theirs in Sept/Oct 2026).
//
// A DCO has no usage trigger: every kiosk that runs two form types must be visited once before the due
// date. This function answers "which sites are done, which are left, and are we on pace".
//
// Evidence a site is done, strongest first:
//   0. counter and testing sites (machine type OTHER, or a site code that is not the usual two letters and
//      four digits) are treated as not applicable automatically: their forms are changed by the state's own
//      staff, not by MCR technicians (Ohio, Sept 2026: 0 of 43 such sites had a change-out note, against
//      41 of 68 regular kiosks). A manual 'include' mark puts one back in scope.
//   1. Neumo's own "Decal Change" maintenance tickets: a site with one is in scope even if it looks like a
//      counter site, and the ticket being closed counts as done (Ohio, Sept 2026: 47 of 66 regular kiosks
//      got a ticket, all closed; the rest were done on other visits and say so in the closing note).
//   2. a manual mark on the tracker page (done / exempt / include), stored in dco_marks
//   3. a closing note on a visit on/after the campaign start that says the change-out was performed
//      ("completed DCO", "performed decal change over", "performed the dco on printer two" ...)
// A note that mentions a DCO but reads as not done or still to do ("no dco", "needs dco", "will do dco") is
// returned as status 'review' so a person decides. Per-printer tracking is not modelled yet: one site, one
// done date.
//
// GET  ?state=OH                      -> campaign, counts, pace, sites
// POST { action:'save_campaign', state, start_date, due_date }
// POST { action:'mark', state, site_code, status:'done'|'exempt'|'clear', done_date?, note? }

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify(obj),
  };
}

const DCO_TERM = /\b(?:d\.?c\.?o\.?|decal[\s-]*change(?:[\s-]*(?:over|out))?|change[\s-]*out of decals?|decal[\s-]*changeover)\b/i;
// "no dco", "did not do the dco", "needs a dco", "will perform dco", "dco needed/pending/scheduled", "unable to dco"
const NOT_DONE = /(?:\b(?:no|not|n't|unable to|couldn'?t|could not|need(?:s|ed)?(?: to)?|still need(?:s)?(?: to)?|will|to be|must|should|pending|schedule[d]?(?: for)?|waiting (?:on|for)|awaiting)\s+(?:be\s+)?(?:perform(?:ed)?\s+|complete[d]?\s+|do(?:ne)?\s+)?(?:a\s+|the\s+|an\s+)?(?:d\.?c\.?o\.?|decal[\s-]*change)|(?:d\.?c\.?o\.?|decal[\s-]*change(?:[\s-]*(?:over|out))?)\s+(?:is\s+|was\s+)?(?:needed|pending|not done|not complete[d]?|still due|scheduled|to be done|remains))/i;

function ymd(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function todayEt() {
  // Calendar date in America/New_York.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function etDate(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
function workdaysBetween(fromStr, toStr) {
  // Monday-Friday days from fromStr through toStr inclusive; 0 if the range is empty.
  if (toStr < fromStr) return 0;
  let n = 0;
  for (let d = fromStr; d <= toStr; d = addDays(d, 1)) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

const IN_CHUNK = 100;
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

async function loadCampaign(supabase, state) {
  const { data, error } = await supabase.from('dco_campaigns').select('*').eq('state', state)
    .order('start_date', { ascending: false }).limit(1);
  if (error) throw new Error('campaign fetch failed: ' + error.message);
  return (data && data[0]) || null;
}

exports.handler = async (event) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { ok: false, error: 'Not configured.' });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (event.httpMethod === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'Bad request.' }); }
      const state = String(body.state || '').trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(state)) return json(400, { ok: false, error: 'Pick a state.' });

      if (body.action === 'save_campaign') {
        const start = String(body.start_date || ''), due = String(body.due_date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return json(400, { ok: false, error: 'Enter both dates.' });
        if (due < start) return json(400, { ok: false, error: 'The completion date is before the start date.' });
        const existing = await loadCampaign(supabase, state);
        let err;
        if (existing) ({ error: err } = await supabase.from('dco_campaigns').update({ start_date: start, due_date: due, updated_at: new Date().toISOString() }).eq('id', existing.id));
        else ({ error: err } = await supabase.from('dco_campaigns').insert({ state, start_date: start, due_date: due }));
        if (err) return json(500, { ok: false, error: 'Could not save the dates.' });
        return json(200, { ok: true });
      }

      if (body.action === 'mark') {
        const camp = await loadCampaign(supabase, state);
        if (!camp) return json(400, { ok: false, error: 'Set the start and completion dates first.' });
        const code = String(body.site_code || '').trim().toUpperCase();
        const { data: site } = await supabase.from('sites').select('id').eq('site_code', code).limit(1);
        if (!site || !site.length) return json(404, { ok: false, error: 'Site not found.' });
        const status = String(body.status || '');
        if (status === 'clear') {
          const { error } = await supabase.from('dco_marks').delete().eq('campaign_id', camp.id).eq('site_id', site[0].id);
          if (error) return json(500, { ok: false, error: 'Could not clear the mark.' });
          return json(200, { ok: true });
        }
        if (status !== 'done' && status !== 'exempt' && status !== 'include') return json(400, { ok: false, error: 'Unknown status.' });
        const doneDate = status === 'done' && /^\d{4}-\d{2}-\d{2}$/.test(String(body.done_date || '')) ? body.done_date : (status === 'done' ? todayEt() : null);
        const row = {
          campaign_id: camp.id, site_id: site[0].id, status,
          done_date: doneDate, note: body.note ? String(body.note).slice(0, 300) : null,
          marked_at: new Date().toISOString(),
        };
        const { error } = await supabase.from('dco_marks').upsert(row, { onConflict: 'campaign_id,site_id' });
        if (error) return json(500, { ok: false, error: 'Could not save the mark.' });
        return json(200, { ok: true });
      }
      return json(400, { ok: false, error: 'Unknown action.' });
    }

    if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method Not Allowed' });
    const params = event.queryStringParameters || {};
    const state = String(params.state || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) return json(400, { ok: false, error: 'Pick a state.' });

    const camp = await loadCampaign(supabase, state);
    if (!camp) return json(200, { ok: true, state, campaign: null, sites: [], counts: null });

    const { data: sites, error: sErr } = await supabase.from('sites')
      .select('id, site_code, name, county, primary_tech_id, machine_type')
      .eq('state', state).eq('active', true).eq('is_placeholder', false).order('site_code');
    if (sErr) return json(500, { ok: false, error: 'sites fetch failed' });
    const ids = (sites || []).map((s) => s.id);

    const { data: techs } = await supabase.from('technicians').select('id, name');
    const techName = {}; (techs || []).forEach((t) => { techName[t.id] = t.name; });

    const marks = {};
    {
      const { data } = await supabase.from('dco_marks').select('site_id, status, done_date, note').eq('campaign_id', camp.id);
      (data || []).forEach((m) => { marks[m.site_id] = m; });
    }

    // Closing notes on/after the campaign start that mention a change-out.
    const noteHits = {}; // site_id -> { done: {date, tech, note}, review: {date, tech, note} }
    const lastVisit = {};
    for (const c of chunk(ids, IN_CHUNK)) {
      const { data, error } = await supabase.from('site_visits')
        .select('site_id, started_at, tech_name_raw, closing_note')
        .in('site_id', c)
        .gte('started_at', camp.start_date + 'T00:00:00-05:00')
        .not('closing_note', 'is', null)
        .order('started_at', { ascending: true });
      if (error) return json(500, { ok: false, error: 'visits fetch failed' });
      for (const v of data || []) {
        const note = String(v.closing_note || '');
        const day = etDate(v.started_at);
        if (day < camp.start_date) continue;
        lastVisit[v.site_id] = day;
        if (!DCO_TERM.test(note)) continue;
        const hit = { date: day, tech: v.tech_name_raw || '', note: note.length > 220 ? note.slice(0, 220) + '...' : note };
        const slot = (noteHits[v.site_id] = noteHits[v.site_id] || {});
        if (NOT_DONE.test(note)) { if (!slot.review) slot.review = hit; }
        else if (!slot.done) slot.done = hit;
      }
    }

    // Neumo "Decal Change" maintenance tickets received on/after the campaign start.
    const ticketHits = {}; // site_id -> { wo, closed, received }
    for (const c of chunk(ids, IN_CHUNK)) {
      const { data: tks, error: tErr } = await supabase.from('tickets')
        .select('site_id, wo_number, status, manually_resolved_at, received_at, inbound_email_id')
        .in('site_id', c).gte('received_at', camp.start_date + 'T00:00:00-05:00').not('inbound_email_id', 'is', null);
      if (tErr) return json(500, { ok: false, error: 'tickets fetch failed' });
      const emailIds = [...new Set((tks || []).map((t) => t.inbound_email_id))];
      const dcoEmail = new Set();
      for (const ec of chunk(emailIds, IN_CHUNK)) {
        const { data: ems, error: eErr } = await supabase.from('inbound_emails').select('id').in('id', ec).ilike('body_text', '%decal%change%');
        if (eErr) return json(500, { ok: false, error: 'emails fetch failed' });
        (ems || []).forEach((e) => dcoEmail.add(e.id));
      }
      for (const t of tks || []) {
        if (!dcoEmail.has(t.inbound_email_id)) continue;
        const closed = t.status === 'closed' || !!t.manually_resolved_at;
        const prev = ticketHits[t.site_id];
        // Keep one entry per site: any open ticket keeps the site open; otherwise the latest closed one.
        if (!prev || (!closed && prev.closed) || (closed === prev.closed && t.received_at > prev.received)) {
          ticketHits[t.site_id] = { wo: t.wo_number, closed, received: t.received_at };
        }
      }
    }

    // A closed ticket only counts as a completed change-out if a visit was recorded against that work order;
    // a ticket closed with no visit was canceled or covered by an earlier visit (the closing note decides).
    const woList = Object.values(ticketHits).filter((t) => t.closed).map((t) => t.wo).filter(Boolean);
    const woVisit = {}; // wo_number -> ET date of the visit
    for (const c of chunk(woList, IN_CHUNK)) {
      const { data: vs, error: vErr } = await supabase.from('site_visits').select('wo_number, started_at').in('wo_number', c);
      if (vErr) return json(500, { ok: false, error: 'ticket visits fetch failed' });
      (vs || []).forEach((v) => { const d = etDate(v.started_at); if (!woVisit[v.wo_number] || d > woVisit[v.wo_number]) woVisit[v.wo_number] = d; });
    }

    const rows = (sites || []).map((s) => {
      const m = marks[s.id];
      const tk = ticketHits[s.id];
      const h = noteHits[s.id] || {};
      let status = 'remaining', doneDate = null, source = null, evidence = null, tech = null;
      const counterSite = s.machine_type === 'OTHER' || !/^[A-Z]{2}\d{4}$/.test(s.site_code);
      if (m && m.status === 'exempt') { status = 'exempt'; source = 'manual'; evidence = m.note || null; }
      else if (m && m.status === 'done') { status = 'done'; doneDate = m.done_date; source = 'manual'; evidence = m.note || null; }
      else if (h.done) { status = 'done'; doneDate = h.done.date; source = 'closing note'; evidence = h.done.note; tech = h.done.tech; }
      else if (tk && tk.closed && woVisit[tk.wo]) { status = 'done'; doneDate = woVisit[tk.wo]; source = 'ticket closed'; evidence = 'Change-out ticket ' + tk.wo + ' completed'; }
      else if (tk && tk.closed) { status = 'review'; source = 'ticket closed'; evidence = 'Change-out ticket ' + tk.wo + ' was closed with no visit recorded (canceled, or done on an earlier visit)'; }
      else if (tk) { status = 'remaining'; source = 'ticket open'; evidence = 'Change-out ticket ' + tk.wo + ' open'; }
      else if (counterSite && !(m && m.status === 'include')) { status = 'exempt'; source = 'automatic'; evidence = 'Counter or testing site'; }
      else if (h.review) { status = 'review'; doneDate = h.review.date; source = 'closing note'; evidence = h.review.note; tech = h.review.tech; }
      return {
        site_code: s.site_code, name: s.name, county: s.county || null, machine_type: s.machine_type || null,
        primaryTech: techName[s.primary_tech_id] || null,
        status, doneDate, source, evidence, doneBy: tech, counterSite, ticketed: !!tk,
        lastVisit: lastVisit[s.id] || null,
      };
    });

    const counts = { total: rows.length, done: 0, remaining: 0, review: 0, exempt: 0 };
    rows.forEach((r) => { counts[r.status]++; });
    const inScope = counts.total - counts.exempt;

    const today = todayEt();
    const perDay = {};
    rows.forEach((r) => { if (r.status === 'done' && r.doneDate) perDay[r.doneDate] = (perDay[r.doneDate] || 0) + 1; });
    const from = today < camp.start_date ? camp.start_date : today;
    const workdaysLeft = workdaysBetween(from, camp.due_date);
    const left = counts.remaining + counts.review;
    const elapsedWork = Math.max(1, workdaysBetween(camp.start_date, today < camp.due_date ? today : camp.due_date));
    const started = today >= camp.start_date;
    const doneLast7 = rows.filter((r) => r.status === 'done' && r.doneDate && r.doneDate > addDays(today, -7)).length;
    const pace = {
      today, daysLeft: Math.max(0, Math.round((new Date(camp.due_date) - new Date(today)) / 86400000)),
      workdaysLeft, needPerWorkday: workdaysLeft > 0 ? Math.ceil((left / workdaysLeft) * 10) / 10 : null,
      donePerWorkday: started ? Math.round((counts.done / elapsedWork) * 10) / 10 : null,
      doneLast7,
      projectedFinish: null,
      pastDue: today > camp.due_date && left > 0,
    };
    if (started && doneLast7 > 0 && left > 0) {
      // Rough: last 7 calendar days of completions is about 5 workdays of pace.
      const rate = doneLast7 / 5;
      const need = Math.ceil(left / rate);
      let d = from, n = 0;
      while (n < need && n < 400) { d = addDays(d, 1); const dow = new Date(d + 'T00:00:00Z').getUTCDay(); if (dow !== 0 && dow !== 6) n++; }
      pace.projectedFinish = d;
    }

    return json(200, {
      ok: true, state,
      campaign: { start_date: camp.start_date, due_date: camp.due_date },
      counts, inScope, pace, perDay, sites: rows,
    });
  } catch (e) {
    console.error('[dco-status] error:', e.message);
    return json(500, { ok: false, error: 'Something went wrong. Try again.' });
  }
};
