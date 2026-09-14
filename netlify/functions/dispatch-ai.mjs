/**
 * dispatch-ai.mjs — v1 (fresh rebuild) — 2026-09-13
 *
 * Backend for the embedded AI Dispatch Assistant command bar -- shared by
 * index.html's board panel and the state-console redesign (state.html),
 * per the 2026-09-13 scoping decision to build one backend for both rather
 * than let capabilities drift between two implementations.
 *
 * Rebuilt fresh rather than merged from the old, unmerged PR #1 branch
 * (292 commits behind main, only 2 commits of its own work -- not worth
 * untangling). This file keeps that branch's overall shape (Gemini via
 * Netlify AI Gateway, numbered-roster prompt, function-call tools, diff
 * reporting, Supabase persistence) but is wired against the CURRENT schema
 * -- in particular get-assignments.js's flat {siteCode, techName, status,
 * ticket} response shape (not the old nested sites()/technicians() joins),
 * and adds three new read-only advisory tools that didn't exist before.
 *
 * PHILOSOPHY (per 2026-09-13 requirements discussion): this app is a
 * decision-support resource, not something that overrides dispatcher
 * judgment or touches real dispatching. Nothing this function writes ever
 * reaches the actual Salesforce Gantt board -- a dispatcher still has to
 * manually drag tickets onto technicians' timelines there. That's what
 * makes reassign_stop/sort_route's write access low-risk: a mistake here
 * is wrong pixels in this app, not a wrong truck. The three advisory
 * tools are explicitly read-only/no-DB-write -- they answer a question,
 * they never block or auto-flag an action a dispatcher is taking.
 *
 * NO EXTERNAL MAPPING API IS CALLED HERE. Every mile and minute quoted
 * comes from the locally pre-computed distance matrix
 * (distance-matrix/{STATE} in Blobs, built by compute-distance-matrix.js
 * and compute-site-distance-matrix.js) with a straight-line haversine
 * fallback over stored lat/lng -- see lib/route-optimizer.mjs, the same
 * ordering/leg-distance math index.html's tech cards and state.html's map
 * both already use client-side.
 *
 * Written as a modern (v2) ESM function on purpose -- Netlify's AI Gateway
 * only injects provider credentials into the modern function runtime, so
 * this one must stay .mjs/`export default` even though most of its
 * neighbors in this directory are still v1 CommonJS `exports.handler`.
 *
 * POST /.netlify/functions/dispatch-ai
 * Body: {
 *   text: "move stop 2 from Robert to Keontae",   // typed text or voice transcript
 *   state: "GA",
 *   dispatchDate: "2026-09-13",
 *   routes: [ { tech: "Robert Medley", stops: ["GA1001", "GA1017"] }, ... ]
 * }
 *
 * The caller sends its own live route state (index.html's
 * window.currentAssignments, or state.html building the equivalent shape
 * from get-assignments.js) rather than this function re-deriving it, so
 * in-session moves not yet persisted are respected either way.
 *
 * Response: {
 *   ok: true,
 *   reply: "...",                       // plain-language answer when nothing was actionable
 *   actions: [ { type, summary, ... } ],
 *   summary: "Moved Stop 2 to Keontae | Net Fleet: -4.2 mi",
 *   routes: [ { tech, stops: [...] } ], // full new ordering, for the UI to apply
 *   changedTechs: [...],
 *   persisted: true
 * }
 */

import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';
import { getStore } from '@netlify/blobs';
import { createClient } from '@supabase/supabase-js';
import {
  createLegResolver,
  routeMetrics,
  fleetMetrics,
  optimizeRoute,
  insertStopAtBestPosition,
} from './lib/route-optimizer.mjs';

// 2026-09-13: same model the old PR branch used. Verify this is still a
// current, supported Netlify AI Gateway model name before deploying --
// nothing here confirms that's still accurate a month later.
const MODEL = 'gemini-3.7-flash';

// Rough per-stop dwell-time assumption for the overtime-risk advisory tool
// (see get_overtime_risk below) -- this app has no real per-ticket
// duration estimate anywhere, so this is a deliberately simple, tunable
// placeholder, not a measured figure. Adjust freely.
const AVG_STOP_DWELL_MIN = 20;
// 8am-5pm minus an hour for lunch, matching the service-window rules
// already used for SLA calculations elsewhere in this app.
const WORKDAY_BUDGET_MIN = 8 * 60;

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * The commands/questions the assistant is allowed to handle. Indices are
 * 1-based to match how the roster is numbered in the prompt and how
 * dispatchers actually talk ("stop 2", not "stop index 1").
 */
function functionDeclarations() {
  return [
    {
      name: 'reassign_stop',
      description:
        "Move one stop out of one technician's route and into another technician's route. " +
        'Use this for any instruction about giving, moving, handing off, or transferring a stop or site to a different tech.',
      parameters: {
        type: 'OBJECT',
        properties: {
          fromTechIndex: {
            type: 'INTEGER',
            description: 'The 1-based number of the technician who currently has the stop, exactly as numbered in the roster.',
          },
          stopIndex: {
            type: 'INTEGER',
            description: "The 1-based position of the stop inside that technician's route, exactly as numbered in the roster.",
          },
          toTechIndex: {
            type: 'INTEGER',
            description: 'The 1-based number of the technician who should receive the stop, exactly as numbered in the roster.',
          },
        },
        required: ['fromTechIndex', 'stopIndex', 'toTechIndex'],
      },
    },
    {
      name: 'sort_route',
      description:
        "Re-sequence one technician's existing stops into the shortest sensible driving order from their home base. " +
        'Use this for instructions about sorting, optimizing, re-ordering, or cleaning up a route. It never adds or removes stops.',
      parameters: {
        type: 'OBJECT',
        properties: {
          techIndex: {
            type: 'INTEGER',
            description: 'The 1-based number of the technician whose route should be re-sorted, exactly as numbered in the roster.',
          },
        },
        required: ['techIndex'],
      },
    },
    {
      name: 'get_leg_distance',
      description:
        'Answers a question about the distance/drive time between two points -- two site codes, or a technician and a site ' +
        '(their current home base or wherever they are). Read-only: never changes the board. Use for questions like ' +
        '"how far is GA1017 from Robert" or "what\'s the distance between these two sites".',
      parameters: {
        type: 'OBJECT',
        properties: {
          fromTechIndex: {
            type: 'INTEGER',
            description: "1-based technician number if the starting point is a technician's home base. Omit if starting from a site instead.",
          },
          fromSiteCode: {
            type: 'STRING',
            description: 'Site code if the starting point is a site rather than a technician. Omit if fromTechIndex is used.',
          },
          toSiteCode: {
            type: 'STRING',
            description: 'The destination site code.',
          },
        },
        required: ['toSiteCode'],
      },
    },
    {
      name: 'get_stop_addition_cost',
      description:
        'Read-only advisory: estimates the mileage/time a technician\'s route would gain by adding one more stop (a site not ' +
        "currently on their route), inserted at its best position -- without actually adding it. Never changes the board. " +
        'Use for questions like "what would it cost Robert to also pick up GA1042" or "is it worth having Sean grab this on his way".',
      parameters: {
        type: 'OBJECT',
        properties: {
          techIndex: {
            type: 'INTEGER',
            description: 'The 1-based number of the technician whose route to evaluate.',
          },
          siteCode: {
            type: 'STRING',
            description: 'The site code being considered for addition.',
          },
        },
        required: ['techIndex', 'siteCode'],
      },
    },
    {
      name: 'get_overtime_risk',
      description:
        "Read-only advisory: rough estimate of whether a technician's current route risks running into overtime today, based " +
        'on total drive time plus an average per-stop dwell time against an 8-hour workday budget. This is a flagged ' +
        '"likely" estimate, not a hard fact -- it has no real per-ticket duration data. Never blocks or changes anything. ' +
        'Use for questions like "is Robert going to run into overtime today".',
      parameters: {
        type: 'OBJECT',
        properties: {
          techIndex: {
            type: 'INTEGER',
            description: 'The 1-based number of the technician to check.',
          },
        },
        required: ['techIndex'],
      },
    },
  ];
}

/** Numbered roster given to the model so it can resolve names and positions. */
function buildRoster(routes, siteNames) {
  const lines = [];
  routes.forEach((r, ti) => {
    lines.push(`Technician ${ti + 1}: ${r.tech}`);
    if (!r.stops.length) {
      lines.push('  (no stops)');
      return;
    }
    r.stops.forEach((code, si) => {
      const name = siteNames[code];
      lines.push(`  Stop ${si + 1}: ${code}${name ? ' — ' + name : ''}`);
    });
  });
  return lines.join('\n');
}

function systemInstruction(roster, state, dispatchDate, unavailableTechs) {
  const lines = [
    'You are the dispatch assistant for a field-service dispatch board.',
    `Region: ${state}. Dispatch date: ${dispatchDate}.`,
    '',
    'Here is the current board. Technicians and stops are numbered; use those exact numbers in your tool calls.',
    '',
    roster,
    '',
  ];
  if (unavailableTechs && unavailableTechs.size) {
    lines.push(
      `Unavailable on ${dispatchDate} (comp day, time off, or not on-call): ${[...unavailableTechs].join(', ')}.`,
      "Do not call reassign_stop to move a stop onto one of these technicians -- if asked, reply explaining they're unavailable that day instead.",
      ''
    );
  }
  lines.push(
    'Rules:',
    '- Match technicians by first name, last name, or nickname; the dispatcher rarely says the full name.',
    '- If the dispatcher names a site code or site name instead of a stop number, find that stop in the roster and use its number.',
    '- If an instruction implies several changes, emit one tool call per change, in the order they should be applied.',
    '- The advisory tools (get_leg_distance, get_stop_addition_cost, get_overtime_risk) never change the board -- use them ' +
      'freely to answer a question, even speculative ones ("what if"), without asking for confirmation first.',
    '- reassign_stop and sort_route DO change the board. Only call one of those when you are confident which technician ' +
      'and stop are meant. If the instruction is ambiguous, unrelated to the board, or refers to someone or something not ' +
      'in the roster, do not call a tool: reply with one short sentence saying what you need clarified.',
    '- Never invent technicians, stops, or site codes that are not in the roster above.'
  );
  return lines.join('\n');
}

/** "-4.2 mi" / "+12 min" style signed formatting used in the diff line. */
function signed(value, unit, decimals) {
  const rounded = Number(value.toFixed(decimals));
  const sign = rounded > 0 ? '+' : (rounded < 0 ? '-' : '');
  return `${sign}${Math.abs(rounded).toFixed(decimals)} ${unit}`;
}

function deltaText(before, after) {
  const parts = [signed(after.distanceMi - before.distanceMi, 'mi', 1)];
  if (before.durationMin != null && after.durationMin != null) {
    parts.push(signed(after.durationMin - before.durationMin, 'min', 0));
  }
  return parts.join(' / ');
}

/** "12.3 mi" / "12.3 mi (18 min)" style plain (non-diff) formatting for the advisory tools. */
function legText(leg) {
  const mi = `${leg.distanceMi.toFixed(1)} mi`;
  if (leg.durationMin == null) return `${mi} (estimated, no real drive-time data)`;
  return `${mi} (${Math.round(leg.durationMin)} min)`;
}

/** First name only, which is how the dispatcher-facing diff line reads. */
function shortName(techName) {
  return String(techName || '').trim().split(/\s+/)[0] || techName;
}

/**
 * Loads everything the metrics need: the pre-computed matrix for the state
 * plus technician and site coordinates. All local reads -- Blobs and
 * Supabase, no mapping API.
 */
async function loadContext(supabase, state, techNames, siteCodes) {
  let matrix = null;
  try {
    const store = getStore('dispatch');
    const blob = await store.get('distance-matrix/' + state, { type: 'json' });
    matrix = (blob && blob.matrix) || null;
  } catch (err) {
    console.error('[dispatch-ai] distance matrix unavailable, falling back to haversine:', err.message);
  }

  const techs = {};
  const techIdByName = {};
  if (techNames.length) {
    const { data, error } = await supabase
      .from('technicians')
      .select('id, name, lat, lng')
      .in('name', techNames);
    if (error) throw new Error('Technician lookup failed: ' + error.message);
    for (const t of data || []) {
      techs[t.name] = { lat: t.lat, lng: t.lng };
      techIdByName[t.name] = t.id;
    }
  }

  const sites = {};
  const siteIdByCode = {};
  const siteNames = {};
  if (siteCodes.length) {
    const { data, error } = await supabase
      .from('sites')
      .select('id, site_code, name, lat, lng')
      .in('site_code', siteCodes);
    if (error) throw new Error('Site lookup failed: ' + error.message);
    for (const s of data || []) {
      sites[s.site_code] = { lat: s.lat, lng: s.lng };
      siteIdByCode[s.site_code] = s.id;
      siteNames[s.site_code] = s.name;
    }
  }

  return { matrix, techs, techIdByName, sites, siteIdByCode, siteNames };
}

/**
 * Writes the new ordering to Supabase `assignments`.
 *
 * Deliberately an update-then-insert rather than a blanket upsert: an
 * upsert has to supply technician_id and assigned_by (both NOT NULL) on
 * every row, which would reset assigned_by provenance on stops that were
 * merely re-sequenced. Existing rows get only the columns that actually
 * changed; rows that don't exist yet (a stop generated in the browser but
 * never persisted) are inserted in full.
 *
 * A stop that actually changed hands is marked assigned_by 'manual', the
 * same provenance index.html's own reassignStop writes -- a dispatcher
 * moving a stop through the assistant is still a dispatcher decision.
 * Stops that only got re-sequenced keep whatever provenance they already
 * had.
 */
async function persistRoutes(supabase, dispatchDate, routes, changedTechs, ctx, movedCodes) {
  const affected = routes.filter((r) => changedTechs.has(r.tech));
  const codes = affected.flatMap((r) => r.stops);
  const siteIds = codes.map((c) => ctx.siteIdByCode[c]).filter(Boolean);
  if (!siteIds.length) return { persisted: false, reason: 'no matching sites in Supabase' };

  const { data: existingRows, error: readErr } = await supabase
    .from('assignments')
    .select('id, site_id, technician_id, sequence_order, assigned_by')
    .eq('dispatch_date', dispatchDate)
    .in('site_id', siteIds);
  if (readErr) throw new Error('Assignment read failed: ' + readErr.message);

  const existingBySite = {};
  for (const row of existingRows || []) existingBySite[row.site_id] = row;

  const now = new Date().toISOString();
  const inserts = [];
  const updates = [];

  for (const route of affected) {
    const techId = ctx.techIdByName[route.tech];
    if (!techId) {
      console.error(`[dispatch-ai] no Supabase technician row for "${route.tech}" -- skipping persistence for that route`);
      continue;
    }
    route.stops.forEach((code, idx) => {
      const siteId = ctx.siteIdByCode[code];
      if (!siteId) return;
      const sequenceOrder = idx + 1;
      const moved = movedCodes.has(code);
      const existing = existingBySite[siteId];
      if (existing) {
        const patch = {};
        if (existing.technician_id !== techId) patch.technician_id = techId;
        if (existing.sequence_order !== sequenceOrder) patch.sequence_order = sequenceOrder;
        if (moved && existing.assigned_by !== 'manual') patch.assigned_by = 'manual';
        if (Object.keys(patch).length) {
          patch.updated_at = now;
          updates.push({ id: existing.id, patch });
        }
      } else {
        inserts.push({
          dispatch_date: dispatchDate,
          site_id: siteId,
          technician_id: techId,
          assigned_by: moved ? 'manual' : 'auto',
          status: 'planned',
          sequence_order: sequenceOrder,
          locked: false,
          updated_at: now,
        });
      }
    });
  }

  for (const u of updates) {
    const { error } = await supabase.from('assignments').update(u.patch).eq('id', u.id);
    if (error) throw new Error('Assignment update failed: ' + error.message);
  }
  if (inserts.length) {
    const { error } = await supabase
      .from('assignments')
      .upsert(inserts, { onConflict: 'dispatch_date,site_id' });
    if (error) throw new Error('Assignment insert failed: ' + error.message);
  }

  return { persisted: true, updated: updates.length, inserted: inserts.length };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return json(200, {});
  if (req.method !== 'POST') return json(405, { ok: false, error: 'Method Not Allowed' });

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const text = String(payload.text || '').trim();
  if (!text) return json(400, { ok: false, error: 'No command text provided' });
  if (text.length > 1000) return json(400, { ok: false, error: 'Command text too long' });

  const state = String(payload.state || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) return json(400, { ok: false, error: 'A 2-letter state is required' });

  const dispatchDate = String(payload.dispatchDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dispatchDate)) {
    return json(400, { ok: false, error: 'dispatchDate is required, format YYYY-MM-DD' });
  }

  // The caller sends its own live route state -- index.html's
  // window.currentAssignments, or state.html assembling the equivalent
  // {tech, stops} shape from get-assignments.js -- rather than this
  // function re-deriving it, so in-session moves not yet persisted are
  // respected either way.
  const routes = (Array.isArray(payload.routes) ? payload.routes : [])
    .filter((r) => r && r.tech)
    .map((r) => ({
      tech: String(r.tech),
      stops: (Array.isArray(r.stops) ? r.stops : []).map((c) => String(c)),
    }));
  if (!routes.length) {
    return json(400, { ok: false, error: 'No dispatch routes to work with -- generate dispatches first' });
  }

  // Techs the caller has already determined are unavailable on this date
  // (comp day, BlueFolder-synced vacation/personal, manual override, or not
  // on-call on a Saturday) -- index.html computes this the same way its own
  // Reassign dropdown does (getUnavailableTechsForDate) and sends it along
  // so a reassign can't silently land on someone who isn't actually working.
  const unavailableTechs = new Set(
    (Array.isArray(payload.unavailableTechs) ? payload.unavailableTechs : []).map((t) => String(t))
  );

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: 'Supabase env vars not configured' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const ctx = await loadContext(
      supabase,
      state,
      routes.map((r) => r.tech),
      [...new Set(routes.flatMap((r) => r.stops))],
    );

    const legInfo = createLegResolver(ctx.matrix, ctx.techs, ctx.sites);
    const before = routes.map((r) => ({ tech: r.tech, stops: r.stops.slice() }));
    const fleetBefore = fleetMetrics(legInfo, before);

    const ai = new GoogleGenAI({});
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: text,
      config: {
        temperature: 0,
        systemInstruction: systemInstruction(buildRoster(routes, ctx.siteNames), state, dispatchDate, unavailableTechs),
        tools: [{ functionDeclarations: functionDeclarations() }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
      },
    });

    const calls = response.functionCalls || [];
    if (!calls.length) {
      return json(200, {
        ok: true,
        actions: [],
        summary: '',
        reply: (response.text || '').trim() || "Couldn't tell which stop or technician you meant — try naming the tech and the stop number.",
        routes,
        changedTechs: [],
        persisted: false,
      });
    }

    const working = routes.map((r) => ({ tech: r.tech, stops: r.stops.slice() }));
    const byTechIndex = (i) => (Number.isInteger(i) && i >= 1 && i <= working.length ? working[i - 1] : null);

    const actions = [];
    const changedTechs = new Set();
    const movedCodes = new Set();

    for (const call of calls) {
      const args = call.args || {};

      if (call.name === 'reassign_stop') {
        const from = byTechIndex(args.fromTechIndex);
        const to = byTechIndex(args.toTechIndex);
        const stopIndex = Number(args.stopIndex);
        if (!from || !to) {
          actions.push({ type: 'error', summary: 'That technician is not on the current board.' });
          continue;
        }
        if (from.tech === to.tech) {
          actions.push({ type: 'error', summary: `${shortName(from.tech)} already has that stop.` });
          continue;
        }
        // Hard guard, independent of the system-prompt instruction above --
        // never rely on the model alone to respect an availability rule.
        if (unavailableTechs.has(to.tech)) {
          actions.push({ type: 'error', summary: `${shortName(to.tech)} is marked unavailable on ${dispatchDate} -- pick someone else.` });
          continue;
        }
        if (!Number.isInteger(stopIndex) || stopIndex < 1 || stopIndex > from.stops.length) {
          actions.push({ type: 'error', summary: `${shortName(from.tech)} has no stop ${args.stopIndex}.` });
          continue;
        }

        const fromBefore = routeMetrics(legInfo, from.tech, from.stops);
        const toBefore = routeMetrics(legInfo, to.tech, to.stops);
        const code = from.stops.splice(stopIndex - 1, 1)[0];
        // Slot the stop into route order on the receiving side rather than
        // pinning it to the front, matching what a manual reassign +
        // auto-resort pair ends up doing.
        to.stops = insertStopAtBestPosition(legInfo, to.tech, to.stops, code, ctx.sites);
        movedCodes.add(code);
        changedTechs.add(from.tech);
        changedTechs.add(to.tech);

        actions.push({
          type: 'reassign_stop',
          summary: `Moved Stop ${stopIndex} (${code}) to ${shortName(to.tech)}`,
          siteCode: code,
          siteName: ctx.siteNames[code] || null,
          fromTech: from.tech,
          toTech: to.tech,
          fromDelta: deltaText(fromBefore, routeMetrics(legInfo, from.tech, from.stops)),
          toDelta: deltaText(toBefore, routeMetrics(legInfo, to.tech, to.stops)),
        });
        continue;
      }

      if (call.name === 'sort_route') {
        const route = byTechIndex(args.techIndex);
        if (!route) {
          actions.push({ type: 'error', summary: 'That technician is not on the current board.' });
          continue;
        }
        if (route.stops.length <= 1) {
          actions.push({ type: 'error', summary: `${shortName(route.tech)} has nothing to re-sort.` });
          continue;
        }

        const sortBefore = routeMetrics(legInfo, route.tech, route.stops);
        const original = route.stops.slice();
        route.stops = optimizeRoute(legInfo, route.tech, route.stops, ctx.sites);
        const sortAfter = routeMetrics(legInfo, route.tech, route.stops);
        const reordered = route.stops.some((c, i) => c !== original[i]);
        if (reordered) changedTechs.add(route.tech);

        actions.push({
          type: 'sort_route',
          summary: reordered
            ? `Re-sorted ${shortName(route.tech)}'s ${route.stops.length} stops`
            : `${shortName(route.tech)}'s route was already optimal`,
          tech: route.tech,
          reordered,
          delta: deltaText(sortBefore, sortAfter),
        });
        continue;
      }

      if (call.name === 'get_leg_distance') {
        const toCode = String(args.toSiteCode || '').toUpperCase();
        if (!ctx.sites[toCode]) {
          actions.push({ type: 'error', summary: `Don't have a location on file for ${toCode || '(blank)'}.` });
          continue;
        }
        let fromLabel;
        let leg;
        if (args.fromSiteCode) {
          const fromCode = String(args.fromSiteCode).toUpperCase();
          if (!ctx.sites[fromCode]) {
            actions.push({ type: 'error', summary: `Don't have a location on file for ${fromCode}.` });
            continue;
          }
          fromLabel = ctx.siteNames[fromCode] || fromCode;
          leg = legInfo(null, fromCode, toCode);
        } else {
          const route = byTechIndex(args.fromTechIndex);
          if (!route) {
            actions.push({ type: 'error', summary: 'That technician is not on the current board.' });
            continue;
          }
          fromLabel = `${shortName(route.tech)}'s home base`;
          leg = legInfo(route.tech, null, toCode);
        }
        const toLabel = ctx.siteNames[toCode] || toCode;
        actions.push({
          type: 'get_leg_distance',
          summary: `${fromLabel} → ${toLabel}: ${legText(leg)}`,
          distanceMi: leg.distanceMi,
          durationMin: leg.durationMin,
          isReal: leg.isReal,
        });
        continue;
      }

      if (call.name === 'get_stop_addition_cost') {
        const route = byTechIndex(args.techIndex);
        const code = String(args.siteCode || '').toUpperCase();
        if (!route) {
          actions.push({ type: 'error', summary: 'That technician is not on the current board.' });
          continue;
        }
        if (!ctx.sites[code]) {
          actions.push({ type: 'error', summary: `Don't have a location on file for ${code || '(blank)'}.` });
          continue;
        }
        if (route.stops.includes(code)) {
          actions.push({ type: 'error', summary: `${shortName(route.tech)} already has ${code} on their route.` });
          continue;
        }
        const costBefore = routeMetrics(legInfo, route.tech, route.stops);
        const withStop = insertStopAtBestPosition(legInfo, route.tech, route.stops, code, ctx.sites);
        const costAfter = routeMetrics(legInfo, route.tech, withStop);
        actions.push({
          type: 'get_stop_addition_cost',
          summary: `Adding ${code} to ${shortName(route.tech)}'s route: ${deltaText(costBefore, costAfter)}`,
          siteCode: code,
          siteName: ctx.siteNames[code] || null,
          tech: route.tech,
          bestPositionStops: withStop, // advisory only -- not applied unless a separate reassign_stop call does it
          delta: deltaText(costBefore, costAfter),
        });
        continue;
      }

      if (call.name === 'get_overtime_risk') {
        const route = byTechIndex(args.techIndex);
        if (!route) {
          actions.push({ type: 'error', summary: 'That technician is not on the current board.' });
          continue;
        }
        const metrics = routeMetrics(legInfo, route.tech, route.stops);
        const dwellMin = route.stops.length * AVG_STOP_DWELL_MIN;
        const driveMin = metrics.durationMin != null ? metrics.durationMin : null;
        // If any leg lacked real drive-time data, driveMin is null -- still
        // give a rough estimate off distance (assume ~35 mph average) so
        // the tool always answers something, but say plainly it's rougher.
        const estimatedDriveMin = driveMin != null ? driveMin : Math.round((metrics.distanceMi / 35) * 60);
        const projectedMin = estimatedDriveMin + dwellMin;
        const overBy = projectedMin - WORKDAY_BUDGET_MIN;
        const risk = overBy > 0 ? 'likely' : (overBy > -60 ? 'borderline' : 'unlikely');
        actions.push({
          type: 'get_overtime_risk',
          summary: overBy > 0
            ? `${shortName(route.tech)}: overtime ${risk} -- projected ~${Math.round(projectedMin / 60 * 10) / 10}h against an 8h budget (${route.stops.length} stops, rough dwell-time estimate)`
            : `${shortName(route.tech)}: overtime ${risk} -- projected ~${Math.round(projectedMin / 60 * 10) / 10}h against an 8h budget`,
          tech: route.tech,
          stopCount: route.stops.length,
          projectedMinutes: projectedMin,
          driveMinutesWereEstimated: driveMin == null,
          risk,
        });
        continue;
      }

      actions.push({ type: 'error', summary: `Unsupported command: ${call.name}` });
    }

    const fleetAfter = fleetMetrics(legInfo, working);
    const fleetDelta = deltaText(fleetBefore, fleetAfter);

    let persistResult = { persisted: false, reason: 'nothing changed' };
    if (changedTechs.size) {
      persistResult = await persistRoutes(supabase, dispatchDate, working, changedTechs, ctx, movedCodes);
    }

    const applied = actions.filter((a) => a.type !== 'error');
    // Advisory tools (get_leg_distance etc.) don't move fleet mileage, so
    // only fold the Net Fleet line in when something on the board actually
    // changed -- otherwise it's a meaningless "+0.0 mi" tacked onto a
    // plain answer.
    const summary = applied.length
      ? applied.map((a) => a.summary).join(' · ') + (changedTechs.size ? ` | Net Fleet: ${fleetDelta}` : '')
      : actions.map((a) => a.summary).join(' · ');

    return json(200, {
      ok: true,
      actions,
      summary,
      fleetDelta,
      routes: working,
      changedTechs: [...changedTechs],
      ...persistResult,
    });
  } catch (err) {
    console.error('[dispatch-ai] failed:', err);
    return json(500, { ok: false, error: err.message || 'Unexpected error' });
  }
};
