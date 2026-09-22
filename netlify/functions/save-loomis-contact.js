/**
 * save-loomis-contact.js — 2026-09-22
 *
 * Netlify Function — create, update, or delete one row in loomis_contacts.
 * Companion to get-loomis-contacts.js. A simple roster CRUD, same shape
 * as save-technician.js elsewhere in this app -- no state machine, no
 * side effects, just keeps the per-state Loomis contact list current as
 * new states (California) or new branch staff turn up.
 *
 * POST /.netlify/functions/save-loomis-contact
 * body: {
 *   id?: string,            // present = update that row; absent = insert new
 *   delete?: true,          // present + id = delete that row instead
 *   state: string,          // 2-letter code, required unless deleting
 *   branchName: string,     // e.g. "Loomis Detroit (Canton, MI)"
 *   contactName?: string,
 *   phone?: string,
 *   email: string,          // required unless deleting
 *   notes?: string,
 * }
 * -> { ok: true, contact: {...} }  (or { ok: true, deleted: true } )
 */
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: "Supabase env vars not configured" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (body.delete) {
      if (!body.id) return json(400, { ok: false, error: "id is required to delete a contact" });
      const { error } = await supabase.from("loomis_contacts").delete().eq("id", body.id);
      if (error) return json(500, { ok: false, error: error.message });
      return json(200, { ok: true, deleted: true });
    }

    const state = String(body.state || "").trim().toUpperCase();
    const branchName = String(body.branchName || "").trim();
    const email = String(body.email || "").trim();
    if (!/^[A-Z]{2}$/.test(state)) return json(400, { ok: false, error: "state (2-letter code) is required" });
    if (!branchName) return json(400, { ok: false, error: "branchName is required" });
    if (!email) return json(400, { ok: false, error: "email is required" });

    const row = {
      state,
      branch_name: branchName,
      contact_name: body.contactName ? String(body.contactName).trim() : null,
      phone: body.phone ? String(body.phone).trim() : null,
      email,
      notes: body.notes ? String(body.notes).trim() : null,
      updated_at: new Date().toISOString(),
    };

    let result;
    if (body.id) {
      const { data, error } = await supabase
        .from("loomis_contacts").update(row).eq("id", body.id).select().single();
      if (error) return json(500, { ok: false, error: error.message });
      result = data;
    } else {
      const { data, error } = await supabase
        .from("loomis_contacts").insert(row).select().single();
      if (error) return json(500, { ok: false, error: error.message });
      result = data;
    }

    return json(200, {
      ok: true,
      contact: {
        id: result.id,
        state: result.state,
        branchName: result.branch_name,
        contactName: result.contact_name || "",
        phone: result.phone || "",
        email: result.email,
        notes: result.notes || "",
      },
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message });
  }
};
