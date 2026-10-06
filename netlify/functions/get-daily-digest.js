// get-daily-digest.js — v3.1 — 2026-10-01
//
// Netlify Function -- shared backend for the morning brief and the
// "State of the State" end-of-day digest. Returns structured data only
// (no narration), plus a short ranked "attention" list so a viewer, email
// or text can lead with what actually needs a look.
//
// GET /.netlify/functions/get-daily-digest?state=GA&mode=morning[&date=YYYY-MM-DD]
//   mode: 'morning' (default) or 'evening'
//   state: the dispatcher territory code. GA is the combined GA/NC/SC region.
//
// v2 changes (from v1, 2026-09-16):
//   - GA now means the whole GA/NC/SC region everywhere (sites, technicians,
//     tickets, weather), instead of GA only.
//   - Technician availability planning: out today, out next business day,
//     returning today, returning next business day. Free-text notes are NOT
//     returned for time off (only the type), so the data is safe to put in
//     an email or text.
//   - Trouble tickets use the computed SLA, are grouped by when they arrived
//     (carried over / overnight / today) and ranked by status: overdue, due
//     today, later, and "stale" (overdue more than STALE_DAYS, assumed closed
//     in reality). The ticket's own state is passed to the SLA calculator so
//     NC/SC tickets get the right Saturday rules.
//   - Armored truck meets are pulled out of the SLA list (the 4-hour clock
//     does not apply to them) into specialProjects.armoredTruckMeets with the
//     Loomis negotiation status.
//   - Installs/site surveys get a "when" (today / next / later / past /
//     unscheduled). Team-calendar entries of type Site Survey, Install and
//     Info/Note are returned as calendarProjects (ribbon cuttings and other
//     timed events can be entered on the calendar as Info/Note).
//   - Restock stops flag the ones pushed from the previous business day.
//   - techLoad: per-technician stop count and estimated drive time from the
//     distance tables, flagged when a tech has more than CALLS_LIMIT stops or
//     TRAVEL_LIMIT_MIN or more of estimated round-trip driving.
//   - dayWeight: light / regular / heavy, comparing stops per available tech
//     to the trailing BASELINE_DAYS average, using the state's saved
//     Heavy-Day Trigger as the heavy cutoff. The numbers behind it are
//     returned so the thresholds can be tuned against real days.
//   - weather: active Severe/Extreme National Weather Service alerts for the
//     territory (non-marine). Best effort; failure never breaks the digest.
//   - saturday: Saturday on-call technicians and dispatcher for the current
//     or coming Saturday.
//   - Open tickets are read with status = 'open' first (the table is small),
//     then the same resolved / closing-visit exclusions as v1.
//
// v3 changes (from v2):
//   - Reads dispatcher-maintained special projects (public.special_projects, see
//     special-projects.js): ribbon cuttings and anything arranged outside the
//     ticket flow, plus status/hold tracking for installs and surveys that are
//     delayed for reasons the app cannot see. Returned as specialProjects.projects
//     (needs eyes) and specialProjects.onHold (quiet until their hold date).
//     A project linked to a ticket replaces that ticket in specialProjects.installs;
//     if the linked ticket closes, the project drops off on its own.
//   - Installs/surveys that are past their date are NEVER treated as closed
//     (stores remodel, delay or cancel for reasons outside our control). They get
//     daysLate so the viewer can show them in their own quiet group.
//   - Attention list gains: special projects due today, projects waiting on a
//     store/carrier with no update for a couple of days, and ended holds.
//
// v3.1 changes (2026-10-01, after the first live look):
//   - The technician roster no longer counts placeholder records such as
//     "Unassigned (New Site)" (they inflated "techs available").
//   - GA comp days: Georgia's on-call comp days are not stored as rows; they
//     are computed from on_call_schedule (Robert Medley takes the Thursday before
//     his on-call Saturday, every other on-call tech takes the Monday), exactly
//     as get-state-console.js does. The digest now applies the same rule, so
//     "Technicians out" and the workload capacity match the State Console.
//     THURSDAY_COMP_TECHS below must be kept in sync with get-state-console.js.
//   - On a Saturday with an on-call schedule, only the on-call technicians count
//     as available (same as the State Console), and the long list of everyone
//     else is not shown as "out".
//
// Not covered yet: a true "pushed" marker on restock assignments (v2 infers
// it: not finished the previous business day and on the board again today).

const { createClient } = require('@supabase/supabase-js');
const { computeAreaWeight } = require('./lib/area-workload');
const { computeSlaDeadline, resolveTimezone, HOLIDAYS_2026 } = require('./slaCalculator.js');

// ---------------------------------------------------------------- config
const REGION_STATES = { GA: ['GA', 'NC', 'SC'] };

const STATE_TIMEZONES = {
  GA: 'America/New_York', NC: 'America/New_York', SC: 'America/New_York',
  FL: 'America/New_York', IN: 'America/New_York', OH: 'America/New_York',
  WV: 'America/New_York', MI: 'America/Detroit', IL: 'America/Chicago',
  MN: 'America/Chicago', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles',
  CO: 'America/Denver', ID: 'America/Boise', CA: 'America/Los_Angeles',
  AL: 'America/Chicago',
};

// GA-only on-call comp-day rule, mirrored from get-state-console.js (keep in sync).
const THURSDAY_COMP_TECHS = ['Robert Medley'];
const TIME_OFF_REASONS = new Set(['vacation', 'personal', 'pto', 'comp_day', 'manual', 'other', 'last_day']);
const PROJECT_REASONS = { site_survey: 'Site Survey', install: 'Install', info: 'Note' };

const CALLS_LIMIT = 6;            // more than this many stops in a day = overloaded
const TRAVEL_LIMIT_MIN = 300;     // 5 hours or more of estimated round-trip driving = overloaded
const STALE_DAYS = 4;             // a ticket overdue longer than this is assumed closed in reality
const DEFAULT_HEAVY_TRIGGER = 1.3;
const LIGHT_RATIO = 0.8;
const BASELINE_DAYS = 28;
const MEET_STALE_DAYS = 2;        // no Loomis movement for this long = worth a nudge
const PROJECT_STALE_DAYS = 2;     // a waiting project with no update this long = worth a nudge
const PROJECT_TYPE_LABEL = {
  ribbon_cutting: 'Ribbon cutting', install: 'Install', site_survey: 'Site survey',
  armored_truck_meet: 'Armored truck meet', other: 'Project',
};

// ---------------------------------------------------------------- helpers
function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify(obj),
  };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay(); // 0=Sun
}

function isBusinessDay(dateStr) {
  const dow = dayOfWeek(dateStr);
  if (dow === 0 || dow === 6) return false;
  return !(HOLIDAYS_2026 && HOLIDAYS_2026.has && HOLIDAYS_2026.has(dateStr));
}

function nextBusinessDay(dateStr) {
  let d = addDays(dateStr, 1);
  for (let i = 0; i < 10 && !isBusinessDay(d); i++) d = addDays(d, 1);
  return d;
}

function prevBusinessDay(dateStr) {
  let d = addDays(dateStr, -1);
  for (let i = 0; i < 10 && !isBusinessDay(d); i++) d = addDays(d, -1);
  return d;
}

function daysBetween(fromStr, toStr) {
  return Math.round((new Date(toStr + 'T12:00:00Z') - new Date(fromStr + 'T12:00:00Z')) / 86400000);
}

function nextSaturdayOnOrAfter(dateStr) {
  const dow = dayOfWeek(dateStr);
  return addDays(dateStr, (6 - dow + 7) % 7);
}

function localParts(isoOrDate, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(isoOrDate));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, hour: parseInt(o.hour, 10), minute: parseInt(o.minute, 10) };
}

function formatLocal(iso, timeZone) {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  } catch (e) { return null; }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Pages through a Supabase query so the 1000-row default cap never silently
// truncates a result. build(from, to) must return the query with .range applied.
async function fetchAll(build) {
  const out = [];
  const page = 1000;
  for (let from = 0; from < 30000; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}

async function safe(label, fn, fallback) {
  try { return await fn(); }
  catch (e) { console.error(`[get-daily-digest] ${label} failed (non-fatal):`, e.message); return fallback; }
}

function minutesToText(min) {
  if (min == null) return null;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function isArmoredTruckMeet(category) {
  return (category || '').trim().toLowerCase() === 'armored truck meet';
}

// ---------------------------------------------------------------- weather
async function fetchWeather(areaCodes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`https://api.weather.gov/alerts/active?area=${areaCodes.join(',')}`, {
      headers: { 'User-Agent': 'MCR Dispatch (mckelvey@mcrtechservice.com)', Accept: 'application/geo+json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status, alerts: [] };
    const data = await res.json();
    const rank = { Extreme: 0, Severe: 1 };
    const alerts = (data.features || [])
      .map((f) => f.properties || {})
      .filter((p) => (p.severity === 'Extreme' || p.severity === 'Severe')
        && !/marine|small craft|beach|surf|rip current|gale|coastal flood/i.test(p.event || ''))
      .sort((a, b) => (rank[a.severity] - rank[b.severity]) || String(a.onset || '').localeCompare(String(b.onset || '')))
      .slice(0, 8)
      .map((p) => ({
        event: p.event,
        severity: p.severity,
        headline: p.headline || null,
        areas: String(p.areaDesc || '').slice(0, 160),
        onset: p.onset || p.effective || null,
        ends: p.ends || p.expires || null,
      }));
    return { ok: true, alerts };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, alerts: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function readHeavyTrigger(event, state) {
  try {
    const blobs = require('@netlify/blobs');
    blobs.connectLambda(event);
    const store = blobs.getStore('dispatch');
    const settings = await store.get(`settings/${state}`, { type: 'json' });
    const v = parseFloat(settings && settings.heavyDayTriggerRatio);
    if (v > 0) return v;
  } catch (e) { /* default below */ }
  return DEFAULT_HEAVY_TRIGGER;
}

// ---------------------------------------------------------------- handler
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const params = event.queryStringParameters || {};
  const state = String(params.state || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    return json(400, { error: 'state query param (2-letter code) is required' });
  }
  const mode = (params.mode === 'evening') ? 'evening' : 'morning';

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase env vars not configured' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const regionStates = REGION_STATES[state] || [state];
    const timezone = STATE_TIMEZONES[state] || 'America/New_York';
    const now = new Date();

    const requestedDate = params.date;
    const todayStr = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate || '')
      ? requestedDate
      : new Date().toLocaleDateString('en-CA', { timeZone: timezone });
    const prevBiz = prevBusinessDay(todayStr);
    const nextBiz = nextBusinessDay(todayStr);
    const saturdayDate = nextSaturdayOnOrAfter(todayStr);
    const baselineFrom = addDays(todayStr, -BASELINE_DAYS);

    // ---- sites in this territory
    const { data: sites, error: sitesErr } = await supabase
      .from('sites').select('id, site_code, name, state, lat, lng')
      .in('state', regionStates).eq('active', true);
    if (sitesErr) return json(500, { error: 'sites fetch failed: ' + sitesErr.message });
    const siteById = {};
    (sites || []).forEach((s) => { siteById[s.id] = s; });
    const siteIds = Object.keys(siteById);

    // ---- technicians in this territory
    const regionList = `{${regionStates.join(',')}}`;
    const { data: techsRaw, error: techErr } = await supabase
      .from('technicians').select('id, name, lat, lng')
      .or(`home_state.in.(${regionStates.join(',')}),additional_states.ov.${regionList}`)
      .eq('active', true).order('name');
    if (techErr) return json(500, { error: 'technicians fetch failed: ' + techErr.message });
    // Placeholder records (e.g. "Unassigned (New Site)") are not people.
    const techs = (techsRaw || []).filter((t) => !/^unassigned\b/i.test(String(t.name || '').trim()));
    const techIds = (techs || []).map((t) => t.id);
    const techNameById = {};
    (techs || []).forEach((t) => { techNameById[t.id] = t.name; });

    // ---- availability rows (baseline window through next business day, one pass)
    let availRows = [];
    if (techIds.length) {
      for (const ids of chunk(techIds, 80)) {
        const rows = await fetchAll((from, to) => supabase
          .from('technician_availability')
          .select('technician_id, day, reason')
          .in('technician_id', ids).eq('available', false)
          .gte('day', baselineFrom).lte('day', nextBiz)
          .order('day').range(from, to));
        availRows.push(...rows);
      }
    }
    const timeOffByDay = {};          // day -> Map(techId -> reason)
    for (const r of availRows) {
      const reason = r.reason || 'other';
      if (!TIME_OFF_REASONS.has(reason)) continue;
      (timeOffByDay[r.day] = timeOffByDay[r.day] || new Map()).set(r.technician_id, reason);
    }
    // On-call rows for the comp-day rule (GA) and the Saturday availability rule.
    const onCallWindow = await safe('on-call window', async () => {
      const { data } = await supabase.from('on_call_schedule')
        .select('state, day, technician_id').in('state', regionStates)
        .gte('day', baselineFrom).lte('day', addDays(nextBiz, 6));
      return data || [];
    }, []);
    if (state === 'GA') {
      for (const row of onCallWindow) {
        const name = techNameById[row.technician_id];
        if (!name) continue;
        const compDay = addDays(row.day, THURSDAY_COMP_TECHS.includes(name) ? -2 : -5);
        const m = (timeOffByDay[compDay] = timeOffByDay[compDay] || new Map());
        if (!m.has(row.technician_id)) m.set(row.technician_id, 'comp_day');   // a real entry wins
      }
    }
    const outOn = (day) => timeOffByDay[day] || new Map();
    // On a Saturday with an on-call schedule only the on-call techs are working.
    const onCallTodayIds = dayOfWeek(todayStr) === 6
      ? [...new Set(onCallWindow.filter((r) => r.day === todayStr).map((r) => r.technician_id))] : [];
    const namesFor = (day, filterFn) => (techs || [])
      .filter((t) => filterFn ? filterFn(t) : outOn(day).has(t.id))
      .map((t) => ({ name: t.name, reason: outOn(day).get(t.id) || null }));

    const availability = {
      prevDate: prevBiz,
      nextDate: nextBiz,
      outToday: namesFor(todayStr),
      outNext: namesFor(nextBiz),
      returningToday: (techs || []).filter((t) => outOn(prevBiz).has(t.id) && !outOn(todayStr).has(t.id))
        .map((t) => ({ name: t.name, reason: outOn(prevBiz).get(t.id) })),
      returningNext: (techs || []).filter((t) => outOn(todayStr).has(t.id) && !outOn(nextBiz).has(t.id))
        .map((t) => ({ name: t.name, reason: outOn(todayStr).get(t.id) })),
    };
    const technicians = (techs || []).map((t) => ({
      id: t.id,
      name: t.name,
      available: !outOn(todayStr).has(t.id),
      reason: outOn(todayStr).get(t.id) || null,
    }));

    // Timed items entered on the team calendar (surveys, installs, notes).
    const calendarProjects = [];
    for (const r of availRows) {
      if ((r.day !== todayStr && r.day !== nextBiz) || !PROJECT_REASONS[r.reason]) continue;
      calendarProjects.push({
        day: r.day,
        when: r.day === todayStr ? 'today' : 'next',
        type: PROJECT_REASONS[r.reason],
        technicianName: techNameById[r.technician_id] || null,
      });
    }
    // Their free-text notes (where times are typed) are fetched separately so
    // the time-off rows above never carry notes.
    if (calendarProjects.length) {
      await safe('calendar project notes', async () => {
        const { data } = await supabase.from('technician_availability')
          .select('technician_id, day, reason, note').in('technician_id', techIds)
          .eq('available', false).in('day', [todayStr, nextBiz]).in('reason', Object.keys(PROJECT_REASONS));
        const noteKey = (d, t, r) => `${d}|${t}|${r}`;
        const notes = {};
        (data || []).forEach((r) => { notes[noteKey(r.day, r.technician_id, PROJECT_REASONS[r.reason])] = r.note || null; });
        for (const p of calendarProjects) {
          const tid = Object.keys(techNameById).find((id) => techNameById[id] === p.technicianName);
          p.note = notes[noteKey(p.day, tid, p.type)] || null;
        }
      }, null);
    }

    // ---- tickets: open ones for this territory
    const openRows = await fetchAll((from, to) => supabase
      .from('tickets')
      .select('id, wo_number, site_text, site_id, ticket_kind, needs_review, issue_category, issue_detail, address, due_at, sla_ends_at, earliest_start_at, received_at, status, attributes, manually_resolved_at, loomis_meet_status, loomis_meet_confirmed_at, loomis_meet_last_contact_at')
      .eq('status', 'open').order('received_at', { ascending: false }).range(from, to));

    const inRegion = (t) => t.site_text && regionStates.includes(t.site_text.slice(0, 2).toUpperCase());
    const candidates = openRows.filter(inRegion);

    // A closing site_visit linked to the ticket means it is confirmed closed,
    // whatever tickets.status says (same signal the state console uses).
    const closedTicketIds = new Set();
    for (const ids of chunk(candidates.map((t) => t.id), 100)) {
      const { data: visits, error: vErr } = await supabase.from('site_visits').select('ticket_id').in('ticket_id', ids);
      if (vErr) return json(500, { error: 'closing-visit fetch failed: ' + vErr.message });
      (visits || []).forEach((v) => { if (v.ticket_id) closedTicketIds.add(v.ticket_id); });
    }
    const liveTickets = candidates.filter((t) => !t.manually_resolved_at && !closedTicketIds.has(t.id));

    const staleMs = STALE_DAYS * 86400000;
    function classifyOrigin(receivedIso) {
      const lp = localParts(receivedIso, timezone);
      const key = `${lp.date}T${String(lp.hour).padStart(2, '0')}:${String(lp.minute).padStart(2, '0')}`;
      if (key >= `${todayStr}T08:00`) return 'today';
      if (key >= `${prevBiz}T17:00`) return 'overnight';
      return 'carried_over';
    }

    // ---- trouble tickets (armored truck meets are handled separately)
    const slaRank = { overdue: 0, due_today: 1, later: 2, unknown: 3, stale: 4 };
    const troubleTickets = liveTickets
      .filter((t) => t.ticket_kind === 'trouble' && !isArmoredTruckMeet(t.issue_category))
      .map((t) => {
        const tState = t.site_text.slice(0, 2).toUpperCase();
        let deadline = null;
        let tz = timezone;
        try { tz = resolveTimezone(t.address, tState) || timezone; } catch (e) { /* keep state tz */ }
        if (t.received_at) {
          try { deadline = computeSlaDeadline(t.received_at, t.address, tState); } catch (e) { deadline = null; }
        }
        let slaStatus = 'unknown';
        if (deadline) {
          const ms = new Date(deadline).getTime() - now.getTime();
          if (ms < -staleMs) slaStatus = 'stale';
          else if (ms < 0) slaStatus = 'overdue';
          else if (localParts(deadline, tz).date === todayStr) slaStatus = 'due_today';
          else slaStatus = 'later';
        }
        const routedState = (t.attributes || {}).routedState || null;
        return {
          ticketId: t.id,
          woNumber: t.wo_number,
          siteText: t.site_text,
          matched: !!t.site_id,
          issueCategory: t.issue_category,
          issueDetail: t.issue_detail,
          receivedAt: t.received_at,
          origin: t.received_at ? classifyOrigin(t.received_at) : null,
          computedSlaDeadline: deadline,
          dueText: deadline ? formatLocal(deadline, tz) : null,
          slaStatus,
          routedTo: (routedState && routedState !== state && !regionStates.includes(routedState)) ? routedState : null,
        };
      })
      .sort((a, b) => (slaRank[a.slaStatus] - slaRank[b.slaStatus])
        || String(a.computedSlaDeadline || '').localeCompare(String(b.computedSlaDeadline || '')));

    // ---- special projects
    const whenFor = (dateStr) => {
      if (!dateStr) return 'unscheduled';
      if (dateStr === todayStr) return 'today';
      if (dateStr === nextBiz) return 'next';
      return dateStr < todayStr ? 'past' : 'later';
    };

    // Dispatcher-maintained projects (open ones only). Non-fatal if the table
    // cannot be read: the rest of the digest still works.
    const projectRows = await safe('special projects', async () => {
      const { data, error } = await supabase.from('special_projects').select('*')
        .in('state', regionStates).not('status', 'in', '(done,cancelled)');
      if (error) throw new Error(error.message);
      return data || [];
    }, []);
    const liveById = {};
    liveTickets.forEach((t) => { liveById[t.id] = t; });
    const linkedTicketIds = new Set(projectRows.filter((p) => p.ticket_id).map((p) => p.ticket_id));

    const fmtDate = (d) => new Date(d + 'T12:00:00Z')
      .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const whenRank = { today: 0, next: 1, later: 2, unscheduled: 3, past: 4 };

    const projectItems = [];
    for (const p of projectRows) {
      // Linked ticket closed in the meantime: the project is finished with it.
      if (p.ticket_id && !liveById[p.ticket_id]) continue;
      const lt = p.ticket_id ? liveById[p.ticket_id] : null;
      const sd = p.scheduled_date || null;
      const when = whenFor(sd);
      const daysLate = sd && sd < todayStr ? daysBetween(sd, todayStr) : 0;
      const daysSinceUpdate = p.last_update_at
        ? Math.max(0, Math.floor((now.getTime() - new Date(p.last_update_at).getTime()) / 86400000)) : 0;
      const holdEnded = p.status === 'on_hold' && !!p.hold_until && p.hold_until <= todayStr;
      const quiet = p.status === 'on_hold' && !holdEnded;
      let nudgeReason = null;
      if (holdEnded) nudgeReason = 'hold ended, check status';
      else if (!quiet && p.status === 'waiting' && daysSinceUpdate >= PROJECT_STALE_DAYS) nudgeReason = `no update in ${daysSinceUpdate} days`;
      else if (!quiet && ['planned', 'confirmed', 'rescheduled'].includes(p.status) && daysLate > 0) nudgeReason = `date passed ${daysLate} day${daysLate === 1 ? '' : 's'} ago, still open`;
      projectItems.push({
        id: p.id,
        type: p.project_type,
        typeLabel: PROJECT_TYPE_LABEL[p.project_type] || 'Project',
        title: p.title,
        location: p.location || null,
        status: p.status,
        scheduledDate: sd,
        scheduledTime: p.scheduled_time || null,
        whenText: sd ? [fmtDate(sd), p.scheduled_time].filter(Boolean).join(' ') : 'No date yet',
        when,
        daysLate,
        holdUntil: p.hold_until || null,
        holdUntilText: p.hold_until ? fmtDate(p.hold_until) : null,
        note: p.note || null,
        ticketId: p.ticket_id || null,
        woNumber: lt ? lt.wo_number : null,
        daysSinceUpdate,
        quiet,
        needsNudge: !!nudgeReason,
        nudgeReason,
      });
    }
    const projectSort = (a, b) => (whenRank[a.when] - whenRank[b.when])
      || String(a.scheduledDate || '9').localeCompare(String(b.scheduledDate || '9'))
      || String(a.scheduledTime || '').localeCompare(String(b.scheduledTime || ''));
    const projects = projectItems.filter((p) => !p.quiet).sort(projectSort);
    const onHoldProjects = projectItems.filter((p) => p.quiet).sort(projectSort);

    // Neumo installs/surveys. Past-date ones are kept (never assumed closed:
    // stores remodel or delay for reasons outside our control) and flagged with
    // daysLate. Ones a dispatcher has linked to a project are shown there instead.
    const installs = liveTickets
      .filter((t) => (t.ticket_kind === 'install' || t.ticket_kind === 'site_survey') && !linkedTicketIds.has(t.id))
      .map((t) => {
        const startDate = t.earliest_start_at ? localParts(t.earliest_start_at, timezone).date : null;
        return {
          ticketId: t.id,
          woNumber: t.wo_number,
          siteText: t.site_text,
          ticketKind: t.ticket_kind,
          earliestStartAt: t.earliest_start_at,
          startText: t.earliest_start_at ? formatLocal(t.earliest_start_at, timezone) : null,
          startDate,
          startTimeText: t.earliest_start_at
            ? new Date(t.earliest_start_at).toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }) : null,
          when: whenFor(startDate),
          daysLate: startDate && startDate < todayStr ? daysBetween(startDate, todayStr) : 0,
        };
      })
      .sort((a, b) => String(a.earliestStartAt || '9').localeCompare(String(b.earliestStartAt || '9')));

    const armoredTruckMeets = liveTickets
      .filter((t) => t.ticket_kind === 'trouble' && isArmoredTruckMeet(t.issue_category))
      .map((t) => {
        // loomis_meet_confirmed_at holds the clock time written in the email
        // stored as if it were UTC, so it is read back with UTC fields (no
        // timezone conversion) to show the time that was actually agreed.
        let confirmedWallClock = null;
        let confirmedDate = null;
        if (t.loomis_meet_confirmed_at) {
          confirmedWallClock = new Date(t.loomis_meet_confirmed_at).toISOString().slice(0, 16).replace('T', ' ');
          confirmedDate = confirmedWallClock.slice(0, 10);
        }
        const lastContact = t.loomis_meet_last_contact_at || t.received_at;
        const daysSinceContact = lastContact ? Math.floor((now.getTime() - new Date(lastContact).getTime()) / 86400000) : null;
        const status = t.loomis_meet_status || 'awaiting_response';
        return {
          ticketId: t.id,
          woNumber: t.wo_number,
          siteText: t.site_text,
          meetStatus: status,
          confirmedWallClock,
          when: status === 'confirmed' ? whenFor(confirmedDate) : null,
          lastContactAt: t.loomis_meet_last_contact_at || null,
          daysSinceContact,
          needsNudge: status !== 'confirmed' && daysSinceContact != null && daysSinceContact >= MEET_STALE_DAYS,
        };
      });

    const needsReview = liveTickets.filter((t) => t.needs_review).map((t) => ({
      ticketId: t.id,
      woNumber: t.wo_number,
      siteText: t.site_text,
      issueCategory: t.issue_category,
      issueDetail: t.issue_detail,
      receivedAt: t.received_at,
    }));

    // ---- restock stops
    async function fetchAssignments(fromDate, toDate) {
      const all = [];
      for (const ids of chunk(siteIds, 100)) {
        const rows = await fetchAll((from, to) => supabase
          .from('assignments')
          .select('id, site_id, technician_id, status, dispatch_date, sequence_order, created_at')
          .in('site_id', ids).gte('dispatch_date', fromDate).lte('dispatch_date', toDate)
          .order('id').range(from, to));
        all.push(...rows);
      }
      return all;
    }

    const histAssignments = siteIds.length ? await fetchAssignments(baselineFrom, nextBiz) : [];
    const byDate = (d) => histAssignments.filter((a) => a.dispatch_date === d);
    const todaysAssignments = byDate(todayStr);
    const prevAssignments = byDate(prevBiz);

    // Technician names for assignments (a tech outside the roster can still own a stop).
    const missingTechIds = [...new Set(histAssignments.map((a) => a.technician_id).filter((id) => id && !techNameById[id]))];
    if (missingTechIds.length) {
      await safe('assignment technician names', async () => {
        const { data } = await supabase.from('technicians').select('id, name').in('id', missingTechIds);
        (data || []).forEach((t) => { techNameById[t.id] = t.name; });
      }, null);
    }

    const prevUnfinishedSites = new Set(prevAssignments
      .filter((a) => a.status !== 'completed' && a.status !== 'removed').map((a) => a.site_id));
    const pushedSites = new Set(todaysAssignments
      .filter((a) => a.status !== 'removed' && prevUnfinishedSites.has(a.site_id)).map((a) => a.site_id));

    function describeAssignment(a) {
      const site = siteById[a.site_id];
      return {
        siteCode: site ? site.site_code : null,
        siteName: site ? site.name : '(unknown site)',
        technicianName: a.technician_id ? (techNameById[a.technician_id] || null) : null,
        pushedFromPrevious: pushedSites.has(a.site_id) && a.status !== 'removed',
      };
    }
    const restocks = {
      completed: todaysAssignments.filter((a) => a.status === 'completed').map(describeAssignment),
      stillOpen: todaysAssignments.filter((a) => a.status === 'planned' || a.status === 'notified').map(describeAssignment),
      removed: todaysAssignments.filter((a) => a.status === 'removed').map(describeAssignment),
    };
    restocks.pushedFromPrevious = [...restocks.completed, ...restocks.stillOpen].filter((r) => r.pushedFromPrevious);

    // ---- per-technician load (stop count + estimated drive time)
    async function computeTechLoad(dayAssignments) {
      const live = dayAssignments.filter((a) => a.status !== 'removed' && a.technician_id);
      if (!live.length) return [];
      const tIds = [...new Set(live.map((a) => a.technician_id))];
      const sIds = [...new Set(live.map((a) => a.site_id))];

      const techLegs = {};   // `${techId}|${siteId}` -> minutes
      for (const rows of await Promise.all(chunk(sIds, 100).map(async (ids) => {
        const { data } = await supabase.from('tech_site_distances')
          .select('technician_id, site_id, mode, duration_min')
          .in('technician_id', tIds).in('site_id', ids);
        return data || [];
      }))) {
        for (const r of rows) {
          if (r.duration_min == null) continue;
          const key = `${r.technician_id}|${r.site_id}`;
          if (r.mode === 'driving' || techLegs[key] == null) techLegs[key] = Number(r.duration_min);
        }
      }
      const siteLegs = {};   // `${a}|${b}` -> minutes
      for (const ids of chunk(sIds, 80)) {
        const { data } = await supabase.from('site_site_distances')
          .select('site_a, site_b, duration_min').eq('mode', 'driving')
          .in('site_a', ids).in('site_b', ids);
        for (const r of (data || [])) if (r.duration_min != null) siteLegs[`${r.site_a}|${r.site_b}`] = Number(r.duration_min);
      }

      const out = [];
      for (const techId of tIds) {
        const stops = live.filter((a) => a.technician_id === techId)
          .sort((a, b) => ((a.sequence_order ?? 9999) - (b.sequence_order ?? 9999)) || String(a.created_at).localeCompare(String(b.created_at)));
        let minutes = 0;
        let missing = 0;
        const add = (v) => { if (v == null) missing++; else minutes += v; };
        add(techLegs[`${techId}|${stops[0].site_id}`]);
        for (let i = 1; i < stops.length; i++) {
          const a = stops[i - 1].site_id, b = stops[i].site_id;
          add(a === b ? 0 : (siteLegs[`${a}|${b}`] ?? siteLegs[`${b}|${a}`]));
        }
        add(techLegs[`${techId}|${stops[stops.length - 1].site_id}`]);

        const reasons = [];
        if (stops.length > CALLS_LIMIT) reasons.push(`${stops.length} stops`);
        if (minutes >= TRAVEL_LIMIT_MIN) reasons.push(`about ${minutesToText(minutes)} of driving`);
        out.push({
          technicianName: techNameById[techId] || null,
          stops: stops.length,
          driveMinutes: Math.round(minutes),
          driveText: minutesToText(minutes),
          incompleteEstimate: missing > 0,
          overloaded: reasons.length > 0,
          reasons,
        });
      }
      return out.sort((a, b) => (Number(b.overloaded) - Number(a.overloaded)) || (b.stops - a.stops));
    }

    const techLoad = await safe('tech load', () => computeTechLoad(todaysAssignments), []);
    const nextAssignments = byDate(nextBiz);
    const techLoadNext = (mode === 'evening')
      ? await safe('tech load (next day)', () => computeTechLoad(nextAssignments), [])
      : [];

    // ---- light / regular / heavy
    const callsToday = todaysAssignments.filter((a) => a.status !== 'removed').length;
    const availToday = onCallTodayIds.length
      ? onCallTodayIds.length
      : Math.max(1, (techs || []).length - outOn(todayStr).size);
    const heavyTrigger = await readHeavyTrigger(event, state);
    let dayWeight = { label: 'unknown', note: 'Not enough history to compare yet.' };
    {
      const callsByDay = {};
      histAssignments.filter((a) => a.dispatch_date < todayStr && a.status !== 'removed')
        .forEach((a) => { callsByDay[a.dispatch_date] = (callsByDay[a.dispatch_date] || 0) + 1; });
      let sumCalls = 0, sumAvail = 0, basisDays = 0;
      for (const [day, calls] of Object.entries(callsByDay)) {
        if (!isBusinessDay(day) || calls < 1) continue;
        sumCalls += calls;
        sumAvail += Math.max(1, (techs || []).length - outOn(day).size);
        basisDays++;
      }
      if (callsToday === 0) {
        dayWeight = { label: 'none_yet', note: 'No stops on the board for today yet.', callsToday, availableTechs: availToday };
      } else if (basisDays >= 5 && sumAvail > 0) {
        const baselinePerTech = sumCalls / sumAvail;
        const ratio = (callsToday / availToday) / baselinePerTech;
        const label = ratio >= heavyTrigger ? 'heavy' : (ratio < LIGHT_RATIO ? 'light' : 'regular');
        dayWeight = {
          label,
          ratio: Math.round(ratio * 100) / 100,
          callsToday,
          availableTechs: availToday,
          callsPerTech: Math.round((callsToday / availToday) * 10) / 10,
          baselineCallsPerTech: Math.round(baselinePerTech * 10) / 10,
          heavyTrigger,
          lightBelow: LIGHT_RATIO,
          basisDays,
        };
      }
    }

    // ---- Workload by area (PREVIEW, 2026-10-06): the same stops measured per area against
    // the technicians who can actually reach it (see lib/area-workload.js). Shown beside
    // the territory-wide label above; it does not change that label or the attention list.
    const areaWeight = await safe('area workload', async () => computeAreaWeight({
      techs, sites: sites || [], assignments: histAssignments, todayStr,
      isBusinessDay, isOut: (day, id) => outOn(day).has(id), onCallTodayIds,
      heavyTrigger, lightBelow: LIGHT_RATIO,
    }), null);

    // ---- Saturday on-call (this or the coming Saturday)
    const saturday = await safe('saturday on-call', async () => {
      const { data: onCallRows } = await supabase.from('on_call_schedule')
        .select('state, technician_id').in('state', regionStates).eq('day', saturdayDate);
      const ids = [...new Set((onCallRows || []).map((r) => r.technician_id))];
      const missing = ids.filter((id) => !techNameById[id]);
      if (missing.length) {
        const { data } = await supabase.from('technicians').select('id, name').in('id', missing);
        (data || []).forEach((t) => { techNameById[t.id] = t.name; });
      }
      if (!ids.length) return null;
      const { data: disp } = await supabase.from('saturday_dispatcher_schedule')
        .select('dispatchers(username)').eq('day', saturdayDate).limit(1);
      const dispatcher = disp && disp[0] && disp[0].dispatchers ? disp[0].dispatchers.username : null;
      return {
        date: saturdayDate,
        isToday: saturdayDate === todayStr,
        technicians: (onCallRows || []).map((r) => ({ name: techNameById[r.technician_id] || null, state: r.state })),
        dispatcher,
      };
    }, null);

    // ---- open RMA shipments
    let openShipments = [];
    if (siteIds.length) {
      for (const ids of chunk(siteIds, 100)) {
        const { data: shipments, error: shipErr } = await supabase
          .from('rma_shipments').select('site_id, return_broken_part, warehouse_name')
          .in('site_id', ids).is('returned_at', null);
        if (shipErr) return json(500, { error: 'rma_shipments fetch failed: ' + shipErr.message });
        (shipments || []).forEach((s) => {
          const site = siteById[s.site_id];
          openShipments.push({
            siteCode: site ? site.site_code : null,
            siteName: site ? site.name : '(unknown site)',
            needsReturn: !!s.return_broken_part,
            warehouseName: s.warehouse_name || null,
          });
        });
      }
    }

    // ---- weather
    const weather = await safe('weather', () => fetchWeather(regionStates), { ok: false, error: 'unavailable', alerts: [] });

    // ---- evening preview of the next business day
    let preview = null;
    if (mode === 'evening') {
      preview = {
        date: nextBiz,
        restocksQueued: nextAssignments.filter((a) => a.status === 'planned' || a.status === 'notified').map((a) => {
          const site = siteById[a.site_id];
          return { siteCode: site ? site.site_code : null, siteName: site ? site.name : '(unknown site)' };
        }),
        installs: installs.filter((i) => i.when === 'next'),
        projects: projects.filter((p) => p.when === 'next'),
      };
    }

    // ---- ranked attention list (what a brief should lead with)
    const attention = [];
    const add = (level, text) => attention.push({ level, text });
    weather.alerts.slice(0, 2).forEach((a) => add('high', `Weather: ${a.event} (${a.areas})`));
    if (dayWeight.label === 'heavy') add('high', `Heavy day: ${dayWeight.callsToday} stops for ${dayWeight.availableTechs} available techs (${dayWeight.ratio}x a normal day)`);
    const overdue = troubleTickets.filter((t) => t.slaStatus === 'overdue');
    const dueToday = troubleTickets.filter((t) => t.slaStatus === 'due_today');
    if (overdue.length) add('high', `${overdue.length} trouble ticket${overdue.length === 1 ? '' : 's'} past SLA`);
    if (dueToday.length) add('high', `${dueToday.length} trouble ticket${dueToday.length === 1 ? '' : 's'} due today, first at ${dueToday[0].dueText}`);
    armoredTruckMeets.filter((m) => m.needsNudge || m.meetStatus === 'needs_reschedule')
      .forEach((m) => add('high', `Armored truck meet ${m.siteText}: ${m.meetStatus === 'needs_reschedule' ? 'carrier cannot make it, needs a new time' : `no carrier reply for ${m.daysSinceContact} days`}`));
    armoredTruckMeets.filter((m) => m.when === 'today').forEach((m) => add('info', `Armored truck meet today ${m.confirmedWallClock.slice(11)} at ${m.siteText}`));
    projects.filter((p) => p.needsNudge).forEach((p) => add('high', `${p.typeLabel} ${p.title}: ${p.nudgeReason}`));
    projects.filter((p) => !p.needsNudge && p.when === 'today' && ['planned', 'confirmed', 'rescheduled'].includes(p.status))
      .forEach((p) => add('info', `${p.typeLabel} today${p.scheduledTime ? ' at ' + p.scheduledTime : ''}: ${p.title}`));
    techLoad.filter((t) => t.overloaded).forEach((t) => add('high', `${t.technicianName}: ${t.reasons.join(', ')} today`));
    if (availability.outToday.length) add('info', `Out today: ${availability.outToday.map((t) => t.name).join(', ')}`);
    const nextLabel = new Date(nextBiz + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    if (availability.outNext.length) add('info', `Out ${nextLabel}: ${availability.outNext.map((t) => t.name).join(', ')}`);
    if (needsReview.length) add('info', `${needsReview.length} ticket${needsReview.length === 1 ? '' : 's'} flagged for review`);
    if (dayWeight.label === 'light') add('info', 'Light day compared with normal');

    return json(200, {
      ok: true,
      version: 3,
      state,
      region: regionStates,
      mode,
      date: todayStr,
      timezone,
      generatedAt: now.toISOString(),
      attention,
      dayWeight,
      weather,
      availability,
      technicians,
      troubleTickets,
      specialProjects: { installs, armoredTruckMeets, calendarProjects, projects, onHold: onHoldProjects },
      needsReview,
      restocks,
      techLoad,
      techLoadNext,
      areaWeight,
      saturday,
      openShipments,
      preview,
    });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
