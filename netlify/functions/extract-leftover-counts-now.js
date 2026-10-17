/**
 * extract-leftover-counts-now.js  (2026-10-17)
 *
 * Open-by-URL twin of extract-leftover-counts.js. Netlify does not let a
 * scheduled function be opened by URL (the browser gets "Access denied"),
 * so this unscheduled copy runs exactly the same code and shows the result.
 * Sign in to mcrdispatch.net first, in the same browser.
 *
 *   /.netlify/functions/extract-leftover-counts-now?days=400&dry=1   preview, writes nothing
 *   /.netlify/functions/extract-leftover-counts-now?days=400         backfill
 */
const scheduled = require("./extract-leftover-counts.js");

exports.handler = scheduled.handler;
