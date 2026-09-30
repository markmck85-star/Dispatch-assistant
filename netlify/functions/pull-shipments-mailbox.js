/**
 * pull-shipments-mailbox.js  (2026-09-30)
 * SAVE AS: netlify/functions/pull-shipments-mailbox.js   (ONE file)
 *
 * Read-only IMAP poll of the MCR shipments mailbox into inbound_emails, so
 * the inventory board's shipments section has mail to read until TJ sets up
 * a forward to the app. Runs every 20 minutes (schedule in netlify.toml).
 *
 * Stateless on purpose: each run looks at the last LOOKBACK_DAYS days of the
 * mailbox and inserts what it has not stored yet. inbound_emails already
 * rejects a repeated Message-ID, so re-reading is harmless. Nothing is
 * deleted, moved or marked read on the mail server (BODY.PEEK only).
 *
 * If TJ later forwards the mailbox to the app, the forwarded copies and
 * these copies collapse into one shipment (same tech + request date + state),
 * so this can simply be unscheduled then.
 *
 * Env (Netlify):
 *   MAIL_SHIPPING_USER
 *   SHIPMENTS_MAIL_PASSWORD
 *   MAIL_SHIPMENTS_HOST    optional, default outlook.office365.com
 *   MAIL_SHIPMENTS_PORT    optional, default 993
 *   MAIL_SHIPMENTS_FOLDER  optional, default INBOX
 *
 * Manual run / check:  GET /.netlify/functions/pull-shipments-mailbox?days=14
 */

const tls = require("tls");
const { createClient } = require("@supabase/supabase-js");

const LOOKBACK_DAYS = 3;
const MAX_MESSAGES = 60;
const STOP_MS = 20000;

function json(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function parseImapDate(d) {
  // 01-Mar-2026
  const dt = d ? new Date(d) : new Date(Date.now() - 180 * 86400000);
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
      this.pending = {
        tag,
        resolve: (v) => { clearTimeout(t); resolve(v); },
      };
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

function parseFetchBatch(raw) {
  // Bigfoot: "* <seq> FETCH (UID <uid> BODY[...] ...)"
  // Sequence number is not the UID. Always read UID from the body.
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
      const start = textMatch.index + textMatch[0].length;
      text = part.slice(start, start + n);
    } else {
      const alt = part.match(/BODY\[TEXT\]\s+"([\s\S]*?)"\n/);
      if (alt) text = alt[1];
    }
    // HTML part is often in BODY[2] — keep a short peek from text
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
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}


exports.handler = async (event) => {
  const user = process.env.MAIL_SHIPPING_USER;
  const pass = process.env.SHIPMENTS_MAIL_PASSWORD;
  const host = process.env.MAIL_SHIPMENTS_HOST || "outlook.office365.com";
  const port = process.env.MAIL_SHIPMENTS_PORT || "993";
  const folder = process.env.MAIL_SHIPMENTS_FOLDER || "INBOX";

  if (!user || !pass) return json(500, { error: "MAIL_SHIPPING_USER / SHIPMENTS_MAIL_PASSWORD not set" });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  const qs = (event && event.queryStringParameters) || {};
  const days = Math.min(60, Math.max(1, Number(qs.days) || LOOKBACK_DAYS));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  let session;
  try {
    session = await connectImap(host, port);
    const login = await session.cmd(`LOGIN ${quote(user)} ${quote(pass)}`);
    if (!login.ok) return json(401, { error: "IMAP login failed", detail: login.text });

    const sel = await session.cmd(`SELECT ${quote(folder)}`);
    if (!sel.ok) return json(500, { error: "SELECT failed", detail: sel.text });

    const search = await session.cmd(`UID SEARCH SINCE ${parseImapDate(since)}`);
    if (!search.ok) return json(500, { error: "SEARCH failed", detail: search.text });
    const uids = (search.raw.match(/\* SEARCH[^\r\n]*/i) || [""])[0]
      .replace(/^\* SEARCH/i, "").trim().split(/\s+/).map(Number).filter(Boolean)
      .slice(-MAX_MESSAGES);

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const fetchItems = "(UID BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)] BODY.PEEK[TEXT])";
    const started = Date.now();
    let inserted = 0, skipped = 0, examined = 0;
    const errors = [];

    for (let i = 0; i < uids.length && Date.now() - started < STOP_MS; i += 10) {
      const batch = uids.slice(i, i + 10);
      const fetch = await session.cmd(`UID FETCH ${batch.join(",")} ${fetchItems}`);
      if (!fetch.ok) { errors.push({ error: "FETCH failed", detail: fetch.text }); break; }
      const msgs = parseFetchBatch(fetch.raw).filter((m) => batch.includes(m.uid));
      examined += msgs.length;
      for (const m of msgs) {
        const mid = m.messageId ? (m.messageId.startsWith("<") ? m.messageId : `<${m.messageId}>`) : `imap-shipments-uid-${m.uid}`;
        const received = m.date ? new Date(m.date) : new Date();
        const row = {
          mailbox: "imap-shipments",
          sender: m.from || user,
          subject: m.subject || "(no subject)",
          body_text: m.text || "",
          body_html: m.html,
          received_at: isNaN(received.getTime()) ? new Date().toISOString() : received.toISOString(),
          classified_as: "unknown",
          parse_status: "pending",
          mailgun_message_id: mid,
          to_address: m.to || null,
        };
        const { error } = await supabase.from("inbound_emails").insert(row);
        if (error) {
          if (/duplicate|unique/i.test(error.message || "")) skipped += 1;
          else errors.push({ uid: m.uid, error: error.message });
        } else inserted += 1;
      }
    }

    session.socket.end();
    return json(200, { ok: true, days, found: uids.length, examined, inserted, skipped, errors: errors.slice(0, 8) });
  } catch (err) {
    try { if (session && session.socket) session.socket.end(); } catch {}
    return json(500, { error: err.message });
  }
};
