const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function getDispatchStore() {
  return getStore("dispatch");
}

exports.handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid JSON body" }); }

  const state = String(payload.state || "").trim().toUpperCase();
  if (!state || !/^[A-Z]{2}$/.test(state)) return json(400, { error: "Missing or invalid state" });

  const code = String(payload.code || payload.siteCode || "").trim().toUpperCase();
  if (!code) return json(400, { error: "Site code is required" });

  const record = {
    code, state,
    name: String(payload.name || "").trim(),
    address: String(payload.address || "").trim(),
    primaryTech: String(payload.primaryTech || payload.defaultTech || "").trim(),
    fallbackTech: String(payload.fallbackTech || "").trim(),
    // Keep defaultTech in sync for backward-compat with embedded LOCATIONS records
    defaultTech: String(payload.primaryTech || payload.defaultTech || "").trim(),
    contractorOverride: Boolean(payload.contractorOverride),
    contractorName: String(payload.contractorName || "").trim(),
    machineType: String(payload.machineType || "SK").trim(),
    remote: Boolean(payload.remote),
    updatedAt: new Date().toISOString(),
  };

  const store = getDispatchStore();
  const key = "locations/" + state;

  // Netlify Blobs has no built-in locking (confirmed via Netlify's own docs:
  // "last write wins... does not include a concurrency control mechanism").
  // This function does read-modify-write on a single per-state blob holding
  // EVERY site's data -- so two reassignments fired close together (e.g.
  // batch-reassigning several sites after adding a new technician) can each
  // read before the other writes, then the second write silently overwrites
  // the first's change with stale data. This is the exact bug behind
  // reassignments "not sticking" until retried one at a time with a refresh
  // in between (found 2026-07-16). Fixed with optimistic concurrency
  // (onlyIfMatch/onlyIfNew) plus retry. The write result is verified by
  // re-reading rather than trusted blindly, since Netlify's docs don't
  // clearly document whether a failed conditional write throws or resolves
  // silently -- this way correctness doesn't depend on guessing that.
  const MAX_ATTEMPTS = 6;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const current = await store.getWithMetadata(key, { type: "json" });
      const existing = (current && current.data) || {};
      const etag = current && current.etag;
      const prev = existing[code] || {};

      const newAddress = record.address;
      const addressChanged = newAddress && newAddress !== (prev.address || "");
      const merged = { ...prev, ...record };
      if (addressChanged) {
        delete merged.lat;
        delete merged.lng;
        delete merged.geoFormatted;
        delete merged.geoAt;
      }
      existing[code] = merged;

      const writeOpts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      await store.setJSON(key, existing, writeOpts);

      // Verify the write actually landed rather than trusting it blindly.
      const verify = await store.get(key, { type: "json" });
      if (verify && JSON.stringify(verify[code]) === JSON.stringify(merged)) {
        // Additive Supabase sync (admin-panel-to-Supabase gap fix). Blobs is
        // still what the live app reads; this keeps the sites table (used by
        // save-assignment.js/get-assignments.js/mailgun-inbound.js lookups)
        // from going stale. Never blocks or fails the Blobs write above.
        if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
          try {
            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

            // Tech names -> ids, best-effort (site row still saves if a name
            // doesn't match; matches the same best-effort pattern used for
            // ticket linkage in mailgun-inbound.js).
            let primaryTechId = null, fallbackTechId = null;
            const primaryName = merged.primaryTech || merged.defaultTech || "";
            const fallbackName = merged.fallbackTech || "";
            if (primaryName) {
              const { data: pRow } = await supabase.from("technicians").select("id").eq("name", primaryName).maybeSingle();
              if (pRow) primaryTechId = pRow.id;
            }
            if (fallbackName) {
              const { data: fRow } = await supabase.from("technicians").select("id").eq("name", fallbackName).maybeSingle();
              if (fRow) fallbackTechId = fRow.id;
            }

            const siteRow = {
              site_code: code,
              state,
              name: merged.name || code,
              address: merged.address || null,
              machine_type: merged.machineType || null,
              contractor_override: !!merged.contractorOverride,
              contractor_name: merged.contractorName || null,
              remote: !!merged.remote,
              primary_tech_id: primaryTechId,
              fallback_tech_id: fallbackTechId,
            };
            if (addressChanged) {
              // Match Blobs behavior: an address change invalidates any
              // existing coordinates until the site is re-geocoded.
              siteRow.lat = null;
              siteRow.lng = null;
            }
            const { error: supaErr } = await supabase.from("sites").upsert(siteRow, { onConflict: "site_code" });
            if (supaErr) console.error("[save-location] Supabase sync failed (non-fatal):", supaErr.message);
          } catch (supaEx) {
            console.error("[save-location] Supabase sync error (non-fatal):", supaEx.message);
          }
        }
        return json(200, { ok: true, location: merged });
      }
      lastErr = new Error("Write did not verify -- concurrent update detected, retrying");
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 220)); // jittered backoff
  }

  return json(500, { error: "Failed to save location after concurrent-write retries: " + (lastErr && lastErr.message) });
};
