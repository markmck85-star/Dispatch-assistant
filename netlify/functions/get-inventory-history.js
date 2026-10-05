/**
 * get-inventory-history.js  (v1, 2026-10-05)
 * SAVE AS: netlify/functions/get-inventory-history.js
 *
 * Past count sheets for one technician. The original spreadsheet is already
 * in the private inventory-sheets bucket. This lists them and returns a
 * short-lived download link plus the parsed lines (forms and spare hardware).
 *
 * GET ?name=Rich%20Gerhart
 * GET ?id=<inventory_sheets id>   (one sheet, includes downloadUrl)
 */
const { createClient } = require("@supabase/supabase-js");
const { resolveSheetTech } = require("./lib/inventory-names.js");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(obj) };
}
function linesOf(parsed) {
  return ((parsed && parsed.items) || []).map((it) => ({
    code: it.code,
    name: it.name,
    kind: it.kind,
    par: it.par,
    count: it.count,
    inTransit: it.inTransit,
    toOrder: it.toOrder,
    comment: it.comment || null,
  }));
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Supabase env vars not configured" });
  const q = event.queryStringParameters || {};
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (q.id) {
    const { data: row, error } = await supabase.from("inventory_sheets").select("id, filename, storage_path, received_at, parsed").eq("id", q.id).maybeSingle();
    if (error) return json(500, { error: error.message });
    if (!row) return json(404, { error: "Sheet not found" });
    let downloadUrl = null;
    if (row.storage_path) {
      const signed = await supabase.storage.from("inventory-sheets").createSignedUrl(row.storage_path, 600);
      if (!signed.error && signed.data) downloadUrl = signed.data.signedUrl;
    }
    return json(200, {
      ok: true,
      id: row.id,
      filename: row.filename,
      sheetDate: row.parsed && row.parsed.invDate,
      techName: row.parsed && row.parsed.techName,
      receivedAt: row.received_at,
      downloadUrl,
      items: linesOf(row.parsed),
    });
  }

  const name = String(q.name || "").trim();
  if (!name) return json(400, { error: "Pass name or id" });
  const { data: techs } = await supabase.from("technicians").select("id, name, home_state").eq("active", true);
  const tech = resolveSheetTech(techs || [], name);
  const { data: rows, error } = await supabase
    .from("inventory_sheets")
    .select("id, filename, received_at, parsed")
    .not("parsed", "is", null)
    .order("received_at", { ascending: false })
    .limit(800);
  if (error) return json(500, { error: error.message });

  const sheets = [];
  for (const r of rows || []) {
    const raw = r.parsed && r.parsed.techName;
    const hit = resolveSheetTech(techs || [], raw);
    const same = tech ? (hit && hit.id === tech.id) : String(raw || "").toLowerCase() === name.toLowerCase();
    if (!same) continue;
    sheets.push({
      id: r.id,
      filename: r.filename,
      sheetDate: r.parsed.invDate || null,
      receivedAt: r.received_at,
      techName: hit ? hit.name : raw,
      state: hit ? hit.home_state : null,
      itemCount: (r.parsed.items || []).length,
    });
  }
  return json(200, { ok: true, name: tech ? tech.name : name, state: tech ? tech.home_state : null, sheets });
};
