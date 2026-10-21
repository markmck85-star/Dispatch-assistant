# MCR Dispatch Platform: Architecture

A decision-support tool for field-service dispatchers. Actual dispatching still happens in the customer's Salesforce; this app reads the same inbound email and reports, helps plan routes, and keeps the history. Written 2026-10-16. If something here disagrees with the code, trust the code and fix this file.

## Read this first: which copy of a file is live

The repo has duplicates. Only one copy of each is live.

- `netlify.toml` publishes the **repo root** (`publish = "."`). The live web pages are the `.html` files **in the root**: `index.html` (dispatch board), `state.html` (state console), `calendar.html`, `tech-portal.html`, and so on.
- Netlify functions are deployed from **`netlify/functions/`** (`functions = "netlify/functions"`). The live backend is the `.js` / `.mjs` files **in that folder** and its `lib/` subfolder.
- Duplicate copies were removed on 2026-10-16 (stale `.html` files inside `netlify/functions/`, and root-level `.js` files that were copies of functions). Do not recreate them.
- Exception: `digest-panel.js` and `update-check.js` in the **root** are live **browser scripts** that pages load with `<script src>`. They share a name with files in `netlify/functions/` (a function, not a script); the two are unrelated, so edit each in its own place.
- Rule: edit the root for pages, `netlify/functions/` for backend, and always start from a fresh copy of `main`, never from an earlier download.
- `_redirects` returns 404 for server code and config that would otherwise be downloadable from the published root (`/netlify/*`, `netlify.toml`, `package.json`, some root `.js` files). Any other file added to the root is publicly downloadable, so do not put server code there.

## Stack

- Static HTML pages (large single-file pages with inline JavaScript, no build step) plus Netlify Functions (Node, CommonJS).
- Supabase (Postgres) is the system of record. Functions use the service-role key; Row Level Security is on for every table with no policies, so browsers never query tables directly.
- Netlify Blobs: the original store, now mostly legacy; Supabase replaced it in stages.
- Mailgun: inbound email webhook, outbound email, and text messages sent through it.
- Headless Chromium (Playwright with `@sparticuz/chromium`) logs into Salesforce to export the closed-ticket report.
- Google Maps (geocoding and distance matrix), BlueFolder API, Web Push, and Google Gemini (`@google/genai`) for the embedded AI assistant.
- Secrets are Netlify environment variables (Supabase, Mailgun, mailbox credentials, Maps key, auth secret, push keys, MCP shared secret). None are in the repo.
- Deploys: every push to `main` auto-deploys. There is no staging site.

## Request path and auth

1. `netlify/edge-functions/gate.js` runs in front of every `/.netlify/functions/*` call. It requires the `mcr_auth` HttpOnly cookie unless the function is on its `PUBLIC` list (login, webhooks, the technician portal API, signed acknowledgement links). It has role tiers: public, admin-only, technician (mileage functions only), and everything else for any active dispatcher or admin.
2. `login.js` + `lib/auth.js`: username plus PIN/passphrase against the `dispatchers` table, lockout after repeated failures (`login_attempts`), a forced change on first login when flagged.
3. `tech-api.js` is the technician/staff portal backend with its own accounts (`tech_accounts`, `staff_accounts`), signed tokens, and server-side state scoping.
4. `mcp-server.js` exposes read-only tools to Claude custom connectors, protected by a shared secret.
5. Emergency switch: environment variable `AUTH_ENFORCE=0` lets everything through while logging.

## Data flow

**Inbound email (the main input).** The customer emails dispatch lists, trouble tickets, installs and site surveys to a Mailgun address. `mailgun-inbound.js` classifies and parses each message, stores it in `inbound_emails`, matches the site (`lib/address-match.js`, `site_aliases`, placeholder sites when nothing matches), and creates or updates `tickets` and `ticket_line_items`. Trouble tickets also trigger the "watchdog" alerts (text, plus push to subscribed phones). Quiet-hours and Saturday rules apply.

**Dispatch board (`index.html`).** The dispatcher pastes or loads the day's list; the page parses restock counts, auto-assigns technicians using `sites`, `technicians`, `tech_site_distances`, `site_site_distances`, availability and on-call data, and renders per-technician routes. Every action (Done, Cancel, reassign, push to another day, undo) is persisted through `save-assignment.js` into `assignments` (one row per site per dispatch date). `dispatch-ai.mjs` powers the embedded assistant (read tools plus route/reassignment commands with undo).

**Closed tickets and history.** A scheduled function triggers `salesforce-report-sync-background.mjs`, which drives headless Chromium through the Salesforce report export. Rows go through `lib/perform-import.js` into `site_visits` (matching sites and technicians) and close the matching tickets. `closings-sync`, `pull-state-closings` and `lib/closing-notes.js` attach closing notes. A manual xlsx upload path (`import-service-appointments.js`) reuses the same code.

**Other mailboxes.** `pull-mailbox.js` and `pull-shipments-mailbox.js` read IMAP mailboxes (service-response close-outs; shipment notices). `apply-service-responses.js` applies close-outs to tickets. `bluefolder-*` functions mirror service requests for locations outside Salesforce.

## Ticket status: the part that is easy to get wrong

- `tickets.status` is `open` or `closed`. It becomes `closed` through the closed-ticket import (`perform-import`) or applied service responses.
- `tickets.manually_resolved_at` (+ note) is a **separate** flag set by a dispatcher via `mark-ticket-resolved.js`. It is deliberately not the same as "closed", so a Salesforce-confirmed close and a local "I know this is done" stay distinguishable. Pages that care about "is this still outstanding" must check both.
- `get-watchdog-log.js` lists tickets with `status = open` **and** `manually_resolved_at IS NULL`, limited to the state/region asked for, and drops anything more than 4 days past its deadline.
- The board's Cancel button on a ticket-backed stop sets `manually_resolved_at` (note "canceled on board"); Undo clears it. Done changes only the assignment; the import normally closes the ticket.
- `assignments.status` is one of `planned`, `notified`, `completed`, `removed`. Pushing a stop to another day writes a `removed` row for the old day and a `planned` row for the new one. `assigned_by` is one of `auto`, `manual`, `fallback_rule`, `contractor_rule`.
- Georgia is an umbrella region in the watchdog (GA + NC + SC).

## Main tables

`sites` (+ `site_aliases`), `technicians` (+ availability, coverage, `on_call_schedule`), `dispatchers`, `tickets` (+ `ticket_line_items`), `inbound_emails`, `assignments`, `site_visits`, `tech_site_distances` / `site_site_distances` (precomputed driving distances), `shipments` / `consumable_shipments` / `rma_shipments`, `inventory_sheets`, mileage report and log tables, `push_subscriptions`, `app_settings`, `backups`. Many `*_backup_<date>` tables are one-off safety copies from data fixes and can be ignored.

## Scheduled jobs (from `netlify.toml`)

| What | Schedule |
|---|---|
| Salesforce report sync trigger | every 20 min |
| Shipments mailbox pull | every 20 min |
| Closings sync | every 2 h |
| Inventory date-text check | every 10 min |
| Closing-note forms-left reader (`extract-leftover-counts`) | hourly at :25 |
| Saturday alert reset | hourly |
| Morning summary push (8:00 AM in each dispatcher's own time zone, once per day) | every 15 min |
| Notification digests | disabled on purpose |

`check-report-sync-health.js` (added 2026-10-16) runs at :15/:35/:55 each hour. If the Salesforce sync has no successful run in 60 minutes it sends one alert (to `ALERT_EMAIL` / `ALERT_SMS_ADDRESS`) and stays quiet until a sync succeeds. It reads the same Blobs records the sync writes (`report-sync` store: `last-success`, `last-failure`, `in-progress`, `stale-alert-sent`).

`extract-leftover-counts` (added 2026-10-17) reads the exact forms-left number out of closing notes ("The left form count was 142 prior to restock") into `restock_leftover_counts` (`source = 'closing_note'`, no assignment). Rows typed in the portal Done prompt (`source = 'portal'`) win: a site and day that already has a row is skipped. Parser: `lib/leftover-from-notes.js` (also reads the short form "replaced forms at 157"). FL and NC counts are guesses (techs pull ~100 forms before installing), so those rows use `source = 'closing_note_approx'`. After each real run it calls `refresh_site_usage_rates()`, which fills `site_usage_rates` (forms used per day per site: (800 minus the count at a restock) over days since the previous forms restock; needs 3 clean intervals; FL/NC, zero counts, partial-roll starts and intervals with an uncounted restock in between are skipped). `estimate_site_counts(date)` estimates each rated site's count on a day (800 minus rate times days since its last forms restock). Backtest 2026-10-17: median error about 1 day of use, no bias. Backfill by hand while logged in: `/.netlify/functions/extract-leftover-counts-now?days=400` (add `&dry=1` to preview). The `-now` file is an unscheduled twin, since Netlify blocks URL calls to scheduled functions.

Journal paper (added 2026-10-20, because NC no longer issues registration decals): the kiosk journal count is in inches. The portal Done prompt asks for it when a restock includes journal paper and stores it as key `J` in `restock_leftover_counts.rolls` (0-20000; `refresh_site_usage_rates()` only reads LF/F/RF, so `J` does not touch the forms model). `get-journal-status` (GET `?state=NC&capacity=7000&trigger=2200`) estimates inches left per site from three reading sources (`dispatch_list_history`, `assignments.restock_form_counts`, portal `J` counts): a listing or portal count that replaced journal paper resets the site to a full roll (assumed 7000 in, adjustable), burn per day is the median of reading-to-reading drops with no replacement in between, and status compares the estimate to the low-paper trigger (about 2200 in, from NC list history). Sites with no pair of readings use the state-wide burn (flagged). `restock-tracker.html` has a Forms / Journal toggle (default Journal for NC). The 7000 in roll length is an assumption until confirmed.

Netlify does not let you call a scheduled function by URL, so some jobs have an unscheduled twin (for example `pull-shipments-now`).

## Pages

Dispatch board `index.html`; state console `state.html` (map, watchdog, restock schedule, recent tickets); `watchdog-log.html`; `calendar.html`; `saturday-oncall.html`; `service-responses.html`; `location-lookup.html`; `restock-tracker.html`; `shipments.html`; inventory pages; mileage pages; `tech-portal.html` (PWA for technicians); `admin.html`; `help.html`.

## Conventions

- Comments carry dates and the reason for a change. Keep that habit; it is the project's memory.
- Changes ship as complete files. Pages that dispatchers read must not contain internal names, billing talk or speculation; put that in code comments instead.
- Verify against the live database before assuming a column exists; schema has changed a lot (several early assumptions in old comments are out of date).

Add-site prompt (`showAddLocationPrompt` in `index.html`, shown for list codes the board does not know): since 2026-10-21 it starts from the pasted dispatch list itself. The name comes from the list row (`listNameForCode`, e.g. "Michigan City SSO 1" from "Michigan City SSO 1 - IN1146"), a row with P3 forms (3+ printers) defaults the machine type to BH (the dropdown now has BH), and the street address is looked up by list name in ticket text (`findAddressNearListName`) before falling back to searching emails for the code. Reason: a new site appears on the list before any email carries its code; Neumo's install tickets for Michigan City SSO (IN1146-1148, go-live 2026-09-22) are titled "IN - Michigan City BMV" with the BMV's mailing address, while the kiosks are at 1551 Woodland Avenue. `list-inbound-emails` takes an optional `maxChars` (default 900, max 4000) so addresses past the snippet cut can be read.

Decal change-out (DCO) tracker (`dco-tracker.html`, `netlify/functions/dco-status.js`, tables `dco_campaigns` and `dco_marks`; added 2026-10-21): one campaign per state with a dispatcher-set start and completion date. A site counts as done when a closing note on/after the start date says the change-out was performed (regex in the function; "no dco" / "needs dco" style notes become `review`), or when someone marks it on the page (done / not applicable, stored in `dco_marks`). The page shows progress, the pace needed per working day and a projected finish. Not built yet: per-printer tracking on 3-4 printer machines, a portal Done-prompt checkbox, and routing suggestions that bundle remaining sites with scheduled restocks or tickets (reuse the opportunistic-restock logic).

"DCO due" marker (2026-10-21): `dco-status?due=1` returns every site still needing a change-out in states with a running campaign (start date reached). `index.html` loads it once per session (5-minute cache) into `window.dcoDue` and shows a badge on board stops, the compact summary, the printed view and a "Also needs a DCO" line in tech messages (`dcoDueFor`, `dcoDueBadgeHtml`). The stop that is itself the change-out ticket is not marked. The old board-menu "DCO: ON/OFF" button became a checkbox on the messages screen.
