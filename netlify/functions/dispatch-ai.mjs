/**
 * dispatch-ai.mjs — v1 — added 2026-08-18
 *
 * Backend for the embedded AI Dispatch Assistant command bar in index.html.
 * Takes a typed or dictated instruction ("move stop 2 from Robert to
 * Keontae", "re-sort Gina's route"), has Gemini turn it into one or more
 * structured tool calls, executes them against the live route state, writes
 * the result to Supabase, and hands back both the new stop order and a
 * mileage/duration diff for the dispatcher to sanity-check.
 *
 * Written as a modern (v2) ESM function on purpose. Netlify's AI Gateway
 * only injects provider credentials into the modern function runtime -- a
 * legacy `exports.handler` function builds fine but 500s at runtime with a
 * missing-API-key error, so this one must stay in this format even though
 * most of its neighbors in this directory are still v1 CommonJS.
 *
 * NO EXTERNAL MAPPING API IS CALLED HERE. Every mile and minute quoted in a
 * diff comes from the locally pre-computed distance matrix
 * (distance-matrix/{STATE} in Blobs, built once per state by
 * compute-distance-matrix.js and compute-site-distance-matrix.js) with a
 * straight-line haversine fallback over stored lat/lng -- see
 * lib/route-optimizer.mjs, which is the server-side port of the exact
 * ordering/leg-distance logic index.html already uses on the tech cards.
 *
 * POST /.netlify/functions/dispatch-ai
 * Body: {
 *   text: "move stop 2 from Robert to Keontae",   // typed text or voice transcript
 *   state: "GA",
 *   dispatchDate: "2026-08-18",
 *   routes: [ { tech: "Robert Medley", stops: ["GA1001", "GA1017"] }, ... ]
 * }
 *
 * Response: {
 *   ok: true,
 *   reply: "...",                       // plain-language answer when nothing was actionable
 *   actions: [ { type, summary, tech, ... } ],
 *   summary: "Moved Stop 2 to Keontae | Net Fleet: -4.2 mi",
 *   routes: [ { tech, stops: [...] } ], // full new ordering, for the UI to apply
 *   changedTechs: ["Robert Medley", "Keontae Brooks"],
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

const MODEL = 'gemini-3.7-flash';

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
 * The two commands the assistant is allowed to perform. Indices are 1-based
 * to match how the roster is numbered in the prompt and how dispatchers
 * actually talk ("stop 2", not "stop index 1").
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
  ];
}

/** Numbered roster given to the model so it can resolve names and positions. */
function buildRoster(routes, siteNames, unavailableTechs) {
  const lines = [];
  routes.forEach((r, ti) => {
    const flag = unavailableTechs.has(r.tech) ? ' (UNAVAILABLE TODAY)' : '';
    lines.push(`Technician ${ti + 1}: ${r.tech}${flag}`);
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

function systemInstruction(roster, state, dispatchDate) {
  return [
    'You are the dispatch assistant for a field-service dispatch board.',
    `Region: ${state}. Dispatch date: ${dispatchDate}.`,
    '',
    "Here is the current board. Technicians and stops are numbered; use those exact numbers in your tool calls.",
    '',
    roster,
    '',
    'Rules:',
    '- Match technicians by first name, last name, or nickname; the dispatcher rarely says the full name.',
    '- If the dispatcher names a site code or site name instead of a stop number, find that stop in the roster and use its number.',
    '- If an instruction implies several changes, emit one tool call per change, in the order they should be applied.',
    '- Only call a tool when you are confident which technician and stop are meant. If the instruction is ambiguous, ' +
      'unrelated to moving or sorting stops, or refers to someone or something not on the board, do not call a tool: ' +
      'reply with one short sentence saying what you need clarified.',
    '- Never invent technicians, stops, or site codes that are not in the roster above.',
    '- A technician marked (UNAVAILABLE TODAY) should not receive a reassigned stop. If the dispatcher asks to move a ' +
      'stop to someone marked unavailable, do not call a tool: reply that they are unavailable today and ask who should ' +
      'get it instead.',
  ].join('\n');
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
 * Deliberately an update-then-insert rather than a blanket upsert: an upsert
 * has to supply technician_id and assigned_by (both NOT NULL) on every row,
 * which would reset assigned_by provenance on stops that were merely
 * re-sequenced. Existing rows get only the columns that actually changed;
 * rows that don't exist yet (a stop generated in the browser but never
 * persisted) are inserted in full.
 *
 * A stop that actually changed hands is marked assigned_by 'manual', the same
 * provenance index.html's own reassignStop writes -- a dispatcher moving a
 * stop through the assistant is still a dispatcher decision. Stops that only
 * got re-sequenced keep whatever provenance they already had.
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

  // Sent by the browser from the same getUnavailableTechsForDate() the
  // Reassign dropdown and fallback-assignment queue already use (comp days,
  // BlueFolder sync, manual toggles). Absence of the field (older client,
  // or the fetch failed client-side) means we can't vouch for anyone's
  // availability -- treated as "nobody confirmed unavailable" rather than
  // silently trusting a stale/empty list, same fail-open posture the rest
  // of the payload takes elsewhere in this handler.
  const unavailableTechs = new Set(
    (Array.isArray(payload.unavailableTechs) ? payload.unavailableTechs : []).map((t) => String(t))
  );

  // The browser sends the live board rather than us re-deriving it:
  // window.currentAssignments is the working copy the dispatcher is looking
  // at, including in-session moves that may not have reached Supabase yet.
  const routes = (Array.isArray(payload.routes) ? payload.routes : [])
    .filter((r) => r && r.tech)
    .map((r) => ({
      tech: String(r.tech),
      stops: (Array.isArray(r.stops) ? r.stops : []).map((c) => String(c)),
    }));
  if (!routes.length) {
    return json(400, { ok: false, error: 'No dispatch routes to work with -- generate dispatches first' });
  }

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
        systemInstruction: systemInstruction(buildRoster(routes, ctx.siteNames, unavailableTechs), state, dispatchDate),
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
        if (unavailableTechs.has(to.tech)) {
          actions.push({ type: 'error', summary: `${shortName(to.tech)} is marked unavailable today -- pick someone else or clear their availability first.` });
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
        // pinning it to the front, matching what index.html's reassign +
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

      actions.push({ type: 'error', summary: `Unsupported command: ${call.name}` });
    }

    const fleetAfter = fleetMetrics(legInfo, working);
    const fleetDelta = deltaText(fleetBefore, fleetAfter);

    let persistResult = { persisted: false, reason: 'nothing changed' };
    if (changedTechs.size) {
      persistResult = await persistRoutes(supabase, dispatchDate, working, changedTechs, ctx, movedCodes);
    }

    const applied = actions.filter((a) => a.type !== 'error');
    const summary = applied.length
      ? `${applied.map((a) => a.summary).join(' · ')} | Net Fleet: ${fleetDelta}`
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
