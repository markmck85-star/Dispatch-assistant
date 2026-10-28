// Morning summary push for the staff portal.
//
// Once per business day, at 8:00 AM in each dispatcher's OWN time zone, a phone
// with alerts turned on gets one notification listing the open Watchdog tickets
// for the states it subscribed to (overnight arrivals and anything carried over
// from the last business day). Nothing is sent when there is nothing open.
//
// A dispatcher's time zone is worked out when this runs (nothing is stored on
// the dispatcher row): home address zip of the linked technician record, then
// that record's home state, then the first state on the login.
//
// Saturday: the summary goes out only to the dispatcher scheduled as the
// Saturday on-call dispatcher that day (saturday_dispatcher_schedule), covers
// every Saturday-coverage state, and lists that day's on-call technicians
// (on_call_schedule). That dispatcher needs alerts turned on for any area; the
// Saturday summary then ignores which areas they ticked. Sundays and company
// holidays: never.
//
// Every export swallows its own errors. Nothing here may break anything else.

const SUMMARY_START_MIN = 8 * 60;        // 8:00 AM local
const SUMMARY_END_MIN = 8 * 60 + 44;     // tolerate a late scheduler run
const GA_BUNDLED = ['NC', 'SC', 'AL'];

function localParts(now, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return {
    iso: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
  };
}

// Time zone and dispatcher username for one portal account. The time zone falls
// back to Eastern if nothing resolves.
async function accountProfile(supabase, accountKey) {
  const { resolveTimezone } = require('../slaCalculator.js');
  const fallback = { tz: 'America/New_York', dispatcher: '' };
  try {
    const { data: acc } = await supabase
      .from('staff_accounts').select('dispatcher_username').eq('username', accountKey).maybeSingle();
    if (!acc || !acc.dispatcher_username) return fallback;
    const { data: d } = await supabase
      .from('dispatchers').select('technician_id, states').eq('username', acc.dispatcher_username).maybeSingle();
    if (!d) return { tz: fallback.tz, dispatcher: acc.dispatcher_username };
    let address = '';
    let state = (d.states && d.states[0]) || '';
    if (d.technician_id) {
      const { data: t } = await supabase
        .from('technicians').select('home_address, home_state').eq('id', d.technician_id).maybeSingle();
      if (t) {
        address = t.home_address || '';
        if (t.home_state) state = t.home_state;
      }
    }
    return { tz: resolveTimezone(address, String(state || '').toUpperCase()), dispatcher: acc.dispatcher_username };
  } catch (e) {
    return fallback;
  }
}

async function accountTimeZone(supabase, accountKey) {
  return (await accountProfile(supabase, accountKey)).tz;
}

// States with Saturday coverage (the same group the Watchdog tab calls
// Saturday On-Call).
const SAT_FALLBACK_STATES = ['GA', 'IN', 'MI', 'NV'];

// Saturday context for one calendar day: the on-call dispatcher's username and
// the on-call technicians per state. Never throws; empty values when unknown.
async function saturdayContext(supabase, iso) {
  const out = { dispatcher: '', techs: [], states: SAT_FALLBACK_STATES };
  try {
    const [dsp, tch] = await Promise.all([
      supabase.from('saturday_dispatcher_schedule')
        .select('dispatchers!inner(username)').eq('day', iso).limit(1).maybeSingle(),
      supabase.from('on_call_schedule')
        .select('state, technicians!inner(name)').eq('day', iso).order('state', { ascending: true }),
    ]);
    if (dsp && dsp.data && dsp.data.dispatchers) out.dispatcher = String(dsp.data.dispatchers.username || '');
    out.techs = ((tch && tch.data) || []).map((r) => ({
      state: r.state, name: r.technicians ? r.technicians.name : '',
    })).filter((r) => r.name);
  } catch (e) { /* leave empty */ }
  return out;
}

function cap(v) { v = String(v || ''); return v ? v.charAt(0).toUpperCase() + v.slice(1) : v; }

function onCallLines(ctx) {
  const lines = [];
  if (ctx.dispatcher) lines.push('On-call dispatcher: ' + cap(ctx.dispatcher) + '.');
  if (ctx.techs.length) {
    const by = {};
    ctx.techs.forEach((t) => { (by[t.state] = by[t.state] || []).push(t.name); });
    lines.push('On-call technicians: ' + Object.keys(by).sort().map((st) => st + ' ' + by[st].join(' / ')).join('; ') + '.');
  }
  return lines;
}

// Open Watchdog tickets for a list of states, de-duplicated. Uses the watchdog
// log's own handler so selection and staleness rules stay defined in one place.
async function openTickets(states) {
  const watchdog = require('../get-watchdog-log.js');
  const regions = [];
  (states || []).forEach((s) => {
    const u = String(s || '').toUpperCase();
    const r = GA_BUNDLED.indexOf(u) !== -1 ? 'GA' : u;
    if (/^[A-Z]{2}$/.test(r) && regions.indexOf(r) === -1) regions.push(r);
  });
  const lists = await Promise.all(regions.map(async (state) => {
    try {
      const resp = await watchdog.handler({ httpMethod: 'GET', queryStringParameters: { state } });
      const data = JSON.parse(resp.body || '{}');
      return resp.statusCode === 200 ? (data.entries || []) : [];
    } catch (e) { return []; }
  }));
  const seen = new Set();
  const out = [];
  lists.forEach((list, i) => list.forEach((e) => {
    const k = e.ticketId || (e.woNumber + '|' + e.siteText);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({
      region: regions[i],
      siteCode: e.siteCode || '',
      siteName: e.siteName || e.siteText || '',
      slaEndsAt: e.slaEndsAt || e.dueAt || null,
      woNumber: e.woNumber || '',
    });
  }));
  return out;
}

// Builds { title, body } or null when nothing is open.
function summaryMessage(tickets, tz) {
  if (!tickets.length) return null;
  const counts = {};
  tickets.forEach((t) => { counts[t.region] = (counts[t.region] || 0) + 1; });
  const byState = Object.keys(counts).sort().map((k) => k + ' ' + counts[k]).join(', ');
  const withSla = tickets.filter((t) => t.slaEndsAt && !isNaN(new Date(t.slaEndsAt)))
    .sort((a, b) => new Date(a.slaEndsAt) - new Date(b.slaEndsAt));
  let body = byState + '.';
  if (withSla.length) {
    const n = withSla[0];
    const when = new Date(n.slaEndsAt).toLocaleString('en-US', {
      timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
    body += ' Soonest deadline: ' + (n.siteCode ? n.siteCode + ' ' : '') + when + '.';
  }
  return {
    title: 'Morning summary: ' + tickets.length + ' open ticket' + (tickets.length === 1 ? '' : 's'),
    body,
  };
}

// Is this subscription due its summary right now (local 8:00 to 8:44, a business
// day, and not already sent for that local date)?
function isDue(row, now, tz) {
  const lp = localParts(now, tz);
  if (lp.minutes < SUMMARY_START_MIN || lp.minutes > SUMMARY_END_MIN) return null;
  if (lp.weekday === 'Sun') return null;
  const { HOLIDAYS_2026 } = require('../slaCalculator.js');
  if (HOLIDAYS_2026.has(lp.iso)) return null;
  if (row.last_summary_on && String(row.last_summary_on) >= lp.iso) return null;
  return lp.iso;
}

// Scheduled entry point. Returns counts; never throws.
async function runDue(supabase, now) {
  const out = { checked: 0, sent: 0, empty: 0, failed: 0 };
  try {
    const push = require('./push.js');
    if (!push.pushConfigured() || !supabase) return out;
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth, states, selections, fail_count, account_key, last_summary_on')
      .limit(1000);
    if (error) { console.log('[summary] load failed:', error.message); return out; }
    let rows = data || [];
    const active = await push.activeStaffKeys(supabase);
    if (active) rows = rows.filter((r) => active.has(r.account_key));
    const profCache = {};
    const satCache = {};
    const webpush = rows.length ? push.getWebPush() : null;
    for (const row of rows) {
      out.checked++;
      if (!profCache[row.account_key]) profCache[row.account_key] = await accountProfile(supabase, row.account_key);
      const prof = profCache[row.account_key];
      const tz = prof.tz;
      const day = isDue(row, now, tz);
      if (!day) continue;
      const isSat = localParts(now, tz).weekday === 'Sat';
      let sat = null;
      if (isSat) {
        if (!satCache[day]) satCache[day] = await saturdayContext(supabase, day);
        sat = satCache[day];
        // Saturdays: only the scheduled on-call dispatcher gets one.
        if (!sat.dispatcher || sat.dispatcher.toLowerCase() !== String(prof.dispatcher || '').toLowerCase()) continue;
      }
      // Claim today's summary first so an overlapping run cannot send it twice.
      const { data: claimed } = await supabase
        .from('push_subscriptions').update({ last_summary_on: day })
        .eq('id', row.id).or(`last_summary_on.is.null,last_summary_on.lt.${day}`).select('id');
      if (!claimed || !claimed.length) continue;
      let msg = summaryMessage(await openTickets(isSat ? sat.states : row.states), tz);
      if (isSat) {
        const extra = onCallLines(sat).join('\n');
        if (msg) msg.body += (extra ? '\n' + extra : '');
        else if (extra) msg = { title: 'Saturday on-call: nothing open', body: extra };
      }
      if (!msg) { out.empty++; continue; }
      const ok = await push.sendOne(webpush, supabase, row, JSON.stringify({
        title: msg.title, body: msg.body, tag: 'morning-summary', url: '/tech-portal.html',
      }));
      if (ok) out.sent++; else out.failed++;
    }
    console.log('[summary]', JSON.stringify(out));
  } catch (e) {
    console.log('[summary] runDue error (non-fatal):', e.message);
  }
  return out;
}

// "Send a sample" button: builds and sends the summary to one of the caller's own
// phones right now, ignoring the clock and the once-a-day record.
async function sendSample(supabase, accountKey, endpoint) {
  try {
    const push = require('./push.js');
    if (!push.pushConfigured()) return { ok: false, error: 'Push is not set up on the server yet.' };
    const { data: row } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth, states, selections, fail_count, account_key')
      .eq('endpoint', endpoint).eq('account_key', accountKey).maybeSingle();
    if (!row) return { ok: false, error: 'This phone is not subscribed yet.' };
    const tz = await accountTimeZone(supabase, accountKey);
    const tickets = await openTickets(row.states);
    const msg = summaryMessage(tickets, tz) ||
      { title: 'Morning summary: nothing open', body: 'No open tickets for your areas right now.' };
    // Also show the next Saturday's on-call people, so the Saturday format can
    // be checked without waiting for a Saturday.
    const nowD = new Date();
    const lp = localParts(nowD, tz);
    const daysToSat = (6 - ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(lp.weekday) + 7) % 7;
    const satIso = new Date(Date.UTC(Number(lp.iso.slice(0, 4)), Number(lp.iso.slice(5, 7)) - 1, Number(lp.iso.slice(8, 10)) + daysToSat))
      .toISOString().slice(0, 10);
    const sat = await saturdayContext(supabase, satIso);
    const extra = onCallLines(sat);
    if (extra.length) msg.body += '\nSaturday ' + satIso.slice(5) + ' on call. ' + extra.join(' ');
    const ok = await push.sendOne(push.getWebPush(), supabase, row, JSON.stringify({
      title: 'Sample: ' + msg.title, body: msg.body, tag: 'morning-summary-sample', url: '/tech-portal.html',
    }));
    return ok ? { ok: true } : { ok: false, error: 'The sample could not be delivered.' };
  } catch (e) {
    return { ok: false, error: 'Could not send the sample.' };
  }
}

module.exports = { runDue, sendSample, accountTimeZone, accountProfile, saturdayContext, onCallLines, isDue, summaryMessage, localParts };
