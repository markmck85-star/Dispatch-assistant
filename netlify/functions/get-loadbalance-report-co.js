/**
 * get-loadbalance-report-co.js — v1 — added 2026-07-21
 *
 * READ-ONLY report, companion to assign-default-techs-co.js. That script
 * always picks the single closest employee per site; this one shows, for
 * every site, the FULL ranked list of employee techs by distance -- so you
 * can see how close the runner-up is. Sorted by the smallest gap between
 * 1st and 2nd choice, so the cheapest possible load-balancing moves (a
 * couple extra miles) float to the top, and sites where the assigned tech
 * is the only sane choice (next-closest is 100+ mi away) sink to the
 * bottom.
 *
 * Never writes anything -- this is purely for review. Reassigning is still
 * a manual decision made in the app (reassign dropdown) or by re-running
 * assign-default-techs-co.js after a technicians/CO change.
 *
 * Contractors are excluded from the ranking entirely -- this is about
 * balancing load across employees, not re-litigating the contractor/
 * employee cost tradeoff (that's what assign-default-techs-co.js's
 * needsReview list is for).
 *
 * GET /.netlify/functions/get-loadbalance-report-co
 *   ?tech=Daren%20Dozier   optional -- only show sites currently assigned
 *                          to this tech (name must match technicians/CO
 *                          exactly)
 *   ?maxDelta=10           optional -- only show sites where the gap to
 *                          the runner-up is <= this many miles
 *
 * -> { report: [ { code, name, currentTech, ranked: [{tech, distanceMi,
 *        durationMin}, ...], deltaMi, deltaMin } ], count }
 *    ranked[0] is always the closest employee (should normally match
 *    currentTech, unless defaultTech hasn't been (re)run since the last
 *    matrix update). deltaMi/deltaMin are ranked[1] - ranked[0].
 *    Sites with only one employee in range (no runner-up) are included
 *    at the end with deltaMi/deltaMin: null, since there's no
 *    load-balancing option to weigh.
 */
const { getStore, connectLambda } = require("@netlify/blobs");

const CONTRACTOR_NAMES = new Set(["Joseph Osborn", "Dr. Joel"]);

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  connectLambda(event);
  const params = event.queryStringParameters || {};
  const focusTech = params.tech ? String(params.tech).trim() : null;
  const maxDelta = params.maxDelta !== undefined ? parseFloat(params.maxDelta) : null;

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
    const techByKey = {};
    for (const [key, t] of Object.entries(technicians)) {
      techByKey[key] = t.name || key;
    }

    const report = [];

    for (const [code, loc] of Object.entries(locations)) {
      const currentTech = loc.defaultTech || loc.primaryTech || null;
      if (focusTech && currentTech !== focusTech) continue;

      // Rank every non-contractor employee tech by distance to this site
      const employees = [];
      for (const [pairKey, val] of Object.entries(matrix)) {
        const sep = pairKey.lastIndexOf("|");
        if (pairKey.slice(sep + 1) !== code) continue;
        const techKey = pairKey.slice(0, sep);
        const techName = techByKey[techKey];
        if (!techName || CONTRACTOR_NAMES.has(techName)) continue;
        employees.push({ tech: techName, distanceMi: val.distanceMi, durationMin: val.durationMin });
      }
      if (!employees.length) continue;
      employees.sort((a, b) => a.distanceMi - b.distanceMi);

      const deltaMi = employees.length > 1 ? +(employees[1].distanceMi - employees[0].distanceMi).toFixed(1) : null;
      const deltaMin = employees.length > 1 ? employees[1].durationMin - employees[0].durationMin : null;

      if (maxDelta !== null && (deltaMi === null || deltaMi > maxDelta)) continue;

      report.push({ code, name: loc.name, currentTech, ranked: employees, deltaMi, deltaMin });
    }

    // Cheapest swaps first; sites with no runner-up (deltaMi: null) sort to the end
    report.sort((a, b) => {
      if (a.deltaMi === null && b.deltaMi === null) return 0;
      if (a.deltaMi === null) return 1;
      if (b.deltaMi === null) return -1;
      return a.deltaMi - b.deltaMi;
    });

    return json(200, { report, count: report.length });
  } catch (err) {
    return json(500, { error: "Failed: " + err.message });
  }
};
