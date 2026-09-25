/**
 * closings-sync.js
 * Scheduled closer: one state per run so we stay under Netlify's
 * 26s cap. Walks MI → OH → NV → CO. Each box gets hit about
 * three times a day with schedule 0 */2 * * * (UTC).
 *
 * Reuses pull-state-closings + apply-service-responses.
 * No secrets here.
 */
const { getStore, connectLambda } = require("@netlify/blobs");
const pull = require("./pull-state-closings");
const apply = require("./apply-service-responses");

const STATES = ["MI", "OH", "NV", "CO"];
const KEY = "closings-sync-rotate";

function json(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function sinceDays(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  try { connectLambda(event); } catch {}
  const store = getStore("dispatch");
  let saved = {};
  try { saved = (await store.get(KEY, { type: "json" })) || {}; } catch { saved = {}; }
  const idx = Number(saved.idx || 0) % STATES.length;
  const state = STATES[idx];
  const since = sinceDays(14);

  const pullEvent = {
    httpMethod: "GET",
    queryStringParameters: { state, loop: "1", since },
    headers: event.headers || {},
    rawUrl: event.rawUrl,
    rawQuery: event.rawQuery,
  };
  const applyEvent = {
    httpMethod: "GET",
    queryStringParameters: { state, limit: "80" },
    headers: event.headers || {},
  };

  const pullRes = await pull.handler(pullEvent);
  let pullBody = {};
  try { pullBody = JSON.parse(pullRes.body || "{}"); } catch { pullBody = { raw: pullRes.body }; }

  const applyRes = await apply.handler(applyEvent);
  let applyBody = {};
  try { applyBody = JSON.parse(applyRes.body || "{}"); } catch { applyBody = { raw: applyRes.body }; }

  const next = (idx + 1) % STATES.length;
  await store.setJSON(KEY, { idx: next, lastState: state, at: new Date().toISOString() });

  return json(200, {
    ok: true,
    state,
    next: STATES[next],
    pull: {
      inserted: pullBody.inserted,
      skipped: pullBody.skipped,
      found: pullBody.found,
      error: pullBody.error,
    },
    apply: {
      closed: applyBody.closed,
      unmatched: applyBody.unmatched,
      examined: applyBody.examined,
      error: applyBody.error,
    },
  });
};
