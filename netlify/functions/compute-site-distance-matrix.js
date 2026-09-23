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
 *
 * v3 (2026-09-23): FIXED a real duplicate-billing bug found by Mark. Since
 * 2026-09-23's auto-migrate-to-Supabase addition, a completed build's real
 * results live in TWO places: the Blobs cache here (distance-matrix/{STATE})
 * AND site_site_distances in Supabase. But the incremental "known vs new"
 * check below (knownCodes/pKnownCodes) only ever looked at the Blobs
 * matrix -- it had no idea Supabase might already hold pairs the Blobs
 * cache doesn't (e.g. an older build, a Blobs cache that got cleared/reset,
 * or data that only ever entered Supabase through the migration path).
 * Confirmed live: FL had 4,090 real pairs already in Supabase, but a
 * dry-run still reported "127 sites, 127 new" -- a full, ~$42 rebuild of
 * data that mostly already existed, because Blobs' own copy of the FL
 * matrix didn't have those keys. Fixed by also querying
 * site_site_distances for this state's site codes and merging any site
 * that appears in EITHER source into knownCodes -- so a site already
 * covered in Supabase (even if Blobs never knew about it) is correctly
 * treated as known, not new. Applied identically to the dry-run preview
 * and the real build so the estimate and the actual spend always agree.
 *
 * v4 (2026-09-23): FIXED a real coverage bug found live on the CA build --
 * the Supabase `sites` query below had no explicit sort order. Postgres
 * does NOT guarantee a stable row order without one; a state that finishes
 * in a single call never noticed, but CA's build got interrupted and
 * resumed multiple times (network drops), and each resumed call can fetch
 * the 290 sites back in a DIFFERENT order than the previous call. Since
 * the origin/destination batching below assumes a stable site ordering
 * across chunks (each chunk's `offset` refers to a position in that
 * ordering), a reshuffled order between chunks silently produces gaps --
 * confirmed live: every one of CA's 290 sites got touched at least once,
 * but only 22,105 of the possible 41,905 unique pairs (about 53%) actually
 * got computed. Fixed by adding an explicit `.order("site_code")` to the
 * sites query, so the ordering is identical and deterministic across every
 * chunk of a build, resumed or not.
 */

const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");
const { getMonthlyElementsUsed, addMonthlyElementsUsed, estimateCost } = require("./distance-matrix-usage.js");

const MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";
const ORIGIN_BATCH = 8;   // origins per call
const DEST_BATCH = 10;    // destinations per call -- 8x10 = 80 elements/call, under the 100-element cap
// CA (~290 sites) timed out on chunk 0 when this was 2 (2026-09-21).
// One origin-batch per invocation stays under Netlify's limit; admin.html still loops.
const ORIGIN_BATCHES_PER_CALL = 1;
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

// Sites whose lat/lng were corrected after pairs were already written.
// refreshMovedPins drops every blob key touching these codes so additive
// treats them as new (~6×N elements) instead of a full-state rebuild.
const MOVED_PINS = {
  FL: ["FL1001", "FL1004", "FL1005", "FL1006", "FL1020", "FL1021", "FL1039", "FL1130"],
};

function stripRefreshCodes(matrix, codes) {
  if (!matrix || !codes || !codes.length) return matrix || {};
  const set = new Set(codes.map((c) => String(c).toUpperCase()));
  const out = {};
  for (const [k, v] of Object.entries(matrix)) {
    const [a, b] = k.split("|");
    if (set.has(a) || set.has(b)) continue;
    out[k] = v;
  }
  return out;
}

// v3 (2026-09-23): pulls the set of site codes for this state that already
// have at least one real pair recorded in Supabase's site_site_distances --
// the authoritative store now that builds auto-migrate there. Used to
// supplement (never replace) the Blobs-derived knownCodes set, so a site
// already covered in Supabase is never re-billed just because the Blobs
// cache doesn't happen to know about it. refreshCodes (moved-pin site
// codes) are excluded here too, mirroring stripRefreshCodes' treatment of
// the Blobs matrix -- a site whose pin moved should still be treated as
// needing fresh pairs even if Supabase has stale ones on file for it.
async function getSupabaseKnownCodes(supabase, state, siteIdByCode, refreshCodes) {
  const codeById = Object.fromEntries(Object.entries(siteIdByCode).map(([code, id]) => [id, code]));
  const ids = Object.values(siteIdByCode);
  if (!ids.length) return new Set();

  const refreshSet = new Set((refreshCodes || []).map((c) => String(c).toUpperCase()));
  const known = new Set();

  // site_a/site_b are both FKs into sites.id -- a state's own sites can be
  // paired with sites in another state's list is not expected in practice
  // (site-to-site builds are per-state), but querying by id on both sides
  // covers it correctly either way without assuming same-state pairing.
  //
  // v4 (2026-09-23) BUG FIX: this was a single unpaginated query -- Supabase
  // caps a single response at 1000 rows by default. Never bit FL (only 4,090
  // pairs spread evenly across 127 sites meant even a truncated 1000-row
  // page still touched nearly every site at least once), but the same
  // pattern in the new backfill-site-distance-gaps.js DID produce a real
  // wrong cost estimate on CA (22,105 pairs -> most rows silently dropped),
  // so this is fixed here too before it causes a similar miss on a future
  // larger state. Pages through with .range() until a page comes back
  // shorter than PAGE_SIZE.
  const PAGE_SIZE = 1000;
  let page = 0;
  for (;;) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data: rows, error } = await supabase
      .from("site_site_distances")
      .select("site_a, site_b")
      .or(`site_a.in.(${ids.join(",")}),site_b.in.(${ids.join(",")})`)
      .range(from, to);

    if (error) {
      // Best-effort supplement -- if this query fails for any reason, fall
      // back to whatever's already in `known` rather than blocking the
      // whole preview or build. Logged so a real, recurring failure here
      // doesn't go unnoticed.
      console.error("[compute-site-distance-matrix] Supabase known-pairs lookup failed (continuing with partial/Blobs-only known set):", error.message);
      break;
    }

    for (const row of rows || []) {
      const codeA = codeById[row.site_a];
      const codeB = codeById[row.site_b];
      if (codeA && !refreshSet.has(codeA)) known.add(codeA);
      if (codeB && !refreshSet.has(codeB)) known.add(codeB);
    }

    if (!rows || rows.length < PAGE_SIZE) break;
    page++;
  }
  return known;
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
  const refreshCodes = Array.isArray(payload.refreshCodes) && payload.refreshCodes.length
    ? payload.refreshCodes.map((c) => String(c).toUpperCase())
    : (payload.refreshMovedPins ? (MOVED_PINS[state] || []) : []);

  // Dry-run cost preview (2026-09-07) -- Step 3 previously had NO real
  // preview at all, just a rough client-side estimate from a hardcoded
  // site-count table (admin.html's DM_SITE_COUNT_HINTS), which is how an
  // accidental Indiana build went through today instead of the intended
  // Georgia one with no real-time warning of what was about to be billed.
  // This mirrors Step 2's dry-run pattern: fully self-contained, runs
  // BEFORE the password gate/cooldown/orphaned-build guard below since
  // none of those protect anything a free preview could touch -- only
  // free Supabase + Blobs reads here, no Google API call, nothing written.
  // Element count is computed by walking the EXACT same origin/destination
  // batching grid the real build uses (including the same site-code-based
  // knownCodes/newSites split), so this is an exact total for the whole
  // build, not an approximation -- matches what elementsUsed will sum to
  // once every chunk of a real run completes.
  if (payload.dryRun === true) {
    const dryStore = getStore("dispatch");
    const dryExisting = await dryStore.get("distance-matrix/" + state, { type: "json" });
    const dryExistingMatrix = stripRefreshCodes((dryExisting && dryExisting.matrix) || {}, refreshCodes);

    const supabasePreview = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: pSites, error: pSitesErr } = await supabasePreview
      .from("sites")
      .select("id, site_code, lat, lng")
      .eq("state", state)
      .eq("active", true) // BUG FIX (2026-09-07): soft-deleted sites (delete-location.js
      // sets active:false, never hard-deletes -- see that file's own comment on why)
      // were never excluded here, so a deleted site kept showing up in every future
      // build forever. Confirmed via direct query: sites.active is always true/false,
      // never null, so this filter is safe with no edge cases.
      .order("site_code", { ascending: true }); // v4 (2026-09-23): see top-of-file comment -- deterministic ordering across chunks
    if (pSitesErr) return json(500, { ok: false, error: "sites fetch failed: " + pSitesErr.message });

    const pLocEntries = (pSites || [])
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => [s.site_code, { lat: s.lat, lng: s.lng }]);
    const pSiteIdByCode = Object.fromEntries((pSites || []).map((s) => [s.site_code, s.id]));

    // 2026-09-23: was "^" + state + "\\d+$" -- see the matching fix and
    // comment on the real-build siteCodePattern further down in this file
    // for the full reasoning. Testing stations (T-codes) and OTC sites
    // (C-codes) are supposed to be part of this matrix too (confirmed),
    // so they need to be recognized here as well, or every incremental
    // preview after the first would keep reporting them as "new" forever
    // instead of "already known."
    const pSiteCodePattern = new RegExp("^" + state + "[A-Z]?\\d+$");
    const pKnownCodes = new Set();
    for (const key of Object.keys(dryExistingMatrix)) {
      const [a, b] = key.split("|");
      if (pSiteCodePattern.test(a) && pSiteCodePattern.test(b)) {
        pKnownCodes.add(a);
        pKnownCodes.add(b);
      }
    }
    // v3 (2026-09-23): supplement with Supabase's own record of already-computed
    // pairs, so a site the Blobs cache doesn't know about (but Supabase does,
    // via the auto-migration added last night) doesn't get billed again.
    const pSupabaseKnown = await getSupabaseKnownCodes(supabasePreview, state, pSiteIdByCode, refreshCodes);
    for (const code of pSupabaseKnown) pKnownCodes.add(code);

    const pFullRebuild = !!payload.fullRebuild || pKnownCodes.size === 0;
    const pNewSites = pFullRebuild ? pLocEntries : pLocEntries.filter(([code]) => !pKnownCodes.has(code));
    const pKnownSites = pFullRebuild ? [] : pLocEntries.filter(([code]) => pKnownCodes.has(code));
    const pOrdered = [...pNewSites, ...pKnownSites];

    const pOriginStarts = [];
    for (let oStart = 0; oStart < pNewSites.length; oStart += ORIGIN_BATCH) pOriginStarts.push(oStart);

    let elementCount = 0;
    for (const oStart of pOriginStarts) {
      const originBatch = pOrdered.slice(oStart, oStart + ORIGIN_BATCH);
      const destRange = pOrdered.slice(oStart);
      for (let dStart = 0; dStart < destRange.length; dStart += DEST_BATCH) {
        const destBatch = destRange.slice(dStart, dStart + DEST_BATCH);
        for (const [originCode] of originBatch) {
          for (const [destCode] of destBatch) {
            if (originCode !== destCode) elementCount++;
          }
        }
      }
    }

    const usedThisMonth = await getMonthlyElementsUsed(dryStore);
    const preview = estimateCost(elementCount, usedThisMonth);
    return json(200, {
      ok: true,
      state,
      siteCount: pLocEntries.length,
      newSiteCount: pNewSites.length,
      incremental: !pFullRebuild,
      elementCount,
      ...preview,
    });
  }

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

  // Brute-force lockout (2026-09-02) -- shared with compute-distance-matrix.js
  // via the same Blobs key, since both functions check the same password.
  // A few wrong guesses locks out ALL driving-mode builds (both functions)
  // for 24h, so guessing against this endpoint instead of the other one
  // doesn't dodge the limit. Only checked when STARTING a build (offset===0)
  // -- a resume call already passed this gate on its first request.
  const authStore = getStore("dispatch");
  const failKey = "distance-matrix-failed-attempts";
  const MAX_FAILED_ATTEMPTS = 5;
  const LOCKOUT_HOURS = 24;
  if (offset === 0) {
    const failData = (await authStore.get(failKey, { type: "json" })) || { count: 0, lockedUntil: null };

    if (failData.lockedUntil && Date.now() < new Date(failData.lockedUntil).getTime()) {
      const minsLeft = Math.ceil((new Date(failData.lockedUntil).getTime() - Date.now()) / 60000);
      return json(429, {
        error: `Too many incorrect admin-secret attempts -- locked out for ${minsLeft} more minute(s) (shared lockout across both distance-matrix build functions).`,
      });
    }

    if (String(payload.adminSecret || "") !== requiredSecret) {
      const newCount = (failData.count || 0) + 1;
      const update = { count: newCount, lockedUntil: null };
      let msg;
      if (newCount >= MAX_FAILED_ATTEMPTS) {
        update.lockedUntil = new Date(Date.now() + LOCKOUT_HOURS * 3600 * 1000).toISOString();
        update.count = 0;
        msg = `Incorrect admin secret. Too many failed attempts -- locked out for ${LOCKOUT_HOURS} hours.`;
      } else {
        msg = `Incorrect admin secret. ${MAX_FAILED_ATTEMPTS - newCount} attempt(s) remaining before a ${LOCKOUT_HOURS}-hour lockout.`;
      }
      await authStore.setJSON(failKey, update);
      return json(401, { error: msg });
    }

    if (failData.count) await authStore.setJSON(failKey, { count: 0, lockedUntil: null });
  } else {
    // Resume call (offset > 0) -- still must present the correct password
    // on every request (this function is stateless per-call), just skipped
    // the lockout bookkeeping above since it already passed on offset===0.
    if (String(payload.adminSecret || "") !== requiredSecret) {
      return json(401, { error: "Incorrect or missing admin secret for this paid operation." });
    }
  }

  // Cooldown (2026-08-18) -- these are one-time-per-state builds in normal
  // use (Mark: "they obviously don't need to be run very often"), so a
  // short-window abuse pattern (someone scripting repeat calls, or a stray
  // client-side loop) is easy to tell apart from legitimate use just by
  // spacing. Only checked when STARTING a fresh build (offset===0) -- a
  // resume call (offset>0) is continuing a build that already passed this
  // gate, not a new one, so it's allowed through regardless of cooldown.
  const COOLDOWN_HOURS = 24;
  if (offset === 0 && refreshCodes.length === 0) {
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
    // Cooldown is stamped AFTER the first chunk actually writes (see below).
    // Stamping here on offset===0 meant a Netlify HTML/timeout on chunk 0
    // locked the state for 24h and looked like a successful spend.
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
    .select("id, site_code, lat, lng")
    .eq("state", state)
    .eq("active", true) // BUG FIX (2026-09-07): see matching comment in the dryRun branch above
    .order("site_code", { ascending: true }); // v4 (2026-09-23): see top-of-file comment -- deterministic ordering across chunks
  if (sitesErr) return json(500, { error: "sites fetch failed: " + sitesErr.message });

  const locEntries = (sites || [])
    .filter((s) => s.lat != null && s.lng != null)
    .map((s) => [s.site_code, { lat: s.lat, lng: s.lng }]);

  // 2026-09-15: id lookup for the Supabase sync below -- kept separate from
  // locEntries (which several existing loops below iterate as [code, latlng]
  // pairs) rather than folding id into that shape, to avoid touching any of
  // that already-working logic.
  const siteIdByCode = Object.fromEntries((sites || []).map((s) => [s.site_code, s.id]));

  if (locEntries.length < 2) {
    return json(400, {
      error: "Need at least 2 geocoded locations for " + state + ". Run geocode-addresses first.",
    });
  }

  const existingMatrix = stripRefreshCodes((existing && existing.matrix) || {}, refreshCodes);

  // Incremental rebuild (2026-08-18, added after confirming a re-run
  // previously recomputed the ENTIRE state from scratch -- a real, recurring
  // cost given how often new kiosk installs get added to an already-built
  // state). A site counts as "already known" if it appears on either side
  // of any existing pair key; a site with zero such appearances is "new"
  // since the last completed build for this state. known x known pairs are
  // guaranteed already covered by that prior build, so they're skipped
  // entirely -- only new x new and new x known pairs get fetched. Reordering
  // so new sites come first lets the existing origin/destination-slice
  // batching logic below work unchanged; only the origin range being
  // iterated (newSites.length instead of locEntries.length) actually
  // changes for the incremental case.
  //
  // Falls back to a full rebuild automatically when there's no existing
  // matrix at all (first build for this state -- every site is "new") or
  // when the caller explicitly passes fullRebuild:true (e.g. site
  // coordinates changed and old pairs need refreshing, not just new ones
  // added).
  // BUG FIX (2026-09-07): this used to add BOTH sides of every existing
  // matrix key to knownCodes, but tech-to-site entries use the identical
  // "{key}|{key}" format (e.g. "robert-medley|GA1001") -- splitting those
  // put every site code already touched by the (separate, older)
  // tech-to-site matrix into knownCodes, even though zero site-to-site
  // pairs had ever actually been computed. Result: newSites came out
  // empty and the build silently no-op'd every time, reporting success
  // ("done: true, 0 pairs computed") without doing anything. Only count a
  // code as "known" when it appears in a genuine SITE-TO-SITE pair -- i.e.
  // both sides of the key match this state's site-code pattern (state
  // abbreviation + digits, e.g. "GA1001"), which no tech key ever does.
  // 2026-09-23: confirmed testing stations (T-codes, e.g. MIT051) and OTC
  // sites (C-codes, e.g. OHC003) are meant to be part of this matrix too
  // -- this pattern previously only matched a plain numeric code
  // ("^" + state + "\\d+$"), so those sites could never register as
  // "known" here even after a real build included them (they were always
  // correctly present in locEntries/newSites -- this pattern only feeds
  // the known-vs-new incremental split, so the effect was silent, not a
  // hard failure: every incremental run after the first would keep
  // treating every T/C-code site as brand new again, recomputing and
  // re-billing its pairs on every future incremental build instead of
  // skipping the ones already covered. The optional [A-Z]? covers both
  // namespaces with one change.
  const siteCodePattern = new RegExp("^" + state + "[A-Z]?\\d+$");
  const knownCodes = new Set();
  for (const key of Object.keys(existingMatrix)) {
    const [a, b] = key.split("|");
    if (siteCodePattern.test(a) && siteCodePattern.test(b)) {
      knownCodes.add(a);
      knownCodes.add(b);
    }
  }
  // v3 (2026-09-23): same Supabase-supplement fix as the dry-run branch
  // above -- see the top-of-file comment and getSupabaseKnownCodes() for
  // the full reasoning. Without this, a real build (not just the preview)
  // would re-fetch and re-bill pairs Supabase already has on file whenever
  // the Blobs cache didn't happen to know about them.
  const supabaseKnown = await getSupabaseKnownCodes(supabase, state, siteIdByCode, refreshCodes);
  for (const code of supabaseKnown) knownCodes.add(code);

  const fullRebuild = !!payload.fullRebuild || knownCodes.size === 0;
  const newSites = fullRebuild ? locEntries : locEntries.filter(([code]) => !knownCodes.has(code));
  const knownSites = fullRebuild ? [] : locEntries.filter(([code]) => knownCodes.has(code));
  // New sites first, so slicing destRange from an origin's index still
  // naturally includes remaining new sites (avoiding duplicate new x new
  // pairs) followed by every known site (giving the new x known pairs).
  const orderedEntries = [...newSites, ...knownSites];

  // Resume any in-progress build's partial results (stored under meta.siteToSite.partialMatrix
  // between calls) rather than starting the merge over from scratch each chunk.
  const priorPartial = (offset > 0 && existing && existing.meta && existing.meta.siteToSite && existing.meta.siteToSite.partialMatrix) || {};
  const matrix = { ...priorPartial };
  const priorFailed = (offset > 0 && existing && existing.meta && existing.meta.siteToSite && existing.meta.siteToSite.failedPairs) || [];
  const failedPairs = [...priorFailed];
  let elementsUsed = (offset > 0 && existing && existing.meta && existing.meta.siteToSite && existing.meta.siteToSite.elementsUsed) || 0;
  const elementsUsedBeforeThisChunk = elementsUsed; // baseline, to bill only what THIS invocation adds

  // Only iterate origins over the NEW portion of orderedEntries -- known x
  // known pairs (everything past newSites.length as an origin) never needed
  // recomputing in the first place.
  const originStarts = [];
  for (let oStart = 0; oStart < newSites.length; oStart += ORIGIN_BATCH) originStarts.push(oStart);

  const chunkStarts = originStarts.slice(offset, offset + ORIGIN_BATCHES_PER_CALL);

  for (const oStart of chunkStarts) {
    const originBatch = orderedEntries.slice(oStart, oStart + ORIGIN_BATCH);
    const destRange = orderedEntries.slice(oStart);
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

  // Monthly usage tracking (2026-09-07) -- bill only what THIS invocation
  // added (elementsUsed carries the running cumulative total across
  // resumed chunks, so the delta against the pre-chunk baseline is what
  // actually needs adding to the shared monthly counter this call).
  const elementsBilledThisChunk = elementsUsed - elementsUsedBeforeThisChunk;
  let monthlyElementsUsedTotal = null;
  if (elementsBilledThisChunk > 0) {
    monthlyElementsUsedTotal = await addMonthlyElementsUsed(store, elementsBilledThisChunk);
  }

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

    // Supabase sync (2026-09-15) -- Blobs above remains the operational
    // source of truth for THIS function's own resume/incremental-rebuild
    // bookkeeping (existingMatrix/knownCodes, the orphaned-build guard's
    // partialMatrix, etc.) -- deliberately untouched, since that machinery
    // was hardened after a real ~$122 overspend and isn't worth any risk to
    // change. This only ADDS a parallel write of this run's real results
    // (`matrix` -- always pure site-to-site pairs by construction, since it
    // was built purely from locEntries) into site_site_distances, so reads
    // (get-distance-matrix.js, get-distance.js, the MCP connector) have
    // current data without depending on Blobs at all. Best-effort: a
    // Supabase write failure here is reported but does NOT fail the
    // response -- the Blobs write above already succeeded and real money
    // was already spent on this build, so surfacing a hard error here would
    // wrongly suggest the build itself failed.
    const siteToSiteRows = [];
    const supabaseSyncSkipped = [];
    for (const [key, entry] of Object.entries(matrix)) {
      const [a, b] = key.split("|");
      const idA = siteIdByCode[a];
      const idB = siteIdByCode[b];
      if (!idA || !idB) { supabaseSyncSkipped.push(key); continue; }
      if (idA === idB) { supabaseSyncSkipped.push(key); continue; } // self-pair after resolution -- would violate the site_a < site_b CHECK; see migrate-distance-matrix-to-supabase.js's fuller comment on the same case
      const [site_a, site_b] = idA < idB ? [idA, idB] : [idB, idA];
      siteToSiteRows.push({
        site_a, site_b,
        // site_site_distances.mode CHECK only allows 'haversine'/'driving'
        // -- 'haversine-fallback' (a per-pair straight-line substitute for
        // one failed API element) normalizes to 'haversine', same fix as
        // migrate-distance-matrix-to-supabase.js, which hit this live.
        mode: entry.type === "driving" ? "driving" : "haversine",
        distance_mi: entry.distanceMi,
        duration_min: entry.durationMin ?? null,
        computed_at: mergedMeta.siteToSite.computedAt,
      });
    }
    let supabaseSyncError = null;
    if (siteToSiteRows.length) {
      const { error: syncErr } = await supabase
        .from("site_site_distances")
        .upsert(siteToSiteRows, { onConflict: "site_a,site_b,mode" });
      if (syncErr) supabaseSyncError = syncErr.message;
    }

    // Only lock the state after this invocation persisted something.
    if (offset === 0 && siteToSiteRows.length && !supabaseSyncError) {
      await store.set("distance-matrix-cooldown/site-site/" + state, new Date().toISOString());
    }

    return json(200, {
      ok: true,
      done: true,
      state,
      siteCount: locEntries.length,
      elementsUsed,
      elementsBilledThisChunk,
      monthlyElementsUsedTotal,
      newEntryCount: Object.keys(matrix).length,
      totalEntryCount: Object.keys(mergedMatrix).length,
      failedCount: failedPairs.length,
      incremental: !fullRebuild,
      newSiteCount: newSites.length,
      supabaseSync: { written: siteToSiteRows.length, skipped: supabaseSyncSkipped.length, error: supabaseSyncError },
      // TEMPORARY DIAGNOSTIC (2026-09-07) -- investigating why repeated
      // builds keep reporting the same ~960 "new" pairs with zero net
      // growth in totalEntryCount. Lists the actual site_code values
      // classified as "new" this run -- if the same handful shows up
      // every time, their codes likely don't match ^STATE\d+$ (whitespace,
      // case, unusual format), which would make them permanently invisible
      // to the knownCodes check even after being written. Remove once
      // diagnosed.
      newSiteCodesForDebug: newSites.map(([code]) => JSON.stringify(code)),
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
    elementsBilledThisChunk,
    monthlyElementsUsedTotal,
  });
};
