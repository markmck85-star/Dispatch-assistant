/**
 * pull-shipments-mailbox.js
 * Read-only IMAP for the consumable-shipments mailbox
 * (shipments@mcrtechservice.com or whatever TJ created).
 *
 * Same pattern as pull-state-closings.js. Secrets stay in Netlify env.
 *
 * Accepted env names (first match wins):
 *   user: MAIL_SHIPPING_USER | MAIL_SHIPMENTS_USER
 *   pass: SHIPMENTS_MAIL_PASSWORD | MAIL_SHIPPING_PASS | MAIL_SHIPMENTS_PASS
 *   host: MAIL_MAIN_HOST (default securemail.aplus.net)
 *   port: MAIL_MAIN_PORT (default 993)
 *
 * GET /.netlify/functions/pull-shipments-mailbox?dryRun=1
 * GET /.netlify/functions/pull-shipments-mailbox?since=2026-09-01
 */

const tls = require("tls");
const { createClient } = require("@supabase/supabase-js");
const { getStore, connectLambda } = require("@netlify/blobs");

const MAILBOX_TAG = "imap-shipments";
const CURSOR_KEY = "imap-shipments-cursor";
const STOP_MS = 20000;

function json(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function envUser() {
  return process.env.MAIL_SHIPPING_USER || process.env.MAIL_SHIPMENTS_USER || "";
}

function envPass() {
  return process.env.SHIPMENTS_MAIL_PASSWORD || process.env.MAIL_SHIPPING_PASS || process.env.MAIL_SHIPMENTS_PASS || "";
}

function classify(subject, text) {
  const s = `${subject || ""} ${text || ""}`;
  if (/RESTOCK\s+MCR/i.test(s)) return "consumable_shipment";
  if (/\b1Z[0-9A-Z]{16}\b/.test(s) && /box(?:es)?\s+shipped/i.test(s)) return "consumable_shipment";
  if (/RMA|shipping label|Neumo Shipping Details/i.test(s)) return "rma_shipping";
  if (/inventory/i.test(subject || "")) return "inventory_sheet";
  if (/^Re:/i.test(subject || "")) return "reply";
  return "unknown";
}

function parseImapDate(d) {
  const dt = d ? new Date(d) : new Date(Date.now() - 45 * 86400000);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${String(dt.getUTCDate()).padStart(2,"0")}-${months[dt.getUTCMonth()]}-${dt.getUTCFullYear()}`;
}

class ImapSession {
  constructor(socket) {
    this.socket = socket;
    this.buf = "";
    this.tag = 0;
    this.pending = null;
    socket.on("data", (chunk) => this._onData(chunk.toString("utf8")));
  }
  _onData(s) {
    this.buf += s;
    if (!this.pending) return;
    const { tag, resolve } = this.pending;
    const re = new RegExp(`(?:^|\\r\\n)${tag} (OK|NO|BAD)([^\\r\\n]*)`);
    const m = this.buf.match(re);
    if (!m) return;
    const body = this.buf;
    this.buf = "";
    this.pending = null;
    resolve({ ok: m[1] === "OK", status: m[1], text: m[2], raw: body });
  }
  cmd(command) {
    this.tag += 1;
    const tag = "A" + String(this.tag).padStart(4, "0");
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("IMAP timeout: " + command.slice(0, 80))), 20000);
      this.pending = { tag, resolve: (v) => { clearTimeout(t); resolve(v); } };
      this.socket.write(tag + " " + command + "\r\n");
    });
  }
}

function connectImap(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: Number(port) || 993, servername: host }, () => resolve(new ImapSession(socket)));
    socket.setTimeout(25000);
    socket.on("timeout", () => { socket.destroy(); reject(new Error("TLS timeout")); });
    socket.on("error", reject);
  });
}

function quote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unfold(s) {
  return String(s || "").replace(/\r?\n[ \t]+/g, " ").trim();
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function parseFetchBatch(raw) {
  const parts = raw.split(/\r\n\* /);
  const out = [];
  for (const part of parts) {
    if (!/FETCH/i.test(part)) continue;
    const uidM = part.match(/\bUID\s+(\d+)/i);
    const seqM = part.match(/^(\d+) FETCH/i);
    const uid = uidM ? Number(uidM[1]) : (seqM ? Number(seqM[1]) : 0);
    if (!uid) continue;
    const msgid = (part.match(/Message-ID:\s*<?([^>\r\n]+)>?/i) || [])[1] || "";
    const from = (part.match(/^From:\s*(.+)$/im) || [])[1] || "";
    const to = (part.match(/^To:\s*(.+)$/im) || [])[1] || "";
    const subj = (part.match(/^Subject:\s*(.+)$/im) || [])[1] || "";
    const date = (part.match(/^Date:\s*(.+)$/im) || [])[1] || "";
    let text = "";
    const textMatch = part.match(/BODY\[TEXT\]\s*\{(\d+)\}\r\n/);
    if (textMatch) {
      const n = Number(textMatch[1]);
      text = part.slice(textMatch.index + textMatch[0].length, textMatch.index + textMatch[0].length + n);
    }
    out.push({
      uid,
      messageId: msgid.trim(),
      from: from.trim(),
      to: to.trim(),
      subject: unfold(subj),
      date,
      text: stripHtml(text).slice(0, 20000),
      html: /<html/i.test(text) ? text.slice(0, 50000) : null,
    });
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") return json(405, { error: "POST or GET" });

  const user = envUser();
  const pass = envPass();
  const host = process.env.MAIL_MAIN_HOST || "securemail.aplus.net";
  const port = process.env.MAIL_MAIN_PORT || "993";
  const folder = process.env.MAIL_SHIPPING_FOLDER || process.env.MAIL_MAIN_FOLDER || "INBOX";

  if (!user || !pass) {
    return json(500, {
      error: "Shipping mailbox env not set",
      lookedFor: {
        user: ["MAIL_SHIPPING_USER", "MAIL_SHIPMENTS_USER"],
        pass: ["SHIPMENTS_MAIL_PASSWORD", "MAIL_SHIPPING_PASS", "MAIL_SHIPMENTS_PASS"],
      },
    });
  }

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }
  const qs = event.queryStringParameters || {};

  try { connectLambda(event); } catch {}
  const store = getStore("dispatch");
  let saved = {};
  try { saved = (await store.get(CURSOR_KEY, { type: "json" })) || {}; } catch { saved = {}; }

  const since = body.since || qs.since || saved.since || "2026-09-01";
  const limit = Math.min(40, Number(body.limit || qs.limit || 25));
  const dryRun = !!(body.dryRun || qs.dryRun);
  const loop = !dryRun && (body.loop === 0 || qs.loop === "0" ? false : true);
  let afterUid = Number(body.afterUid || qs.afterUid || saved.afterUid || 0);

  let session;
  try {
    session = await connectImap(host, port);
    const login = await session.cmd("LOGIN " + quote(user) + " " + quote(pass));
    if (!login.ok) {
      session.socket.end();
      return json(401, { error: "IMAP login failed", detail: login.text, user, host });
    }

    const sel = await session.cmd("SELECT " + quote(folder));
    if (!sel.ok) {
      session.socket.end();
      return json(500, { error: "SELECT failed", detail: sel.text, folder });
    }

    const search = await session.cmd("UID SEARCH SINCE " + parseImapDate(since));
    if (!search.ok) {
      session.socket.end();
      return json(500, { error: "SEARCH failed", detail: search.text });
    }
    const uids = (search.raw.match(/\* SEARCH[^\r\n]*/i) || [""])[0]
      .replace(/^\* SEARCH/i, "")
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(Boolean);

    const fetchItems = dryRun
      ? "(UID BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])"
      : "(UID BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)] BODY.PEEK[TEXT])";

    const supabase = dryRun ? null : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const started = Date.now();
    let inserted = 0, skipped = 0, examined = 0, batches = 0;
    const errors = [];
    let lastUid = afterUid;
    let remaining = afterUid ? uids.filter((u) => u > afterUid) : uids.slice();

    if (dryRun) {
      const batch = remaining.slice(0, limit);
      if (!batch.length) {
        session.socket.end();
        return json(200, { ok: true, dryRun: true, mailbox: MAILBOX_TAG, user, host, found: uids.length, batch: [] });
      }
      const fetch = await session.cmd("UID FETCH " + batch[0] + ":" + batch[batch.length - 1] + " " + fetchItems);
      session.socket.end();
      const msgs = parseFetchBatch(fetch.raw);
      return json(200, {
        ok: true,
        dryRun: true,
        mailbox: MAILBOX_TAG,
        user,
        host,
        found: uids.length,
        batch: msgs.map((m) => ({ uid: m.uid, subject: m.subject, from: m.from, date: m.date })),
      });
    }

    while (remaining.length && Date.now() - started < STOP_MS) {
      const batch = remaining.slice(0, limit);
      const fetch = await session.cmd("UID FETCH " + batch[0] + ":" + batch[batch.length - 1] + " " + fetchItems);
      if (!fetch.ok) {
        errors.push({ error: "FETCH failed", detail: fetch.text });
        break;
      }
      const msgs = parseFetchBatch(fetch.raw).filter((m) => batch.includes(m.uid));
      examined += msgs.length;
      batches += 1;
      for (const m of msgs) {
        const mid = m.messageId ? (m.messageId.startsWith("<") ? m.messageId : "<" + m.messageId + ">") : ("imap-ship-" + m.uid);
        const received = m.date ? new Date(m.date) : new Date();
        const row = {
          mailbox: MAILBOX_TAG,
          sender: m.from || user,
          subject: m.subject || "(no subject)",
          body_text: m.text || "",
          body_html: m.html,
          received_at: isNaN(received.getTime()) ? new Date().toISOString() : received.toISOString(),
          classified_as: classify(m.subject, m.text),
          parse_status: "pending",
          mailgun_message_id: mid,
          to_address: m.to || null,
        };
        const { error } = await supabase.from("inbound_emails").insert(row);
        if (error) {
          if (/duplicate|unique/i.test(error.message || "")) skipped += 1;
          else errors.push({ uid: m.uid, error: error.message });
        } else {
          inserted += 1;
        }
      }
      lastUid = batch[batch.length - 1];
      remaining = remaining.filter((u) => u > lastUid);
      if (!loop) break;
    }

    session.socket.end();
    const done = remaining.length === 0;
    await store.setJSON(CURSOR_KEY, { since, afterUid: lastUid, done, updatedAt: new Date().toISOString() });

    return json(200, {
      ok: true,
      mailbox: MAILBOX_TAG,
      found: uids.length,
      examined,
      inserted,
      skipped,
      batches,
      errors: errors.slice(0, 8),
      lastUid,
      remaining: remaining.length,
      done,
      nextHint: done
        ? "Shipments mailbox caught up for this since window."
        : ("Call again with afterUid=" + lastUid + "&since=" + since),
    });
  } catch (err) {
    try { if (session && session.socket) session.socket.end(); } catch (e) {}
    return json(500, { error: err.message });
  }
};
