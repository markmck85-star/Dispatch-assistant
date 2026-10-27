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
        // The work order number (same value as tickets.wo_number): ParentRecord, or ParentFields.WorkOrderNumber.
        work_order: (f.ParentRecord || (val(item && item.ParentFields) || {}).WorkOrderNumber) ? String(f.ParentRecord || val(item.ParentFields).WorkOrderNumber) : null,
        street: f.Street ? String(f.Street) : null,
        city: f.City ? String(f.City) : null,
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

// Moves a board assignment onto the technician Salesforce actually has the appointment on, but ONLY when
// the board's technician came from the system's own defaults (auto / fallback_rule / contractor_rule).
// A manual choice on the board is never touched. A moved row is marked assigned_by 'manual' (so a later
// reprocess keeps it), with sf_synced_at / sf_prev_tech so the card can say it was moved to match
// Salesforce. Matching is by work order number (tickets.wo_number = the appointment's ParentRecord).
const OVERRIDABLE = new Set(['auto', 'fallback_rule', 'contractor_rule']);
const LIVE_STATUSES = new Set(['Scheduled', 'Dispatched', 'In Progress']);
async function reconcileAssignments(supabase, list) {
  const out = { checked: 0, moved: 0, moves: [] };
  const live = list.filter((r) => r.work_order && r.technician_id && LIVE_STATUSES.has(r.status));
  if (!live.length) return out;
  const woToTech = new Map();
  for (const r of live) {
    const prev = woToTech.get(r.work_order);
    if (!prev || (r.sf_last_modified || '') >= (prev.sf_last_modified || '')) woToTech.set(r.work_order, r);
  }
  const { data: tickets } = await supabase.from('tickets').select('id, wo_number').in('wo_number', Array.from(woToTech.keys()));
  const woByTicket = new Map((tickets || []).map((t) => [t.id, t.wo_number]));
  if (!woByTicket.size) return out;
  const { data: rows } = await supabase
    .from('assignments')
    .select('id, ticket_id, technician_id, assigned_by, status, locked, technicians(name)')
    .in('ticket_id', Array.from(woByTicket.keys()))
    .in('status', ['planned', 'notified']);
  const { data: techs } = await supabase.from('technicians').select('id, name');
  const nameById = new Map((techs || []).map((t) => [t.id, t.name]));
  for (const a of rows || []) {
    out.checked++;
    const sf = woToTech.get(woByTicket.get(a.ticket_id));
    if (!sf || sf.technician_id === a.technician_id) continue;
    if (a.locked || !OVERRIDABLE.has(a.assigned_by)) continue;
    const { error } = await supabase.from('assignments').update({
      technician_id: sf.technician_id,
      assigned_by: 'manual',
      sf_synced_at: new Date().toISOString(),
      sf_prev_tech: (a.technicians && a.technicians.name) || nameById.get(a.technician_id) || null,
      updated_at: new Date().toISOString(),
    }).eq('id', a.id).eq('technician_id', a.technician_id).in('assigned_by', Array.from(OVERRIDABLE));
    if (!error) {
      out.moved++;
      out.moves.push(woByTicket.get(a.ticket_id) + ': ' + ((a.technicians && a.technicians.name) || '?') + ' -> ' + (nameById.get(sf.technician_id) || '?'));
    }
  }
  return out;
}

async function runStatusPass(page, supabase, opts) {
  const started = Date.now();
  const summary = { ok: false, rowsSeen: 0, matchedTechs: 0, statuses: {}, error: null };
  let tab = null, onResp = null;
  try {
    // Use the sync's own signed-in page: after the report import nothing else needs it (the closing-notes
    // pass navigates for itself). A separate browser context did not receive the Gantt data.
    tab = page;
    const bodies = [];
    const pending = [];
    onResp = (resp) => {
      if (!/\/dispatchconsole\/apexremote/.test(resp.url())) return;
      pending.push((async () => {
        try { const t = await resp.text(); if (t && t.includes('FSL.ctrl001_Gantt')) bodies.push(t); } catch (e) { /* ignore */ }
      })());
    };
    tab.on('response', onResp);
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
    if (!rows.size) throw new Error(got ? 'The Gantt responded but no appointments could be read from it (format may have changed).' : 'The Gantt data calls never arrived (page did not load the Gantt; ended on ' + String(tab.url()).slice(0, 120) + (await tab.locator('#username').count().catch(() => 0) ? ', which is a sign-in page' : '') + ').');

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
    // optional: make the board follow Salesforce for default-assigned tickets (opts.matchAssignments !== false)
    summary.assignmentsMoved = 0;
    if (!opts || opts.matchAssignments !== false) {
      try {
        const rec = await reconcileAssignments(supabase, list);
        summary.assignmentsMoved = rec.moved;
        summary.moves = rec.moves;
      } catch (e) { summary.matchError = e.message; }
    }
    // keep the table small: drop anything not modified or scheduled within the last 4 days
    const cutoff = new Date(Date.now() - 4 * 86400000).toISOString();
    await supabase.from('sa_live_status').delete().lt('seen_at', cutoff);
    summary.ok = true;
  } catch (e) {
    summary.error = e.message;
  } finally {
    if (tab && onResp) { try { tab.off('response', onResp); } catch (e) { /* ignore */ } }
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

module.exports = { runStatusPass, extractServices, reconcileAssignments };
