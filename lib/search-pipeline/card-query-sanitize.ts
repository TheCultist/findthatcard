/**
 * Shared sanitizers for LLM-produced Scryfall clauses.
 *
 * Both the synergy resolver and the similar-cards resolver ask an LLM for a
 * Scryfall expression describing a functional relationship to a named card.
 * The model occasionally emits filters that the pipeline must own itself
 * (color identity, format, the source-card exclusion) or fragments that match
 * far too broadly (bare single-word `o:` tokens).  This module strips that
 * noise into a clean *functional clause* — the part that describes mechanics —
 * leaving the caller to append the `-name:"…"` exclusion and any global
 * filters once.
 */

/**
 * Returns true when `query` contains an OR operator at the top level
 * (i.e. not inside parentheses or quoted strings).
 *
 * Used to decide whether the expression must be wrapped in parens so that
 * global AND filters (mv=, id:, the -name: exclusion) apply to the whole
 * expression rather than binding only to the last OR branch.
 */
export function hasTopLevelOR(query: string): boolean {
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (inQuote) continue;
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth--; continue; }
    if (depth === 0 && /^OR\s/i.test(query.slice(i))) return true;
  }
  return false;
}

/**
 * Cleans a raw LLM Scryfall expression into a functional clause:
 *
 *   - strips outer quotes, format filters, name: filters, identity filters,
 *     and negative exclusions the pipeline injects itself;
 *   - drops bare single-word `o:` fragments (they match thousands of cards);
 *   - slugifies tag values (`function:"sacrifice outlet"` → `function:sacrifice-outlet`);
 *   - wraps a top-level OR expression in parens so callers can safely AND or
 *     OR it with other terms.
 *
 * Does NOT append a `-name:` exclusion — the caller is responsible for that,
 * because different callers combine the clause with other terms differently.
 *
 * Returns null when nothing usable remains.
 */
export function sanitizeFunctionalClause(raw: string): string | null {
  let query = raw.trim();
  if (!query || query.length < 3) return null;

  if (query.startsWith('"') && query.endsWith('"')) {
    query = query.slice(1, -1);
  }

  query = query.replace(/\bf:\w+\b/gi, "").replace(/\s{2,}/g, " ").trim();

  // Strip positive name: — callers that want specific names add them explicitly;
  // ANDing a stray name: with the -name: exclusion would yield zero hits.
  query = query.replace(/\bname:"[^"]*"/gi, "").replace(/\s{2,}/g, " ").trim();

  // Strip bare single-word oracle text fragments — they match too broadly.
  // o:"multi word phrase" is fine; o:singleword is not.
  query = query.replace(/\bo:"[^"]{1,15}"\b/g, (match) => {
    const inner = match.slice(3, -1);
    return /\s/.test(inner) ? match : "";
  });
  query = query.replace(/\bo:\S+/g, (match) => {
    if (match.startsWith('o:"')) return match;
    return "";
  });
  query = query.replace(/\s{2,}/g, " ").trim();

  query = query.replace(
    /\b(function|otag|oracletag|art|atag|arttag):"([^"]+)"/gi,
    (_match, prefix: string, value: string) => `${prefix}:${value.replace(/\s+/g, "-")}`
  );

  // Normalize comma-separated type lists — Scryfall's `t:` is a substring match,
  // so `t:instant,sorcery` matches nothing. Rewrite to a parenthesized OR group:
  // `t:instant,sorcery` → `(t:instant or t:sorcery)`.
  query = query.replace(
    /\b(t|type):([a-z][a-z]*(?:-[a-z]+)*(?:,[a-z][a-z]*(?:-[a-z]+)*)+)/gi,
    (_match, prefix: string, list: string) => {
      const types = list.split(",").map((s) => s.trim()).filter(Boolean);
      return `(${types.map((t) => `${prefix}:${t}`).join(" or ")})`;
    }
  );

  // Strip any identity filters the AI may have added — the pipeline injects those.
  query = query.replace(/\bid(?:entity)?(?:<=|>=|=|:)\s*[wubrgc]{1,5}\b/gi, "").replace(/\s{2,}/g, " ").trim();

  // Strip negative exclusions the pipeline owns (the source card is removed by the caller).
  query = query
    .replace(/-o:"[^"]*"/g, "")
    .replace(/-o:\S+/g, "")
    .replace(/-!"[^"]*"/g, "")
    .replace(/-name:"[^"]*"/gi, "")
    .replace(/-n:"[^"]*"/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!query) return null;

  // Wrap top-level OR expressions in parens so the whole clause stays grouped
  // when the caller AND/ORs it with other terms or appends global filters.
  if (hasTopLevelOR(query)) {
    query = `(${query})`;
  }

  return query || null;
}
