/**
 * get-watchdog-log.js — v3, scope-limited 2026-08-12
 *
 * Netlify Function — surfaces every open ticket the SMS watchdog already
 * alerts dispatchers about, for a given state, so the same tickets are
 * visible in-app even to a dispatcher who hasn't enabled text alerts.
 *
 * v1 (same day) scoped this to site_id IS NULL, reasoning from the
 * dispatch-board gap (site_survey/Testing-Station tickets with no site
 * match are invisible there). That was too narrow: the SMS watchdog in
 * mailgun-inbound.js sends a text for EVERY dispatchType==='trouble'
 * ticket -- which covers ticket_kind 'trouble', 'install', and
 * 'site_survey' -- regardless of whether the ticket ever matched a real
 * site. A properly-matched, SLA-bound trouble ticket (e.g. WO 00149456,
 * FL1045) already shows up fine on the board/state console, but Mark's
 * actual ask was to mirror the SMS content itself -- these "burn bright"
 * tickets (real service-window/SLA urgency, or the odd install/survey
 * categories that don't fit normal restock/trouble flow) -- not just the
 * subset that also happens to be unmatched. Maintenance/restock tickets
 * never trigger an SMS at all and are correctly excluded here too.
 *
 * v3: a real 4-hour-SLA trouble ticket essentially never survives days
 * unaddressed in practice -- confirmed 2026-08-12 when a WO number
 * collision with a Neumo Salesforce sandbox/test ticket left a permanent,
 * never-closing phantom entry (SLA 8+ days past) sitting on this page,
 * which briefly looked like a real critical miss. Rather than chase every
 * individual bad-data case, cap the window: any ticket more than 4
 * calendar days PAST its own deadline (sla_ends_at for trouble, due_at
 * for install/site_survey) is dropped. Deliberately deadline-based, not
 * received-based -- a site_survey/install scheduled several days out is
 * still legitimately upcoming and must stay visible until ITS OWN date
 * passes, even if it was received a while ago. No Saturday-coverage/
 * business-day logic needed -- flat calendar days, same cutoff in every
 * state, per Mark's call.
 *
 * v4 (2026-09-26): added siteCode/siteName, joined from the ticket's own
 * site_id when matched. Found via the Saturday on-call page showing "MI -
 * Wyoming SOS" instead of the real site name for two properly-matched
 * tickets (MIT038, MI1018) -- site_text is the ticket's own raw/stored
 * text and does NOT reliably start with the real site code (only true for
 * tickets whose raw Neumo text happened to embed it; a ticket matched via
 * WO number, PC name, or a site_aliases entry has no such guarantee).
 * Every consumer of this endpoint that needs the actual matched site
 * should use siteCode now instead of re-deriving one from site_text.
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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });

  const state = String((event.queryStringParameters || {}).state || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    return json(400, { error: "state query param (2-letter code) is required" });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // ticket_kind IN ('trouble','install','site_survey') mirrors exactly
    // which tickets mailgun-inbound.js sends an SMS for (dispatchType ===
    // 'trouble', which is the parse-template that produces all three
    // kinds). site_id is intentionally NOT filtered on -- matched and
    // unmatched tickets both belong here.
    //
    // needs_review = true is included as a separate OR branch: a line item
    // added to an existing restock/maintenance ticket never changes that
    // ticket's ticket_kind (mailgun-inbound.js only sets needs_review on
    // it), so without this branch those tickets -- exactly the ones with
    // possible SLA impact that prompted this page -- would never appear
    // here no matter what SMS notification hours are configured.
    //
    // sites(site_code, name): the real matched site, when there is one --
    // see the v4 header note for why site_text alone isn't a safe way to
    // derive this.
    const { data, error } = await supabase
      .from("tickets")
      .select("id, wo_number, site_text, site_id, ticket_kind, needs_review, issue_category, issue_detail, description, address, due_at, sla_ends_at, earliest_start_at, received_at, status, loomis_meet_status, loomis_meet_confirmed_at, loomis_meet_last_contact_at, sites(site_code, name)")
      .or("ticket_kind.in.(trouble,install,site_survey),needs_review.eq.true")
      .eq("status", "open")
      .order("received_at", { ascending: false });

    if (error) return json(500, { error: error.message });

    const now = Date.now();

    // site_text always starts with the site code (which starts with the
    // state abbreviation) when a code was found, or the raw "XX - ..."
    // account/location text when it wasn't -- same convention relied on
    // by get-unmatched-tickets.js, and true regardless of match status.
    const entries = (data || [])
      .filter((t) => t.site_text && t.site_text.slice(0, 2).toUpperCase() === state)
      .filter((t) => {
        // Deadline-based staleness cutoff -- see v3 note above. sla_ends_at
        // (trouble) takes priority over due_at (maintenance/needs_review
        // fallback), EXCEPT for install/site_survey: as of 2026-09-10
        // those never get an sla_ends_at at all (see mailgun-inbound.js --
        // it's not a real deadline for these, just a stale receipt-
        // anchored calculation), and their own "Due Date" field is
        // boilerplate too (5 PM end-of-window, not the actual appointment)
        // -- earliest_start_at (Neumo's "Earliest Start Permitted") is the
        // genuine scheduled time and is what should gate staleness here. A
        // ticket with NEITHER field set (shouldn't happen in practice) is
        // kept rather than silently dropped.
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
        // own local timezone (derived from its zip -- receivedAt arrives
        // in Eastern regardless of site state), skipping non-business days
        // per state Saturday-coverage rules, Sundays, and holidays.
        // Decision 2026-09-07 (superseded 2026-09-10 below): only trouble
        // tickets get this treatment -- install/site_survey never did.
        // slaEndsAt (raw email value) is left in place alongside it rather
        // than overwritten, so nothing else reading this endpoint breaks.
        // 2026-09-22: an "Armored Truck Meet" ticket isn't a response-time
        // SLA item -- it's blocked on a multi-day Loomis scheduling
        // negotiation (see loomis_meet_status/mailgun-inbound.js), so the
        // normal 4-business-hour computation would just be false-overdue
        // noise for it, same reasoning as install/site_survey above.
        const isArmoredTruckMeet = (t.issue_category || '').trim().toLowerCase() === 'armored truck meet';
        let computedSlaDeadline = null;
        if (t.ticket_kind === "trouble" && !isArmoredTruckMeet && t.received_at) {
          try {
            computedSlaDeadline = computeSlaDeadline(t.received_at, t.address, state);
          } catch (e) {
            // Missing/unparseable zip AND no state fallback configured --
            // surface as null rather than failing the whole request.
            computedSlaDeadline = null;
          }
        }

        return {
          ticketId: t.id,
          woNumber: t.wo_number,
          siteText: t.site_text,
          // v4: the real matched site, if any -- null for a genuinely
          // unmatched ticket, which is a real and different case from a
          // matched ticket whose raw text just didn't embed the code.
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
          // 2026-09-10: the real scheduled appointment time for
          // install/site_survey -- see the filter comment above for why
          // this replaced sla_ends_at/due_at as the meaningful deadline
          // for these two kinds specifically.
          earliestStartAt: t.earliest_start_at,
          computedSlaDeadline,
          receivedAt: t.received_at,
          // 2026-09-22: null for every ticket except Armored Truck Meet --
          // lets the frontend show a "Loomis: confirmed Fri 9/26 @ 10am" /
          // "Awaiting Loomis (proposed, no reply Xd)" badge in place of an
          // SLA countdown for this one category.
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
