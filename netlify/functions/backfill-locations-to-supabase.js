/**
 * backfill-locations-to-supabase.js — ONE-TIME USE, safe to delete after running
 *
 * Same gap as backfill-technicians-to-supabase.js, on the sites side.
 * save-location.js syncs every save to Supabase's `sites` table on top of
 * its existing Blobs write (Blobs remains the source of truth for the
 * admin panel's Locations tab) -- but that sync only fires when a site is
 * actually saved again through the admin panel. Any site whose Blobs
 * record predates that sync, and hasn't been edited since, never got a
 * matching row created in Supabase. Flagged as a real possibility back on
 * 2026-07-21 when the technicians/sites sync was first built and tested,
 * but never actually checked until the technician-side gap surfaced live
 * on 2026-08-15 (Nyzier Moore, Sean Reich, Robert Medley missing from the
 * RMA shipments technician dropdown).
 *
 * Run backfill-technicians-to-supabase.js FIRST if you haven't already --
 * this script resolves each site's primaryTech/fallbackTech name to a
 * Supabase technician id, so it needs the technicians table to already be
 * populated to link correctly.
 *
 * Visit once in a browser:
 *   https://mcrdispatch.net/.netlify/functions/backfill-locations-to-supabase?confirm=yes
 *
 * Safe to run more than once (upsert on site_code, never duplicates).
 * Delete this file from netlify/functions/ once you've confirmed the
 * Supabase `sites` table row count matches what the admin panel shows per
 * state.
 */
const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");

const STATES = ["GA", "FL", "NC", "SC", "MI", "IN", "OH", "NV", "IL", "MN", "WV", "OR", "CO", "ID"];

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  connectLambda(event);
  const confirm = (event.queryStringParameters || {}).confirm;
  if (confirm !== "yes") {
    return json(400, { error: "Add ?confirm=yes to the URL to run this backfill." });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const store = getStore("dispatch");

  // Load every technician once, name -> id, so we're not issuing a query
  // per site for tech-name resolution (same best-effort matching
  // save-location.js does, just batched instead of per-row).
  const { data: techRows, error: techErr } = await supabase.from("technicians").select("id, name");
  if (techErr) return json(500, { error: "Failed to load technicians for name matching: " + techErr.message });
  const techIdByName = new Map((techRows || []).map(t => [t.name, t.id]));

  const results = {};
  const errors = [];

  for (const state of STATES) {
    let locs;
    try {
      locs = (await store.get("locations/" + state, { type: "json" })) || {};
    } catch (err) {
      errors.push(`${state}: Blobs read failed -- ${err.message}`);
      continue;
    }

    const codes = Object.keys(locs);
    if (codes.length === 0) {
      results[state] = 0;
      continue;
    }

    // Same field mapping as save-location.js's sync block.
    const rows = codes.map((code) => {
      const loc = locs[code];
      const primaryName = loc.primaryTech || loc.defaultTech || "";
      const fallbackName = loc.fallbackTech || "";
      const row = {
        site_code: code,
        state: loc.state || state,
        name: loc.name || code,
        address: loc.address || null,
        machine_type: loc.machineType || null,
        contractor_override: !!loc.contractorOverride,
        contractor_name: loc.contractorName || null,
        remote: !!loc.remote,
        primary_tech_id: primaryName ? (techIdByName.get(primaryName) || null) : null,
        fallback_tech_id: fallbackName ? (techIdByName.get(fallbackName) || null) : null,
      };
      if (loc.lat != null && loc.lng != null) {
        row.lat = loc.lat;
        row.lng = loc.lng;
      }
      return row;
    });

    const { error } = await supabase.from("sites").upsert(rows, { onConflict: "site_code" });
    if (error) {
      errors.push(`${state}: Supabase upsert failed -- ${error.message}`);
      continue;
    }
    results[state] = rows.length;
  }

  return json(200, {
    ok: errors.length === 0,
    locationsWritten: results,
    totalWritten: Object.values(results).reduce((a, b) => a + b, 0),
    errors,
    message: errors.length === 0
      ? "Done. Spot-check a few sites in Supabase against the admin panel. You can delete this function file now."
      : "Completed with some errors -- see the errors array. Safe to re-run.",
  });
};
