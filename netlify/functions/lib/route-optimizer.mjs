/**
 * route-optimizer.mjs — re-added 2026-09-13 for the fresh dispatch-ai.mjs
 * rebuild (ported unchanged from the old, unmerged embedded-AI PR branch --
 * this file is schema-agnostic, so nothing here needed to change).
 *
 * Server-side port of the stop-ordering and leg-distance logic that now
 * exists in TWO other places in this app, both of which need to stay in
 * sync with this one if the algorithm ever changes:
 *   - index.html's tech cards (getCachedLegInfo / sortStopsByDistance /
 *     getTechDistance / haversineDistance)
 *   - state.html's map (stateMapLegInfo / sortStateMapStops, added
 *     2026-09-13 for the state-console redesign)
 * The AI Dispatch Assistant needs the same numbers those two already show,
 * computed server-side where the dispatcher's browser state isn't
 * available, so the algorithm lives here rather than being re-invented a
 * fourth time:
 *
 *   - Same two passes: nearest-neighbor for an initial route, then 2-opt
 *     segment reversal, with the same 0.05 mi improvement threshold and
 *     200-iteration guard as the other two copies.
 *   - Same distance sourcing preference: the pre-computed driving matrix
 *     first, straight-line haversine only as a fallback.
 *   - Same convention that stops with no coordinates keep their relative
 *     order at the end of the route instead of being dropped or guessed at.
 *
 * IMPORTANT: no external mapping API is ever called from here. Every
 * distance/duration comes from the locally pre-computed matrix blob
 * (distance-matrix/{STATE}, built once per state by
 * compute-distance-matrix.js + compute-site-distance-matrix.js) or from
 * haversine over stored lat/lng.
 *
 * Matrix key conventions (unchanged, set by the two compute- functions):
 *   tech -> site : "{tech-name-lowercased-hyphenated}|{SITECODE}"
 *   site -> site : "{SITECODE_A}|{SITECODE_B}", either ordering
 * Entry shape   : { distanceMi, durationMin?, durationText?, type }
 */

const EARTH_RADIUS_MI = 3958.8;

/** Same formula and radius as the other two copies' haversineDistance. */
export function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MI * 2 * Math.asin(Math.sqrt(a));
}

/** index.html/state.html derive a tech's matrix key from the display name this way. */
export function techMatrixKey(techName) {
  return String(techName || "").toLowerCase().replace(/\s+/g, "-");
}

/**
 * Builds the leg-distance resolver used by every metric below.
 *
 * matrix — the `matrix` object out of the distance-matrix/{STATE} blob (may
 *          be null/empty; everything then falls back to haversine).
 * techs  — { [techName]: { lat, lng } }
 * sites  — { [siteCode]: { lat, lng } }
 *
 * The returned function takes (techName, fromCode, toCode) where a null
 * fromCode means "from the technician's home base", and returns
 * { distanceMi, durationMin, isReal } — durationMin is null whenever only
 * straight-line distance was available, exactly like the other two copies.
 */
export function createLegResolver(matrix, techs, sites) {
  const m = matrix || {};

  return function legInfo(techName, fromCode, toCode) {
    if (fromCode === null || fromCode === undefined) {
      const entry = m[techMatrixKey(techName) + "|" + toCode];
      if (entry && entry.distanceMi != null) {
        return {
          distanceMi: entry.distanceMi,
          durationMin: entry.durationMin != null ? entry.durationMin : null,
          isReal: entry.type === "driving",
        };
      }
      const tech = techs[techName];
      const dest = sites[toCode];
      if (tech && dest && tech.lat != null && tech.lng != null && dest.lat != null && dest.lng != null) {
        return {
          distanceMi: haversineDistance(tech.lat, tech.lng, dest.lat, dest.lng),
          durationMin: null,
          isReal: false,
        };
      }
      return { distanceMi: 0, durationMin: null, isReal: false };
    }

    const entry = m[fromCode + "|" + toCode] || m[toCode + "|" + fromCode];
    if (entry && entry.distanceMi != null) {
      return {
        distanceMi: entry.distanceMi,
        durationMin: entry.durationMin != null ? entry.durationMin : null,
        isReal: entry.type === "driving",
      };
    }
    const a = sites[fromCode];
    const b = sites[toCode];
    if (a && b && a.lat != null && a.lng != null && b.lat != null && b.lng != null) {
      return {
        distanceMi: haversineDistance(a.lat, a.lng, b.lat, b.lng),
        durationMin: null,
        isReal: false,
      };
    }
    return { distanceMi: 0, durationMin: null, isReal: false };
  };
}

/** True when we have coordinates good enough to include a stop in sorting. */
function hasCoords(sites, code) {
  const s = sites[code];
  return !!(s && s.lat != null && s.lng != null);
}

/**
 * Total distance (and duration, when every leg had real driving data) for one
 * technician's route, home -> stop 1 -> stop 2 -> ...
 *
 * durationMin is null unless every leg resolved a duration, so the assistant
 * never quotes a time delta that silently mixes real drive times with legs
 * that had none.
 */
export function routeMetrics(legInfo, techName, codes) {
  if (!codes || codes.length === 0) {
    return { distanceMi: 0, durationMin: 0, allReal: true };
  }
  let distanceMi = 0;
  let durationMin = 0;
  let allReal = true;
  let prev = null;
  for (const code of codes) {
    const leg = legInfo(techName, prev, code);
    distanceMi += leg.distanceMi || 0;
    if (leg.durationMin == null) allReal = false;
    else durationMin += leg.durationMin;
    prev = code;
  }
  // 2026-09-17: previously stopped at the last stop -- the trip back home
  // at the end of the day was never counted anywhere in this app (the two
  // client-side copies of this same gap were just fixed the same way).
  // Since this function backs nearly everything -- fleet totals, per-swap
  // savings, stop-addition cost, overtime risk, and (via optimizeRoute
  // below) the ordering decision itself -- fixing it here is what actually
  // makes the "Total mileage saved" figures, tech-card totals, and swap
  // deltas reflect a technician's real round-trip day, not just the
  // outbound leg. legInfo(tech, lastCode, null) reuses the same
  // tech<->site distance as the outbound home leg, since the matrix only
  // stores that pair once -- a fair approximation of the return drive.
  const returnLeg = legInfo(techName, null, codes[codes.length - 1]);
  distanceMi += returnLeg.distanceMi || 0;
  if (returnLeg.durationMin == null) allReal = false;
  else durationMin += returnLeg.durationMin;
  return {
    distanceMi,
    durationMin: allReal ? durationMin : null,
    allReal,
  };
}

/** Fleet-wide distance/duration across every technician's route. */
export function fleetMetrics(legInfo, routes) {
  let distanceMi = 0;
  let durationMin = 0;
  let allReal = true;
  for (const r of routes) {
    const m = routeMetrics(legInfo, r.tech, r.stops);
    distanceMi += m.distanceMi;
    if (m.durationMin == null) allReal = false;
    else durationMin += m.durationMin;
  }
  return { distanceMi, durationMin: allReal ? durationMin : null, allReal };
}

/**
 * Nearest-neighbor + 2-opt, the same two passes as the other two copies'
 * sort logic. Takes and returns an array of site codes; stops without
 * coordinates are appended in their original relative order.
 */
export function optimizeRoute(legInfo, techName, codes, sites) {
  const withCoords = codes.filter((c) => hasCoords(sites, c));
  const withoutCoords = codes.filter((c) => !hasCoords(sites, c));
  if (withCoords.length <= 1) return codes.slice();

  const legDist = (from, to) => legInfo(techName, from, to).distanceMi;
  // Same return-trip-home fix as routeMetrics above, applied here too since
  // this is a SEPARATE local implementation used only for the 2-opt
  // decision itself (matches the two client-side copies of this same
  // duplication).
  const routeDist = (route) => {
    let total = legDist(null, route[0]);
    for (let i = 0; i < route.length - 1; i++) total += legDist(route[i], route[i + 1]);
    total += legDist(null, route[route.length - 1]); // trip back home
    return total;
  };

  // Pass 1: nearest-neighbor
  const remaining = withCoords.slice();
  const nnRoute = [];
  let prev = null;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = legDist(prev, remaining[i]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    nnRoute.push(next);
    prev = next;
  }

  // Pass 2: 2-opt refinement
  let route = nnRoute;
  let bestDist = routeDist(route);
  let improved = true;
  let guard = 0;
  while (improved && guard < 200) {
    improved = false;
    guard++;
    for (let i = 0; i < route.length - 1 && !improved; i++) {
      for (let k = i + 1; k < route.length; k++) {
        const candidate = route.slice(0, i)
          .concat(route.slice(i, k + 1).reverse())
          .concat(route.slice(k + 1));
        const candidateDist = routeDist(candidate);
        if (candidateDist < bestDist - 0.05) {
          route = candidate;
          bestDist = candidateDist;
          improved = true;
          break;
        }
      }
    }
  }

  return route.concat(withoutCoords);
}

/**
 * Chooses the best insertion point for one stop in an existing route rather
 * than always dropping it at the front. Used by reassign_stop so a moved
 * stop lands in route order the way a manual reassign + re-sort pair ends
 * up leaving it, without disturbing the rest of the sequence.
 */
export function insertStopAtBestPosition(legInfo, techName, codes, newCode, sites) {
  if (!hasCoords(sites, newCode) || codes.length === 0) {
    return codes.concat([newCode]);
  }
  let bestRoute = null;
  let bestDist = Infinity;
  for (let i = 0; i <= codes.length; i++) {
    const candidate = codes.slice(0, i).concat([newCode], codes.slice(i));
    const d = routeMetrics(legInfo, techName, candidate).distanceMi;
    if (d < bestDist) { bestDist = d; bestRoute = candidate; }
  }
  return bestRoute;
}
