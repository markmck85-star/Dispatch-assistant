// get-restock-schedule.js
//
// Ports restock tracker's cycle-detection algorithm (computeDashboard in
// its index.html) to run against the same site_visits data that's already
// live in Supabase, instead of requiring a separately re-uploaded Salesforce
// xlsx. Mark: several features now rely on that same report (closed-ticket
// import, this) -- would rather have them all reading one shared, current
// source than re-downloading it per tool. Algorithm ported as closely to
// the original as possible since it's already proven out in daily use:
//
// v2 (2026-07-27): added optional ?since=YYYY-MM-DD / ?until=YYYY-MM-DD to
// bound the history window used for cycle/average calculations -- both
// technician closing behavior and Neumo's actual restock trigger threshold
// have drifted over time, so including old data skews the average. Also
// added CORS headers since this is now called cross-origin from the
// separate restock-tracker site, not just same-origin from the dispatch app.
//
//   - avg restock cycle = mean interval between a site's restocks, with
//     outlier gaps (>2x the median interval) filtered out first so one
//     missed report row or outage doesn't wreck the estimate
//   - "anomalous" instead of a confident status when there's too little
//     history and the gaps are wildly inconsistent (max/min ratio > 10,
//     under 5 data points) -- refuses to guess rather than false-flag
//   - two-tier overdue: if a non-restock visit (e.g. a trouble ticket)
//     happened AFTER the last real restock, status is suffixed "(visited)"
//     -- the tech may have informally topped off consumables while there
//     for something else, so confidence in "still overdue" is lower
//   - overdue if (avg - daysSinceLastRestock) < -7, due soon if <= 7,
//     otherwise on track -- same thresholds as the original tool
//
// Grouped by real site_id (sites table) rather than raw account-name text,
// since that's already resolved upstream by the closed-ticket import --
// no need for restock tracker's original ticketsOnly/string-matching path.

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

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Math.round(days));
  return d;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});

  const params = event.queryStringParameters || {};
  const state = params.state; // optional -- omit for all states

  // Optional history-window bounds. Validated as plain YYYY-MM-DD so a
  // malformed value fails fast with a clear error rather than silently
  // producing a Supabase filter that matches nothing.
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const since = params.since && dateRe.test(params.since) ? params.since : null;
  const until = params.until && dateRe.test(params.until) ? params.until : null;
  if (params.since && !since) return json(400, { ok: false, error: 'since must be YYYY-MM-DD' });
  if (params.until && !until) return json(400, { ok: false, error: 'until must be YYYY-MM-DD' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let sitesQuery = supabase.from('sites').select('id, site_code, name, state').eq('active', true);
  if (state) sitesQuery = sitesQuery.eq('state', state);
  const { data: sites, error: sitesErr } = await sitesQuery;
  if (sitesErr) return json(500, { ok: false, error: 'sites fetch failed: ' + sitesErr.message });
  const siteById = {};
  for (const s of sites) siteById[s.id] = s;
  const siteIds = sites.map(s => s.id);
  if (!siteIds.length) return json(200, { ok: true, locations: [] });

  // Paginate -- a full state's visit history can run into the thousands of rows.
  let allVisits = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let visitsQuery = supabase
      .from('site_visits')
      .select('site_id, started_at, is_restock, tech_name_raw, appointment_number, imported_at')
      .in('site_id', siteIds)
      .not('started_at', 'is', null)
      .order('started_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (since) visitsQuery = visitsQuery.gte('started_at', since + 'T00:00:00');
    if (until) visitsQuery = visitsQuery.lte('started_at', until + 'T23:59:59');
    const { data: page, error: visitsErr } = await visitsQuery;
    if (visitsErr) return json(500, { ok: false, error: 'site_visits fetch failed: ' + visitsErr.message });
    allVisits = allVisits.concat(page);
    if (page.length < pageSize) break;
    from += pageSize;
  }

  // True data-freshness signal: when the underlying Salesforce report was
  // last imported into Supabase (via the closed-ticket import), not "now" --
  // this is a shared, periodically-refreshed dataset, not a live feed.
  let lastImportedAt = null;
  for (const v of allVisits) {
    if (v.imported_at && (!lastImportedAt || v.imported_at > lastImportedAt)) lastImportedAt = v.imported_at;
  }

  // Group per site
  const bySite = {};
  for (const v of allVisits) {
    if (!bySite[v.site_id]) bySite[v.site_id] = { restocks: [], allVisits: [] };
    const d = new Date(v.started_at);
    bySite[v.site_id].allVisits.push({ date: d, tech: v.tech_name_raw, appt: v.appointment_number });
    if (v.is_restock) bySite[v.site_id].restocks.push({ date: d, tech: v.tech_name_raw, appt: v.appointment_number });
  }

  const TODAY = new Date();
  TODAY.setHours(0, 0, 0, 0);
  const todayStr = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-${String(TODAY.getDate()).padStart(2, '0')}`;

  // Already-scheduled check: is this site already sitting on someone's board
  // for today or a future date? Mark uses this to decide whether a stop
  // needs catching early or can be left alone since it's already planned --
  // separate question from the projected/predicted date (next1), which is
  // just a cycle-based estimate with no awareness of what's actually been
  // dispatched.
  const { data: upcoming, error: upcomingErr } = await supabase
    .from('assignments')
    .select('site_id, dispatch_date, technician_id, technicians(name)')
    .in('site_id', siteIds)
    .eq('status', 'planned')
    .gte('dispatch_date', todayStr)
    .order('dispatch_date', { ascending: true });
  if (upcomingErr) return json(500, { ok: false, error: 'assignments fetch failed: ' + upcomingErr.message });
  const scheduledBySite = {};
  for (const row of (upcoming || [])) {
    if (!scheduledBySite[row.site_id]) {
      scheduledBySite[row.site_id] = { date: row.dispatch_date, tech: row.technicians ? row.technicians.name : null };
    }
  }

  const locations = [];
  for (const [siteId, data] of Object.entries(bySite)) {
    const site = siteById[siteId];
    if (!site) continue;

    const restockDates = data.restocks.map(r => r.date).sort((a, b) => a - b);
    const count = restockDates.length;
    const last = restockDates[count - 1] || null;
    const daysSince = last ? Math.round((TODAY - last) / 86400000) : null;

    let avg = null;
    let anomalous = false;
    if (count >= 2) {
      const intervals = [];
      for (let i = 1; i < restockDates.length; i++) {
        intervals.push(Math.round((restockDates[i] - restockDates[i - 1]) / 86400000));
      }
      const sorted = [...intervals].sort((a, b) => a - b);
      const median = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];
      const filtered = intervals.filter(v => v <= median * 2);
      const useIntervals = filtered.length >= 1 ? filtered : intervals;
      avg = useIntervals.reduce((a, b) => a + b, 0) / useIntervals.length;

      const maxI = Math.max(...intervals);
      const minI = Math.min(...intervals);
      if (count <= 5 && minI > 0 && maxI / minI > 10) anomalous = true;
    }

    let status = 'ok';
    if (count === 0) status = 'nodata';
    else if (count === 1) status = 'single';
    else if (anomalous) status = 'anomalous';
    else {
      const daysUntil = avg - daysSince;
      if (daysUntil < -7) status = 'overdue';
      else if (daysUntil <= 7) status = 'soon';
      else status = 'ok';
    }

    const lastVisitEntry = data.allVisits.reduce((best, v) => (!best || v.date > best.date) ? v : best, null);
    const lastVisit = lastVisitEntry ? lastVisitEntry.date : null;
    const visitedSinceRestock = !!(lastVisit && last && lastVisit > last);

    const lastRestockEntry = data.restocks.reduce((best, r) => (!best || r.date > best.date) ? r : best, null);

    const scheduled = scheduledBySite[siteId] || null;

    locations.push({
      site_id: siteId,
      site_code: site.site_code,
      name: site.name,
      state: site.state,
      count,
      avg,
      last: last ? last.toISOString() : null,
      daysSince,
      anomalous,
      status,
      next1: avg && last ? addDays(last, avg).toISOString() : null,
      next2: avg && last ? addDays(last, avg * 2).toISOString() : null,
      next3: avg && last ? addDays(last, avg * 3).toISOString() : null,
      lastVisit: lastVisit ? lastVisit.toISOString() : null,
      visitedSinceRestock,
      lastVisitTech: lastVisitEntry ? lastVisitEntry.tech : null,
      lastVisitAppt: lastVisitEntry ? lastVisitEntry.appt : null,
      lastRestockTech: lastRestockEntry ? lastRestockEntry.tech : null,
      lastRestockAppt: lastRestockEntry ? lastRestockEntry.appt : null,
      scheduledDate: scheduled ? scheduled.date : null,
      scheduledTech: scheduled ? scheduled.tech : null,
    });
  }

  const statusOrder = { overdue: 0, soon: 1, anomalous: 2, ok: 3, single: 4, nodata: 5 };
  locations.sort((a, b) => {
    if (statusOrder[a.status] !== statusOrder[b.status]) return statusOrder[a.status] - statusOrder[b.status];
    const an1 = a.next1 ? new Date(a.next1).getTime() : Infinity;
    const bn1 = b.next1 ? new Date(b.next1).getTime() : Infinity;
    return an1 - bn1;
  });

  return json(200, {
    ok: true,
    locations,
    totalSites: locations.length,
    generatedAt: new Date().toISOString(),
    lastImportedAt,
    range: { since, until },
  });
};
