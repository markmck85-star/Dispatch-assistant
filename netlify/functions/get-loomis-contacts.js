/**
 * get-loomis-contacts.js — 2026-09-22
 *
 * Netlify Function — returns the per-state/branch Loomis armored-truck-
 * meet contacts (regional ops supervisor, dispatch email/phone) so the
 * app knows who to address when an "Armored Truck Meet" ticket needs a
 * coordination email -- see loomis-armored-truck-meets notes. Previously
 * this lived only in old email threads (Ryan Stetter/Loomis Detroit,
 * Michelle Flora/Loomis Grand Rapids, Andrew Brown/Loomis Portland).
 *
 * GET /.netlify/functions/get-loomis-contacts?state=MI
 * -> { ok: true, contacts: [ { id, state, branchName, contactName, phone,
 *                               email, notes } ] }
 * With no state param, returns every contact across all states (used by
 * an admin/settings screen listing the whole roster).
 */
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: "Supabase env vars not configured" });
  }

  const state = String((event.queryStringParameters || {}).state || "").trim().toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(state)) {
    return json(400, { ok: false, error: "state, if provided, must be a 2-letter code" });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    let query = supabase
      .from("loomis_contacts")
      .select("id, state, branch_name, contact_name, phone, email, notes")
      .order("state", { ascending: true })
      .order("branch_name", { ascending: true });
    if (state) query = query.eq("state", state);

    const { data, error } = await query;
    if (error) return json(500, { ok: false, error: error.message });

    const contacts = (data || []).map((c) => ({
      id: c.id,
      state: c.state,
      branchName: c.branch_name,
      contactName: c.contact_name || "",
      phone: c.phone || "",
      email: c.email,
      notes: c.notes || "",
    }));

    return json(200, { ok: true, contacts });
  } catch (err) {
    return json(500, { ok: false, error: err.message });
  }
};
