/**
 * assign-default-techs-co.js — ONE-TIME USE, safe to delete after running
 *
 * Reads the CO distance matrix (must already be built) and assigns each
 * site's defaultTech to its closest employee, writing to both Blobs
 * (locations/CO, what the live app reads) and Supabase (sites.primary_tech_id,
 * kept in sync the same way save-location.js does it).
 *
 * Contractors (Joseph Osborn, Dr. Joel) are NEVER auto-assigned as default,
 * even when they're the closest option -- flagged in the response instead
 * for manual review, since contractor cost is a real tradeoff only a human
 * should weigh, not something to silently optimize for distance alone.
 *
 * Visit once in a browser:
 *   https://mcrdispatch.net/.netlify/functions/assign-default-techs-co?confirm=yes
 *
 * Safe to re-run (idempotent, just overwrites defaultTech with the latest
 * computed closest each time). Delete this file once you've reviewed the
 * results and are happy with the assignments.
 */
const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");

const CONTRACTOR_NAMES = new Set(["Joseph Osborn", "Dr. Joel"]);

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  connectLambda(event);
  const confirm = (event.queryStringParameters || {}).confirm;
  if (confirm !== "yes") {
    return json(400, { error: "Add ?confirm=yes to the URL to run this." });
  }

  try {
    const store = getStore("dispatch");
    const [matrixData, locations, technicians] = await Promise.all([
      store.get("distance-matrix/CO", { type: "json" }),
      store.get("locations/CO", { type: "json" }),
      store.get("technicians/CO", { type: "json" }),
    ]);

    if (!matrixData || !matrixData.matrix) {
      return json(400, { error: "No distance matrix found for CO -- build it in the admin panel first." });
    }
    if (!locations || !technicians) {
      return json(400, { error: "Missing locations/CO or technicians/CO in Blobs." });
    }

    const matrix = matrixData.matrix;
    const techByKey = {}; // techKey -> display name
    for (const [key, t] of Object.entries(technicians)) {
      techByKey[key] = t.name || key;
    }

    const assigned = [];
    const needsReview = [];
    const noData = [];

    for (const [code, loc] of Object.entries(locations)) {
      // Find every tech|code pair for this site, split into employees vs contractors
      let bestEmployee = null;
      let bestOverall = null;
      for (const [pairKey, val] of Object.entries(matrix)) {
        const sep = pairKey.lastIndexOf("|");
        if (pairKey.slice(sep + 1) !== code) continue;
        const techKey = pairKey.slice(0, sep);
        const techName = techByKey[techKey];
        if (!techName) continue;
        const isContractor = CONTRACTOR_NAMES.has(techName);
        const entry = { techName, techKey, distanceMi: val.distanceMi, durationMin: val.durationMin, isContractor };
        if (!bestOverall || entry.distanceMi < bestOverall.distanceMi) bestOverall = entry;
        if (!isContractor && (!bestEmployee || entry.distanceMi < bestEmployee.distanceMi)) bestEmployee = entry;
      }

      if (!bestOverall) {
        noData.push(code);
        continue;
      }

      if (bestOverall.isContractor) {
        // Closest option overall is a contractor -- don't auto-assign, flag for review
        needsReview.push({
          code, name: loc.name,
          closestContractor: { name: bestOverall.techName, distanceMi: bestOverall.distanceMi, durationMin: bestOverall.durationMin },
          closestEmployee: bestEmployee ? { name: bestEmployee.techName, distanceMi: bestEmployee.distanceMi, durationMin: bestEmployee.durationMin } : null,
        });
        continue;
      }

      assigned.push({ code, name: loc.name, tech: bestOverall.techName, distanceMi: bestOverall.distanceMi, durationMin: bestOverall.durationMin });
      loc.defaultTech = bestOverall.techName;
      loc.primaryTech = bestOverall.techName;
    }

    await store.setJSON("locations/CO", locations);

    // Sync to Supabase too, matching save-location.js's own convention
    let supabaseSynced = 0;
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      for (const a of assigned) {
        const { data: techRow } = await supabase.from("technicians").select("id").eq("name", a.tech).maybeSingle();
        if (techRow) {
          const { error } = await supabase.from("sites").update({ primary_tech_id: techRow.id }).eq("site_code", a.code);
          if (!error) supabaseSynced++;
        }
      }
    }

    return json(200, {
      ok: true,
      autoAssigned: assigned.length,
      needsManualReview: needsReview.length,
      noMatrixData: noData.length,
      supabaseSynced,
      assigned,
      needsReview,
      noData,
    });
  } catch (err) {
    return json(500, { error: "Failed: " + err.message });
  }
};
