/**
 * pull-mailbox.js — read-only IMAP backfill into inbound_emails
 *
 * Does NOT replace Mailgun. Live mail still arrives via the forward.
 * This fills months that were never forwarded, and is the same hook
 * we will point at state OTC/testing boxes later.
 *
 * Env (Netlify):
 *   MAIL_MAIN_USER
 *   MAIL_MAIN_PASS
 *   MAIL_MAIN_HOST   optional, default outlook.office365.com
 *   MAIL_MAIN_PORT   optional, default 993
 *   MAIL_MAIN_FOLDER optional, default INBOX
 *
 * POST JSON: { since: "2026-03-01", limit: 40, dryRun: false }
 * Returns inserted / skipped / nextUid so you can run it again.
 */

const tls = require("tls");
const { createClient } = require("@supabase/supabase-js");

function json(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function classify(subject, text) {
  const s = `${subject || ""} ${text || ""}`;
  if (/Dispatch List/i.test(s)) return "dispatch_list";
  if (/Restock By|Consumables Needed|SST Consumable/i.test(s) && /Tech Dispatch/i.test(s)) return "restock_sameday";
  if (/Tech Dispatch - SST - Maintenance/i.test(s)) return "maintenance";
  if (/RMA|shipping label/i.test(s)) return "rma_shipment";
  if (/\b(closed|completed|resolved|closing notes?)\b/i.test(s)) return "closing_note_email";
  if (/^Re:/i.test(subject || "")) return "reply";
  if (/Tech Dispatch|Work Order|Trouble/i.test(s)) return "trouble";
  return "unknown";
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
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") return json(405, { error: "POST or GET" });

  const user = process.env.MAIL_MAIN_USER;
  const pass = process.env.MAIL_MAIN_PASS;
  const host = process.env.MAIL_MAIN_HOST || "outlook.office365.com";
  const port = process.env.MAIL_MAIN_PORT || "993";
  const folder = process.env.MAIL_MAIN_FOLDER || "INBOX";

  if (!user || !pass) {
    return json(500, { error: "MAIL_MAIN_USER / MAIL_MAIN_PASS not set" });
  }

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }
  const qs = event.queryStringParameters || {};
  const since = body.since || qs.since || "2026-03-01";
  const limit = Math.min(60, Number(body.limit || qs.limit || 30));
  const afterUid = Number(body.afterUid || qs.afterUid || 0);
  const dryRun = !!(body.dryRun || qs.dryRun);

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
      .replace(/^\* SEARCH/i, "")
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(Boolean);

    const remaining = afterUid ? uids.filter((u) => u > afterUid) : uids;
    const batch = remaining.slice(0, limit);
    if (batch.length === 0) {
      session.socket.end();
      return json(200, { ok: true, found: uids.length, inserted: 0, skipped: 0, message: "No messages after uid " + afterUid });
    }

    const fetchItems = dryRun
      ? "(UID BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])"
      : "(UID BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)] BODY.PEEK[TEXT])";
    const fetch = await session.cmd(
      `UID FETCH ${batch[0]}:${batch[batch.length - 1]} ${fetchItems}`
    );
    if (!fetch.ok) {
      session.socket.end();
      return json(500, { error: "FETCH failed", detail: fetch.text, found: uids.length });
    }
    session.socket.end();

    const msgs = parseFetchBatch(fetch.raw).filter((m) => batch.includes(m.uid));

    if (dryRun) {
      return json(200, {
        ok: true,
        dryRun: true,
        found: uids.length,
        batch: msgs.map((m) => ({ uid: m.uid, subject: m.subject, from: m.from, date: m.date })),
      });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    let inserted = 0;
    let skipped = 0;
    const errors = [];

    for (const m of msgs) {
      const mid = m.messageId ? (m.messageId.startsWith("<") ? m.messageId : `<${m.messageId}>`) : `imap-uid-${m.uid}`;
      const classified = classify(m.subject, m.text);
      const received = m.date ? new Date(m.date) : new Date();
      const row = {
        mailbox: "imap-main",
        sender: m.from || user,
        subject: m.subject || "(no subject)",
        body_text: m.text || "",
        body_html: m.html,
        received_at: isNaN(received.getTime()) ? new Date().toISOString() : received.toISOString(),
        classified_as: classified,
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

    return json(200, {
      ok: true,
      found: uids.length,
      examined: msgs.length,
      inserted,
      skipped,
      errors: errors.slice(0, 8),
      lastUid: batch[batch.length - 1],
      remaining: Math.max(0, remaining.length - batch.length),
      nextHint: remaining.length > limit
        ? ("Call again with afterUid=" + batch[batch.length - 1] + "&since=" + since)
        : "Done for this since window",
    });
  } catch (err) {
    try { if (session && session.socket) session.socket.end(); } catch {}
    return json(500, { error: err.message });
  }
};
