/**
 * get-watchdog-log.js — v5, 2026-09-29
 *
 * Netlify Function — surfaces every open ticket the SMS watchdog already
 * alerts dispatchers about, for a given state, so the same tickets are
 * visible in-app even to a dispatcher who hasn't enabled text alerts.
 *
 * v1 (2026-08-12) scoped this to site_id IS NULL, reasoning from the
 * dispatch-board gap (site_survey/Testing-Station tickets with no site
 * match are invisible there). That was too narrow: the SMS watchdog in
 * mailgun-inbound.js sends a text for EVERY dispatchType==='trouble'
 * ticket -- which covers ticket_kind 'trouble', 'install', and
 * 'site_survey' -- regardless of whether the ticket ever matched a real
 * site. Maintenance/restock tickets never trigger an SMS at all and are
 * correctly excluded here too.
 *
 * v3: a real 4-hour-SLA trouble ticket essentially never survives days
 * unaddressed in practice -- confirmed 2026-08-12 when a WO number
 * collision with a Neumo Salesforce sandbox/test ticket left a permanent,
 * never-closing phantom entry (SLA 8+ days past) sitting on this page.
 * Any ticket more than 4 calendar days PAST its own deadline (sla_ends_at
 * for trouble, due_at for install/site_survey) is dropped. Deliberately
 * deadline-based, not received-based -- a site_survey/install scheduled
 * several days out is still legitimately upcoming. Flat calendar days,
 * same cutoff in every state, per Mark's call.
 *
 * v4 (2026-09-26): added siteCode/siteName, joined from the ticket's own
 * site_id when matched.
 *
 * v5 (2026-09-29): TWO fixes, both found via NC1002 / WO 00150499 (a
 * TV Topper + restock email for a North Carolina site that never showed
 * on the watchdog with "Georgia / NC / SC" selected):
 *
 *  (1) REGION EXPANSION. The dropdown's "Georgia / NC / SC" option sends
 *      state=GA, but the state test below only ever matched tickets whose
 *      own state was literally GA -- so NC/SC tickets could never appear
 *      under it (and NC/SC aren't separate dropdown options either).
 *      GA is now treated as the umbrella region GA + NC + SC, matching
 *      how the dispatch board's Georgia / NC / SC region already works.
 *      Asking for state=NC or state=SC directly still works too.
 *
 *  (2) STATE DETECTION. The old test was site_text.slice(0,2) === state.
 *      That holds for trouble tickets ("GA1037 – Gwinnett..."), but every
 *      maintenance/restock ticket's site_text is "<SST number> / <site
 *      code>" (e.g. "102 / NC1002"), which starts with digits -- so any
 *      needs_review maintenance ticket (the branch this page has always
 *      claimed to include) was silently dropped for EVERY state. State is
 *      now taken from the matched site's own state when there is one,
 *      then a site code found anywhere in site_text, then the old
 *      prefix test, then attributes.routedState as a last resort.
 *
 * GET /.netlify/functions/get-watchdog-log?state=CO
 * -> { entries: [ { ticketId, woNumber, siteText, siteCode, siteName,
 *                    ticketKind, matched, issueCategory, issueDetail,
 *                    description, address, dueAt, slaEndsAt, receivedAt } ] }
 */
const { createClient } = require("@supabase/supabase-js");
const { computeSlaDeadline } = require("./slaCalculator.js");

const STALE_GRACE_DAYS = 4;
const STALE_GRACE_MS = STALE_GRACE_DAYS * 24 * 60 * 60 * 1000;

// Umbrella regions: the state a caller asks for -> every real state whose
// tickets belong under it. Only GA is an umbrella today (Gina's combined
// Georgia / NC / SC territory).
const REGION_MEMBERS = {
  GA: ["GA", "NC", "SC"],
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(obj),
  };
}

// Best-effort 2-letter state for a ticket row. Order matters: the matched
// site's real state is the most trustworthy signal; text-derived guesses
// only apply to unmatched tickets.
function ticketState(t) {
  if (t.sites && t.sites.state) return String(t.sites.state).toUpperCase();
  const text = t.site_text || "";
  const codeMatch = text.match(/\b([A-Z]{2})\d{3,5}(?![A-Z\d])/);
  if (codeMatch) return codeMatch[1];
  const prefix = text.slice(0, 2).toUpperCase();
  if (/^[A-Z]{2}$/.test(prefix)) return prefix;
  const routed = t.attributes && t.attributes.routedState;
  if (routed) return String(routed).toUpperCase();
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });

  const state = String((event.queryStringParameters || {}).state || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    return json(400, { error: "state query param (2-letter code) is required" });
  }
  const regionStates = REGION_MEMBERS[state] || [state];

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // ticket_kind IN ('trouble','install','site_survey') mirrors exactly
    // which tickets mailgun-inbound.js sends an SMS for. site_id is
    // intentionally NOT filtered on -- matched and unmatched tickets both
    // belong here.
    //
    // needs_review = true is included as a separate OR branch: a line item
    // added to an existing restock/maintenance ticket (or, as of
    // 2026-09-29, a restock email that also carries a non-restock line
    // item) never changes that ticket's ticket_kind, so without this
    // branch those tickets would never appear here.
    //
    // sites(site_code, name, state): the real matched site, when there is
    // one -- see the v4/v5 header notes.
    const { data, error } = await supabase
      .from("tickets")
      .select("id, wo_number, site_text, site_id, ticket_kind, needs_review, issue_category, issue_detail, description, address, due_at, sla_ends_at, earliest_start_at, received_at, status, attributes, loomis_meet_status, loomis_meet_confirmed_at, loomis_meet_last_contact_at, sites(site_code, name, state)")
      .or("ticket_kind.in.(trouble,install,site_survey),needs_review.eq.true")
      .eq("status", "open")
      .order("received_at", { ascending: false });

    if (error) return json(500, { error: error.message });

    const now = Date.now();

    const entries = (data || [])
      .filter((t) => {
        const st = ticketState(t);
        return !!st && regionStates.includes(st);
      })
      .filter((t) => {
        // Deadline-based staleness cutoff -- see v3 note above. sla_ends_at
        // (trouble) takes priority over due_at (maintenance/needs_review
        // fallback), EXCEPT for install/site_survey: earliest_start_at
        // (Neumo's "Earliest Start Permitted") is the genuine scheduled
        // time and is what gates staleness for those. A ticket with
        // NEITHER field set is kept rather than silently dropped.
        const isInstallOrSurvey = t.ticket_kind === 'install' || t.ticket_kind === 'site_survey';
        const deadline = isInstallOrSurvey
          ? (t.earliest_start_at || t.due_at)
          : (t.sla_ends_at || t.due_at);
        if (!deadline) return true;
        const deadlineMs = new Date(deadline).getTime();
        if (Number.isNaN(deadlineMs)) return true;
        return (now - deadlineMs) <= STALE_GRACE_MS;
      })
      .map((t) => {
        // computedSlaDeadline replaces the unreliable email-stated deadline
        // for trouble tickets: 4 business hours (8am-5pm), in the site's
        // own local timezone, skipping non-business days per state
        // Saturday-coverage rules, Sundays, and holidays. Only trouble
        // tickets get this; "Armored Truck Meet" is excluded (blocked on a
        // multi-day Loomis scheduling negotiation, not a response-time SLA).
        const isArmoredTruckMeet = (t.issue_category || '').trim().toLowerCase() === 'armored truck meet';
        let computedSlaDeadline = null;
        if (t.ticket_kind === "trouble" && !isArmoredTruckMeet && t.received_at) {
          try {
            // v5: the ticket's own state (not the requested region code)
            // is the right fallback for timezone lookup -- an NC ticket
            // requested via the GA region is still an Eastern-time NC site.
            computedSlaDeadline = computeSlaDeadline(t.received_at, t.address, ticketState(t) || state);
          } catch (e) {
            computedSlaDeadline = null;
          }
        }

        return {
          ticketId: t.id,
          woNumber: t.wo_number,
          siteText: t.site_text,
          siteCode: t.sites ? t.sites.site_code : null,
          siteName: t.sites ? t.sites.name : null,
          ticketKind: t.ticket_kind,
          needsReview: !!t.needs_review,
          matched: !!t.site_id,
          issueCategory: t.issue_category,
          issueDetail: t.issue_detail,
          description: t.description,
          address: t.address,
          dueAt: t.due_at,
          slaEndsAt: t.sla_ends_at,
          earliestStartAt: t.earliest_start_at,
          computedSlaDeadline,
          receivedAt: t.received_at,
          loomisMeetStatus: t.loomis_meet_status || null,
          loomisMeetConfirmedAt: t.loomis_meet_confirmed_at || null,
          loomisMeetLastContactAt: t.loomis_meet_last_contact_at || null,
        };
      });

    return json(200, { entries });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
