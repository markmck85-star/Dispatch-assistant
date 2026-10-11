/**
 * recover-inventory-mail.js  (v3, 2026-10-11)
 * SAVE AS: netlify/functions/recover-inventory-mail.js
 *
 * Finds recent inventory emails in Mailgun's own stored copy of the mail, opens
 * their attachments with the same reader the app uses, and says exactly which
 * ones are readable and why the others are not. With save = true it also puts
 * the files the app missed into the private inventory-sheets bucket and the
 * inventory_sheets table (counts when readable, the reason when not), so they
 * show on the inventory board.
 *
 * Why it exists: on 2026-10-10/11 four real count sheets arrived and were dropped
 * without a trace. Mailgun keeps each received message for a few days, but the
 * stored copy can only be read with the account API key, which this server has.
 *
 * v2: split into two quick steps so no single call runs long.
 *   step "list" (default): returns the candidate messages only.
 *   step "one": opens one stored message (storageUrl from the list) and its attachments.
 * POST JSON { username, pin, step?, hours?, match?, save?, item? }
 *   username, pin  an admin dispatcher login (same check as Quick Add)
 *   hours          how far back to look, default 72 (max 168)
 *   match          optional text; only mail whose sender or subject contains it
 *   save           true to store what is missing; omitted or false = look only
 *
 * Needs: MAILGUN_API_KEY (already set), optional MAILGUN_DOMAIN (default
 * mcrdispatch.net) and MAILGUN_API_BASE (default https://api.mailgun.net).
 * Mailgun only keeps stored messages for a limited time (about 3 days on most
 * plans), so older mail can no longer be recovered this way.
 */
const { createClient } = require("@supabase/supabase-js");
const { inspectInventoryAttachment } = require("./lib/inventory-sheet.js");
const { verifyQuickAddAdmin } = require("./distance-matrix-quickadd-auth.js");

const KEEP_EXT = /\.(xlsx|xlsm|xls|csv|pdf|docx?|png|jpe?g|heic|gif)$/i;
const MAX_CANDIDATES = 40;

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(obj) };
}

async function mg(url, apiKey, accept) {
  const headers = { Authorization: "Basic " + Buffer.from("api:" + apiKey).toString("base64") };
  if (accept) headers.Accept = accept;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 7000);
  try {
    const resp = await fetch(url, { headers, signal: ctl.signal });
    if (!resp.ok) {
      let snip = "";
      try { snip = (await resp.text()).replace(/\s+/g, " ").slice(0, 120); } catch (e) {}
      let host = "";
      try { host = new URL(url).hostname; } catch (e) {}
      throw new Error("Mailgun " + resp.status + " at " + host + (snip ? " (" + snip + ")" : ""));
    }
    return resp;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Mailgun was too slow to answer");
    throw e;
  } finally { clearTimeout(t); }
}

function mailgunHostOk(u) {
  try { const x = new URL(u); return x.protocol === "https:" && /(^|\.)mailgun\.net$/i.test(x.hostname); } catch (e) { return false; }
}

async function listStoredEvents(base, domain, apiKey, cutoffSec, match) {
  const out = [];
  const seen = new Set();
  const started = Date.now();
  // oldest first from the cutoff forward, so the window is bounded at the source
  let url = base + "/v3/" + domain + "/events?event=accepted&ascending=yes&limit=300&begin=" + Math.floor(cutoffSec);
  for (let page = 0; page < 6 && url; page++) {
    if (Date.now() - started > 6000) break;
    const resp = await mg(url, apiKey);
    const data = await resp.json();
    const items = data.items || [];
    if (!items.length) break;
    for (const it of items) {
      const st = it.storage || {};
      if (!st.url || !st.key || seen.has(st.key)) continue;
      const msg = it.message || {};
      const h = msg.headers || {};
      const atts = msg.attachments || [];
      if (!atts.length) continue;
      const subject = String(h.subject || "");
      const from = String(h.from || "");
      const names = atts.map((a) => a.filename || a.name || "").join(" ");
      const inventoryish = /inventory/i.test(subject) || /inventory|SST\s*-\s*MCR/i.test(names) || /SST\s*-\s*MCR/i.test(subject);
      if (match) {
        if (!(from + " " + subject + " " + names).toLowerCase().includes(String(match).toLowerCase())) continue;
      } else if (!inventoryish) continue;
      seen.add(st.key);
      out.push({ ts: it.timestamp, storageUrl: st.url, from, subject, messageId: String(h["message-id"] || "").replace(/^<|>$/g, "") });
    }
    url = data.paging && data.paging.next ? data.paging.next : null;
  }
  return out;
}

async function processOne(supabase, apiKey, base, c, save) {
  const res = { receivedAt: new Date(c.ts * 1000).toISOString(), from: c.from, subject: c.subject, emailRow: false, attachments: [] };
  try {
    let msgResp;
    try {
      msgResp = await mg(c.storageUrl, apiKey);
    } catch (e1) {
      // second try: the same stored message through the main API address
      const path = String(c.storageUrl).replace(/^https?:\/\/[^/]+/, "");
      try { msgResp = await mg(base + path, apiKey); }
      catch (e2) { throw new Error(e1.message + " | retry: " + e2.message); }
    }
    const msg = await msgResp.json();
    const atts = (msg.attachments || []).filter((a) => KEEP_EXT.test(a.name || a.filename || ""));

    let emailId = null;
    if (c.messageId) {
      const { data: rows } = await supabase.from("inbound_emails").select("id").in("mailgun_message_id", [c.messageId, "<" + c.messageId + ">"]).limit(1);
      if (rows && rows[0]) emailId = rows[0].id;
    }
    res.emailRow = !!emailId;

    for (const a of atts) {
      const name = a.name || a.filename;
      const item = { name, size: a.size || null };
      try {
        if (!mailgunHostOk(a.url)) throw new Error("unexpected attachment address");
        const fileResp = await mg(a.url, apiKey);
        const buf = Buffer.from(await fileResp.arrayBuffer());
        item.size = buf.length;
        if (/\.(png|jpe?g|gif)$/i.test(name) && buf.length < 30 * 1024) { item.status = "skipped (small picture, probably a signature logo)"; res.attachments.push(item); continue; }
        const v = inspectInventoryAttachment(name, buf);
        item.readable = v.accepted;
        item.reason = v.reason || null;
        item.tabs = v.sheetNames;
        if (v.parsed) { item.techName = v.parsed.techName || null; item.invDate = v.parsed.invDate || null; item.itemsRead = (v.parsed.items || []).length; item.tab = v.parsed.sheetName || null; item.warnings = v.parsed.warnings || []; }

        let existing = null;
        if (emailId) {
          const { data: ex } = await supabase.from("inventory_sheets").select("id, parsed").eq("inbound_email_id", emailId).eq("filename", name).limit(1);
          existing = ex && ex[0];
        }
        if (existing) { item.status = "already saved" + (existing.parsed ? "" : " (unreadable)"); }
        else if (!emailId) { item.status = "no matching email record, not saved"; }
        else if (!save) { item.status = "not saved yet"; }
        else {
          const safe = String(name).replace(/[^A-Za-z0-9._-]+/g, "_");
          const storagePath = emailId + "/" + safe;
          const up = await supabase.storage.from("inventory-sheets").upload(storagePath, buf, { contentType: a.contentType || a["content-type"] || "application/octet-stream", upsert: true });
          if (up.error) { item.status = "save failed: " + up.error.message; }
          else {
            const { error: rowErr } = await supabase.from("inventory_sheets").upsert({
              inbound_email_id: emailId,
              filename: name,
              content_type: a.contentType || a["content-type"] || null,
              size_bytes: buf.length,
              storage_path: storagePath,
              received_at: res.receivedAt,
              parsed: v.accepted ? v.parsed : null,
              parse_error: v.accepted ? null : (v.reason || "Not recognized as a count sheet"),
            }, { onConflict: "inbound_email_id,filename" });
            item.status = rowErr ? "save failed: " + rowErr.message : (v.accepted ? "saved (readable)" : "saved (unreadable, kept for review)");
          }
        }
      } catch (e) {
        item.status = "could not fetch: " + e.message;
      }
      res.attachments.push(item);
    }
    if (!atts.length) res.note = "No spreadsheet-type attachment found in the stored copy";
  } catch (e) {
    res.error = e.message;
  }
  return res;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Supabase env vars not configured" });
  const apiKey = process.env.MAILGUN_API_KEY;
  if (!apiKey) return json(500, { error: "MAILGUN_API_KEY is not set" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Bad request" }); }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const auth = await verifyQuickAddAdmin(supabase, body.username, body.pin);
  if (!auth.ok) return json(401, { error: auth.reason });

  const domain = process.env.MAILGUN_DOMAIN || "mcrdispatch.net";
  const base = (process.env.MAILGUN_API_BASE || "https://api.mailgun.net").replace(/\/$/, "");

  if (body.step === "one") {
    const c = body.item || {};
    if (!mailgunHostOk(c.storageUrl) || c.storageUrl.indexOf("/domains/" + domain + "/messages/") < 0) return json(400, { error: "Bad message address" });
    const r = await processOne(supabase, apiKey, base, { ts: Number(c.ts) || Date.now() / 1000, storageUrl: c.storageUrl, from: String(c.from || ""), subject: String(c.subject || ""), messageId: String(c.messageId || "") }, body.save === true);
    return json(200, { ok: true, message: r });
  }

  const hours = Math.max(1, Math.min(168, Number(body.hours) || 72));
  const cutoffSec = Date.now() / 1000 - hours * 3600;
  let candidates;
  try {
    candidates = await listStoredEvents(base, domain, apiKey, cutoffSec, String(body.match || "").trim());
  } catch (e) {
    return json(502, { error: "Could not list Mailgun messages: " + e.message });
  }
  const total = candidates.length;
  candidates = candidates.slice(-MAX_CANDIDATES); // keep the newest
  return json(200, { ok: true, hours, found: total, truncated: total > candidates.length, items: candidates });
};
