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
 * Removes enclosing parentheses that span the entire string, repeatedly:
 * `((A OR B))` → `A OR B`. Parens that close before the end (`(A) OR (B)`)
 * are left alone.
 */
function unwrapOuterParens(query: string): string {
  let s = query.trim();
  for (;;) {
    if (!s.startsWith("(") || !s.endsWith(")")) return s;
    let depth = 0;
    let inQuote = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (inQuote) continue;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0 && i < s.length - 1) return s;
      }
    }
    s = s.slice(1, -1).trim();
  }
}

/**
 * Splits a clause into its top-level OR branches (quote/paren aware),
 * unwrapping enclosing parens first so `((A) OR (B))` splits like `(A) OR (B)`.
 * Returns a single-element array when there is no top-level OR.
 */
export function splitTopLevelORBranches(query: string): string[] {
  const s = unwrapOuterParens(query);
  const branches: string[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') { inQuote = !inQuote; i++; continue; }
    if (inQuote) { i++; continue; }
    if (ch === "(") { depth++; i++; continue; }
    if (ch === ")") { depth--; i++; continue; }
    if (depth === 0 && (i === 0 || s[i - 1] === " ") && /^or\s/i.test(s.slice(i))) {
      branches.push(s.slice(start, i).trim());
      i += 3;
      start = i;
      continue;
    }
    i++;
  }
  branches.push(s.slice(start).trim());
  return branches.filter(Boolean);
}

/**
 * A branch is "anchored" when it still contains a selective term: a Tagger
 * tag, a keyword-ability filter, or a multi-word oracle phrase. A branch of
 * only broad structural filters (`t:instant`, `mv<3`, single-word o:) matches
 * thousands of cards.
 */
const BRANCH_ANCHOR_PATTERN =
  /(?:^|[\s(])(?:function|otag|oracletag|art|atag|arttag|kw|keyword):|o:"[^"]*\s[^"]*"/i;

/**
 * Drops top-level OR branches that have no selective anchor left — the
 * failure mode when an invalid Tagger tag is stripped from a branch and only
 * its broad shell (`(t:instant OR t:sorcery)`) remains, flooding results.
 *
 * Returns null when NO branch is anchored (the whole clause is noise).
 */
export function dropUnanchoredOrBranches(query: string): string | null {
  const branches = splitTopLevelORBranches(query);
  const anchored = branches.filter((b) => BRANCH_ANCHOR_PATTERN.test(b));
  if (anchored.length === 0) return null;
  if (anchored.length === branches.length) return query;
  return anchored.length === 1 ? anchored[0] : `(${anchored.join(" OR ")})`;
}

/**
 * Wraps bare same-field OR alternations in parentheses.
 *
 * Scryfall binds AND tighter than OR, so an unparenthesized alternation inside
 * an AND group leaks the OR up to the group level. The model routinely emits
 * `function:card-draw o:"target" t:instant OR t:sorcery` intending the type to
 * be "instant or sorcery", but Scryfall reads it as
 * `(function:card-draw AND o:"target" AND t:instant) OR t:sorcery` — matching
 * EVERY sorcery. Wrapping runs of the same field (`t:instant OR t:sorcery` →
 * `(t:instant OR t:sorcery)`) restores the alternation the AI meant.
 *
 * Only runs where both sides share the identical field prefix are wrapped, so
 * genuine two-branch expressions (`t:creature OR function:card-draw`) are left
 * alone. A run already opened by `(` is skipped to avoid redundant nesting.
 */
export function groupBareFieldAlternations(query: string): string {
  return query.replace(
    /(?<!\()\b([a-z]+):[^\s()]+(?:\s+or\s+\1:[^\s()]+)+/gi,
    (match) => `(${match})`
  );
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
  // o:"multi word phrase" is fine; o:"singleword" is not. (No trailing \b:
  // a closing quote is a non-word char, so \b after it never matches and the
  // rule would be dead code.)
  query = query.replace(/\bo:"([^"]{1,15})"/g, (match, inner: string) =>
    /\s/.test(inner) ? match : ""
  );
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

  // Fix Scryfall precedence on bare same-field alternations before anything else
  // combines this clause — an unwrapped `t:instant OR t:sorcery` inside an AND
  // group otherwise leaks the OR and matches every sorcery.
  query = groupBareFieldAlternations(query);

  // Wrap top-level OR expressions in parens so the whole clause stays grouped
  // when the caller AND/ORs it with other terms or appends global filters.
  if (hasTopLevelOR(query)) {
    query = `(${query})`;
  }

  return query || null;
}
