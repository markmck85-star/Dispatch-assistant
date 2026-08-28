/**
 * get-locations.js — v2 — Phase 2 Stage 3 (sites read cutover)
 *
 * Now reads from Supabase `sites` (source of truth going forward) instead
 * of Blobs. Falls back to the old Blobs read if Supabase isn't configured
 * or the query errors, so a Supabase outage degrades to the old behavior
 * rather than breaking dispatch generation.
 *
 * Returned shape is unchanged from the Blobs version so index.html doesn't
 * need any changes: an object keyed by site code, each value shaped like
 * { code, state, name, address, primaryTech, fallbackTech, defaultTech,
 *   contractorOverride, contractorName, machineType, remote, lat, lng }.
 *
 * v3 (2026-08-28): also resolves code-style site_aliases (e.g. a site
 * whose site_code is GA1083 but that Neumo's own dispatch-list digest
 * still labels under an old code like GA1018) as additional keys pointing
 * at the same location object -- so a pasted/parsed dispatch-list code
 * that no longer has its own `sites` row still resolves correctly instead
 * of silently failing to match or (worse) recreating a duplicate site.
 * Only aliases matching the site-code pattern (e.g. GA1018) are used this
 * way; free-text name aliases are left alone since they're not something
 * index.html ever looks up as a key. A real site_code always wins if it's
 * still live -- alias keys never overwrite an existing entry.
 *
 * Known gap: `cluster` (used for remote-cluster grouping) isn't in the
 * `sites` table and has no current write path anywhere in the app (checked
 * admin.html and every Supabase-writing function -- nothing sets it). Not
 * carried over here. Flagged to Mark 2026-07-27 rather than silently
 * dropped -- worth confirming whether it's still meaningfully populated
 * before deciding whether to add the column or leave it retired, given the
 * planned distance-matrix-based clustering rebuild makes it likely moot.
 */

const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");

const SITE_CODE_PATTERN = /^[A-Z]{2}\d+$/;

function getDispatchStore() {
  return getStore("dispatch");
}

async function readFromBlobs(state) {
  try {
    const store = getDispatchStore();
    const data = await store.get("locations/" + state, { type: "json" });
    return data || {};
  } catch (err) {
    return {};
  }
}

exports.handler = async (event) => {
  connectLambda(event);
  const params = event.queryStringParameters || {};
  const state = (params.state || "").trim().toUpperCase();

  if (!state || !/^[A-Z]{2}$/.test(state)) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing or invalid state parameter" }),
    };
  }

  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

      const { data: sites, error: sitesErr } = await supabase
        .from("sites")
        .select("id, site_code, state, name, address, machine_type, contractor_override, contractor_name, remote, lat, lng, primary_tech_id, fallback_tech_id")
        .eq("state", state);

      if (sitesErr) throw sitesErr;

      // Resolve primary/fallback tech ids -> names in one follow-up query
      // rather than guessing FK constraint names for an embedded select.
      const techIds = [...new Set(
        (sites || []).flatMap(s => [s.primary_tech_id, s.fallback_tech_id]).filter(Boolean)
      )];
      let techNameById = {};
      if (techIds.length > 0) {
        const { data: techs, error: techErr } = await supabase
          .from("technicians")
          .select("id, name")
          .in("id", techIds);
        if (techErr) throw techErr;
        techNameById = Object.fromEntries((techs || []).map(t => [t.id, t.name]));
      }

      const result = {};
      const siteIdById = {};
      for (const s of (sites || [])) {
        const primaryTech = techNameById[s.primary_tech_id] || "";
        const fallbackTech = techNameById[s.fallback_tech_id] || "";
        const record = {
          code: s.site_code,
          state: s.state,
          name: s.name || s.site_code,
          address: s.address || "",
          primaryTech,
          fallbackTech,
          defaultTech: primaryTech, // backward-compat with embedded LOCATIONS records
          contractorOverride: !!s.contractor_override,
          contractorName: s.contractor_name || "",
          machineType: s.machine_type || "SK",
          remote: !!s.remote,
          ...(s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : {}),
        };
        result[s.site_code] = record;
        siteIdById[s.id] = record;
      }

      // Fold in code-style site_aliases (e.g. an old/alternate code Neumo's
      // dispatch-list digest still uses) as additional keys pointing at the
      // same record, without ever overwriting a live site_code entry.
      const siteIds = Object.keys(siteIdById);
      if (siteIds.length > 0) {
        const { data: aliases, error: aliasErr } = await supabase
          .from("site_aliases")
          .select("site_id, alias")
          .in("site_id", siteIds);
        if (aliasErr) throw aliasErr;

        for (const a of (aliases || [])) {
          const alias = (a.alias || "").trim().toUpperCase();
          if (!SITE_CODE_PATTERN.test(alias)) continue; // skip free-text name aliases
          if (result[alias]) continue; // never clobber a real, still-live site_code
          const record = siteIdById[a.site_id];
          if (record) result[alias] = record;
        }
      }

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      };
    } catch (err) {
      console.error("[get-locations] Supabase read failed, falling back to Blobs:", err.message);
      const fallback = await readFromBlobs(state);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fallback),
      };
    }
  }

  // Supabase not configured -- old behavior
  const data = await readFromBlobs(state);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
};
