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
 * EST_COST_PER_ELEMENT: 2026-09-17 fix -- was $0.0031/element, explicitly
 * labeled in this file's own prior comment as "a conservative low-end
 * estimate... not Google's real negotiated rate." Checked against Google's
 * official current pricing list (developers.google.com/maps/billing-and-
 * pricing/pricing, page itself last updated 2026-09-10) before Mark quoted
 * a build cost to TJ: the real published Distance Matrix (Legacy,
 * Essentials) rate is $5.00 per 1,000 elements for the first 100,000
 * monthly elements, dropping to $4.00/1,000 beyond that -- the old constant
 * was underquoting real cost by roughly 61%. Using the $5.00/1,000 rate
 * here (the tier that applies to MCR's actual per-state build volumes,
 * which stay well under 100k/month) rather than trying to model the tier
 * break, since a single state's one-time build is never going to cross it.
 */

const MONTHLY_FREE_ELEMENTS = 10000;
const EST_COST_PER_ELEMENT = 0.005;

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
