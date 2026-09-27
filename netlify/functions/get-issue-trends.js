// get-issue-trends.js
//
// Weekly volume for a problem bucket across states, so a statewide or
// multi-state pattern (Florida forms, a bad ribbon lot, a journal driver)
// shows up even when no single site has hit the 3-ticket Repeat Issues
// threshold. Built off incoming trouble tickets (issue_category /
// issue_detail) plus matching closing notes when they exist.
//
// Email tickets only go back to mid-2026 for most states; older Salesforce
// closed-ticket rows do not carry form-vs-printer-vs-jam, so this will not
// reconstruct events from years ago. Read-only.

const { createClient } = require('@supabase/supabase-js');

const NON_FAULT_CATEGORIES = new Set(['Technician Request', 'Research']);

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function mondayOf(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay(); // 0 Sun
  const diff = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

function ticketMatchesType(category, detail, description, type) {
  const cat = (category || '').toLowerCase();
  const det = (detail || '').toLowerCase();
  const desc = (description || '').toLowerCase();
  const blob = cat + ' ' + det + ' ' + desc;
  if (!type || type === 'all') return true;
  if (type === 'journal') return cat === 'journal printer';
  if (type === 'registration') return cat === 'registration printer';
  if (type === 'print_quality') {
    return (cat === 'journal printer' || cat === 'registration printer') &&
      /print quality|form fault|unable to print/.test(det);
  }
  if (type === 'ribbon') {
    return (cat === 'journal printer' || cat === 'registration printer') &&
      /ribbon/.test(blob);
  }
  if (type === 'connectivity') {
    return cat === 'offline' ||
      /connection failure|connection issue|power|cell modem|internal wiring|offline/.test(blob);
  }
  if (type === 'card') return cat === 'card reader';
  if (type === 'touchscreen') return cat === 'touchscreen';
  if (type === 'cash') {
    return cat === 'cash dispenser' || cat === 'cash acceptor' || cat === 'coin dispenser';
  }
  return true;
}

function noteLooksLikeRestock(note, remediation, remediationDetail, isRestock) {
  if (isRestock) return true;
  if (/preventative|consumable restock/i.test(String(remediation || '') + ' ' + String(remediationDetail || ''))) return true;
  const n = String(note || '').toLowerCase();
  if (!n) return false;
  const boilerplate = /replaced \d+(st|nd|rd|th)? roll of forms|arrived on site for a consumable restock|old forms at \d+%/;
  const problemish = /stick(ing)? to ribbon|print quality|halfway|sensor|notch|calibrat|wrong form|state form|fading|streak|form fault|unable to print|level two|level 2/;
  if (boilerplate.test(n) && !problemish.test(n)) return true;
  return false;
}

async function fetchAll(supabase, table, columns, apply) {
  const page = 1000;
  let from = 0;
  const out = [];
  while (true) {
    let q = supabase.from(table).select(columns);
    if (apply) q = apply(q);
    const { data, error } = await q.range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = data || [];
    out.push(...rows);
    if (rows.length < page) break;
    from += page;
    if (from > 20000) break;
  }
  return out;
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const state = params.state || null;
  const days = Math.min(Math.max(parseInt(params.days || '90', 10) || 90, 30), 365);
  const type = params.type || 'all';

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceDate = since.toISOString();
  const midpoint = new Date(since.getTime() + (Date.now() - since.getTime()) / 2).toISOString();

  try {
    let sitesQuery = (q) => {
      q = q.select('id, site_code, name, state');
      if (state) q = q.eq('state', state);
      return q;
    };
    // fetchAll applies extra select — handle sites separately
    let sq = supabase.from('sites').select('id, site_code, name, state');
    if (state) sq = sq.eq('state', state);
    const { data: sites, error: sitesErr } = await sq;
    if (sitesErr) return json(500, { ok: false, error: sitesErr.message });
    const siteById = {};
    for (const s of sites || []) siteById[s.id] = s;

    const tickets = await fetchAll(
      supabase,
      'tickets',
      'id, site_id, issue_category, issue_detail, description, received_at, wo_number, inbound_email_id',
      (q) => q.eq('ticket_kind', 'trouble').not('site_id', 'is', null).gte('received_at', sinceDate)
    );

    const matched = [];
    for (const t of tickets) {
      const site = siteById[t.site_id];
      if (!site) continue;
      if (NON_FAULT_CATEGORIES.has(t.issue_category)) continue;
      if (!ticketMatchesType(t.issue_category, t.issue_detail, t.description, type)) continue;
      matched.push({
        id: t.id,
        site_id: t.site_id,
        site_code: site.site_code,
        site_name: site.name,
        state: site.state,
        issue_category: t.issue_category,
        issue_detail: t.issue_detail,
        description: t.description,
        received_at: t.received_at,
        wo_number: t.wo_number,
        inbound_email_id: t.inbound_email_id,
        week: t.received_at ? mondayOf(new Date(t.received_at)) : null,
      });
    }

    const weekMap = {};
    const stateCounts = {};
    const stateRecent = {};
    const statePrior = {};
    const siteCounts = {};
    for (const t of matched) {
      if (t.week) {
        if (!weekMap[t.week]) weekMap[t.week] = { week_start: t.week, count: 0, by_state: {} };
        weekMap[t.week].count += 1;
        weekMap[t.week].by_state[t.state] = (weekMap[t.week].by_state[t.state] || 0) + 1;
      }
      stateCounts[t.state] = (stateCounts[t.state] || 0) + 1;
      if (t.received_at >= midpoint) stateRecent[t.state] = (stateRecent[t.state] || 0) + 1;
      else statePrior[t.state] = (statePrior[t.state] || 0) + 1;
      const sk = t.site_code + '|' + t.state;
      if (!siteCounts[sk]) siteCounts[sk] = { site_code: t.site_code, site_name: t.site_name, state: t.state, count: 0 };
      siteCounts[sk].count += 1;
    }

    // Fill empty weeks so the sparkline does not skip quiet weeks
    const weeks = [];
    const cursor = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
    const startMon = mondayOf(cursor);
    let w = new Date(startMon + 'T00:00:00Z');
    const now = new Date();
    while (w <= now) {
      const key = w.toISOString().slice(0, 10);
      weeks.push(weekMap[key] || { week_start: key, count: 0, by_state: {} });
      w.setUTCDate(w.getUTCDate() + 7);
    }

    const states = Object.keys(stateCounts).sort((a, b) => stateCounts[b] - stateCounts[a]).map((st) => {
      const recent = stateRecent[st] || 0;
      const prior = statePrior[st] || 0;
      let trend = 'flat';
      if (recent > prior * 1.25 && recent - prior >= 2) trend = 'up';
      else if (prior > recent * 1.25 && prior - recent >= 2) trend = 'down';
      return {
        state: st,
        count: stateCounts[st],
        recent,
        prior,
        trend,
      };
    });

    const hotSites = Object.values(siteCounts).sort((a, b) => b.count - a.count).slice(0, 12);

    // Attach notes for the most recent matching tickets (skip restock boilerplate)
    const recentForNotes = matched
      .slice()
      .sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)))
      .slice(0, 40);
    const noteTicketIds = recentForNotes.map((t) => t.id).filter(Boolean);
    const noteWos = [...new Set(recentForNotes.map((t) => t.wo_number).filter(Boolean))];
    const visitByTicket = {};
    const visitByWo = {};
    async function loadVisitChunk(column, values) {
      for (let i = 0; i < values.length; i += 80) {
        const chunk = values.slice(i, i + 80);
        const { data: visits, error: vErr } = await supabase
          .from('site_visits')
          .select('ticket_id, wo_number, appointment_number, closing_note, tech_name_raw, started_at, remediation, remediation_detail, is_restock')
          .in(column, chunk);
        if (vErr) break;
        for (const v of visits || []) {
          if (v.ticket_id) visitByTicket[v.ticket_id] = v;
          if (v.wo_number) visitByWo[v.wo_number] = v;
        }
      }
    }
    if (noteTicketIds.length) await loadVisitChunk('ticket_id', noteTicketIds);
    if (noteWos.length) await loadVisitChunk('wo_number', noteWos);

    const samples = recentForNotes.map((t) => {
        const v = (t.id && visitByTicket[t.id]) || (t.wo_number && visitByWo[t.wo_number]) || null;
        let note = v && v.closing_note ? v.closing_note : null;
        if (note && noteLooksLikeRestock(note, v.remediation, v.remediation_detail, v.is_restock)) note = null;
        return {
          received_at: t.received_at,
          state: t.state,
          site_code: t.site_code,
          site_name: t.site_name,
          issue_category: t.issue_category,
          issue_detail: t.issue_detail,
          description: t.description,
          wo_number: t.wo_number,
          inbound_email_id: t.inbound_email_id,
          appointment_number: v ? v.appointment_number : null,
          closing_note: note,
          tech_name_raw: v ? v.tech_name_raw : null,
        };
      });

    return json(200, {
      ok: true,
      type,
      days,
      state: state || null,
      total: matched.length,
      midpoint,
      weeks,
      states,
      hot_sites: hotSites,
      samples,
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
