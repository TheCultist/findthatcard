import { hasCommanderDeckContext, resolveCommanderColorIdentity } from "@/lib/commander-context";
import { getMtgKeywordList, resolveKeywordFilters } from "@/lib/mtg-keywords";
import {
  ensureCatalogIndex,
  matchSubtype,
  matchSupertype,
  fuzzyMatchSubtype,
  getArtistIndex,
} from "@/lib/scryfall/catalog-index";
import { isScryfallQuery } from "@/lib/scryfall/query-converter";
import { resolveSetFilters } from "@/lib/scryfall/sets";
import { resolveStrategyName, STRATEGY_ORACLETAGS } from "@/lib/strategies/oracletagStrategies";
import { ensureTaggerTagCache, getTaggerTagCache } from "@/lib/tagger/cache";
import { Phase1Result, QueryClause, ResolverCategory, UnresolvedFragment } from "@/lib/search-pipeline/types";

const FORMAT_TOKENS = [
  "standard",
  "modern",
  "legacy",
  "vintage",
  "pioneer",
  "pauper",
  "commander",
  "brawl",
] as const;

const TYPE_TOKENS = [
  "creature",
  "artifact",
  "enchantment",
  "instant",
  "sorcery",
  "planeswalker",
  "land",
  "battle",
] as const;

const COLOR_IDENTITY: Record<string, string> = {
  white: "w",
  blue: "u",
  black: "b",
  red: "r",
  green: "g",
  azorius: "wu",
  dimir: "ub",
  rakdos: "br",
  gruul: "rg",
  selesnya: "gw",
  orzhov: "wb",
  izzet: "ur",
  golgari: "bg",
  boros: "rw",
  simic: "gu",
  esper: "wub",
  grixis: "ubr",
  jund: "brg",
  naya: "rgw",
  bant: "guw",
  abzan: "wbg",
  jeskai: "urw",
  sultai: "bug",
  mardu: "brw",
  temur: "urg",
  // 4-color identities — nephilim names, popular commander names, and "non-X" shorthands
  // WUBR (no green)
  "yore-tiller": "wubr",
  breya: "wubr",
  "non-green": "wubr",
  nongreen: "wubr",
  // WUBG (no red)
  "witch-maw": "wubg",
  atraxa: "wubg",
  "non-red": "wubg",
  nonred: "wubg",
  // WBRG (no blue)
  "dune-brood": "wbrg",
  saskia: "wbrg",
  "non-blue": "wbrg",
  nonblue: "wbrg",
  // UBRG (no white)
  "glint-eye": "ubrg",
  yidris: "ubrg",
  "non-white": "ubrg",
  nonwhite: "ubrg",
  // WURG (no black)
  "ink-treader": "wurg",
  kynaios: "wurg",
  "non-black": "wurg",
  nonblack: "wurg",
  // 5-color
  "5 color": "wubrg",
  fivecolor: "wubrg",
  fivecolors: "wubrg",
};

const SINGLE_COLOR_NAMES = new Set(["white", "blue", "black", "red", "green"]);

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "to",
  "from",
  "with",
  "without",
  "of",
  "in",
  "on",
  "that",
  "which",
  "cards",
  "card",
  "best",
  "good",
  "great",
  "strong",
  "easy",
  "simple",
  "want",
  "need",
  "find",
  "show",
  "me",
  "please",
  "you",
  "your",
  "yours",
  "it",
  "its",
  "when",
  "this",
  "these",
  "those",
  "they",
  "them",
  "their",
  "set",
  "sets",
  "edition",
  "editions",
  "printing",
  "printings",
  "legal",
  "illegal",
  "playable",
  "both",
  "also",
  "any",
  "some",
  "all",
  "most",
  "every",
  "are",
  "can",
  "could",
  "would",
  "should",
  "have",
  "has",
  "had",
  "been",
  "being",
  "about",
  "like",
  "or",
  "and",
  "but",
  "not",
  "nor",
  "yet",
  "so",
  "either",
  "neither",
  "versus",
  "vs",
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s{2,}/g, " ").trim();
}

function dedupeClauses(clauses: QueryClause[]): QueryClause[] {
  const seen = new Set<string>();
  const next: QueryClause[] = [];
  for (const clause of clauses) {
    const key = clause.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(clause);
  }
  return next;
}

function tokenizeNaturalQuery(naturalQuery: string): string[] {
  return naturalQuery
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const row = new Array(b.length + 1);
  for (let i = 0; i <= b.length; i += 1) row[i] = i;

  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }

  return row[b.length];
}

function normalizeFuzzyToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function quoteIfNeeded(value: string): string {
  return /[^\w-]/.test(value) ? `"${value}"` : value;
}

/**
 * Returns true when the text between two adjacent matched terms indicates they
 * should be OR-ed (e.g. "or", ",", ", or") rather than AND-ed.
 */
function isOrConnector(between: string): boolean {
  const t = between.trim();
  if (/^,?\s*or\s*$/.test(t)) return true;   // "or", ", or"
  if (/^,\s*$/.test(t)) return true;           // ","
  if (/^,\s*and\s*$/.test(t)) return true;     // ", and"  (Oxford-comma list)
  return false;
}

/**
 * Groups matched terms by their connectors in the original query.
 * Terms separated by "or" / "," end up in the same group (will become an OR chain).
 * Terms separated by "and", "both…and", or appearing in different parts of the query
 * become separate groups (each emitted as its own AND clause).
 *
 * @param searchOverrides  Optional map: canonical → token that actually appeared in the
 *                         query (needed when the matched token is a plural/fuzzy form).
 */
function groupByConnector(
  naturalQuery: string,
  terms: string[],
  searchOverrides?: Map<string, string>
): string[][] {
  if (terms.length === 0) return [];
  if (terms.length === 1) return [[terms[0]]];

  const lower = naturalQuery.toLowerCase();

  const positions: { term: string; start: number; end: number }[] = [];
  for (const term of terms) {
    const search = searchOverrides?.get(term) ?? term;
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Allow optional trailing "s" so "instant" matches "instants", etc.
    const re = new RegExp(`\\b${escaped}s?\\b`, "i");
    const match = re.exec(lower);
    if (match) {
      positions.push({ term, start: match.index, end: match.index + match[0].length });
    } else {
      // Term not positionally found — treat as a standalone AND group
      positions.push({ term, start: -1, end: -1 });
    }
  }

  const found = positions.filter((p) => p.start >= 0).sort((a, b) => a.start - b.start);
  const notFound = positions.filter((p) => p.start < 0);

  const groups: string[][] = [];
  if (found.length > 0) {
    let currentGroup: string[] = [found[0].term];
    for (let i = 1; i < found.length; i++) {
      const between = lower.slice(found[i - 1].end, found[i].start);
      if (isOrConnector(between)) {
        currentGroup.push(found[i].term);
      } else {
        groups.push(currentGroup);
        currentGroup = [found[i].term];
      }
    }
    groups.push(currentGroup);
  }

  for (const { term } of notFound) groups.push([term]);

  return groups;
}

/**
 * Converts OR-groups into QueryClauses.
 * Single-term groups → `prefix:term`
 * Multi-term groups  → `(prefix:termA or prefix:termB ...)`
 *
 * @param valueTransformer  Applied to each term before attaching the prefix
 *                          (e.g. to add quotes around multi-word values).
 */
function buildGroupedClauses(
  groups: string[][],
  prefix: string,
  source: QueryClause["source"],
  valueTransformer?: (term: string) => string
): QueryClause[] {
  const transform = valueTransformer ?? ((t: string) => t);
  return groups.map((group) => {
    if (group.length === 1) {
      return { value: `${prefix}:${transform(group[0])}`, source };
    }
    const inner = group.map((t) => `${prefix}:${transform(t)}`).join(" or ");
    return { value: `(${inner})`, source };
  });
}

/**
 * Extracts tokens that are filling a semantic role in the query (art subject,
 * oracle-text target, protection source, synergy/support subject, etc.) and
 * therefore must NOT be treated as card-type or subtype filters.
 *
 * Examples:
 *   "forest art"           → "forest"  (not t:forest)
 *   "creatures that exile a zombie" → "zombie" (not t:zombie)
 *   "deals damage to islands" → "islands" (not t:island)
 *   "protection from artifacts" → "artifacts" (not t:artifact)
 *   "equipment support"    → "equipment" (not t:equipment, handled also via synergySubjects)
 */
function extractSemanticRoleTokens(naturalQuery: string): Set<string> {
  const tokens = new Set<string>();
  const lower = naturalQuery.toLowerCase();

  function capture(re: RegExp): void {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(lower)) !== null) {
      const phrase = (m[1] ?? m[2] ?? "").trim();
      for (const tok of phrase.split(/\s+/).filter(Boolean)) {
        if (!STOPWORDS.has(tok)) tokens.add(tok);
      }
    }
  }

  // 1. Art subjects — capture 1-3 words immediately before art/artwork/illustration anchors.
  //    e.g. "with forest art" → "forest", "sword and shield art" → ["sword", "shield"]
  capture(/\b([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})\s+(?:art|artwork|illustration|depict(?:ion|ing|s|ed)?)\b/gi);
  capture(/\b(?:depict(?:ing|s)?|illustrat(?:ed|ing|es)|pictured\s+with)\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})\b/gi);

  // 2. Oracle-text targets — "that destroy/exile/bounce/create/make/... a/an/each X"
  capture(/\bthat\s+(?:destroy|exile|bounce|target|counter|sacrifice|kill|remove|discard|copy|tap|untap|create|make|generate|produce|add)\s+(?:a\s+|an\s+|all\s+|each\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})(?=\s+(?:card|permanent|spell|ability|token)\b|\s+or\b|\s+and\b|\s+from\b|\s+in\b|\s+you\b|$)/gi);

  // 3. Damage targets — "deals/deal damage to a/an/each X"
  capture(/\bdeals?\s+(?:\w+\s+)?damage\s+to\s+(?:a\s+|an\s+|each\s+|any\s+|all\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})(?=\s|$)/gi);

  // 4. Protection source — "protection from X"
  capture(/\bprotection\s+from\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})(?=\s|$)/gi);

  // 5. Synergy / support / matters subjects
  capture(/\b([a-z][a-z-]{2,}(?:\s+(?:or|and)\s+[a-z][a-z-]{2,})*)\s+(?:synerg(?:y|ies)|support|matters?|payoffs?|tribal)\b/gi);
  capture(/\bsupport(?:ing)?\s+([a-z][a-z-]{2,})\b/gi);

  // 6. "Named / called X" — card-name references
  capture(/\b(?:named?|called)\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3})(?=\s+(?:in|from|with|that|or|and)|\s*$)/gi);

  // 7. Creation / production subjects — the thing being made, not the card type of the spell.
  //    e.g. "token maker" → "token" (not t:token), "treasure generator" → "treasure"
  capture(/\b([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})\s+(?:maker|generator|creator|producer|creation|generation)s?\b/gi);
  //    Also bare "token generation", "token creation", "token production"
  capture(/\btoken\s+(?:generat(?:ion|or|ors)|creat(?:ion|or|ors)|produc(?:tion|er|ers)|maker|makers)\b/gi);

  return tokens;
}

function detectCategory(fragment: string): ResolverCategory {
  if (/\b(art|depict|artwork|illustration|pictured)\b/i.test(fragment)) {
    return "art";
  }
  if (/\b(etb|enters|dies|draw|counter|destroy|exile|sacrifice|reanimate|burn)\b/i.test(fragment)) {
    return "effect";
  }
  if (/\b(flying|trample|deathtouch|lifelink|haste|ward|vigilance)\b/i.test(fragment)) {
    return "mechanic";
  }
  return "semantic";
}

function buildUnresolvedFragments(
  naturalQuery: string,
  strippedTerms: string[]
): { unresolvedFragments: UnresolvedFragment[]; noiseTokens: string[] } {
  let remaining = naturalQuery.toLowerCase();
  for (const term of strippedTerms) {
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    remaining = remaining.replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ");
  }
  remaining = normalizeWhitespace(remaining);

  const rawTokens = remaining
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const noiseTokens = rawTokens.filter((token) => STOPWORDS.has(token));
  const usefulTokens = rawTokens.filter((token) => !STOPWORDS.has(token));

  const chunks = remaining
    .split(/\b(?:and|or|but|then|also)\b/gi)
    .map((chunk) => normalizeWhitespace(chunk))
    .filter(Boolean);

  const unresolvedFragments: UnresolvedFragment[] = [];
  for (const chunk of chunks) {
    const filtered = chunk
      .split(/\s+/)
      .filter((token) => !STOPWORDS.has(token))
      .join(" ");
    const cleaned = normalizeWhitespace(filtered);
    if (!cleaned || cleaned.length < 3) continue;
    unresolvedFragments.push({ text: cleaned, category: detectCategory(cleaned) });
  }

  if (unresolvedFragments.length === 0 && usefulTokens.length > 0) {
    const fallback = usefulTokens.join(" ");
    unresolvedFragments.push({ text: fallback, category: detectCategory(fallback) });
  }

  const deduped: UnresolvedFragment[] = [];
  const seen = new Set<string>();
  for (const fragment of unresolvedFragments) {
    const key = fragment.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(fragment);
  }

  return { unresolvedFragments: deduped, noiseTokens };
}

function shouldUseFuzzyMatch(token: string, candidate: string): boolean {
  if (token.length < 5 || candidate.length < 5) {
    return false;
  }
  if (Math.abs(token.length - candidate.length) > 1) {
    return false;
  }
  if (levenshteinDistance(token, candidate) <= 1) {
    return true;
  }

  if (token.length === candidate.length) {
    const mismatches: number[] = [];
    for (let i = 0; i < token.length; i += 1) {
      if (token[i] !== candidate[i]) {
        mismatches.push(i);
        if (mismatches.length > 2) {
          break;
        }
      }
    }
    if (
      mismatches.length === 2 &&
      mismatches[1] === mismatches[0] + 1 &&
      token[mismatches[0]] === candidate[mismatches[1]] &&
      token[mismatches[1]] === candidate[mismatches[0]]
    ) {
      return true;
    }
  }

  return false;
}

const WUBRG_ORDER = "wubrg";

function combineColorLetters(letters: Iterable<string>): string {
  const set = new Set(letters);
  return WUBRG_ORDER.split("").filter((c) => set.has(c)).join("");
}

function extractColorIdentityFromText(lowerQuery: string): string | null {
  // Pass 1: multi-color names (guild / shard / wedge) — return the longest match.
  let multiName: string | null = null;
  let multiNameLength = 0;
  for (const [name, id] of Object.entries(COLOR_IDENTITY)) {
    if (SINGLE_COLOR_NAMES.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(lowerQuery) && name.length > multiNameLength) {
      multiName = id;
      multiNameLength = name.length;
    }
  }
  if (multiName) return multiName;

  // Pass 2: accumulate all individual color names present ("white, blue and black" → "wub").
  const letters = new Set<string>();
  for (const [name, id] of Object.entries(COLOR_IDENTITY)) {
    if (!SINGLE_COLOR_NAMES.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(lowerQuery)) {
      for (const c of id) letters.add(c);
    }
  }
  if (letters.size > 0) return combineColorLetters(letters);

  // Pass 3: fuzzy fallback for mis-spelled multi-color names.
  const tokens = lowerQuery
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const token of tokens) {
    if (token.length < 5) continue;
    for (const [name, id] of Object.entries(COLOR_IDENTITY)) {
      if (name.includes(" ") || SINGLE_COLOR_NAMES.has(name) || name.length < 5) continue;
      if (levenshteinDistance(token, name) <= 1) return id;
    }
  }

  return null;
}

/**
 * Common English words that happen to be composed entirely of the letters w/u/b/r/g.
 * Blocked so they aren't misread as color shorthands.
 */
const COLOR_SHORTHAND_BLOCKLIST = new Set(["bug", "rug", "rub", "grub", "burg", "bur"]);

/**
 * Detects a standalone color-shorthand token (e.g. "wubr", "rg", "wu", "w") in the query.
 * Returns the canonical WUBRG-ordered color string and the original matched token.
 * Rejects tokens that are common English words or contain repeated / non-color letters.
 */
function detectColorShorthand(
  naturalQuery: string
): { colors: string; matchedText: string } | null {
  const lower = naturalQuery.toLowerCase();
  const tokens = lower
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (const token of tokens) {
    if (token.length < 1 || token.length > 5) continue;
    if (COLOR_SHORTHAND_BLOCKLIST.has(token)) continue;

    const chars = token.split("");
    const unique = new Set(chars);
    if (unique.size !== chars.length) continue;              // repeated letter
    if (!chars.every((c) => "wubrg".includes(c))) continue; // non-color letter

    const colors = WUBRG_ORDER.split("").filter((c) => unique.has(c)).join("");
    return { colors, matchedText: token };
  }

  return null;
}

function collectMatchedColorTerms(lowerQuery: string): string[] {
  const matched: string[] = [];
  for (const name of Object.keys(COLOR_IDENTITY)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(lowerQuery)) {
      matched.push(name);
    }
  }

  const tokens = lowerQuery
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const token of tokens) {
    if (token.length < 5) continue;
    for (const name of Object.keys(COLOR_IDENTITY)) {
      if (name.includes(" ")) continue;
      if (SINGLE_COLOR_NAMES.has(name)) continue;
      if (name.length < 5) continue;
      const distance = levenshteinDistance(token, name);
      if (distance <= 1) {
        matched.push(token);
      }
    }
  }

  return matched;
}

function applyOracleIntentHeuristics(
  naturalQuery: string,
  mustClauses: QueryClause[],
  strippedTerms: string[]
): void {
  const hasEtbIntent =
    /\b(etb|enters?\s+(?:the\s+)?(?:battlefield|field)|when\s+[^.]{0,40}\s+enters?)\b/i.test(
      naturalQuery
    );
  const hasDrawIntent =
    /\bdraw(?:s|n|ing)?\b/i.test(naturalQuery) ||
    /\bdraw\s+(?:a|one|two|three|\d+)?\s*cards?\b/i.test(naturalQuery);

  if (hasEtbIntent && hasDrawIntent) {
    mustClauses.push({ value: "o:enters", source: "phase1:oracle" });
    mustClauses.push({ value: "o:draw", source: "phase1:oracle" });
    strippedTerms.push(
      "etb",
      "enters",
      "enter",
      "enters the battlefield",
      "enters the field",
      "battlefield",
      "field",
      "draw",
      "draws",
      "draw cards",
      "draw a card"
    );
  }
}

function applyFuzzyKeywordCorrections(
  naturalQuery: string,
  keywordList: string[]
): { correctedQuery: string; matchedTypos: string[] } {
  const candidates = keywordList
    .map((keyword) => keyword.toLowerCase())
    .filter((keyword) => !keyword.includes(" "));
  const tokens = naturalQuery
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const matchedTypos: string[] = [];
  const replacements = new Map<string, string>();

  for (const token of tokens) {
    if (candidates.includes(token)) continue;
    const best = candidates.find((candidate) => shouldUseFuzzyMatch(token, candidate));
    if (!best) continue;
    replacements.set(token, best);
    matchedTypos.push(token);
  }

  if (replacements.size === 0) {
    return { correctedQuery: naturalQuery, matchedTypos };
  }

  let correctedQuery = naturalQuery.toLowerCase();
  for (const [typo, canonical] of replacements.entries()) {
    const escaped = typo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    correctedQuery = correctedQuery.replace(new RegExp(`\\b${escaped}\\b`, "gi"), canonical);
  }

  return { correctedQuery, matchedTypos };
}

function detectStrategyClauses(
  naturalQuery: string
): { clauses: QueryClause[]; strippedTerms: string[] } {
  const lower = naturalQuery.toLowerCase();
  const clauses: QueryClause[] = [];
  const strippedTerms: string[] = [];
  const canonical = new Set<string>();

  const strategyCandidates = STRATEGY_ORACLETAGS.flatMap((entry) => [
    entry.strategy,
    ...(entry.aliases || []),
  ]);

  for (const candidate of strategyCandidates) {
    const normalizedCandidate = candidate.toLowerCase();
    const escaped = normalizedCandidate
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+");
    if (!new RegExp(`\\b${escaped}\\b`, "i").test(lower)) continue;
    const resolved = resolveStrategyName(candidate);
    if (!resolved) continue;
    canonical.add(resolved);
    strippedTerms.push(normalizedCandidate);
  }

  const fuzzyEntries = strategyCandidates
    .map((name) => ({ raw: name, normalized: normalizeFuzzyToken(name) }))
    .filter((entry) => entry.normalized.length >= 5);
  const tokens = lower
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => normalizeFuzzyToken(token))
    .filter((token) => token.length >= 5);

  for (const token of tokens) {
    for (const entry of fuzzyEntries) {
      if (!shouldUseFuzzyMatch(token, entry.normalized)) continue;
      const resolved = resolveStrategyName(entry.raw);
      if (!resolved) continue;
      canonical.add(resolved);
      strippedTerms.push(token);
      break;
    }
  }

  for (const strategy of canonical) {
    clauses.push({
      value: `strategy:${quoteIfNeeded(strategy)}`,
      source: "phase1:strategy",
    });
  }

  return { clauses, strippedTerms };
}

function singularizeSubject(subject: string): string {
  const normalized = normalizeFuzzyToken(subject);
  if (normalized.endsWith("ies") && normalized.length > 4) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (normalized.endsWith("es") && normalized.length > 4) {
    return normalized.slice(0, -2);
  }
  if (normalized.endsWith("s") && normalized.length > 3) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function getTermForms(term: string): string[] {
  const singular = term.toLowerCase();
  if (singular.endsWith("y") && singular.length > 2) {
    return [singular, `${singular.slice(0, -1)}ies`];
  }
  if (singular.endsWith("s")) {
    return [singular];
  }
  return [singular, `${singular}s`];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTermFormsPattern(forms: string[]): RegExp {
  const escaped = forms.map((form) => escapeRegex(form));
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

function addSynergySubjectsFromPhrase(phrase: string, subjects: Set<string>): void {
  const parts = phrase
    .toLowerCase()
    .split(/\s+(?:or|and)\s+/i)
    .map((part) => singularizeSubject(part))
    .filter((part) => part.length >= 3);
  for (const part of parts) {
    subjects.add(part);
  }
}

function extractTypeListSynergySubjects(lower: string, subjects: Set<string>): void {
  const typePattern = TYPE_TOKENS.join("|");
  const listPattern = new RegExp(
    `\\b((?:(?:${typePattern})s?\\s+)+(?:or|and)\\s+(?:${typePattern})s?)\\s+synerg(?:y|ies)\\b`,
    "gi"
  );

  let match: RegExpExecArray | null;
  while ((match = listPattern.exec(lower)) !== null) {
    const phrase = (match[1] || "").trim();
    if (!phrase) continue;
    const pieces = phrase
      .split(/\s+/)
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token && token !== "or" && token !== "and");
    for (const piece of pieces) {
      const singular = singularizeSubject(piece);
      if (TYPE_TOKENS.includes(singular as (typeof TYPE_TOKENS)[number])) {
        subjects.add(singular);
      }
    }
  }
}

function extractSynergySubjects(naturalQuery: string): Set<string> {
  const subjects = new Set<string>();
  const lower = naturalQuery.toLowerCase();
  extractTypeListSynergySubjects(lower, subjects);
  const patterns = [
    // "X synergies / X synergy"
    /\b([a-z][a-z-]{2,}(?:\s+(?:or|and)\s+[a-z][a-z-]{2,})+)\s+synerg(?:y|ies)\b/gi,
    /\b([a-z][a-z-]{2,})\s+synerg(?:y|ies)\b/gi,
    // "synergize with X"
    /\bsynerg(?:ize|izes|izing|y|ies)\s+with\s+([a-z][a-z-]{2,}(?:\s+(?:or|and)\s+[a-z][a-z-]{2,})+)\b/gi,
    /\bsynerg(?:ize|izes|izing|y|ies)\s+with\s+([a-z][a-z-]{2,})\b/gi,
    // "works well with X"
    /\bwork(?:s)?(?:\s+well)?\s+with\s+([a-z][a-z-]{2,}(?:\s+(?:or|and)\s+[a-z][a-z-]{2,})+)\b/gi,
    /\bwork(?:s)?(?:\s+well)?\s+with\s+([a-z][a-z-]{2,})\b/gi,
    // "X support / X matters / X payoffs / X tribal"
    /\b([a-z][a-z-]{2,}(?:\s+(?:or|and)\s+[a-z][a-z-]{2,})+)\s+(?:support|matters?|payoffs?|tribal)\b/gi,
    /\b([a-z][a-z-]{2,})\s+(?:support|matters?|payoffs?|tribal)\b/gi,
    // "support X / X-matters / X-support"
    /\bsupport(?:ing)?\s+([a-z][a-z-]{2,})\b/gi,
    /\b([a-z][a-z-]{2,})-(?:matters?|support|synerg(?:y|ies))\b/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lower)) !== null) {
      const raw = (match[1] || "").trim();
      if (!raw) continue;
      addSynergySubjectsFromPhrase(raw, subjects);
    }
  }

  return subjects;
}

function tagContainsSubject(tag: string, subject: string): boolean {
  const tokens = tag.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.includes(subject)) return true;
  if (tokens.includes(`${subject}s`)) return true;
  return false;
}

async function resolveSynergyFunctionClauses(
  synergySubjects: Set<string>
): Promise<{ clauses: QueryClause[]; strippedTerms: string[] }> {
  if (synergySubjects.size === 0) {
    return { clauses: [], strippedTerms: [] };
  }

  await ensureTaggerTagCache();
  const functionTags = getTaggerTagCache()?.get("function");
  if (!functionTags || functionTags.size === 0) {
    return { clauses: [], strippedTerms: [] };
  }

  const available = Array.from(functionTags);
  const clauses: QueryClause[] = [];
  const groupedTags: string[] = [];
  const strippedTerms: string[] = [
    "synergy", "synergies", "support", "supports", "matters", "matter",
    "payoff", "payoffs", "tribal",
  ];

  for (const subject of synergySubjects) {
    strippedTerms.push(subject, `${subject}s`);

    const preferred = [`synergy-${subject}`, `${subject}-synergy`].filter((tag) =>
      functionTags.has(tag)
    );
    const related = available
      .filter((tag) => tag.toLowerCase().includes("synergy"))
      .filter((tag) => tagContainsSubject(tag, subject))
      .sort((a, b) => a.length - b.length);

    const selected = [...new Set([...preferred, ...related])].slice(0, 4);
    if (selected.length === 0) continue;

    const tagChain = selected.map((tag) => `function:${tag}`);
    groupedTags.push(...tagChain);
  }

  const dedupedTags = Array.from(new Set(groupedTags));
  if (dedupedTags.length > 0) {
    clauses.push({
      value: dedupedTags.length === 1 ? dedupedTags[0] : `(${dedupedTags.join(" OR ")})`,
      source: "phase1:function",
    });
  }

  return { clauses, strippedTerms };
}

function resolveArtistFromQuery(
  naturalQuery: string
): { name: string; matchedText: string } | null {
  const index = getArtistIndex();
  if (!index || index.size === 0) return null;

  const patterns = [
    /\b(?:by|artist)\s+(.{3,50})$/i,
    /\b(?:by|artist)\s+(.{3,50?})\s+(?:in|from|for|that|with|art|cards?)\b/i,
    /^(.{3,50?})(?:'s)?\s+art\b/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(naturalQuery);
    if (!match) continue;
    const candidate = (match[1] || "").trim();
    if (!candidate) continue;
    const found = index.get(candidate.toLowerCase());
    if (found) return { name: found, matchedText: candidate };

    const words = candidate.split(/\s+/);
    for (let len = Math.min(words.length, 4); len >= 2; len--) {
      const slice = words.slice(0, len).join(" ");
      const sliceMatch = index.get(slice.toLowerCase());
      if (sliceMatch) return { name: sliceMatch, matchedText: slice };
    }
  }

  return null;
}

export async function parseNaturalQuery(naturalQuery: string): Promise<Phase1Result> {
  const tokenizedQuery = tokenizeNaturalQuery(naturalQuery);
  const strippedTerms: string[] = [];
  const synergySubjects = extractSynergySubjects(naturalQuery);

  if (isScryfallQuery(naturalQuery)) {
    return {
      naturalQuery,
      intent: "direct-scryfall",
      tokenizedQuery,
      noiseTokens: [],
      mustClauses: [{ value: naturalQuery.trim(), source: "phase1:direct" }],
      shouldClauses: [],
      mustNotClauses: [],
      unresolvedFragments: [],
      resolvedFragments: [],
      debug: {
        strippedTerms: [],
        aiBatchCalls: 0,
        aiSequentialCalls: 0,
        invalidTagsRemoved: 0,
      },
    };
  }

  const mustClauses: QueryClause[] = [];
  const shouldClauses: QueryClause[] = [];
  const mustNotClauses: QueryClause[] = [];

  const matchedFormats = (FORMAT_TOKENS as readonly string[]).filter((format) =>
    new RegExp(`\\b${format}\\b`, "i").test(naturalQuery)
  );
  for (const format of matchedFormats) strippedTerms.push(format);
  mustClauses.push(
    ...buildGroupedClauses(
      groupByConnector(naturalQuery, matchedFormats),
      "f",
      "phase1:format"
    )
  );

  // Extract all semantic-role tokens BEFORE any type/subtype matching so they are
  // consistently excluded from both TYPE_TOKENS and catalog catalog loops.
  const semanticRoleTokens = extractSemanticRoleTokens(naturalQuery);

  const matchedTypes: string[] = [];
  for (const type of TYPE_TOKENS) {
    const typeForms = getTermForms(type);
    if (synergySubjects.has(type) || semanticRoleTokens.has(type)) {
      strippedTerms.push(...typeForms);
      continue;
    }
    if (buildTermFormsPattern(typeForms).test(naturalQuery)) {
      matchedTypes.push(type);
      strippedTerms.push(...typeForms);
    }
  }
  mustClauses.push(
    ...buildGroupedClauses(
      groupByConnector(naturalQuery, matchedTypes),
      "t",
      "phase1:type"
    )
  );

  await ensureCatalogIndex();

  const catalogTokens = tokenizeNaturalQuery(naturalQuery);
  const matchedSubtypes = new Set<string>();
  const alreadyHandled = new Set([
    ...strippedTerms.map((t) => t.toLowerCase()),
    ...FORMAT_TOKENS.map((f) => f.toLowerCase()),
    ...Object.keys(COLOR_IDENTITY),
    ...semanticRoleTokens,
  ]);

  // Collect supertypes first (position tracked via original query token)
  type CatalogMatch = { canonical: string; queryToken: string };
  const supertypeMatches: CatalogMatch[] = [];

  for (const token of catalogTokens) {
    if (STOPWORDS.has(token) || alreadyHandled.has(token)) continue;
    const superMatch = matchSupertype(token);
    if (superMatch) {
      const stLower = superMatch.toLowerCase();
      if (!matchedSubtypes.has(stLower)) {
        matchedSubtypes.add(stLower);
        supertypeMatches.push({ canonical: stLower, queryToken: token });
        strippedTerms.push(...getTermForms(stLower));
      }
    }
  }

  if (supertypeMatches.length > 0) {
    const overrides = new Map(supertypeMatches.map((m) => [m.canonical, m.queryToken]));
    mustClauses.push(
      ...buildGroupedClauses(
        groupByConnector(naturalQuery, supertypeMatches.map((m) => m.canonical), overrides),
        "t",
        "phase1:subtype"
      )
    );
  }

  // Collect subtypes (bigrams, exact, fuzzy) — position tracked via matched query token
  const subtypeMatches: CatalogMatch[] = [];

  for (let i = 0; i < catalogTokens.length; i++) {
    const token = catalogTokens[i];
    if (STOPWORDS.has(token) || alreadyHandled.has(token)) continue;

    const bigram =
      i < catalogTokens.length - 1
        ? `${catalogTokens[i]} ${catalogTokens[i + 1]}`
        : null;

    if (bigram) {
      const bigramMatch = matchSubtype(bigram);
      if (bigramMatch && !synergySubjects.has(bigramMatch.name.toLowerCase())) {
        const stLower = bigramMatch.name.toLowerCase();
        if (!matchedSubtypes.has(stLower)) {
          matchedSubtypes.add(stLower);
          subtypeMatches.push({ canonical: stLower, queryToken: bigram });
          strippedTerms.push(bigram, ...getTermForms(stLower));
        }
        continue;
      }
    }

    const subMatch = matchSubtype(token);
    if (subMatch) {
      const stLower = subMatch.name.toLowerCase();
      if (synergySubjects.has(stLower) || synergySubjects.has(token)) {
        strippedTerms.push(...getTermForms(stLower));
        continue;
      }
      if (!matchedSubtypes.has(stLower)) {
        matchedSubtypes.add(stLower);
        subtypeMatches.push({ canonical: stLower, queryToken: token });
        strippedTerms.push(...getTermForms(stLower));
      }
      continue;
    }

    if (token.length >= 5 && !matchedSubtypes.has(token)) {
      const fuzzy = fuzzyMatchSubtype(token, shouldUseFuzzyMatch);
      if (fuzzy) {
        const stLower = fuzzy.name.toLowerCase();
        if (!synergySubjects.has(stLower) && !matchedSubtypes.has(stLower)) {
          matchedSubtypes.add(stLower);
          subtypeMatches.push({ canonical: stLower, queryToken: token });
          strippedTerms.push(token, ...getTermForms(stLower));
        }
      }
    }
  }

  if (subtypeMatches.length > 0) {
    const overrides = new Map(subtypeMatches.map((m) => [m.canonical, m.queryToken]));
    mustClauses.push(
      ...buildGroupedClauses(
        groupByConnector(naturalQuery, subtypeMatches.map((m) => m.canonical), overrides),
        "t",
        "phase1:subtype",
        quoteIfNeeded
      )
    );
  }

  const lower = naturalQuery.toLowerCase();
  const hasSetContext = /\b(set|sets|edition|editions|printing|printings)\b/i.test(
    naturalQuery
  );
  const hasFranchiseSetIntent =
    hasSetContext &&
    /\b(avatar|airbender|fallout|lotr|lord\s*of\s*the\s*rings|doctor\s*who|final\s*fantasy)\b/i.test(
      naturalQuery
    );
  strippedTerms.push(...collectMatchedColorTerms(lower));
  const commanderDeck = hasCommanderDeckContext(naturalQuery);

  // Detect standalone color shorthands ("wubr", "rg", "wu", "w", …).
  // Shorthands take priority over incidental color words (e.g. "blue" in "blue artifacts
  // with flash in wubr color identity") so they must be checked before extractColorIdentityFromText.
  const colorShorthand = detectColorShorthand(lower);
  if (colorShorthand) strippedTerms.push(colorShorthand.matchedText);

  const commanderColor =
    resolveCommanderColorIdentity(naturalQuery) ||
    colorShorthand?.colors ||
    extractColorIdentityFromText(lower) ||
    null;
  if (/\bcolor\s+identity\b/i.test(naturalQuery)) {
    strippedTerms.push("color identity", "color", "identity");
  }

  if (commanderDeck) {
    mustClauses.push({ value: "f:commander", source: "phase1:commander" });
    strippedTerms.push("commander");
    if (commanderColor) {
      mustClauses.push({ value: `id:<=${commanderColor}`, source: "phase1:color" });
    }
  } else {
    const wantsCommanderCreature =
      /\b(?:a\s+)?(?:easy\s+)?commander\b|\bcommander\s+from\b|\bcommanders?\s+(?:from|in)\b|\bcan\s+be\s+commanders?\b/i.test(
        naturalQuery
      );
    if (wantsCommanderCreature) {
      mustClauses.push({ value: "is:commander", source: "phase1:commander" });
      strippedTerms.push("commander", "commanders");
    }
    if (commanderColor) {
      // Use color identity (id:) when the query is about commander format or explicitly
      // names "color identity". Otherwise use card color (c:) which is what most searches mean
      // (e.g. "blue creatures" → c:u, not id:u which would be for deck-building).
      const useIdentityFilter =
        /\bcolor\s+identity\b/i.test(naturalQuery) ||
        matchedFormats.includes("commander");

      // Exact match only when the user writes "mono-X" explicitly.
      const MONO_RE = /\bmono[-\s]?(?:white|blue|black|red|green|colou?red?)\b/i;
      const isExplicitMono =
        commanderColor.length === 1 && MONO_RE.test(naturalQuery);

      if (useIdentityFilter) {
        // id= for mono identity, id: for multi
        const isMonocolor = commanderColor.length === 1;
        mustClauses.push({
          value: isMonocolor ? `id=${commanderColor}` : `id:${commanderColor}`,
          source: "phase1:color",
        });

        // Dual-filter edge case: when a color shorthand drives the identity (e.g. "wubr
        // color identity"), individual color words like "blue" or "mono-blue" also describe
        // the card's own color and should emit a secondary c: filter.
        if (colorShorthand) {
          const wordColor = extractColorIdentityFromText(lower);
          if (wordColor && wordColor !== commanderColor) {
            const wordIsMono = wordColor.length === 1 && MONO_RE.test(naturalQuery);
            mustClauses.push({
              value: wordIsMono ? `c=${wordColor}` : `c:${wordColor}`,
              source: "phase1:color",
            });
          }
        }
      } else {
        // c= for explicit mono, c: for everything else
        mustClauses.push({
          value: isExplicitMono ? `c=${commanderColor}` : `c:${commanderColor}`,
          source: "phase1:color",
        });
      }
    }
  }

  const setFilters = await resolveSetFilters(naturalQuery);
  if (hasSetContext) {
    strippedTerms.push("set", "sets", "edition", "editions", "printing", "printings");
  }
  if (hasFranchiseSetIntent) {
    strippedTerms.push(
      "avatar",
      "airbender",
      "fallout",
      "lotr",
      "lord of the rings",
      "doctor who",
      "final fantasy"
    );
  }
  for (const filter of setFilters) {
    strippedTerms.push(filter.name.toLowerCase());
    if (filter.negated) {
      mustNotClauses.push({ value: `set:${filter.code}`, source: "phase1:set" });
    } else {
      shouldClauses.push({ value: `set:${filter.code}`, source: "phase1:set" });
    }
  }

  const artistMatch = resolveArtistFromQuery(naturalQuery);
  if (artistMatch) {
    mustClauses.push({ value: `artist:"${artistMatch.name}"`, source: "phase1:artist" });
    strippedTerms.push(artistMatch.matchedText, artistMatch.name.toLowerCase(), "by", "artist");
  }

  const keywordList = await getMtgKeywordList();
  const { correctedQuery, matchedTypos } = applyFuzzyKeywordCorrections(
    naturalQuery,
    keywordList
  );
  strippedTerms.push(...matchedTypos);

  const keywordFilters = await resolveKeywordFilters(correctedQuery);
  for (const keyword of keywordFilters) strippedTerms.push(keyword.toLowerCase());
  mustClauses.push(
    ...buildGroupedClauses(
      groupByConnector(naturalQuery, keywordFilters.map((k) => k.toLowerCase())),
      "kw",
      "phase1:keyword",
      (k) => (/\s/.test(k) ? `"${k}"` : k)
    )
  );

  const strategyResult = detectStrategyClauses(correctedQuery);
  mustClauses.push(...strategyResult.clauses);
  strippedTerms.push(...strategyResult.strippedTerms);

  const synergyResult = await resolveSynergyFunctionClauses(synergySubjects);
  mustClauses.push(...synergyResult.clauses);
  strippedTerms.push(...synergyResult.strippedTerms);

  applyOracleIntentHeuristics(naturalQuery, mustClauses, strippedTerms);

  const { unresolvedFragments, noiseTokens } = buildUnresolvedFragments(
    naturalQuery,
    strippedTerms
  );

  return {
    naturalQuery,
    intent: commanderDeck ? "commander-deck" : "search",
    tokenizedQuery,
    noiseTokens,
    mustClauses: dedupeClauses(mustClauses),
    shouldClauses: dedupeClauses(shouldClauses),
    mustNotClauses: dedupeClauses(mustNotClauses),
    unresolvedFragments,
    resolvedFragments: [],
    debug: {
      strippedTerms,
      aiBatchCalls: 0,
      aiSequentialCalls: 0,
      invalidTagsRemoved: 0,
    },
  };
}

