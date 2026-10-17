/**
 * sms-optin.js — v1, 2026-10-17
 *
 * Public endpoint behind the SMS consent form on the company website
 * (mcrtechservice.com/sms-optin). Records each sign-up, with the exact consent
 * wording shown at the time, in public.sms_consents so there is proof of opt-in
 * for the carrier / Twilio toll-free verification.
 *
 * POST JSON { name, phone, consent: true, website: "" }
 *   website is a honeypot: real people leave it empty.
 * -> { ok: true } or { ok: false, error }
 *
 * Public on purpose (listed in PUBLIC in netlify/edge-functions/gate.js). Guards:
 * required fields, US phone normalised to E.164, honeypot, and a per-IP limit.
 * It only ever INSERTS; it never reads sign-ups back to the caller.
 */
const { createClient } = require("@supabase/supabase-js");

// Must match, word for word, the consent text printed beside the checkbox on the
// public page. Bump the version if the page wording changes.
const CONSENT_VERSION = "2026-10-17";
const CONSENT_TEXT =
  "I agree to receive text messages from MCR Technical Service, LLC with dispatch and service ticket alerts " +
  "for field staff. Message frequency varies, typically a few messages per day. Message and data rates may apply. " +
  "Reply STOP to cancel and HELP for help. Agreeing is optional and is not a condition of employment or assignment. " +
  "I have read the Privacy Policy and Terms.";

const ALLOWED_ORIGINS = ["https://mcrtechservice.com", "https://www.mcrtechservice.com"];

function cors(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
  if (ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function reply(event, statusCode, obj) {
  return {
    statusCode,
    headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, cors(event)),
    body: JSON.stringify(obj),
  };
}

function toE164(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return reply(event, 200, {});
  if (event.httpMethod !== "POST") return reply(event, 405, { ok: false, error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(event, 400, { ok: false, error: "Bad request" }); }

  // Honeypot: pretend success so bots learn nothing.
  if (body.website) return reply(event, 200, { ok: true });

  const name = String(body.name || "").trim().replace(/\s+/g, " ");
  const phone = toE164(body.phone);
  if (name.length < 2 || name.length > 80) return reply(event, 400, { ok: false, error: "Please enter your full name." });
  if (!phone) return reply(event, 400, { ok: false, error: "Please enter a valid 10-digit US mobile number." });
  if (body.consent !== true) return reply(event, 400, { ok: false, error: "Please check the box to agree to receive text messages." });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return reply(event, 500, { ok: false, error: "Sign-up is temporarily unavailable. Please try again later." });
  }

  const ip = String((event.headers && (event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"])) || "").split(",")[0].trim() || null;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (ip) {
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count } = await supabase.from("sms_consents").select("id", { count: "exact", head: true }).eq("ip", ip).gte("created_at", since);
      if ((count || 0) >= 5) return reply(event, 429, { ok: false, error: "Too many sign-ups from this connection. Please try again later." });
    }
    const { error } = await supabase.from("sms_consents").insert({
      full_name: name,
      phone_e164: phone,
      consent_given: true,
      consent_text: CONSENT_TEXT,
      consent_text_version: CONSENT_VERSION,
      page_url: String((event.headers && (event.headers.referer || event.headers.Referer)) || "").slice(0, 300) || null,
      ip,
      user_agent: String((event.headers && event.headers["user-agent"]) || "").slice(0, 300) || null,
    });
    if (error) return reply(event, 500, { ok: false, error: "Could not save your sign-up. Please try again." });
    return reply(event, 200, { ok: true });
  } catch (e) {
    return reply(event, 500, { ok: false, error: "Could not save your sign-up. Please try again." });
  }
};

exports.CONSENT_TEXT = CONSENT_TEXT;
exports.CONSENT_VERSION = CONSENT_VERSION;
