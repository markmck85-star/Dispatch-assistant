// check-report-sync-health.js -- scheduled at :15, :35 and :55 of every hour
// (see netlify.toml).
//
// Watches the automated Salesforce closed-ticket report sync
// (salesforce-report-sync-background.mjs). That sync runs every 20 minutes and
// writes a "last-success" record to the Netlify Blobs store "report-sync" each
// time it finishes. If no successful run has been recorded for more than
// 60 minutes, closed-ticket data on the dispatch pages is going stale, so this
// sends ONE alert and then stays quiet until the sync has recovered.
//
// Why a separate check at all: the sync already emails when a run fails with an
// error, but it cannot report on itself when it never runs (a broken schedule,
// a crashed container, an expired login that stalls before the error path).
// This catches the silence.
//
// Alert once per outage: the "stale-alert-sent" blob marks that an alert has
// gone out. recordSuccess() in the sync deletes that marker, so the next
// outage alerts again. restock-tracker.html mirrors the same 60-minute
// threshold in its yellow/red freshness banner, so keep the two in step.
//
// Alerts go to ALERT_EMAIL and, if set, ALERT_SMS_ADDRESS, through Mailgun --
// the same variables and sender the sync itself uses.
//
// Nothing here may throw: a scheduled function that errors repeatedly only adds
// noise. Every failure is logged and swallowed.

const { getStore, connectLambda } = require("@netlify/blobs");

const STALE_AFTER_MIN = 60;

async function sendAlert(subject, body) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN || "mcrdispatch.net";
  const to = [process.env.ALERT_EMAIL, process.env.ALERT_SMS_ADDRESS].filter(Boolean).join(",");
  if (!apiKey) {
    console.error("[check-report-sync-health] Cannot send alert -- MAILGUN_API_KEY not set:", subject);
    return false;
  }
  if (!to) {
    console.error("[check-report-sync-health] Cannot send alert -- no ALERT_EMAIL/ALERT_SMS_ADDRESS set:", subject);
    return false;
  }
  try {
    const params = new URLSearchParams({
      from: `MCR Dispatch <dispatch@${domain}>`,
      to,
      subject,
      text: body,
    });
    const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`api:${apiKey}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!res.ok) {
      console.error("[check-report-sync-health] Mailgun refused the alert:", res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[check-report-sync-health] Alert send failed:", err.message);
    return false;
  }
}

async function readJson(store, key) {
  try {
    const raw = await store.get(key, { type: "json" });
    return raw || null;
  } catch (e) {
    return null;
  }
}

exports.handler = async (event) => {
  try {
    try { connectLambda(event); } catch (e) { /* not needed outside the Lambda-compat runtime */ }
    const store = getStore("report-sync");

    const lastSuccess = await readJson(store, "last-success");
    if (!lastSuccess || !lastSuccess.at) {
      // Never succeeded (new site, or Blobs wiped): there is nothing to compare
      // against, and the sync's own failure alerts already cover a first-run problem.
      console.log("[check-report-sync-health] No last-success record yet -- nothing to check.");
      return { statusCode: 200, body: JSON.stringify({ ok: true, stale: false, reason: "no-record" }) };
    }

    const lastMs = new Date(lastSuccess.at).getTime();
    if (Number.isNaN(lastMs)) {
      console.error("[check-report-sync-health] last-success.at is not a valid date:", lastSuccess.at);
      return { statusCode: 200, body: JSON.stringify({ ok: true, stale: false, reason: "bad-timestamp" }) };
    }

    const minsAgo = Math.round((Date.now() - lastMs) / 60000);
    if (minsAgo <= STALE_AFTER_MIN) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, stale: false, minsAgo }) };
    }

    const alreadySent = await readJson(store, "stale-alert-sent");
    if (alreadySent) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, stale: true, minsAgo, alerted: false, reason: "already-alerted" }) };
    }

    // Context for whoever reads the alert: is a run in progress, and what was the last error?
    const inProgress = await readJson(store, "in-progress");
    const lastFailure = await readJson(store, "last-failure");
    const hrs = (minsAgo / 60).toFixed(1);
    const lines = [
      `The automated closed-ticket report sync has not succeeded in ${minsAgo} minutes (${hrs} hours).`,
      `Last successful sync: ${lastSuccess.at}`,
      inProgress
        ? `A run is marked in progress (started ${inProgress.startedAt || "unknown"}, stage: ${inProgress.stage || "unknown"}). If that start time is old, the run likely crashed and left its flag behind.`
        : "No run is currently marked in progress.",
      lastFailure
        ? `Most recent recorded failure (${lastFailure.at || "unknown time"}): ${lastFailure.reason || "no reason recorded"}`
        : "No failure has been recorded, which usually means the sync is not being triggered at all.",
      "",
      "Closed-ticket data on the dispatch pages will keep getting stale until this is fixed. You can try the Refresh Now button on the state console, or check the function logs for salesforce-report-sync-trigger and salesforce-report-sync-background.",
      "This alert is sent once per outage and resets when a sync succeeds.",
    ];

    const sent = await sendAlert("⚠️ Salesforce report sync has gone quiet", lines.join("\n"));
    if (sent) {
      try {
        await store.set("stale-alert-sent", JSON.stringify({ at: new Date().toISOString(), minsAgo }));
      } catch (e) {
        console.error("[check-report-sync-health] Could not record that the alert was sent:", e.message);
      }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, stale: true, minsAgo, alerted: sent }) };
  } catch (e) {
    console.error("[check-report-sync-health] error:", e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: "Check failed." }) };
  }
};
