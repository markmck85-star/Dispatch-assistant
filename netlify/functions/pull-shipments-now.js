/**
 * pull-shipments-now.js  (2026-10-06)
 * SAVE AS: netlify/functions/pull-shipments-now.js   (ONE file)
 *
 * On-demand twin of pull-shipments-mailbox.js. Netlify does not allow a
 * scheduled function to be opened by URL (the browser just gets "Access
 * denied"), so this unscheduled copy runs exactly the same code when you
 * open it, and returns what happened.
 *
 *   /.netlify/functions/pull-shipments-now           (last 3 days)
 *   /.netlify/functions/pull-shipments-now?days=14   (up to 60)
 *
 * Reading the answer:
 *   error "IMAP login failed"  -> the mailbox rejected the stored credentials
 *   found: 0                   -> the Inbox has no mail in that window
 *   found > 0, inserted > 0    -> mail is flowing into the app
 *   found > 0, inserted: 0, skipped > 0 -> already stored earlier
 *   errors: [...]              -> messages that could not be saved (and why)
 *
 * It only reads the mailbox (BODY.PEEK) and saves new messages to
 * inbound_emails, the same as the scheduled run. Repeating it is harmless.
 * Once the schedule is confirmed healthy this file can simply be deleted.
 */
const scheduled = require("./pull-shipments-mailbox.js");

exports.handler = scheduled.handler;
