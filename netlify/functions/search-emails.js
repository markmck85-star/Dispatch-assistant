/**
 * netlify/functions/search-emails.js
 *
 * Standalone read-only endpoint, same pattern as get-restock-schedule.js /
 * get-state-console.js / get-watchdog-log.js: public GET, no auth (auth is
 * enforced one layer up, in mcp-server.js, for the MCP-exposed tool).
 *
 * Wraps full-text search over inbound_emails. Not scoped to a site_id
 * column (none exists) -- site-scoped queries work by expanding the
 * search term against known site codes/aliases/addresses first.
 *
 * ASSUMPTIONS TO CONFIRM AGAINST REAL SCHEMA:
 *   - inbound_emails has columns roughly: id, subject, body_text,
 *     body_html, received_at, inbound_email_id linkage from tickets/
 *     rma_shipments (confirmed elsewhere), but no direct category column.
 *     Category filtering below derives category by joining to tickets/
 *     rma_shipments via inbound_email_id rather than assuming a raw
 *     column -- adjust if inbound_emails actually does have one.
 *   - site_aliases has columns: site_code, alias (confirm exact names
 *     before wiring in the alias-expansion block below).
 *   - A generated tsvector column + GIN index needs to be added via
 *     migration (see accompanying SQL) before this will perform well
 *     at scale -- until then this will still work via to_tsvector() on
 *     the fly, just without an index to back it.
 *
 * Query params:
 *   q          - search text (required)
 *   state      - GA | NC | SC (optional, filters via site_aliases join
 *                when a site is recognized; otherwise no-op for v1)
 *   category   - trouble | maintenance | restock | shipping |
 *                site_survey | new_hire | other (optional)
 *   date_from  - ISO date (optional)
 *   date_to    - ISO date (optional)
 *   limit      - max rows to return (optional, default 20, hard cap 100)
 */

const { createClient } = require("@supabase/supabase-js");
const { cleanEmailRecord } = require("./lib/clean-email");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Look up known aliases/addresses for a search term that might be a
 * site code or colloquial site name, so the search can match emails
 * that use different wording for the same location.
 *
 * Returns an array of additional search terms to OR together with the
 * original query. Returns [] if nothing matches (falls back to a plain
 * text search on the original term).
 */
async function expandSiteTerms(term) {
  const { data, error } = await supabase
    .from("site_aliases")
    .select("site_code, alias")
    .or(`site_code.ilike.%${term}%,alias.ilike.%${term}%`);

  if (error || !data || data.length === 0) return [];

  // Once we know the site_code, pull every alias for that code so a
  // query for "Thompson Bridge" also matches emails that say "GA1090"
  // or "Hall County Kroger", and vice versa.
  const codes = [...new Set(data.map((row) => row.site_code))];
  const { data: allAliases } = await supabase
    .from("site_aliases")
    .select("site_code, alias")
    .in("site_code", codes);

  const terms = new Set(codes);
  (allAliases || []).forEach((row) => terms.add(row.alias));
  return [...terms];
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const { q, state, category, date_from, date_to } = params;

  if (!q || !q.trim()) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing required query param: q" }),
    };
  }

  const limit = Math.min(
    parseInt(params.limit, 10) || DEFAULT_LIMIT,
    MAX_LIMIT
  );

  try {
    // Expand the search term against known site codes/aliases. If the
    // term doesn't match a known site, this just returns [] and we
    // fall back to searching the raw term alone.
    const expandedTerms = await expandSiteTerms(q.trim());
    const searchTerms = expandedTerms.length > 0 ? expandedTerms : [q.trim()];

    // Build a websearch-style tsquery from all candidate terms OR'd
    // together, e.g. "GA1090 OR Thompson Bridge OR Hall County Kroger"
    const tsQuery = searchTerms
      .map((t) => `"${t.replace(/"/g, "")}"`)
      .join(" or ");

    let query = supabase
      .from("inbound_emails")
      .select("id, subject, body_text, received_at, inbound_email_id")
      .textSearch("search_vector", tsQuery, {
        type: "websearch",
        config: "english",
      })
      .order("received_at", { ascending: false })
      .limit(limit);

    if (date_from) query = query.gte("received_at", date_from);
    if (date_to) query = query.lte("received_at", date_to);

    const { data: emails, error } = await query;
    if (error) throw error;

    let results = emails || [];

    // Category filtering: derive from linked tickets/rma_shipments
    // rather than assuming a raw category column on inbound_emails.
    if (category && results.length > 0) {
      const emailIds = results.map((e) => e.id);

      if (category === "shipping") {
        const { data: shipments } = await supabase
          .from("rma_shipments")
          .select("inbound_email_id")
          .in("inbound_email_id", emailIds);
        const validIds = new Set((shipments || []).map((s) => s.inbound_email_id));
        results = results.filter((e) => validIds.has(e.id));
      } else if (["trouble", "maintenance", "restock", "site_survey"].includes(category)) {
        const { data: tickets } = await supabase
          .from("tickets")
          .select("inbound_email_id, ticket_kind")
          .in("inbound_email_id", emailIds)
          .eq("ticket_kind", category);
        const validIds = new Set((tickets || []).map((t) => t.inbound_email_id));
        results = results.filter((e) => validIds.has(e.id));
      }
      // "new_hire" / "other" have no linked-table signal yet -- would
      // need the same label parser mailgun-inbound.js uses, applied at
      // search time or (better) backfilled as a real column. Not
      // implemented here; passing category=new_hire currently no-ops.
    }

    // Clean each email body before returning (strips quoted chains,
    // signatures, disclaimers -- see lib/clean-email.js).
    const cleaned = results.map(cleanEmailRecord);

    return {
      statusCode: 200,
      body: JSON.stringify({
        query: q,
        count: cleaned.length,
        expanded_terms: expandedTerms.length > 0 ? expandedTerms : undefined,
        emails: cleaned,
      }),
    };
  } catch (err) {
    console.error("search-emails error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "search_failed", detail: err.message }),
    };
  }
};
