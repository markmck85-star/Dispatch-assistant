// reparse-inventory-sheets.js
// Re-reads count sheets that were saved as "Not readable" (inventory_sheets.parsed is null), using the
// reader's current rules, including identifying the technician from the sender's address or the file
// name. Admin only.
//   GET /.netlify/functions/reparse-inventory-sheets          -> dry run: what would become readable
//   GET /.netlify/functions/reparse-inventory-sheets?save=1   -> save the ones that are now readable
// Read-only unless save=1. Files that still cannot be read are left exactly as they were.
const { createClient } = require("@supabase/supabase-js");
const auth = require("./lib/auth.js");
const { inspectInventoryAttachment } = require("./lib/inventory-sheet.js");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj, null, 2) };
}

exports.handler = async (event) => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    const who = await auth.requireUser(sb, event, { roles: ["admin"] });
    if (who.error) return json(who.status || 403, { error: who.error });
  } catch (e) { return json(500, { error: "Could not check the login: " + e.message }); }

  const save = ((event.queryStringParameters || {}).save) === "1";
  const { data: roster } = await sb.from("technicians").select("id, name, email").eq("active", true);
  const { data: rows, error } = await sb.from("inventory_sheets")
    .select("id, inbound_email_id, filename, storage_path, received_at")
    .is("parsed", null).order("received_at", { ascending: false }).limit(100);
  if (error) return json(500, { error: error.message });

  const out = [];
  for (const r of rows || []) {
    const item = { file: r.filename, received: r.received_at };
    try {
      if (!r.storage_path) { item.result = "no stored file"; out.push(item); continue; }
      const { data: blob, error: dlErr } = await sb.storage.from("inventory-sheets").download(r.storage_path);
      if (dlErr || !blob) { item.result = "download failed: " + (dlErr && dlErr.message); out.push(item); continue; }
      const buf = Buffer.from(await blob.arrayBuffer());
      const { data: em } = await sb.from("inbound_emails").select("sender").eq("id", r.inbound_email_id).maybeSingle();
      const senderEmail = ((String((em && em.sender) || "").match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || "").toLowerCase();
      const v = inspectInventoryAttachment(r.filename, buf, { roster: roster || [], senderEmail });
      if (v.accepted && v.parsed) {
        item.result = save ? "now readable, saved" : "would become readable";
        item.tech = v.parsed.techName; item.items = (v.parsed.items || []).length; item.warnings = v.parsed.warnings || [];
        if (save) {
          const { error: upErr } = await sb.from("inventory_sheets").update({ parsed: v.parsed, parse_error: null }).eq("id", r.id);
          if (upErr) item.result = "save failed: " + upErr.message;
        }
      } else {
        item.result = "still not readable: " + (v.reason || "unknown");
      }
    } catch (e) { item.result = "error: " + String(e && e.message || e).slice(0, 120); }
    out.push(item);
  }
  const now = out.filter((x) => /readable/.test(x.result) && !/still/.test(x.result)).length;
  return json(200, { mode: save ? "saved" : "dry run", checked: out.length, nowReadable: now, files: out });
};
