/**
 * compute-site-distance-matrix.js
 * Admin-triggered, one state at a time (Mark: starting with GA since it's
 * the state he can personally verify against manual routing experience).
 *
 * Builds real driving distance + duration between every pair of sites in a
 * state via the Google Maps Distance Matrix API, and merges the result into
 * the SAME Blobs key the existing tech-to-site matrix already uses
 * (distance-matrix/{STATE}) -- this is additive, not a replacement. Running
 * this never touches the technician|location entries already in that blob;
 * it only adds/updates location|location entries alongside them.
 *
 * CHUNKED / RESUMABLE: a full state (GA: ~106 API calls) takes far longer
 * than Netlify's function execution limit (10-26s depending on plan) --
 * running it as one long call would get killed mid-flight with no result,
 * which is exactly what happened on the first version of this function
 * 2026-07-25. Each invocation now processes only ORIGIN_BATCHES_PER_CALL
 * origin-batches (a few seconds of work) starting from `offset`, then
 * returns { done: false, nextOffset } for the caller to request next, or
 * { done: true } once every origin batch has been processed. admin.html
 * drives this loop client-side and shows progress between calls.
 *
 * Reads site coordinates from Supabase (sites table, lat/lng columns) --
 * v2 (2026-07-28): migrated from the old Blobs "locations/{STATE}" store,
 * which was left behind when get-locations.js/get-technicians.js moved to
 * Supabase-primary reads earlier this week. geocode-addresses.js was
 * migrated the same day so both stay consistent. Output (the computed
 * distance matrix itself) is unchanged -- still cached in Blobs under
 * distance-matrix/{STATE}, since that's what index.html and the
 * tech-to-site matrix already read from there.
 *
 * Cost: scales with (site count)^2, not tech count -- calibrated 2026-07-25
 * against the existing tech-to-site matrix's own quoted "~$3-6/state" price
 * for GA (8 techs x 121 sites = 968 elements). Full site-to-site coverage
 * for GA (121 sites, ~7,320 unique pairs after dedup) comes out to roughly
 * $23-45 one-time. This is a ONE-TIME build per state, not a recurring
 * cost -- site locations don't move, so it only needs re-running if new
 * sites are added to that state later.
 *
 * Only unique unordered pairs are computed (A->B reused as B->A) rather than
 * the full N^2 -- driving distance/duration is treated as symmetric, which
 * holds except for rare one-way-street edge cases not worth doubling the
 * cost to cover.
 *
 * POST /.netlify/functions/compute-site-distance-matrix
 * Body: { state: "GA", offset: 0 }  -- offset defaults to 0 (start of a
 * fresh build); pass back nextOffset from the previous response to resume.
 *
 * Requires env var: GOOGLE_MAPS_API_KEY
 *
 * New matrix entry key format: "{siteCodeA}|{siteCodeB}" (alphabetical
 * order not enforced -- lookups should check both orderings, same as the
 * existing tech-to-site convention).
 */

const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");

const MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";
const ORIGIN_BATCH = 8;   // origins per call
const DEST_BATCH = 10;    // destinations per call -- 8x10 = 80 elements/call, under the 100-element cap
const ORIGIN_BATCHES_PER_CALL = 2; // how many origin-batches to process per invocation, kept small to stay well under any function timeout
const R_MI = 3958.8;

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R_MI * 2 * Math.asin(Math.sqrt(a));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

exports.handler = async (event) => {
  connectLambda(event);

  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const state = String(payload.state || "").trim().toUpperCase();
  if (!state || !/^[A-Z]{2}$/.test(state)) return json(400, { error: "Valid 2-letter state required" });
  const offset = Number.isInteger(payload.offset) ? payload.offset : 0;

  // Real spend gate (2026-08-18) -- this function previously had NO auth
  // check of any kind; the only thing stopping an unauthenticated call was
  // admin.html's own browser confirm() dialog, which guards the button, not
  // the endpoint. A full state build costs real money (~$23-45 for a state
  // GA's size, scaling with site-count^2), so this needs its own secret
  // independent of the regular admin login/role system -- deliberately NOT
  // reusing DISTANCE_MATRIX_ADMIN_PASSWORD is left unset in an environment
  // by mistake, this fails closed (blocks the call) rather than open.
  const requiredSecret = process.env.DISTANCE_MATRIX_ADMIN_PASSWORD;
  if (!requiredSecret) {
    return json(500, { error: "DISTANCE_MATRIX_ADMIN_PASSWORD is not configured -- refusing to run a paid build until it is set." });
  }
  if (String(payload.adminSecret || "") !== requiredSecret) {
    return json(401, { error: "Incorrect or missing admin secret for this paid operation." });
  }

  // Cooldown (2026-08-18) -- these are one-time-per-state builds in normal
  // use (Mark: "they obviously don't need to be run very often"), so a
  // short-window abuse pattern (someone scripting repeat calls, or a stray
  // client-side loop) is easy to tell apart from legitimate use just by
  // spacing. Only checked when STARTING a fresh build (offset===0) -- a
  // resume call (offset>0) is continuing a build that already passed this
  // gate, not a new one, so it's allowed through regardless of cooldown.
  const COOLDOWN_HOURS = 24;
  if (offset === 0) {
    const cooldownKey = "distance-matrix-cooldown/site-site/" + state;
    const store2 = getStore("dispatch");
    const lastRun = await store2.get(cooldownKey, { type: "text" });
    if (lastRun) {
      const hoursSince = (Date.now() - new Date(lastRun).getTime()) / 36e5;
      if (hoursSince < COOLDOWN_HOURS) {
        return json(429, {
          error: `A site-to-site build for ${state} already ran ${hoursSince.toFixed(1)}h ago -- please wait ${(COOLDOWN_HOURS - hoursSince).toFixed(1)}h before running it again. (Cooldown exists to prevent repeated accidental/malicious spend; site locations don't change often enough to need frequent rebuilds.)`,
        });
      }
    }
    await store2.set(cooldownKey, new Date().toISOString());
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return json(500, { error: "GOOGLE_MAPS_API_KEY env var not set" });

  const store = getStore("dispatch");
  const existing = await store.get("distance-matrix/" + state, { type: "json" });

  // Orphaned-build guard (2026-08-18, found via a real ~$122 overspend
  // investigation with Gemini) -- the client always starts a fresh build at
  // offset:0, with no memory of whether a PREVIOUS build for this state got
  // interrupted (tab closed, phone locked, connection dropped) partway
  // through. Its partial progress is real and already paid for
  // (meta.siteToSite.partialMatrix, saved every chunk -- see below), but
  // nothing was stopping a fresh offset:0 call from silently ignoring it and
  // re-fetching (re-billing) every pair the abandoned attempt already
  // covered. Now: a fresh-start request (offset:0, no force flag) against a
  // state with real in-progress leftovers is refused, telling the caller
  // exactly where to resume from instead. Pass force:true to deliberately
  // discard old progress and start clean (e.g. after the site list changed).
  if (offset === 0 && !payload.force && existing && existing.meta && existing.meta.siteToSite && existing.meta.siteToSite.inProgress) {
    const sf = existing.meta.siteToSite;
    return json(409, {
      error: `An interrupted ${state} build already has ${sf.elementsUsed || 0} billed elements saved (from a previous session that didn't finish). Resume it with offset:${sf.lastOffset || 0} to avoid re-billing that work, or pass force:true to discard it and start completely over.`,
      resumeOffset: sf.lastOffset || 0,
      priorElementsUsed: sf.elementsUsed || 0,
    });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: sites, error: sitesErr } = await supabase
    .from("sites")
    .select("site_code, lat, lng")
    .eq("state", state);
  if (sitesErr) return json(500, { error: "sites fetch failed: " + sitesErr.message });

  const locEntries = (sites || [])
    .filter((s) => s.lat != null && s.lng != null)
    .map((s) => [s.site_code, { lat: s.lat, lng: s.lng }]);

  if (locEntries.length < 2) {
    return json(400, {
      error: "Need at least 2 geocoded locations for " + state + ". Run geocode-addresses first.",
    });
  }

  const existingMatrix = (existing && existing.matrix) || {};
  // Resume any in-progress build's partial results (stored under meta.siteToSite.partialMatrix
  // between calls) rather than starting the merge over from scratch each chunk.
  const priorPartial = (offset > 0 && existing && existing.meta && existing.meta.siteToSite && existing.meta.siteToSite.partialMatrix) || {};
  const matrix = { ...priorPartial };
  const priorFailed = (offset > 0 && existing && existing.meta && existing.meta.siteToSite && existing.meta.siteToSite.failedPairs) || [];
  const failedPairs = [...priorFailed];
  let elementsUsed = (offset > 0 && existing && existing.meta && existing.meta.siteToSite && existing.meta.siteToSite.elementsUsed) || 0;

  const originStarts = [];
  for (let oStart = 0; oStart < locEntries.length; oStart += ORIGIN_BATCH) originStarts.push(oStart);

  const chunkStarts = originStarts.slice(offset, offset + ORIGIN_BATCHES_PER_CALL);

  for (const oStart of chunkStarts) {
    const originBatch = locEntries.slice(oStart, oStart + ORIGIN_BATCH);
    const destRange = locEntries.slice(oStart);
    const origins = originBatch.map(([, l]) => `${l.lat},${l.lng}`).join("|");

    for (let dStart = 0; dStart < destRange.length; dStart += DEST_BATCH) {
      const destBatch = destRange.slice(dStart, dStart + DEST_BATCH);
      const destinations = destBatch.map(([, l]) => `${l.lat},${l.lng}`).join("|");

      const url = MATRIX_URL +
        "?origins=" + encodeURIComponent(origins) +
        "&destinations=" + encodeURIComponent(destinations) +
        "&units=imperial&key=" + apiKey;

      try {
        const res = await fetch(url);
        const data = await res.json();

        if (data.status !== "OK") {
          failedPairs.push({ oStart, dStart, reason: "API status: " + data.status });
          continue;
        }

        data.rows.forEach((row, oi) => {
          const [originCode] = originBatch[oi];
          row.elements.forEach((el, di) => {
            const [destCode, destLoc] = destBatch[di];
            if (originCode === destCode) return; // skip self-pairs
            elementsUsed++;
            const key = `${originCode}|${destCode}`;
            if (el.status === "OK") {
              matrix[key] = {
                distanceMi: Math.round((el.distance.value / 1609.34) * 10) / 10,
                durationMin: Math.round(el.duration.value / 60),
                distanceText: el.distance.text,
                durationText: el.duration.text,
                type: "driving",
              };
            } else {
              failedPairs.push({ originCode, destCode, reason: "Element status: " + el.status });
              const [, originLoc] = originBatch[oi];
              const mi = haversineDistance(originLoc.lat, originLoc.lng, destLoc.lat, destLoc.lng);
              matrix[key] = { distanceMi: Math.round(mi * 10) / 10, type: "haversine-fallback" };
            }
          });
        });
      } catch (err) {
        failedPairs.push({ oStart, dStart, reason: "Network error: " + err.message });
      }

      await sleep(120);
    }
  }

  const nextOffset = offset + chunkStarts.length;
  const done = nextOffset >= originStarts.length;

  if (done) {
    // Final chunk: merge into the real matrix, drop the partial-progress scratch data.
    const mergedMatrix = { ...existingMatrix, ...matrix };
    const mergedMeta = {
      ...((existing && existing.meta) || {}),
      state,
      siteToSite: {
        computedAt: new Date().toISOString(),
        siteCount: locEntries.length,
        elementsUsed,
        failedPairs,
      },
    };
    await store.setJSON("distance-matrix/" + state, { meta: mergedMeta, matrix: mergedMatrix });
    return json(200, {
      ok: true,
      done: true,
      state,
      siteCount: locEntries.length,
      elementsUsed,
      newEntryCount: Object.keys(matrix).length,
      totalEntryCount: Object.keys(mergedMatrix).length,
      failedCount: failedPairs.length,
    });
  }

  // Not done: persist progress (including partial site-to-site results) so
  // the next call can resume, without touching the real merged matrix yet.
  const mergedMeta = {
    ...((existing && existing.meta) || {}),
    state,
    siteToSite: {
      inProgress: true,
      siteCount: locEntries.length,
      elementsUsed,
      failedPairs,
      partialMatrix: matrix,
      lastOffset: nextOffset,
    },
  };
  await store.setJSON("distance-matrix/" + state, { meta: mergedMeta, matrix: existingMatrix });

  return json(200, {
    ok: true,
    done: false,
    nextOffset,
    totalBatches: originStarts.length,
    elementsUsed,
  });
};
