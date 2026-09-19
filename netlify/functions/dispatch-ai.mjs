/**
 * dispatch-ai.mjs — v1.2 (2026-09-19)
 *   - loadContext now reads distances from Supabase (tech_site_distances /
 *     site_site_distances) instead of the legacy distance-matrix/{STATE}
 *     Blob, matching what get-distance-matrix.js and the Reassign dropdown
 *     already switched to on 2026-09-15. The Blob had drifted stale (still
 *     carried pre-cleanup TMPGA001-era entries) and was the actual root
 *     cause of the Randy->Robert mis-suggestion documented in
 *     /areas/route-rebalance-bug.md -- not a data-quality problem with any
 *     individual technician's coordinates, which were fine the whole time.
 *   - trims technician names when building `routes`, and route-optimizer.mjs
 *     now trims inside techMatrixKey too, so incidental whitespage anywhere
 *     along the payload path can't silently miss a matrix/coordinate
 *     lookup for a technician.
 *   - display formatting (signed/legText) now shows "no route data"
 *     instead of "Infinity mi" for a leg route-optimizer.mjs couldn't
 *     resolve -- see that file's 2026-09-19 header note for why unresolved
 *     legs are now Infinity rather than a free-looking 0.
 *
 * v1.1 (2026-09-17)
 *   - retry Gemini generateContent on transient TLS/fetch failures
 *   - stop propose_route_rebalance from suggesting a swap and its reverse
 *   - cap how many extra miles workload-credit can buy
 *   - optional fromTechIndexes / toTechIndexes so "off Hodge onto Alex/Miguel" stays scoped
 *
 * Original rebuild — 2026-09-13
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
 * comes from Supabase's tech_site_distances / site_site_distances tables
 * (falling back to the legacy Blob cache, distance-matrix/{STATE}, only
 * for a state that hasn't been migrated yet -- see loadContext) with a
 * straight-line haversine fallback over stored lat/lng -- see
 * lib/route-optimizer.mjs, the same ordering/leg-distance math index.html's
 * tech cards and state.html's map both already use client-side.
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
  techMatrixKey,
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

// Minimum net fleet-mileage improvement (savings at the giving-up tech minus
// cost at the receiving tech) for propose_route_rebalance to bother
// suggesting a swap. Keeps the list to genuinely worthwhile moves rather
// than noise-level 0.2-mile shuffles nobody would act on.
const MIN_REBALANCE_SAVINGS_MI = 1.0;

// Workload-balance extension (2026-09-15): pure mileage-savings was blind to
// one tech sitting on a handful of stops while another had a full day --
// a swap that fixes a lopsided day was invisible unless it *also* happened
// to save fleet miles. A stop-count gap of 1 is normal noise (a 5-stop vs
// 6-stop day isn't an imbalance worth engineering a swap for); only a gap
// of 2 or more earns credit, and only for the portion beyond that.
// WORKLOAD_CREDIT_PER_STOP_MI is a mileage-equivalent value, not a real
// distance -- it exists purely to let a workload-driven swap clear the same
// MIN_REBALANCE_SAVINGS_MI bar mileage-driven swaps use, so there's one
// acceptance test either way. The real mileage delta (net) is never altered
// by this credit -- it's reported honestly alongside the decision.
const MIN_STOP_GAP_FOR_CREDIT = 2;
const WORKLOAD_CREDIT_PER_STOP_MI = 1.5;
// Workload credit must not buy a huge detour. Today's CA1067 Aaron↔Nick
// oscillation was a mileage-losing move that cleared the score bar on
// credit, then the next round's best move was the exact reverse.
const MAX_WORKLOAD_MILEAGE_COST_MI = 6;
const GEMINI_FETCH_RETRIES = 3;

/**
 * Greedy multi-round savings algorithm for propose_route_rebalance.
 *
 * This is a VRP-lite, not a real solver: each round finds the single best
 * "take this stop off tech A, insert it on tech B" swap across the whole
 * board, applies it, then re-evaluates from scratch before looking for the
 * next one. Re-evaluating every round (rather than ranking all candidates
 * once against the original board) is what correctly catches the
 * backtracking case this tool exists for -- a tech with two stops in
 * opposite directions from each other looks like modest savings for either
 * stop in isolation, but once one of them moves, the value of moving the
 * other can change (usually drop, since the detour that made both stops
 * expensive is now gone).
 *
 * locked/unavailable stops and techs are never touched. Returns the
 * ordered list of suggested moves (empty if nothing clears the minimum
 * threshold) -- purely advisory, never mutates the routes it's given.
 *
 * 2026-09-19: no logic change needed here for the Infinity-sentinel fix
 * (see route-optimizer.mjs) -- `net`/`score` are plain arithmetic on
 * routeMetrics' distanceMi, and Infinity already propagates correctly
 * through the existing `score >= minSavingsMi` check below (Infinity or
 * NaN both fail it). Documented so a future reader doesn't assume this
 * function needs its own explicit unresolved-leg guard.
 */
function proposeRebalance(routes, legInfo, sites, lockedCodes, unavailableTechs, minSavingsMi, maxSuggestions, fromTechSet, toTechSet) {
  let working = routes.map((r) => ({ tech: r.tech, stops: r.stops.slice() }));
  const suggestions = [];
  const usedCodes = new Set();
  const bannedKeys = new Set(); // `${from}|${to}|${code}` and the reverse

  for (let round = 0; round < maxSuggestions; round++) {
    let best = null;

    working.forEach((fromRoute) => {
      if (unavailableTechs.has(fromRoute.tech)) return;
      if (fromTechSet && fromTechSet.size && !fromTechSet.has(fromRoute.tech)) return;
      fromRoute.stops.forEach((code, idx) => {
        if (lockedCodes.has(code) || usedCodes.has(code)) return;
        const before = routeMetrics(legInfo, fromRoute.tech, fromRoute.stops);
        const without = fromRoute.stops.slice(0, idx).concat(fromRoute.stops.slice(idx + 1));
        const after = routeMetrics(legInfo, fromRoute.tech, without);
        const savings = before.distanceMi - after.distanceMi;
        // NOTE: previously bailed here whenever savings <= 0 ("this stop
        // isn't costing its current tech anything extra"). That's still a
        // fine reason to skip on pure mileage grounds, but it would also
        // silently block a workload-only swap -- a perfectly-placed stop on
        // an 8-stop day can still be worth handing to a 1-stop day even
        // though removing it doesn't save the giver any miles. Left
        // unguarded here; the score >= minSavingsMi check below (mileage
        // net + any workload credit) is what actually decides.

        working.forEach((toRoute) => {
          if (toRoute.tech === fromRoute.tech || unavailableTechs.has(toRoute.tech)) return;
          if (toTechSet && toTechSet.size && !toTechSet.has(toRoute.tech)) return;
          if (bannedKeys.has(`${fromRoute.tech}|${toRoute.tech}|${code}`)) return;
          const toBefore = routeMetrics(legInfo, toRoute.tech, toRoute.stops);
          const withStop = insertStopAtBestPosition(legInfo, toRoute.tech, toRoute.stops, code, sites);
          const toAfter = routeMetrics(legInfo, toRoute.tech, withStop);
          const cost = toAfter.distanceMi - toBefore.distanceMi;
          const net = savings - cost;

          // Workload credit: only when fromRoute is genuinely heavier than
          // toRoute (moving a stop the other direction gets none), and only
          // for the gap beyond the 1-stop noise floor. A swap between a
          // 6-stop and a 7-stop route earns nothing; 8 vs 1 (today's real
          // case) earns credit for 5 of that 7-stop gap.
          const stopGapBefore = fromRoute.stops.length - toRoute.stops.length;
          const workloadCredit = stopGapBefore > MIN_STOP_GAP_FOR_CREDIT
            ? (stopGapBefore - MIN_STOP_GAP_FOR_CREDIT) * WORKLOAD_CREDIT_PER_STOP_MI
            : 0;
          if (workloadCredit > 0 && net < -MAX_WORKLOAD_MILEAGE_COST_MI) return;
          const score = net + workloadCredit;

          if (score >= minSavingsMi && (!best || score > best.score)) {
            best = {
              fromTech: fromRoute.tech, toTech: toRoute.tech, code, savings, cost, net, score,
              workloadCredit, stopGapBefore,
              stopsFromBefore: fromRoute.stops.length, stopsFromAfter: fromRoute.stops.length - 1,
              stopsToBefore: toRoute.stops.length, stopsToAfter: toRoute.stops.length + 1,
              newFromStops: without, newToStops: withStop,
            };
          }
        });
      });
    });

    if (!best) break;
    usedCodes.add(best.code);
    bannedKeys.add(`${best.fromTech}|${best.toTech}|${best.code}`);
    bannedKeys.add(`${best.toTech}|${best.fromTech}|${best.code}`);
    working = working.map((r) => {
      if (r.tech === best.fromTech) return { tech: r.tech, stops: best.newFromStops };
      if (r.tech === best.toTech) return { tech: r.tech, stops: best.newToStops };
      return r;
    });
    suggestions.push(best);
  }

  return suggestions;
}

function isTransientFetchError(err) {
  const msg = String(err && (err.message || err));
  const cause = err && err.cause;
  const code = (cause && cause.code) || err.code || '';
  return (
    /fetch failed/i.test(msg) ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    /tls|socket disconnected|network/i.test(msg + ' ' + String(cause && cause.message || ''))
  );
}

async function generateContentWithRetry(ai, request) {
  let lastErr;
  for (let attempt = 1; attempt <= GEMINI_FETCH_RETRIES; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (err) {
      lastErr = err;
      if (!isTransientFetchError(err) || attempt === GEMINI_FETCH_RETRIES) throw err;
      const waitMs = 400 * attempt;
      console.warn(`[dispatch-ai] Gemini fetch failed (attempt ${attempt}/${GEMINI_FETCH_RETRIES}): ${err.message}; retrying in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

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
    {
      name: 'propose_route_rebalance',
      description:
        'Read-only advisory: analyzes the WHOLE board (not just one technician) and suggests specific stop-to-technician swaps ' +
        "that would reduce total fleet mileage/time, OR meaningfully even out a lopsided day (one tech with a full route " +
        "while another has only one or two stops) even when the mileage math alone is close to neutral. Especially useful " +
        "for catching a technician with two stops in opposite directions from each other that force a long backtrack, when " +
        "a different technician has a stop much nearer one of them -- or for catching a tech sitting nearly idle while " +
        "another is overloaded. Never changes the board by itself -- returns a ranked list of suggested moves with each " +
        "one's real mileage impact (never inflated by the workload consideration) plus, when relevant, the stop-count " +
        'change for both techs. Use for requests like "does this board make sense", "any better way to split these ' +
        'routes", "is anyone overloaded today", or "look for backtracking" -- and proactively when a rebalance seems ' +
        'relevant to what\'s being asked, even without an exact match to those phrases. Prefer this tool over ' +
        'get_stop_addition_cost when the site is already on someone\'s route and the ask is who should take it.',
      parameters: {
        type: 'OBJECT',
        properties: {
          maxSuggestions: {
            type: 'INTEGER',
            description: 'Maximum number of suggested swaps to return. Defaults to 5 if omitted.',
          },
          fromTechIndexes: {
            type: 'ARRAY',
            items: { type: 'INTEGER' },
            description: 'Optional 1-based technician numbers to take stops FROM. Use when the dispatcher names overloaded techs.',
          },
          toTechIndexes: {
            type: 'ARRAY',
            items: { type: 'INTEGER' },
            description: 'Optional 1-based technician numbers who should RECEIVE stops. Use when the dispatcher names lighter techs.',
          },
        },
        required: [],
      },
    },
  ];
}

/** Numbered roster given to the model so it can resolve names and positions. */
function buildRoster(routes, siteNames) {
  const lines = [];
  routes.forEach((r, ti) => {
    lines.push(`Technician ${ti + 1}: ${r.tech}${r.color ? ` (map color: ${r.color})` : ''}`);
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
    '- The text may be an imperfect voice-dictation transcript, not typed text. Resolve homophones and near-misses from ' +
      'context rather than requiring an exact match -- e.g. "stop to" or "stop too" almost always means "stop 2" when a ' +
      'number is grammatically expected there; the same applies to any other misheard number word or name.',
    '- Match technicians by first name, last name, nickname, OR the map color shown next to them above (e.g. "move red 2 to Mark" ' +
      'means the technician whose line says "map color: red"). A color reference always means the technician, never a stop or site.',
    '- If the dispatcher names a site code or site name instead of a stop number, find that stop in the roster and use its number.',
    '- If an instruction implies several changes, emit one tool call per change, in the order they should be applied.',
    '- The advisory tools (get_leg_distance, get_stop_addition_cost, get_overtime_risk, propose_route_rebalance) never change ' +
      'the board -- use them freely to answer a question, even speculative ones ("what if"), without asking for confirmation first.',
    '- If asked which existing stops to move from one tech (or color) onto another to balance load, call propose_route_rebalance ' +
      'ONCE with fromTechIndexes / toTechIndexes. Do not call get_stop_addition_cost for sites already on the board -- that tool is ' +
      'only for a site that is not currently assigned.',
    '- reassign_stop and sort_route DO change the board. Only call one of those when you are confident which technician ' +
      'and stop are meant. If the instruction is ambiguous, unrelated to the board, or refers to someone or something not ' +
      'in the roster, do not call a tool: reply with one short sentence saying what you need clarified.',
    '- Never invent technicians, stops, or site codes that are not in the roster above.'
  );
  return lines.join('\n');
}

/** "-4.2 mi" / "+12 min" style signed formatting used in the diff line. */
function signed(value, unit, decimals) {
  // 2026-09-19: an unresolved leg now comes back as Infinity (see
  // route-optimizer.mjs) rather than a free-looking 0 -- show that
  // honestly instead of formatting "Infinity" or "-0.0" for the dispatcher.
  if (!Number.isFinite(value)) return 'no route data';
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
  // 2026-09-19: same non-finite guard as signed() above.
  if (!Number.isFinite(leg.distanceMi)) return 'no route data available for this leg';
  const mi = `${leg.distanceMi.toFixed(1)} mi`;
  if (leg.durationMin == null) return `${mi} (estimated, no real drive-time data)`;
  return `${mi} (${Math.round(leg.durationMin)} min)`;
}

/** First name only, which is how the dispatcher-facing diff line reads. */
function shortName(techName) {
  return String(techName || '').trim().split(/\s+/)[0] || techName;
}

function techSetFromIndexes(indexes, routes) {
  if (!Array.isArray(indexes) || !indexes.length) return null;
  const set = new Set();
  for (const raw of indexes) {
    const i = Number(raw);
    if (Number.isInteger(i) && i >= 1 && i <= routes.length) set.add(routes[i - 1].tech);
  }
  return set.size ? set : null;
}

/**
 * Loads everything the metrics need: leg-distance data for the state plus
 * technician and site coordinates. All local reads -- Supabase and Blobs,
 * no mapping API.
 *
 * 2026-09-19 REWRITE (see /areas/route-rebalance-bug.md): the matrix used
 * to come exclusively from the legacy distance-matrix/{STATE} Blob. That
 * Blob is no longer the source of truth anywhere else in the app --
 * get-distance-matrix.js and the Reassign dropdown switched to reading
 * Supabase's tech_site_distances / site_site_distances tables on
 * 2026-09-15 -- but this function never got the same update, so it kept
 * scoring swaps off a copy of the data that had already drifted stale
 * (it still carries pre-cleanup TMPGA001-era entries). This now builds the
 * matrix the exact same way get-distance-matrix.js does: query both
 * Supabase tables for the technicians/sites this request actually needs,
 * prefer 'driving' rows over 'haversine-fallback' over 'haversine' when a
 * pair has more than one, and fall back to the legacy Blob ONLY if a state
 * hasn't been migrated into those tables yet at all (transitional -- see
 * get-distance-matrix.js's own header for the same fallback rationale).
 */
async function loadContext(supabase, state, techNames, siteCodes) {
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

  const matrix = {};
  const techIds = Object.values(techIdByName);
  const siteIds = Object.values(siteIdByCode);

  const [{ data: techToSite, error: t2sErr }, { data: siteToSite, error: s2sErr }] = await Promise.all([
    techIds.length
      ? supabase.from('tech_site_distances').select('technician_id, site_id, mode, distance_mi, duration_min').in('technician_id', techIds)
      : Promise.resolve({ data: [], error: null }),
    siteIds.length
      ? supabase.from('site_site_distances').select('site_a, site_b, mode, distance_mi, duration_min').or(`site_a.in.(${siteIds.join(',')}),site_b.in.(${siteIds.join(',')})`)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (t2sErr) console.error('[dispatch-ai] tech_site_distances lookup failed, continuing with what resolved:', t2sErr.message);
  if (s2sErr) console.error('[dispatch-ai] site_site_distances lookup failed, continuing with what resolved:', s2sErr.message);

  const nameById = Object.fromEntries(Object.entries(techIdByName).map(([name, id]) => [id, name]));
  const codeById = Object.fromEntries(Object.entries(siteIdByCode).map(([code, id]) => [id, code]));

  // Same driving > haversine-fallback > haversine preference
  // get-distance-matrix.js uses when a pair has rows in more than one mode.
  const MODE_PRIORITY = { driving: 0, 'haversine-fallback': 1, haversine: 2 };
  const pickBest = (rows) => rows.slice().sort((a, b) => (MODE_PRIORITY[a.mode] ?? 9) - (MODE_PRIORITY[b.mode] ?? 9))[0];

  const byTechSite = {};
  for (const row of techToSite || []) {
    const k = row.technician_id + '|' + row.site_id;
    (byTechSite[k] = byTechSite[k] || []).push(row);
  }
  for (const rows of Object.values(byTechSite)) {
    const best = pickBest(rows);
    const name = nameById[best.technician_id];
    const code = codeById[best.site_id];
    if (!name || !code) continue; // one side outside this request's scope -- skip
    matrix[techMatrixKey(name) + '|' + code] = {
      distanceMi: Number(best.distance_mi),
      durationMin: best.duration_min != null ? Number(best.duration_min) : null,
      type: best.mode,
    };
  }

  const bySiteSite = {};
  for (const row of siteToSite || []) {
    const k = row.site_a + '|' + row.site_b;
    (bySiteSite[k] = bySiteSite[k] || []).push(row);
  }
  for (const rows of Object.values(bySiteSite)) {
    const best = pickBest(rows);
    const codeA = codeById[best.site_a];
    const codeB = codeById[best.site_b];
    if (!codeA || !codeB) continue;
    matrix[codeA + '|' + codeB] = {
      distanceMi: Number(best.distance_mi),
      durationMin: best.duration_min != null ? Number(best.duration_min) : null,
      type: best.mode,
    };
  }

  // TRANSITIONAL FALLBACK: a state with nothing in either Supabase table
  // yet (not migrated -- see mcp-server.js's migrate_distance_matrix tool)
  // falls back to the legacy Blob wholesale, exactly as this function used
  // to work, rather than silently running the whole request on zero real
  // distance data. Safe to delete once every active state is confirmed
  // migrated (same note get-distance-matrix.js's header makes about its
  // own copy of this fallback).
  if (!Object.keys(matrix).length) {
    try {
      const store = getStore('dispatch');
      const blob = await store.get('distance-matrix/' + state, { type: 'json' });
      if (blob && blob.matrix) Object.assign(matrix, blob.matrix);
    } catch (err) {
      console.error('[dispatch-ai] legacy Blob fallback also unavailable:', err.message);
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

  // A dedicated button (no typing/dictation) can ask for a specific tool
  // directly rather than going through NL parsing -- deterministic and
  // faster, since there's nothing ambiguous to resolve. Only advisory,
  // read-only tools are forceable this way; a write action (reassign_stop,
  // sort_route) always has to come from an actual instruction, never a
  // one-tap button, since it changes the board.
  // apply_swap is deliberately NOT in functionDeclarations() -- it's never
  // reachable via typed/spoken text, only via the Apply/Revert buttons on a
  // propose_route_rebalance result, which already know exactly which site
  // and technician they mean. Resolved by site code rather than roster
  // indices so a click can't go stale if the board shifted slightly
  // between the analysis running and the button being pressed.
  const FORCEABLE_TOOLS = new Set(['propose_route_rebalance', 'apply_swap']);
  const forceTool = FORCEABLE_TOOLS.has(payload.forceTool) ? String(payload.forceTool) : null;
  const forceToolArgs = (forceTool && payload.forceToolArgs && typeof payload.forceToolArgs === 'object') ? payload.forceToolArgs : {};

  const text = String(payload.text || '').trim();
  if (!forceTool) {
    if (!text) return json(400, { ok: false, error: 'No command text provided' });
    if (text.length > 1000) return json(400, { ok: false, error: 'Command text too long' });
  }

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
  // 2026-09-19: trim tech name -- see route-optimizer.mjs's techMatrixKey
  // fix note. This is the payload's own point of entry, so trimming here
  // (in addition to techMatrixKey's own trim) means `techs[name]` /
  // `techIdByName[name]` lookups in loadContext, which key off this exact
  // string rather than the slug, stay consistent too.
  const routes = (Array.isArray(payload.routes) ? payload.routes : [])
    .filter((r) => r && r.tech)
    .map((r) => ({
      tech: String(r.tech).trim(),
      stops: (Array.isArray(r.stops) ? r.stops : []).map((c) => String(c).trim()),
      color: r.color ? String(r.color) : null,
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
    (Array.isArray(payload.unavailableTechs) ? payload.unavailableTechs : []).map((t) => String(t).trim())
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

    let calls;
    if (forceTool) {
      calls = [{ name: forceTool, args: forceToolArgs }];
    } else {
      const ai = new GoogleGenAI({});
      const response = await generateContentWithRetry(ai, {
        model: MODEL,
        contents: text,
        config: {
          temperature: 0,
          systemInstruction: systemInstruction(buildRoster(routes, ctx.siteNames), state, dispatchDate, unavailableTechs),
          tools: [{ functionDeclarations: functionDeclarations() }],
          toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
        },
      });
      calls = response.functionCalls || [];
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

      if (call.name === 'apply_swap') {
        const toTechName = String(args.toTech || '');
        const code = String(args.siteCode || '').toUpperCase();
        const toRoute = working.find((r) => r.tech === toTechName);
        const fromRoute = working.find((r) => r.stops.includes(code));

        if (!toRoute) {
          actions.push({ type: 'error', summary: `${toTechName || '(unnamed)'} is not on the current board.` });
          continue;
        }
        if (!fromRoute) {
          actions.push({ type: 'error', summary: `Could not find ${code} on any current route -- the board may have changed since this suggestion was made.` });
          continue;
        }
        if (fromRoute.tech === toRoute.tech) {
          actions.push({ type: 'error', summary: `${shortName(toRoute.tech)} already has ${code}.` });
          continue;
        }
        if (unavailableTechs.has(toRoute.tech)) {
          actions.push({ type: 'error', summary: `${shortName(toRoute.tech)} is marked unavailable on ${dispatchDate} -- pick someone else.` });
          continue;
        }

        const fromBefore = routeMetrics(legInfo, fromRoute.tech, fromRoute.stops);
        const toBefore = routeMetrics(legInfo, toRoute.tech, toRoute.stops);
        fromRoute.stops.splice(fromRoute.stops.indexOf(code), 1);
        toRoute.stops = insertStopAtBestPosition(legInfo, toRoute.tech, toRoute.stops, code, ctx.sites);
        movedCodes.add(code);
        changedTechs.add(fromRoute.tech);
        changedTechs.add(toRoute.tech);

        actions.push({
          type: 'apply_swap',
          summary: `Moved ${code} to ${shortName(toRoute.tech)}`,
          siteCode: code,
          siteName: ctx.siteNames[code] || null,
          fromTech: fromRoute.tech,
          toTech: toRoute.tech,
          fromDelta: deltaText(fromBefore, routeMetrics(legInfo, fromRoute.tech, fromRoute.stops)),
          toDelta: deltaText(toBefore, routeMetrics(legInfo, toRoute.tech, toRoute.stops)),
        });
        continue;
      }

      if (call.name === 'propose_route_rebalance') {
        const maxSuggestions = Number.isInteger(args.maxSuggestions) && args.maxSuggestions > 0
          ? Math.min(args.maxSuggestions, 15)
          : 5;
        const lockedCodes = new Set(
          (Array.isArray(payload.lockedCodes) ? payload.lockedCodes : []).map((c) => String(c))
        );
        const fromTechSet = techSetFromIndexes(args.fromTechIndexes, working);
        const toTechSet = techSetFromIndexes(args.toTechIndexes, working);
        const rebalance = proposeRebalance(
          working, legInfo, ctx.sites, lockedCodes, unavailableTechs,
          MIN_REBALANCE_SAVINGS_MI, maxSuggestions, fromTechSet, toTechSet,
        );

        if (!rebalance.length) {
          actions.push({
            type: 'propose_route_rebalance',
            summary: 'No worthwhile rebalancing found -- the board already looks efficient.',
            suggestions: [],
          });
        } else {
          const lines = rebalance.map((s) => {
            const base = `${s.code}${ctx.siteNames[s.code] ? ' (' + ctx.siteNames[s.code] + ')' : ''}: ${shortName(s.fromTech)} → ${shortName(s.toTech)}, net ${signed(-s.net, 'mi', 1)}`;
            return s.workloadCredit > 0
              ? `${base} (also balances load: ${shortName(s.fromTech)} ${s.stopsFromBefore}→${s.stopsFromAfter}, ${shortName(s.toTech)} ${s.stopsToBefore}→${s.stopsToAfter})`
              : base;
          });
          actions.push({
            type: 'propose_route_rebalance',
            summary: `Found ${rebalance.length} worthwhile swap${rebalance.length === 1 ? '' : 's'}: ` + lines.join(' · '),
            suggestions: rebalance.map((s) => ({
              siteCode: s.code,
              siteName: ctx.siteNames[s.code] || null,
              fromTech: s.fromTech,
              toTech: s.toTech,
              savingsMi: Math.round(s.savings * 10) / 10,
              costMi: Math.round(s.cost * 10) / 10,
              netMi: Math.round(s.net * 10) / 10,
              workloadMotivated: s.workloadCredit > 0,
              stopsFromBefore: s.stopsFromBefore,
              stopsFromAfter: s.stopsFromAfter,
              stopsToBefore: s.stopsToBefore,
              stopsToAfter: s.stopsToAfter,
            })),
          });
        }
        // Advisory only -- never touches `working`/changedTechs/persistence,
        // same as the other three advisory tools. The dispatcher applies a
        // suggestion by naming it back (e.g. "do the GA1038 one"), which
        // resolves as an ordinary reassign_stop call on the NEXT request.
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
