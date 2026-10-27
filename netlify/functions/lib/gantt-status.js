// lib/gantt-status.js
//
// Technician appointment-status pass (2026-10-27). Called from salesforce-report-sync-background.mjs
// inside the SAME Salesforce login, after the report import and before the closing-notes pass.
// Off unless settings.salesforceStatusSyncEnabled === true (State Console toggle).
//
// How it works: the dispatch console home page contains the Field Service Gantt. When it loads, it
// asks Salesforce for appointments through "apexremote" calls (FSL.ctrl001_Gantt GetTimePhasedObjects
// / loadServicesInBulk). Each appointment carries ResourceName (the technician), Status,
// StatusCategory, ActualStartTime / ActualEndTime, lat/lng and the account name. This module opens
// that page in a second tab of the already signed-in session, listens for those responses and
// stores the appointments in sa_live_status. No clicking, no hovering, read-only.
//
// Never throws past its own boundary; returns a summary. The caller also wraps it in try/catch so a
// failure here can never affect the report import or closing notes. Records every run in
// sa_status_sync_runs (including the list of distinct Status values seen).

const HOME_URL = process.env.SALESFORCE_CONSOLE_URL || 'https://iti4dmv.my.site.com/dispatchconsole/s/';
const METHODS = new Set(['GetTimePhasedObjects', 'loadServicesInBulk']);

function val(x) { return x && typeof x === 'object' && !Array.isArray(x) && 'v' in x ? x.v : x; }
function ts(ms) { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null; }
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(); }

// Pull appointment records out of one apexremote response body (array of rpc results).
function extractServices(bodyText) {
  const out = [];
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch (e) { return out; }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  for (const call of calls) {
    if (!call || call.action !== 'FSL.ctrl001_Gantt' || !METHODS.has(call.method)) continue;
    const r = val(call.result);
    let list = null;
    if (call.method === 'GetTimePhasedObjects') list = val(r && r.services);
    else list = val(r && r.ganttServiceAppointments);
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const f = val(item && item.Fields);
      if (!f || !f.AppointmentNumber) continue;
      out.push({
        appointment_number: String(f.AppointmentNumber),
        resource_name: item.ResourceName ? String(item.ResourceName) : null,
        status: f.Status ? String(f.Status) : null,
        status_category: f.StatusCategory ? String(f.StatusCategory) : null,
        account_name: f['Account.Name'] || f.Account || null,
        work_type: f.WorkType || null,
        territory: f['ServiceTerritory.Name'] || f.ServiceTerritory || null,
        lat: num(f.Latitude), lng: num(f.Longitude),
        sched_start: ts(f.SchedStartTime), sched_end: ts(f.SchedEndTime),
        actual_start: ts(f.ActualStartTime), actual_end: ts(f.ActualEndTime),
        sf_last_modified: ts(item.ServiceAppointmentLastModifiedDate || f.LastModifiedDate),
      });
    }
  }
  return out;
}

async function runStatusPass(page, supabase, opts) {
  const started = Date.now();
  const summary = { ok: false, rowsSeen: 0, matchedTechs: 0, statuses: {}, error: null };
  let tab = null, ctx2 = null;
  try {
    // The sync opens its page with browser.newPage(), whose context cannot make another page, so make a
    // separate context carrying the same signed-in cookies and open the Gantt page in that.
    const state = await page.context().storageState();
    ctx2 = await page.context().browser().newContext({
      storageState: state,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });
    await ctx2.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    tab = await ctx2.newPage();
    tab.setDefaultTimeout(30000);
    const bodies = [];
    const pending = [];
    tab.on('response', (resp) => {
      if (!/\/dispatchconsole\/apexremote/.test(resp.url())) return;
      pending.push((async () => {
        try { const t = await resp.text(); if (t && t.includes('FSL.ctrl001_Gantt')) bodies.push(t); } catch (e) { /* ignore */ }
      })());
    });
    try { await tab.goto(HOME_URL, { waitUntil: 'commit' }); } catch (e) { /* often benign */ }

    // wait for the Gantt's data calls (up to ~50 s), then a short settle for the second call
    const deadline = Date.now() + 50000;
    let got = false;
    while (Date.now() < deadline) {
      await tab.waitForTimeout(2500);
      await Promise.allSettled(pending.splice(0));
      if (bodies.some((b) => /GetTimePhasedObjects|loadServicesInBulk/.test(b))) { got = true; break; }
    }
    if (got) { await tab.waitForTimeout(5000); await Promise.allSettled(pending.splice(0)); }

    const rows = new Map();
    for (const b of bodies) {
      for (const s of extractServices(b)) {
        const key = s.appointment_number + '|' + (s.resource_name || '');
        const prev = rows.get(key);
        if (!prev || (s.sf_last_modified || '') >= (prev.sf_last_modified || '')) rows.set(key, Object.assign({ sa_key: key }, s));
      }
    }
    summary.rowsSeen = rows.size;
    if (!rows.size) throw new Error(got ? 'The Gantt responded but no appointments could be read from it (format may have changed).' : 'The Gantt data calls never arrived (page did not load the Gantt).');

    // match technicians by name
    const { data: techs } = await supabase.from('technicians').select('id, name').eq('active', true);
    const byName = new Map();
    for (const t of techs || []) byName.set(norm(t.name), t.id);
    const matched = new Set();
    const list = Array.from(rows.values());
    for (const r of list) {
      r.technician_id = r.resource_name ? (byName.get(norm(r.resource_name)) || null) : null;
      if (r.technician_id) matched.add(r.technician_id);
      r.seen_at = new Date().toISOString();
      const st = r.status || '(none)';
      summary.statuses[st] = (summary.statuses[st] || 0) + 1;
    }
    summary.matchedTechs = matched.size;

    for (let i = 0; i < list.length; i += 200) {
      const { error } = await supabase.from('sa_live_status').upsert(list.slice(i, i + 200), { onConflict: 'sa_key' });
      if (error) throw new Error('Saving appointments failed: ' + error.message);
    }
    // keep the table small: drop anything not modified or scheduled within the last 4 days
    const cutoff = new Date(Date.now() - 4 * 86400000).toISOString();
    await supabase.from('sa_live_status').delete().lt('seen_at', cutoff);
    summary.ok = true;
  } catch (e) {
    summary.error = e.message;
  } finally {
    if (tab) { try { await tab.close(); } catch (e) { /* ignore */ } }
    if (ctx2) { try { await ctx2.close(); } catch (e) { /* ignore */ } }
  }
  try {
    await supabase.from('sa_status_sync_runs').insert({
      ok: summary.ok, rows_seen: summary.rowsSeen, matched_techs: summary.matchedTechs,
      statuses: summary.statuses, error: summary.error, ms: Date.now() - started,
    });
    await supabase.from('sa_status_sync_runs').delete().lt('ran_at', new Date(Date.now() - 14 * 86400000).toISOString());
  } catch (e) { /* best effort */ }
  return summary;
}

module.exports = { runStatusPass, extractServices };
