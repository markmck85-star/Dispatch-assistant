/**
 * backfill-site-distance-gaps.js
 * Built 2026-09-23 after a real coverage gap surfaced on the CA
 * site-to-site build: 290/290 sites were touched at least once, but only
 * 22,105 of the possible 41,905 unique pairs (about 53%) actually got
 * computed, because the interrupted/resumed build hit a site-ordering
 * bug in compute-site-distance-matrix.js (fixed there, v4). That fix
 * prevents the gap from recurring, but doesn't fill the gap CA already
 * has -- and re-running compute-site-distance-matrix.js with
 * fullRebuild:true would recompute (and re-bill) every pair, including
 * the 22,105 already-correct ones, roughly doubling the state's cost for
 * work that's already paid for and fine.
 *
 * This function instead: reads the exact set of pairs that SHOULD exist
 * for a state (every unique combination of its active, geocoded sites)
 * and the exact set that already DO exist in site_site_distances, takes
 * the difference, and queries Google for ONLY the missing pairs.
 *
 * Snapshot-plan design (deliberately different from
 * compute-site-distance-matrix.js's per-call recomputation): the missing-
 * pairs list is computed ONCE at the start of a build and saved verbatim
 * to Blobs (gap-fill-plan/{STATE}). Every subsequent chunk just reads
 * forward through that saved list by index -- it never recomputes "what's
 * missing" mid-build. This sidesteps the exact bug class that caused the
 * CA gap in the first place: if "missing" were re-derived on every
 * resumed call (by re-diffing against however many pairs have been
 * written so far), the list would itself shift between calls, which is
 * precisely the kind of moving target that produces silent gaps. A fixed,
 * already-decided plan has nothing to reshuffle.
 *
 * Writes go straight to Supabase's site_site_distances (the authoritative
 * store other functions already read from -- see compute-site-distance-
 * matrix.js's own 2026-09-15 Supabase-sync comment). This intentionally
 * does NOT touch the Blobs distance-matrix/{STATE} cache or its
 * knownCodes/orphaned-build bookkeeping -- that machinery belongs to
 * compute-site-distance-matrix.js alone and was hardened after a real
 * ~$122 overspend; a separate utility has no business touching it.
 *
 * POST /.netlify/functions/backfill-site-distance-gaps
 * Body: { state: "CA", offset: 0, adminSecret: "...", dryRun?, force? }
 *
 * Requires env var: GOOGLE_MAPS_API_KEY, DISTANCE_MATRIX_ADMIN_PASSWORD
 */

const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");
const { getMonthlyElementsUsed, addMonthlyElementsUsed, estimateCost } = require("./distance-matrix-usage.js");

const MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";
const DEST_BATCH = 10;      // destinations per Google API call, matches the other two build functions
const CHUNK_SIZE = 200;     // missing pairs processed per invocation -- comparable to what a single chunk of compute-site-distance-matrix.js already handles without hitting Netlify's execution limit

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Builds the deterministic list of every missing (siteACode, siteBCode)
// pair for a state: every unique combination of its active, geocoded
// sites, minus whatever site_site_distances already has on file. Ordered
// by site_code (both the outer loop and the site fetch itself), so this
// is exactly reproducible -- calling it twice with the same underlying
// data always returns the same list in the same order.
async function computeMissingPairs(supabase, state) {
  const { data: sites, error: sitesErr } = await supabase
    .from("sites")
    .select("id, site_code, lat, lng")
    .eq("state", state)
    .eq("active", true)
    .order("site_code", { ascending: true });
  if (sitesErr) throw new Error("sites fetch failed: " + sitesErr.message);

  const geocoded = (sites || []).filter((s) => s.lat != null && s.lng != null);
  const ids = geocoded.map((s) => s.id);

  const existingKeys = new Set();
  const CHUNK = 150; // .in() batching for larger states -- keeps each query's id-list size reasonable
  const PAGE_SIZE = 1000; // v2 (2026-09-23) BUG FIX: Supabase/PostgREST caps a single query's rows
  // at 1000 by default -- CA has 22,105 existing pairs, so the very first
  // un-paginated attempt at this silently truncated to ~1000 rows per
  // chunk, making almost every real pair look "missing" and inflating the
  // gap-fill estimate to $202 (nearly a full rebuild) instead of the true
  // ~$99 for the actual 19,800-pair gap. Every query here now loops with
  // an explicit .range() until a page comes back shorter than PAGE_SIZE,
  // guaranteeing the full result set is read regardless of size.
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    if (!chunk.length) continue;
    let page = 0;
    for (;;) {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const { data: rows, error: distErr } = await supabase
        .from("site_site_distances")
        .select("site_a, site_b")
        .or(`site_a.in.(${chunk.join(",")}),site_b.in.(${chunk.join(",")})`)
        .range(from, to);
      if (distErr) throw new Error("site_site_distances fetch failed: " + distErr.message);
      for (const row of rows || []) {
        const [a, b] = row.site_a < row.site_b ? [row.site_a, row.site_b] : [row.site_b, row.site_a];
        existingKeys.add(a + "|" + b);
      }
      if (!rows || rows.length < PAGE_SIZE) break;
      page++;
    }
  }

  const missing = [];
  const latLngByCode = {};
  for (const s of geocoded) latLngByCode[s.site_code] = { lat: s.lat, lng: s.lng };

  for (let i = 0; i < geocoded.length; i++) {
    for (let j = i + 1; j < geocoded.length; j++) {
      const a = geocoded[i], b = geocoded[j];
      const [idA, idB] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      if (existingKeys.has(idA + "|" + idB)) continue;
      missing.push([a.site_code, b.site_code]);
    }
  }

  return { missing, latLngByCode, siteCount: geocoded.length };
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

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Free dry-run preview -- same pattern as the other two build functions:
  // exact real numbers before any password or spend, no Google call.
  if (payload.dryRun === true) {
    const dryStore = getStore("dispatch");
    let plan;
    try {
      plan = await computeMissingPairs(supabase, state);
    } catch (e) {
      return json(500, { ok: false, error: e.message });
    }
    const elementCount = plan.missing.length; // one API element per unique pair (symmetric, same convention as the other build functions)
    const usedThisMonth = await getMonthlyElementsUsed(dryStore);
    const preview = estimateCost(elementCount, usedThisMonth);
    return json(200, {
      ok: true,
      state,
      siteCount: plan.siteCount,
      missingPairCount: plan.missing.length,
      elementCount,
      ...preview,
    });
  }

  // Same paid-action password gate as the other two build functions,
  // sharing the same lockout counter (guessing here counts against the
  // same limit as guessing on either of the others).
  const requiredSecret = process.env.DISTANCE_MATRIX_ADMIN_PASSWORD;
  if (!requiredSecret) {
    return json(500, { error: "DISTANCE_MATRIX_ADMIN_PASSWORD is not configured -- refusing to run a paid build until it is set." });
  }
  const authStore = getStore("dispatch");
  const failKey = "distance-matrix-failed-attempts";
  const MAX_FAILED_ATTEMPTS = 5;
  const LOCKOUT_HOURS = 24;
  if (offset === 0) {
    const failData = (await authStore.get(failKey, { type: "json" })) || { count: 0, lockedUntil: null };
    if (failData.lockedUntil && Date.now() < new Date(failData.lockedUntil).getTime()) {
      const minsLeft = Math.ceil((new Date(failData.lockedUntil).getTime() - Date.now()) / 60000);
      return json(429, { error: `Too many incorrect admin-secret attempts -- locked out for ${minsLeft} more minute(s) (shared lockout across all distance-matrix build functions).` });
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
    if (String(payload.adminSecret || "") !== requiredSecret) {
      return json(401, { error: "Incorrect or missing admin secret for this paid operation." });
    }
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return json(500, { error: "GOOGLE_MAPS_API_KEY env var not set" });

  const store = getStore("dispatch");
  const planKey = "gap-fill-plan/" + state;
  let planRecord = await store.get(planKey, { type: "json" });

  // Orphaned-plan guard -- same shape as compute-site-distance-matrix.js's
  // own orphaned-build guard, so admin.html's existing resume-confirm flow
  // (already built for that function) works for this one unchanged.
  if (offset === 0 && !payload.force && planRecord && !planRecord.done) {
    return json(409, {
      error: `An interrupted ${state} gap-fill already has ${planRecord.elementsUsed || 0} billed elements saved (from a previous session that didn't finish). Resume it with offset:${planRecord.processedCount || 0} to avoid re-billing that work, or pass force:true to discard it and start completely over.`,
      resumeOffset: planRecord.processedCount || 0,
      priorElementsUsed: planRecord.elementsUsed || 0,
    });
  }

  // Build a fresh plan on a genuine start (offset:0, no valid existing plan, or force:true).
  if (offset === 0 && (!planRecord || planRecord.done || payload.force)) {
    let computed;
    try {
      computed = await computeMissingPairs(supabase, state);
    } catch (e) {
      return json(500, { ok: false, error: e.message });
    }
    planRecord = {
      state,
      createdAt: new Date().toISOString(),
      pairs: computed.missing,
      latLngByCode: computed.latLngByCode,
      totalPairs: computed.missing.length,
      processedCount: 0,
      elementsUsed: 0,
      failedPairs: [],
      done: false,
    };
    await store.setJSON(planKey, planRecord);
  }

  if (!planRecord) {
    return json(400, { error: "No gap-fill plan found for " + state + " at offset " + offset + " -- start a new build with offset:0." });
  }

  const slice = planRecord.pairs.slice(offset, offset + CHUNK_SIZE);
  if (!slice.length && offset > 0) {
    // Nothing left to process but somehow not marked done -- treat as complete.
    planRecord.done = true;
  }

  // Group this chunk's pairs by their first (lower-indexed) site so each
  // origin only needs one Google API call per DEST_BATCH destinations,
  // same batching convention as the other two build functions.
  const byOrigin = new Map();
  for (const [a, b] of slice) {
    if (!byOrigin.has(a)) byOrigin.set(a, []);
    byOrigin.get(a).push(b);
  }

  const rowsToWrite = [];
  let elementsThisChunk = 0;

  for (const [originCode, destCodes] of byOrigin) {
    const originLoc = planRecord.latLngByCode[originCode];
    if (!originLoc) continue; // site removed/deactivated since the plan was made -- skip, not an error
    for (let i = 0; i < destCodes.length; i += DEST_BATCH) {
      const destBatch = destCodes.slice(i, i + DEST_BATCH);
      const validDest = destBatch.filter((code) => planRecord.latLngByCode[code]);
      if (!validDest.length) continue;
      const destinations = validDest.map((code) => { const l = planRecord.latLngByCode[code]; return `${l.lat},${l.lng}`; }).join("|");

      const url = MATRIX_URL +
        "?origins=" + encodeURIComponent(`${originLoc.lat},${originLoc.lng}`) +
        "&destinations=" + encodeURIComponent(destinations) +
        "&units=imperial&key=" + apiKey;

      try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.status !== "OK") {
          planRecord.failedPairs.push({ originCode, batch: validDest, reason: "API status: " + data.status });
        } else {
          const row = data.rows[0];
          row.elements.forEach((el, di) => {
            const destCode = validDest[di];
            elementsThisChunk++;
            if (el.status === "OK") {
              rowsToWrite.push({
                originCode, destCode,
                distanceMi: Math.round((el.distance.value / 1609.34) * 10) / 10,
                durationMin: Math.round(el.duration.value / 60),
                mode: "driving",
              });
            } else {
              planRecord.failedPairs.push({ originCode, destCode, reason: "Element status: " + el.status });
            }
          });
        }
      } catch (err) {
        planRecord.failedPairs.push({ originCode, batch: validDest, reason: "Network error: " + err.message });
      }
      await sleep(120);
    }
  }

  // Write this chunk's real results immediately -- if the next chunk
  // never runs (dropped connection, closed tab), these pairs are already
  // safely on file and a resume will correctly skip past them by offset,
  // never re-querying them.
  if (rowsToWrite.length) {
    const { data: sitesForIds } = await supabase
      .from("sites")
      .select("id, site_code")
      .eq("state", state)
      .in("site_code", [...new Set(rowsToWrite.flatMap((r) => [r.originCode, r.destCode]))]);
    const idByCode = Object.fromEntries((sitesForIds || []).map((s) => [s.site_code, s.id]));

    const upsertRows = [];
    for (const r of rowsToWrite) {
      const idA = idByCode[r.originCode], idB = idByCode[r.destCode];
      if (!idA || !idB || idA === idB) continue;
      const [site_a, site_b] = idA < idB ? [idA, idB] : [idB, idA];
      upsertRows.push({ site_a, site_b, mode: r.mode, distance_mi: r.distanceMi, duration_min: r.durationMin, computed_at: new Date().toISOString() });
    }
    if (upsertRows.length) {
      const { error: upsertErr } = await supabase
        .from("site_site_distances")
        .upsert(upsertRows, { onConflict: "site_a,site_b,mode" });
      if (upsertErr) {
        return json(500, { ok: false, error: "Supabase write failed mid-backfill (progress NOT saved for this chunk, safe to retry with the same offset): " + upsertErr.message });
      }
    }
  }

  planRecord.elementsUsed = (planRecord.elementsUsed || 0) + elementsThisChunk;
  planRecord.processedCount = offset + slice.length;
  planRecord.done = planRecord.processedCount >= planRecord.totalPairs;

  if (elementsThisChunk > 0) {
    await addMonthlyElementsUsed(store, elementsThisChunk);
  }

  if (planRecord.done) {
    // Clean up the plan -- no reason to keep a completed snapshot around.
    await store.delete(planKey);
    return json(200, {
      ok: true,
      done: true,
      state,
      totalPairs: planRecord.totalPairs,
      elementsUsed: planRecord.elementsUsed,
      failedCount: planRecord.failedPairs.length,
    });
  }

  await store.setJSON(planKey, planRecord);
  return json(200, {
    ok: true,
    done: false,
    nextOffset: planRecord.processedCount,
    totalPairs: planRecord.totalPairs,
    elementsUsed: planRecord.elementsUsed,
    elementsBilledThisChunk: elementsThisChunk,
  });
};
