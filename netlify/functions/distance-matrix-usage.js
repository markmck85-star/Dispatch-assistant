/**
 * distance-matrix-usage.js
 *
 * Shared monthly element-usage tracking and cost estimation for BOTH
 * compute-distance-matrix.js (tech-to-site) and
 * compute-site-distance-matrix.js (site-to-site) -- they draw against the
 * SAME Google Maps Distance Matrix (Legacy) monthly free threshold, so the
 * usage counter has to be shared, not per-function.
 *
 * Added 2026-09-07 after two related gaps surfaced the same day:
 *   1. admin.html's Step 2 "Build (Drive-Time)" button already called its
 *      preview fetch with dryRun:true, expecting a free, password-free cost
 *      preview -- but compute-distance-matrix.js never actually implemented
 *      dryRun at all. Every preview click landed on the password gate with
 *      no adminSecret sent, silently counting as a wrong-password attempt
 *      against the 5-try lockout, before the person ever typed a real
 *      password.
 *   2. Step 3 (site-to-site) had no cost preview at all -- just a rough
 *      static estimate from a hardcoded site-count table -- which is how an
 *      accidental Indiana build went through instead of the intended
 *      Georgia one with no real per-click warning of what was about to be
 *      billed against this month's quota.
 *
 * MONTHLY_FREE_ELEMENTS: confirmed against Google's own Distance Matrix
 * product page 2026-09-07 -- 10,000 free elements/month per SKU, replacing
 * the old flat $200/month credit (changed March 1, 2025). Distance Matrix
 * is Legacy status but still billed this way.
 *
 * EST_COST_PER_ELEMENT: Google's exact tiered/negotiated per-element rate
 * isn't hardcoded here -- this reuses the same conservative low-end
 * estimate ($3.10/1,000 elements) already baked into admin.html's Step 3
 * DM_SITE_COUNT_HINTS cost range (0.0031-0.0062/element), using the LOW end
 * so previews don't overstate cost. Treat as an approximation for the
 * confirm dialog, not an exact bill -- check Google Cloud billing console
 * for the real number.
 */

const MONTHLY_FREE_ELEMENTS = 10000;
const EST_COST_PER_ELEMENT = 0.0031;

function monthKey(date) {
  return (date || new Date()).toISOString().slice(0, 7); // "YYYY-MM"
}

function usageBlobKey(date) {
  return "distance-matrix-monthly-usage/" + monthKey(date);
}

/** Free, read-only -- how many elements has this billing month already used (either function, combined). */
async function getMonthlyElementsUsed(store, date) {
  const rec = await store.get(usageBlobKey(date), { type: "json" });
  return (rec && rec.elementsUsed) || 0;
}

/** Called ONLY after a real (non-dry-run) Google API build actually ran -- adds to this month's running total. */
async function addMonthlyElementsUsed(store, count, date) {
  const key = usageBlobKey(date);
  const current = await getMonthlyElementsUsed(store, date);
  const updated = current + count;
  await store.setJSON(key, { elementsUsed: updated, updatedAt: new Date().toISOString() });
  return updated;
}

/**
 * Given how many elements a prospective build would request, and how many
 * this month has already used, returns the preview numbers admin.html's
 * confirm dialogs show. Pure/free -- no Blobs or API calls in here.
 */
function estimateCost(requestedElements, alreadyUsedThisMonth) {
  const freeElementsRemainingThisMonth = Math.max(0, MONTHLY_FREE_ELEMENTS - alreadyUsedThisMonth);
  const billableElements = Math.max(0, requestedElements - freeElementsRemainingThisMonth);
  const estimatedCost = Math.round(billableElements * EST_COST_PER_ELEMENT * 100) / 100;
  return { freeElementsRemainingThisMonth, billableElements, estimatedCost };
}

module.exports = {
  MONTHLY_FREE_ELEMENTS,
  EST_COST_PER_ELEMENT,
  monthKey,
  getMonthlyElementsUsed,
  addMonthlyElementsUsed,
  estimateCost,
};
