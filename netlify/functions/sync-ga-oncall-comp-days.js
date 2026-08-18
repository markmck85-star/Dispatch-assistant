/**
 * sync-ga-oncall-comp-days.js
 *
 * Backfills GA's on-call-derived comp days into `technician_availability`.
 *
 * Why this exists: index.html's availability panel already computes comp
 * days correctly on the fly (getCompDaysForDate, driven by the static
 * ONCALL_SCHEDULE_GA table below), but that computation has only ever lived
 * in browser JS -- it was never written anywhere as real rows. Two real
 * consequences: (1) Team Calendar (calendar.html) only ever reads
 * `technician_availability` where available=false, so it has never shown
 * GA's comp days at all; (2) any future server-side consumer (e.g. the AI
 * dispatch assistant's availability check) would otherwise need the same
 * JS logic duplicated server-side just to know who's out. Writing real rows
 * here means both get a single, already-existing source of truth instead.
 *
 * ONCALL_SCHEDULE_GA below is a literal copy of the one in index.html
 * (source: official on-call schedule PDF) -- the two must be kept in sync
 * by hand if the schedule ever changes. Comp-day rule, also copied
 * verbatim: Robert Medley takes the Thursday before his on-call Saturday;
 * every other on-call tech takes the Monday before theirs.
 *
 * Idempotent and safe to re-run: does a read-then-write per row rather than
 * a blind upsert, since this schema's unique-constraint situation on
 * (technician_id, day) hasn't been confirmed (other tables in this project
 * have turned out not to have the constraint an upsert assumed). A row this
 * function already wrote (reason='comp_day', bluefolder_appt_id=null) is
 * left alone on a re-run; a manually-set row for the same tech/day is never
 * touched or overwritten, so a comp day someone has since edited by hand
 * (e.g. traded with another tech) doesn't get silently reverted.
 *
 * GET  ?dryRun=1  → preview only, writes nothing, returns what WOULD be written
 * POST (no dryRun)→ actually writes
 *
 * Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

// ── Copied verbatim from index.html -- keep in sync by hand ────────────────
const ONCALL_SCHEDULE_GA = {
  '2026-05-02': ['Omari Williams', 'Robert Medley'],
  '2026-05-09': ['Nyzier Moore', 'Sean Reich'],
  '2026-05-16': ['Omari Williams', 'Robert Medley'],
  '2026-05-23': ['Nyzier Moore', 'Sean Reich'],
  '2026-05-30': ['Omari Williams', 'Robert Medley'],
  '2026-06-06': ['Nyzier Moore', 'Sean Reich'],
  '2026-06-13': ['Omari Williams', 'Robert Medley'],
  '2026-06-20': ['Nyzier Moore', 'Sean Reich'],
  '2026-06-27': ['Omari Williams', 'Robert Medley'],
  '2026-07-04': ['Nyzier Moore', 'Sean Reich'],
  '2026-07-11': ['Omari Williams', 'Robert Medley'],
  '2026-07-18': ['Nyzier Moore', 'Sean Reich'],
  '2026-07-25': ['Omari Williams', 'Robert Medley'],
  '2026-08-01': ['Nyzier Moore', 'Sean Reich'],
  '2026-08-08': ['Omari Williams', 'Robert Medley'],
  '2026-08-15': ['Nyzier Moore', 'Sean Reich'],
  '2026-08-22': ['Omari Williams', 'Robert Medley'],
  '2026-08-29': ['Nyzier Moore', 'Sean Reich'],
  '2026-09-05': ['Omari Williams', 'Robert Medley'],
  '2026-09-12': ['Nyzier Moore', 'Sean Reich'],
  '2026-09-19': ['Omari Williams', 'Robert Medley'],
  '2026-09-26': ['Nyzier Moore', 'Sean Reich'],
  '2026-10-03': ['Omari Williams', 'Robert Medley'],
  '2026-10-10': ['Nyzier Moore', 'Sean Reich'],
  '2026-10-17': ['Omari Williams', 'Robert Medley'],
  '2026-10-24': ['Nyzier Moore', 'Sean Reich'],
  '2026-10-31': ['Omari Williams', 'Robert Medley'],
  '2026-11-07': ['Nyzier Moore', 'Sean Reich'],
  '2026-11-14': ['Omari Williams', 'Robert Medley'],
  '2026-11-21': ['Nyzier Moore', 'Sean Reich'],
  '2026-11-28': ['Omari Williams', 'Robert Medley'],
  '2026-12-05': ['Nyzier Moore', 'Sean Reich'],
  '2026-12-12': ['Omari Williams', 'Robert Medley'],
  '2026-12-19': ['Nyzier Moore', 'Sean Reich'],
  '2026-12-26': ['Omari Williams', 'Robert Medley'],
  '2027-01-02': ['Nyzier Moore', 'Sean Reich'],
};
const THURSDAY_COMP_TECHS = new Set(['Robert Medley']);

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Every (tech, compDay) pair the schedule implies, past AND future --
 *  a past comp day is still worth having on record for calendar history. */
function computeCompDays() {
  const rows = [];
  for (const [satStr, techs] of Object.entries(ONCALL_SCHEDULE_GA)) {
    for (const tech of techs) {
      const compDay = THURSDAY_COMP_TECHS.has(tech) ? addDays(satStr, -2) : addDays(satStr, -5);
      rows.push({ tech, day: compDay, note: `Comp day — on call Sat ${satStr}` });
    }
  }
  return rows;
}

exports.handler = async (event) => {
  const dryRun = event.httpMethod === 'GET' || (event.queryStringParameters || {}).dryRun === '1';

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: techs, error: techErr } = await supabase.from('technicians').select('id, name');
  if (techErr) return json(500, { ok: false, error: 'technicians fetch failed: ' + techErr.message });
  const techIdByName = {};
  for (const t of techs) techIdByName[t.name] = t.id;

  const planned = computeCompDays();
  const toInsert = [];
  const skippedNoTech = [];
  const skippedExisting = [];

  for (const row of planned) {
    const technicianId = techIdByName[row.tech];
    if (!technicianId) { skippedNoTech.push(row); continue; }

    const { data: existing, error: existErr } = await supabase
      .from('technician_availability')
      .select('id, reason, bluefolder_appt_id')
      .eq('technician_id', technicianId)
      .eq('day', row.day)
      .maybeSingle();
    if (existErr) return json(500, { ok: false, error: `existing-row check failed for ${row.tech} ${row.day}: ${existErr.message}` });

    if (existing) { skippedExisting.push({ ...row, existingReason: existing.reason }); continue; }

    toInsert.push({
      technician_id: technicianId,
      day: row.day,
      available: false,
      reason: 'comp_day',
      note: row.note,
      bluefolder_appt_id: null,
    });
  }

  if (dryRun) {
    return json(200, {
      ok: true,
      dryRun: true,
      wouldInsert: toInsert.length,
      skippedNoTechMatch: skippedNoTech.map((r) => r.tech + ' ' + r.day),
      skippedAlreadyPresent: skippedExisting.length,
      sample: toInsert.slice(0, 5),
    });
  }

  if (toInsert.length) {
    const { error: insertErr } = await supabase.from('technician_availability').insert(toInsert);
    if (insertErr) return json(500, { ok: false, error: 'insert failed: ' + insertErr.message });
  }

  return json(200, {
    ok: true,
    dryRun: false,
    inserted: toInsert.length,
    skippedNoTechMatch: skippedNoTech.map((r) => r.tech + ' ' + r.day),
    skippedAlreadyPresent: skippedExisting.length,
  });
};
