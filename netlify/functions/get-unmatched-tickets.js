/**
 * get-unmatched-tickets.js — v3 — updated 2026-09-18
 *
 * Netlify Function — surfaces open trouble/maintenance tickets that never
 * matched an existing site (site_id IS NULL), so the dispatch board can
 * automatically trigger the "Add Location" toast for them instead of
 * requiring the dispatcher to notice one is missing and manually paste its
 * code into the Location Codes box first. Built after a real backlog of
 * these was found sitting invisible (CO - Fremont County Canon City MV,
 * several MI SOS offices, OH - Salem BMV, etc.) with nowhere in the app
 * surfacing them.
 *
 * v2: Mark pointed out the toast only pre-filled the location NAME, even
 * though every real trouble/maintenance ticket also includes the site's
 * PC Name/code and street address -- he'd been manually re-opening the
 * same ticket email to find both and retype them. Checked and confirmed:
 * the code was already being captured into attributes.rawSiteCode this
 * whole time (site_id is null because that code doesn't match an EXISTING
 * site yet -- a genuinely new location -- not because no code was found),
 * it just was never exposed here. Address genuinely wasn't captured
 * anywhere before this -- added to mailgun-inbound.js's parser and a new
 * tickets.address column same day. Now exposes both, so the toast can be
 * close to fully pre-filled rather than just the name.
 *
 * v3: added a second auto-suggest namespace for locations that generate
 * "OTC"-subject POD-printer tickets but have no numbered kiosk at all --
 * these never get a Neumo-assigned code the way a real SST does, the same
 * gap T-codes solved for K2D testing stations. This reuses the STATE+C+NNN
 * convention (e.g. OHC003) already established in an earlier session
 * (OHC001/OHC002 already existed) -- corrected here same day after briefly
 * floating STATE+P+NNN before that earlier convention was remembered; P
 * never shipped anywhere but this file. Mark's own framing: if a location
 * already has a real numbered kiosk on site, its POD-printer tickets
 * should link to THAT existing site_code, not get a separate C-code just
 * because the ticket's subject says OTC -- a C-code is only for genuinely
 * kiosk-less locations. Since the OTC subject token alone can't
 * distinguish those two cases (a site can have both a kiosk and POD
 * printers), this reuses the same street-number + first-street-word
 * address-signature check already used elsewhere (the ticket-driven
 * Add-Location toast's duplicate-address safety net) to see whether ANY
 * existing site in this state already sits at that address before
 * offering a new C-code. A match found there means this ticket almost
 * certainly belongs to an existing numbered site whose account-name text
 * just didn't line up -- so it's left for manual linking instead, exactly
 * like any other raw-text mismatch, rather than risking a duplicate site
 * record.
 *
 * Scoped to ticket_kind IN ('trouble','maintenance') only -- site_survey
 * tickets are deliberately excluded. Mark's plan for those is a separate,
 * not-yet-built "temporary category, promoted to a real site once the
 * install happens" concept -- auto-prompting to create a permanent site
 * record from a survey (which may never become a real install) would be
 * premature.
 *
 * GET /.netlify/functions/get-unmatched-tickets?state=CO
 * -> { unmatched: [ { ticketId, woNumber, siteText, suggestedName,
 *                      suggestedCode, autoSuggested, suggestedCodeType,
 *                      possibleExistingSite, suggestedAddress,
 *                      issueCategory, issueDetail, receivedAt } ] }
 */
const { createClient } = require("@supabase/supabase-js");

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

// Same lightweight signature used by the ticket-driven Add-Location toast's
// duplicate-address safety net: leading street number + first alphabetic
// street-name word, lowercased. Good enough to catch "same building,
// different text" without needing a real geocode round trip here.
function addressSignature(address) {
  if (!address) return null;
  const m = String(address).match(/(\d+)\s+([A-Za-z]+)/);
  if (!m) return null;
  return `${m[1]}|${m[2].toLowerCase()}`;
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

    const { data, error } = await supabase
      .from("tickets")
      .select("id, wo_number, site_text, ticket_kind, issue_category, issue_detail, address, attributes, received_at, inbound_emails(subject)")
      .is("site_id", null)
      .in("ticket_kind", ["trouble", "maintenance"])
      .eq("status", "open")
      .order("received_at", { ascending: false });

    if (error) return json(500, { error: error.message });

    // T-codes: testing-station tickets, added 2026-08-30. Neumo's own
    // dispatch email subject line carries a clean asset-type token
    // distinguishing these: "Tech Dispatch - K2D - ..." for testing
    // stations, vs. "SST" for real kiosk installs and "OTC" for
    // over-the-counter/state-office consumable service -- confirmed
    // against every K2D-subject ticket on file (30/30, matched or not)
    // mapping to a genuine testing-station site, with zero false
    // positives on real kiosk installs at BMV/SOS offices (which show
    // "SST" instead). T is MCR's own invented namespace (Neumo has no
    // equivalent numbering for these at all), so there's no risk of
    // colliding with a real upstream code the way there would be for
    // normal numeric codes.
    const HAS_REAL_CODE = /^[A-Z]{2}\d{3,5}/;
    let nextTNum = null; // lazy-loaded only if this state actually has a candidate this run
    let nextCNum = null; // same, for C-codes
    let stateSiteSignatures = null; // lazy-loaded set of address signatures for every site already in this state

    const unmatched = [];
    for (const t of (data || [])) {
      if (!t.site_text || t.site_text.slice(0, 2).toUpperCase() !== state) continue;

      const suggestedName = t.site_text
        .replace(/^[A-Z]{2}\d{3,5}\s*[-\u2013]\s*/, "")
        .replace(/^[A-Z]{2}\s*[-\u2013]\s*/, "")
        .trim();
      const rawSiteCode = (t.attributes && t.attributes.rawSiteCode) || "";
      const subject = (t.inbound_emails && t.inbound_emails.subject) || "";
      const isTestingStation = /\bK2D\b/i.test(subject);
      const isOtc = /\bOTC\b/i.test(subject);

      let suggestedCode = rawSiteCode;
      let autoSuggested = false;
      let suggestedCodeType = null;
      let possibleExistingSite = null;

      if (!suggestedCode && !HAS_REAL_CODE.test(t.site_text) && isTestingStation) {
        if (nextTNum === null) {
          const { data: tCodes } = await supabase
            .from("sites")
            .select("site_code")
            .ilike("site_code", `${state}T%`);
          let maxN = 0;
          for (const s of (tCodes || [])) {
            const m = s.site_code.match(new RegExp(`^${state}T(\\d+)$`));
            if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
          }
          nextTNum = maxN;
        }
        nextTNum += 1;
        suggestedCode = `${state}T${String(nextTNum).padStart(3, "0")}`;
        autoSuggested = true;
        suggestedCodeType = "testing_station";
      } else if (!suggestedCode && !HAS_REAL_CODE.test(t.site_text) && isOtc && t.address) {
        if (stateSiteSignatures === null) {
          const { data: stateSites } = await supabase
            .from("sites")
            .select("site_code, address")
            .eq("state", state);
          stateSiteSignatures = new Map();
          for (const s of (stateSites || [])) {
            const sig = addressSignature(s.address);
            if (sig) stateSiteSignatures.set(sig, s.site_code);
          }
        }
        const ticketSig = addressSignature(t.address);
        const existingMatch = ticketSig ? stateSiteSignatures.get(ticketSig) : null;

        if (existingMatch) {
          // A site already sits at this address -- almost certainly the
          // same physical location under different account-name text, so
          // don't offer a new C-code. Flag it for manual linking instead.
          possibleExistingSite = existingMatch;
        } else {
          if (nextCNum === null) {
            const { data: cCodes } = await supabase
              .from("sites")
              .select("site_code")
              .ilike("site_code", `${state}C%`);
            let maxN = 0;
            for (const s of (cCodes || [])) {
              const m = s.site_code.match(new RegExp(`^${state}C(\\d+)$`));
              if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
            }
            nextCNum = maxN;
          }
          nextCNum += 1;
          suggestedCode = `${state}C${String(nextCNum).padStart(3, "0")}`;
          autoSuggested = true;
          suggestedCodeType = "otc_no_kiosk";
        }
      }

      unmatched.push({
        ticketId: t.id,
        woNumber: t.wo_number,
        siteText: t.site_text,
        suggestedName,
        suggestedCode,
        autoSuggested,
        suggestedCodeType,
        possibleExistingSite,
        isTestingStation,
        suggestedAddress: t.address || "",
        issueCategory: t.issue_category,
        issueDetail: t.issue_detail,
        receivedAt: t.received_at,
      });
    }

    return json(200, { unmatched });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
