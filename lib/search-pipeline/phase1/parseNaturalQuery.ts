import { hasCommanderDeckContext, resolveCommanderColorIdentity } from "@/lib/commander-context";
import { getMtgKeywordList, resolveKeywordFilters, KEYWORD_SYNONYM_STRIPS } from "@/lib/mtg-keywords";
import {
  ensureCatalogIndex,
  matchSubtype,
  matchSupertype,
  fuzzyMatchSubtype,
  getArtistIndex,
  lookupCardName,
  lookupCardNameByPrefix,
  hasCardNameIndex,
} from "@/lib/scryfall/catalog-index";
import { isScryfallQuery } from "@/lib/scryfall/query-converter";
import { resolveSetFilters } from "@/lib/scryfall/sets";
import { resolveStrategyName, STRATEGY_ORACLETAGS } from "@/lib/strategies/oracletagStrategies";
import { ensureTaggerTagCache, getTaggerTagCache } from "@/lib/tagger/cache";
import { ClauseSource, Phase1Result, QueryClause, QueryIntent, ResolverCategory, UnresolvedFragment } from "@/lib/search-pipeline/types";

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
  // Colorless — Scryfall uses "c" as the colorless identity indicator
  colorless: "c",
};

const SINGLE_COLOR_NAMES = new Set(["white", "blue", "black", "red", "green", "colorless"]);

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
  "other",
  "others",
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
  // Modal / auxiliary verbs missing from the original list.
  // "will" is a Planeswalker subtype (Will Kenrith) and gets matched by the
  // subtype catalog when it appears as an auxiliary verb ("that will make…").
  "will",
  "shall",
  "did",
  "does",
  "do",
  "might",
  "may",
  // Conversational social pronouns that carry no card-search meaning.
  "everyone",
  "someone",
  "anybody",
  "anybody",
  "nobody",
  "somebody",
  "ourselves",
  "themselves",
  "myself",
  "yourself",
  // Common filler adjectives / adverbs in casual phrasing.
  "really",
  "super",
  "very",
  "totally",
  "absolutely",
  "pretty",
  "quite",
  "actually",
  "basically",
  "literally",
  // Vibe / mood descriptors — describe desired game feel, not a Scryfall filter.
  // "funny" in NL means "entertaining effect", NOT is:funny (Un-set/acorn cards).
  "funny",
  "fun",
  "cool",
  "hilarious",
  "crazy",
  "insane",
  "wild",
  "broken",
  "busted",
  "op",
  "overpowered",
  "underrated",
  "underplayed",
  "spicy",
  "spice",
  "unique",
  "interesting",
  "weird",
  "strange",
  "unusual",
  "powerful",
  "epic",
  "awesome",
]);

const WORD_TO_NUMBER: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};

const COMPARISON_OP_PATTERNS: Array<[RegExp, string]> = [
  [/less\s+than|fewer\s+than|below/i, "<"],
  [/more\s+than|greater\s+than|above|higher\s+than/i, ">"],
  [/at\s+most|at\s+max(?:imum)?|or\s+(?:less|fewer)|up\s+to|no\s+more\s+than/i, "<="],
  [/at\s+least|at\s+min(?:imum)?|or\s+(?:more|greater)|no\s+less\s+than/i, ">="],
  [/equal(?:\s+to)?|exactly/i, "="],
];

function textToComparisonOp(text: string): string | null {
  for (const [re, op] of COMPARISON_OP_PATTERNS) {
    if (re.test(text)) return op;
  }
  return null;
}

function wordOrDigitToNumber(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return WORD_TO_NUMBER[t] ?? null;
}

/**
 * Parses natural language numeric stat comparisons (mana value, power, toughness, loyalty)
 * and returns the corresponding Scryfall filter clauses.
 * Examples: "mana value less than 2" → mv<2, "3-drop" → mv=3, "power greater than 4" → pow>4
 */
function resolveNumericStatFilters(naturalQuery: string): {
  clauses: QueryClause[];
  strippedTerms: string[];
} {
  const clauses: QueryClause[] = [];
  const strippedTerms: string[] = [];
  const lower = naturalQuery.toLowerCase();

  const NUM_PAT = `(?:\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
  const OP_PAT = [
    `less\\s+than`, `fewer\\s+than`, `below`,
    `more\\s+than`, `greater\\s+than`, `above`, `higher\\s+than`,
    `at\\s+most`, `at\\s+max(?:imum)?`, `or\\s+(?:less|fewer)`, `up\\s+to`, `no\\s+more\\s+than`,
    `at\\s+least`, `at\\s+min(?:imum)?`, `or\\s+(?:more|greater)`, `no\\s+less\\s+than`,
    `equal(?:\\s+to)?`, `exactly`,
  ].join("|");

  const emitIfNew = (field: string, op: string, num: number, matchedText: string) => {
    const clauseValue = `${field}${op}${num}`;
    if (!clauses.some((c) => c.value === clauseValue)) {
      clauses.push({ value: clauseValue, source: "phase1:stat" });
    }
    strippedTerms.push(matchedText.trim());
  };

  const MV_ALIASES = `(?:mana\\s+value|converted\\s+mana\\s+cost|cmc|mv)`;

  // "[mv alias] [op] [num]" — e.g. "mana value less than 2", "cmc at most 6"
  const mvOpNum = new RegExp(`\\b(${MV_ALIASES})\\s+(?:of\\s+)?(${OP_PAT})\\s+(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(mvOpNum)) {
    const op = textToComparisonOp(m[2] ?? "");
    const num = wordOrDigitToNumber(m[3] ?? "");
    if (op !== null && num !== null) emitIfNew("mv", op, num, m[0]);
  }

  // "[mv alias] of [num]" or "[mv alias] [num]" — e.g. "mana value of 3", "mana value 3"
  const mvEqNum = new RegExp(`\\b(${MV_ALIASES})\\s+(?:of\\s+|equal\\s+to\\s+|exactly\\s+)?(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(mvEqNum)) {
    const num = wordOrDigitToNumber(m[2] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("mv", "=", num, m[0]);
    }
  }

  // "[num] [mv alias]" — e.g. "3 cmc", "2 mv" (reversed order)
  const numMvAlias = new RegExp(`\\b(${NUM_PAT})\\s+(${MV_ALIASES})\\b`, "gi");
  for (const m of lower.matchAll(numMvAlias)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("mv", "=", num, m[0]);
    }
  }

  // "[num]-drop" or "[num] drop" — e.g. "2-drop", "three drop", "three-drop"
  const dropPat = new RegExp(`\\b(${NUM_PAT})[-\\s]drops?\\b`, "gi");
  for (const m of lower.matchAll(dropPat)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num !== null && num <= 12) emitIfNew("mv", "=", num, m[0]);
  }

  // "costs [op] [num] [mana]" — e.g. "costs less than 2 mana"
  const costsOpNum = new RegExp(`\\b(?:costs?|costing)\\s+(${OP_PAT})\\s+(${NUM_PAT})(?:\\s+mana)?\\b`, "gi");
  for (const m of lower.matchAll(costsOpNum)) {
    const op = textToComparisonOp(m[1] ?? "");
    const num = wordOrDigitToNumber(m[2] ?? "");
    if (op !== null && num !== null) emitIfNew("mv", op, num, m[0]);
  }

  // "costs [num] mana" — e.g. "costs 3 mana", "costing 2"
  const costsNum = new RegExp(`\\b(?:costs?|costing)\\s+(${NUM_PAT})(?:\\s+mana)?\\b`, "gi");
  for (const m of lower.matchAll(costsNum)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("mv", "=", num, m[0]);
    }
  }

  // "[num] mana or less/more" — e.g. "2 mana or less", "3 or fewer mana"
  const numManaOp = new RegExp(`\\b(${NUM_PAT})(?:\\s+mana)?\\s+(or\\s+(?:less|fewer|more|greater))\\b`, "gi");
  for (const m of lower.matchAll(numManaOp)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    const op = textToComparisonOp(m[2] ?? "");
    if (num !== null && op !== null) emitIfNew("mv", op, num, m[0]);
  }

  // "[op] [num] mana" standalone — e.g. "less than 2 mana", "at most 3 mana"
  const opNumMana = new RegExp(`\\b(${OP_PAT})\\s+(${NUM_PAT})\\s+mana\\b`, "gi");
  for (const m of lower.matchAll(opNumMana)) {
    const op = textToComparisonOp(m[1] ?? "");
    const num = wordOrDigitToNumber(m[2] ?? "");
    if (op !== null && num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("mv", op, num, m[0]);
    }
  }

  // Bare "[num] mana" — e.g. "3 mana creatures", "2 mana spells"
  // Skip oracle-text contexts like "add 3 mana", "pay 3 mana", "produce 3 mana"
  const ORACLE_MANA_VERBS = /\b(?:add(?:s)?|produce[sd]?|gain(?:s)?|pay[s]?|spend(?:s)?|costs?|tap[s]?|get[s]?)\s*$/i;
  const bareNumMana = new RegExp(`\\b(${NUM_PAT})\\s+mana\\b`, "gi");
  for (const m of lower.matchAll(bareNumMana)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num === null) continue;
    if (strippedTerms.some((t) => t.includes(m[0]))) continue;
    const before = lower.slice(0, m.index ?? 0).trimEnd();
    if (ORACLE_MANA_VERBS.test(before)) continue;
    emitIfNew("mv", "=", num, m[0]);
  }

  // Power: "[power/pow] [op] [num]" and "[num] power"
  const POW_ALIASES = `(?:power|pow)`;
  const powOpNum = new RegExp(`\\b(${POW_ALIASES})\\s+(?:of\\s+)?(${OP_PAT})\\s+(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(powOpNum)) {
    const op = textToComparisonOp(m[2] ?? "");
    const num = wordOrDigitToNumber(m[3] ?? "");
    if (op !== null && num !== null) emitIfNew("pow", op, num, m[0]);
  }
  const powEqNum = new RegExp(`\\b(${POW_ALIASES})\\s+(?:of\\s+|equal\\s+to\\s+|exactly\\s+)?(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(powEqNum)) {
    const num = wordOrDigitToNumber(m[2] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("pow", "=", num, m[0]);
    }
  }
  const numPow = new RegExp(`\\b(${NUM_PAT})\\s+power\\b`, "gi");
  for (const m of lower.matchAll(numPow)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("pow", "=", num, m[0]);
    }
  }

  // Toughness: "[toughness/tou] [op] [num]" and "[num] toughness"
  const TOU_ALIASES = `(?:toughness|tou)`;
  const touOpNum = new RegExp(`\\b(${TOU_ALIASES})\\s+(?:of\\s+)?(${OP_PAT})\\s+(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(touOpNum)) {
    const op = textToComparisonOp(m[2] ?? "");
    const num = wordOrDigitToNumber(m[3] ?? "");
    if (op !== null && num !== null) emitIfNew("tou", op, num, m[0]);
  }
  const touEqNum = new RegExp(`\\b(${TOU_ALIASES})\\s+(?:of\\s+|equal\\s+to\\s+|exactly\\s+)?(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(touEqNum)) {
    const num = wordOrDigitToNumber(m[2] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("tou", "=", num, m[0]);
    }
  }
  const numTou = new RegExp(`\\b(${NUM_PAT})\\s+toughness\\b`, "gi");
  for (const m of lower.matchAll(numTou)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("tou", "=", num, m[0]);
    }
  }

  // Loyalty: "[loyalty/loy] [op] [num]" and "[num] loyalty"
  const LOY_ALIASES = `(?:loyalty|loy)`;
  const loyOpNum = new RegExp(`\\b(${LOY_ALIASES})\\s+(?:of\\s+)?(${OP_PAT})\\s+(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(loyOpNum)) {
    const op = textToComparisonOp(m[2] ?? "");
    const num = wordOrDigitToNumber(m[3] ?? "");
    if (op !== null && num !== null) emitIfNew("loy", op, num, m[0]);
  }
  const loyEqNum = new RegExp(`\\b(${LOY_ALIASES})\\s+(?:of\\s+|equal\\s+to\\s+|exactly\\s+)?(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(loyEqNum)) {
    const num = wordOrDigitToNumber(m[2] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("loy", "=", num, m[0]);
    }
  }
  const numLoy = new RegExp(`\\b(${NUM_PAT})\\s+loyalty\\b`, "gi");
  for (const m of lower.matchAll(numLoy)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("loy", "=", num, m[0]);
    }
  }

  return { clauses, strippedTerms };
}

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
  capture(/\b(?:depict(?:ing|s)?|illustrat(?:ed|ing|es)|pictured\s+with|featuring|shows|showing)\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})\b/gi);
  // The greedy {0,2} capture above can pull in a main card type that sits earlier in the
  // phrase — e.g. "artifacts" from "esper artifacts with clockwork art". Remove any such
  // spurious captures now, before the later patterns run. Those later patterns (protection
  // from X, synergy subjects, etc.) will re-add card type names when they genuinely fill
  // a semantic role, so the correct blocking still happens in those cases.
  for (const type of TYPE_TOKENS) {
    for (const form of getTermForms(type)) {
      tokens.delete(form);
    }
  }

  // 2. Oracle-text targets — "that destroy/exile/bounce/create/make/... a/an/each X"
  capture(/\bthat\s+(?:destroy|exile|bounce|target|counter|sacrifice|kill|remove|discard|copy|tap|untap|create|make|generate|produce|add)\s+(?:a\s+|an\s+|all\s+|each\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})(?=\s+(?:card|permanent|spell|ability|token)\b|\s+or\b|\s+and\b|\s+from\b|\s+in\b|\s+you\b|$)/gi);

  // 3. Damage targets — "deals/deal damage to a/an/each X"
  capture(/\bdeals?\s+(?:\w+\s+)?damage\s+to\s+(?:a\s+|an\s+|each\s+|any\s+|all\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})(?=\s|$)/gi);

  // 5. Protection source — "protection from X"
  capture(/\bprotection\s+from\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})(?=\s|$)/gi);

  // 6. Synergy / support / matters subjects
  capture(/\b([a-z][a-z-]{2,}(?:\s+(?:or|and)\s+[a-z][a-z-]{2,})*)\s+(?:synerg(?:y|ies)|support|matters?|payoffs?|tribal)\b/gi);
  capture(/\bsupport(?:ing)?\s+([a-z][a-z-]{2,})\b/gi);

  // 6. "Named / called X" — card-name references
  capture(/\b(?:named?|called)\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3})(?=\s+(?:in|from|with|that|or|and)|\s*$)/gi);

  // 7. Creation / production subjects — the thing being made, not the card type of the spell.
  //    e.g. "token maker" → "token" (not t:token), "treasure generator" → "treasure"
  capture(/\b([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})\s+(?:maker|generator|creator|producer|creation|generation)s?\b/gi);
  //    Also bare "token generation", "token creation", "token production"
  capture(/\btoken\s+(?:generat(?:ion|or|ors)|creat(?:ion|or|ors)|produc(?:tion|er|ers)|maker|makers)\b/gi);

  // 8. Grant/give targets — the type after "give[s]/grant[s] [quantifier]" is the recipient,
  //    not the card type being searched for.
  //    e.g. "give your creatures haste" → "creatures" (not t:creature)
  //         "grant all permanents indestructible" → "permanents" (not t:permanent)
  capture(/\b(?:gives?|grants?|make[sd]?)\s+(?:your|all|each|every|target|a|an|any|friendly)?\s*([a-z][a-z-]*)\b/gi);

  // 9. Library search targets — the card type being FETCHED is an object of the action,
  //    not a descriptor of the spell. "search your library for a land" → "land" (not t:land).
  //    "fetch a forest from your library" → "forest" (not t:forest / land-subtype filter).
  capture(/\b(?:search(?:es|ing)?|fetch(?:es|ing)?|finds?|tutor(?:s|ing)?(?:\s+for)?)\b.{0,40}\b(?:library|deck)\b.{0,30}\bfor\s+(?:a\s+|an\s+|any\s+|the\s+)?([a-z][a-z-]*)/gi);
  capture(/\b(?:search(?:es|ing)?|fetch(?:es|ing)?|finds?|tutor(?:s|ing)?(?:\s+for)?)\s+(?:a\s+|an\s+|any\s+|the\s+)?([a-z][a-z-]*)\s+(?:from|in)\s+(?:your|the|a|my)?\s*(?:library|deck)\b/gi);
  // "tutor for a land/creature/enchantment" without explicit library mention
  capture(/\b(?:tutor(?:s|ing)?(?:\s+for)?|tutors?\s+up)\s+(?:a\s+|an\s+|the\s+)?([a-z][a-z-]*)/gi);
  // "creature/enchantment/artifact tutor(s)" — target type precedes "tutor(s)"
  capture(/\b([a-z][a-z-]*)\s+tutors?\b/gi);

  return tokens;
}

/**
 * Extracts tokens that appear in trigger position ("when a zombie enters",
 * "whenever an artifact enters") — these must NOT become t: tags, but must
 * remain in the unresolved fragment text so the AI can understand the context.
 */
function extractTriggerSubjectTokens(naturalQuery: string): Set<string> {
  const tokens = new Set<string>();
  const lower = naturalQuery.toLowerCase();

  const re = /\b(?:when(?:ever)?|if)\s+(?:a|an|another|one|or\s+more|target|equipped|enchanted)?\s*([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})\s+(?:enters?|dies?|attacks?|blocks?|leaves?|is\s+put|deals?|becomes?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    const phrase = (m[1] ?? "").trim();
    for (const tok of phrase.split(/\s+/).filter(Boolean)) {
      if (!STOPWORDS.has(tok)) tokens.add(tok);
    }
  }
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

  // Split while retaining the connector word between each chunk (capturing group),
  // so we can record whether adjacent fragments were joined by "or" (→ OR in the query)
  // vs "and"/"but"/etc. (→ AND, the default Scryfall behaviour).
  // splitParts alternates: [chunk0, connector1, chunk1, connector2, chunk2, ...]
  const splitParts = remaining.split(/\b(and|or|but|then|also)\b/gi);

  const unresolvedFragments: UnresolvedFragment[] = [];
  for (let i = 0; i < splitParts.length; i += 2) {
    const chunk = normalizeWhitespace(splitParts[i] || "");
    const filtered = chunk
      .split(/\s+/)
      .filter((token) => !STOPWORDS.has(token))
      .join(" ");
    const cleaned = normalizeWhitespace(filtered);
    if (!cleaned || cleaned.length < 3) continue;

    // The connector at index i-1 (odd) tells us how this chunk relates to the previous one.
    const connector = i > 0 ? (splitParts[i - 1] || "").toLowerCase().trim() : null;
    unresolvedFragments.push({
      text: cleaned,
      category: detectCategory(cleaned),
      orConnected: connector === "or",
    });
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
  const wubrg = WUBRG_ORDER.split("").filter((c) => set.has(c)).join("");
  // "c" (colorless) is not part of WUBRG but is a valid Scryfall color identity
  // letter. Append it after the WUBRG portion when present.
  return set.has("c") ? `${wubrg}c` : wubrg;
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

/**
 * Returns true when the query explicitly asks for cards that *include* or *contain*
 * certain colors, rather than cards whose color is exactly those colors.
 * Used to switch from the default c=/id= (exact) to c:/id: (superset).
 * Examples: "creatures that include white", "cards containing blue and red",
 *           "cards with at least green", "cards with green or more colors"
 */
/**
 * Returns true when the query explicitly asks for cards that *include* or *contain*
 * certain colors. Used to switch c= (default exact) → c: (superset).
 * e.g. "creatures containing blue and red", "cards with at least green"
 */
function detectColorInclusionIntent(naturalQuery: string): boolean {
  return /\b(?:includes?|contain(?:s|ing)?|with\s+at\s+least|at\s+least|or\s+more\s+colou?rs?|including)\b/i.test(
    naturalQuery
  );
}

/**
 * Returns true when the query explicitly asks for an *exact* color identity.
 * Used to switch id: (default superset) → id= (exact).
 * e.g. "exactly esper color identity", "only white color identity", "mono-blue identity"
 */
function detectExactColorIdentityIntent(naturalQuery: string): boolean {
  // "exactly/only/purely/strictly X color identity"
  if (/\b(?:exact(?:ly)?|only|purely|strictly|just)\s+\w[\w\s-]*(?:colou?r\s+)?identit/i.test(naturalQuery)) {
    return true;
  }
  // "mono-X" or "mono X" — single-color exact identity
  if (/\bmono[-\s]?(?:white|blue|black|red|green|colou?red?)\b/i.test(naturalQuery)) {
    return true;
  }
  return false;
}

/**
 * Detects single colors that are explicitly negated in the query
 * (e.g. "not blue", "without red", "that are not green").
 * Returns the negated WUBRG letters and a version of the query with those
 * color names blanked out so positive color extraction ignores them.
 */
function detectColorNegations(lowerQuery: string): {
  negatedColorLetters: string;
  maskedQuery: string;
} {
  const NEG = `(?:not|without|no\\s+|except(?:\\s+for)?|excluding|isn'?t|aren'?t|is\\s+not|are\\s+not|(?:that\\s+(?:is|are)\\s+not))`;
  const negatedLetters = new Set<string>();
  let masked = lowerQuery;

  for (const [name, id] of Object.entries(COLOR_IDENTITY)) {
    if (!SINGLE_COLOR_NAMES.has(name)) continue;
    const escaped = escapeRegex(name);
    const pattern = new RegExp(`\\b${NEG}\\s*(?:a\\s+)?(?:colou?rs?\\s+)?${escaped}\\b`, "gi");
    if (pattern.test(lowerQuery)) {
      for (const c of id) negatedLetters.add(c);
      // Blank this color name so extractColorIdentityFromText won't re-pick it up
      masked = masked.replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ".repeat(name.length));
    }
  }

  const negatedColorLetters = [...WUBRG_ORDER.split(""), "c"].filter((c) => negatedLetters.has(c)).join("");
  return { negatedColorLetters, maskedQuery: masked };
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
  const ETB_TERMS = [
    "etb", "enters", "enter",
    "enters the battlefield", "enters the field",
    "enters battlefield", "battlefield", "field",
    "when it enters", "when they enter", "when ~ enters",
  ];

  const hasEtbIntent =
    /\b(etb|enters?\s+(?:the\s+)?(?:battlefield|field)|when\s+[^.]{0,40}\s+enters?)\b/i.test(
      naturalQuery
    );

  // --- Life-drain / "steal life" ---
  // e.g. "steal life points", "drain life from opponents", "opponents lose life and you gain life"
  // Prefer function tags here so Phase 2 doesn't fall back to brittle oracle snippets.
  const hasLifeStealIntent =
    /\b(?:steal(?:ing)?|drain(?:ing)?|siphon(?:ing)?|leech(?:ing)?)\s+life(?:\s+points?)?\b|\blife[-\s]?drain\b|\bopponents?\s+lose(?:s)?\s+life\b|\blose(?:s)?\s+life\s+and\s+(?:you|i)\s+gain\s+life\b/i.test(
      naturalQuery
    );
  if (hasLifeStealIntent) {
    mustClauses.push({
      value: "(function:life-drain or function:drain-life or function:opponent-loses-life)",
      source: "phase1:function",
    });
    strippedTerms.push(
      "steal life",
      "steal life points",
      "drain life",
      "life drain",
      "siphon life",
      "leech life",
      "lose life",
      "loses life",
      "gain life"
    );
    return;
  }

  // --- Empty hand + damage ---
  // e.g. "no cards in hand damage", "damage when opponent has no cards in hand"
  // No dedicated function tags currently cover this condition robustly, so use
  // oracle text anchors to preserve the intent deterministically.
  const hasNoCardsInHandIntent =
    /\b(?:no|without|zero)\s+cards?\s+in\s+hand\b|\bhellbent\b|\bempty[-\s]?hand(?:ed)?\b/i.test(
      naturalQuery
    );
  const hasDamageWordIntent =
    /\bdamage\b|\bburn\b|\bdeal[st]?\s+.*?\bdamage\b|\bdeals?\b/i.test(naturalQuery);

  if (hasNoCardsInHandIntent && hasDamageWordIntent) {
    if (!mustClauses.some((c) => c.value === 'o:"no cards in hand"')) {
      mustClauses.push({ value: 'o:"no cards in hand"', source: "phase1:oracle" });
    }
    if (!mustClauses.some((c) => c.value === 'o:"deals"')) {
      mustClauses.push({ value: 'o:"deals"', source: "phase1:oracle" });
    }
    strippedTerms.push(
      "no cards in hand",
      "without cards in hand",
      "empty hand",
      "hellbent",
      "damage",
      "deal",
      "deals"
    );
    return;
  }

  // --- "When a/an/another X enters" — trigger off OTHER permanents entering ---
  // Detect explicit non-self trigger subjects ("when an artifact enters",
  // "whenever a land enters the battlefield"). These should use plain o:enters,
  // NOT o:"~ enters" which is the self-referential form.
  const otherEtbMatch = naturalQuery
    .toLowerCase()
    .match(
      /\b(?:when(?:ever)?|if)\s+(?:a|an|another|one|or\s+more)\s+([a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,1})\s+enters?\b/i
    );

  if (hasEtbIntent && otherEtbMatch) {
    const subject = otherEtbMatch[1].trim();
    mustClauses.push({ value: "o:enters", source: "phase1:oracle" });
    mustClauses.push({ value: `o:${subject}`, source: "phase1:oracle" });
    strippedTerms.push(
      ...ETB_TERMS,
      subject,
      "trigger", "triggers", "triggered", "triggering", "that trigger",
      "when a", "when an", "when another", "whenever a", "whenever an",
    );
    return;
  }


  const hasDrawIntent =
    /\bdraw(?:s|n|ing)?\b/i.test(naturalQuery) ||
    /\bdraw\s+(?:a|one|two|three|\d+)?\s*cards?\b/i.test(naturalQuery);

  if (hasEtbIntent && hasDrawIntent) {
    mustClauses.push({ value: 'o:"~ enters"', source: "phase1:oracle" });
    mustClauses.push({ value: "o:draw", source: "phase1:oracle" });
    strippedTerms.push(...ETB_TERMS, "draw", "draws", "draw cards", "draw a card");
    return;
  }

  // --- ETB + mana production ---
  // e.g. "creatures that give you mana when they enter", "adds mana when it enters"
  // No dedicated function tag exists for ETB mana producers, so we use oracle
  // text. o:"~ enters" anchors the ETB trigger; o:"add {" matches actual mana
  // additions (add {G}, add {1}, add {C}, etc.) without false-positives from
  // "add a counter", "add it to your hand", cost-reduction text, etc.
  const hasManaProductionIntent =
    /\b(give[sd]?\s+(?:you\s+)?mana|add[sd]?\s+mana|produce[sd]?\s+mana|generates?\s+mana|mana\s+when|gives?\s+mana)\b/i.test(
      naturalQuery
    );

  if (hasEtbIntent && hasManaProductionIntent) {
    mustClauses.push({ value: 'o:"~ enters"', source: "phase1:oracle" });
    mustClauses.push({ value: 'o:"add {"', source: "phase1:oracle" });
    strippedTerms.push(...ETB_TERMS, "mana", "give", "gives", "add", "adds", "produce", "produces", "generates", "generate");
    return;
  }

  // --- ETB + life gain ---
  // e.g. "creatures that gain life when they enter", "ETB lifegain"
  const hasLifegainIntent =
    /\b(gain[sd]?\s+life|life\s+gain|lifegain|heal[sd]?|restore[sd]?\s+life)\b/i.test(
      naturalQuery
    );

  if (hasEtbIntent && hasLifegainIntent) {
    mustClauses.push({ value: 'o:"~ enters"', source: "phase1:oracle" });
    mustClauses.push({ value: 'o:"gain"', source: "phase1:oracle" });
    strippedTerms.push(...ETB_TERMS, "gain", "gains", "gain life", "lifegain", "life gain", "heal", "heals");
    return;
  }

  // --- ETB + damage ---
  // e.g. "creatures that deal damage when they enter", "ETB pinger"
  const hasDamageIntent =
    /\b(deal[sd]?\s+damage|deal[sd]?\s+\d+\s+damage|ping[sd]?|shock[sd]?|damage\s+when)\b/i.test(
      naturalQuery
    );

  if (hasEtbIntent && hasDamageIntent) {
    mustClauses.push({ value: 'o:"~ enters"', source: "phase1:oracle" });
    mustClauses.push({ value: 'o:"deals"', source: "phase1:oracle" });
    strippedTerms.push(...ETB_TERMS, "deal", "deals", "damage", "pings", "ping");
    return;
  }

  // --- ETB + token creation ---
  // e.g. "creatures that create tokens when they enter"
  const hasTokenIntent =
    /\b(create[sd]?\s+(?:a\s+|an?\s+)?tokens?|make[sd]?\s+(?:a\s+)?tokens?|tokens?\s+when)\b/i.test(
      naturalQuery
    );

  if (hasEtbIntent && hasTokenIntent) {
    mustClauses.push({ value: 'o:"~ enters"', source: "phase1:oracle" });
    mustClauses.push({ value: 'o:"create"', source: "phase1:oracle" });
    strippedTerms.push(...ETB_TERMS, "create", "creates", "token", "tokens", "make", "makes");
    return;
  }

  // --- ETB + discard / hand disruption ---
  // e.g. "creatures that make opponents discard when they enter"
  const hasDiscardIntent =
    /\b(discard[sd]?\s+(?:a\s+)?(?:card|their\s+hand)?|hand\s+disruption)\b/i.test(
      naturalQuery
    );

  if (hasEtbIntent && hasDiscardIntent) {
    mustClauses.push({ value: 'o:"~ enters"', source: "phase1:oracle" });
    mustClauses.push({ value: "o:discard", source: "phase1:oracle" });
    strippedTerms.push(...ETB_TERMS, "discard", "discards", "hand", "disruption");
    return;
  }

  // --- ETB + destroy / exile (removal on ETB) ---
  // e.g. "creatures that destroy a permanent when they enter"
  const hasDestroyIntent =
    /\b(destroy[sd]?\s+(?:target\s+|a\s+|an?\s+)?(?:permanent|creature|artifact|enchantment)|exile[sd]?\s+(?:target\s+|a\s+)?(?:permanent|creature|artifact))\b/i.test(
      naturalQuery
    );

  if (hasEtbIntent && hasDestroyIntent) {
    mustClauses.push({ value: 'o:"~ enters"', source: "phase1:oracle" });
    strippedTerms.push(...ETB_TERMS);
    // leave destroy/exile for the AI/strategy resolver to handle more precisely
    return;
  }

  // --- Mana rocks ---
  // Only fire for explicit "mana rock(s)" or "mana-generating artifact" phrasing.
  // "artifact ramp" / "artifact mana" are intentionally excluded: the user may want
  // any artifact that accelerates mana (including artifact creatures), not just
  // dedicated mana rocks. Those fall through to the general ramp archetype.
  const hasManaRockIntent =
    /\bmana\s+rocks?\b/i.test(naturalQuery) ||
    /\bmana[-\s]generating\s+artifacts?\b/i.test(naturalQuery);

  if (hasManaRockIntent) {
    mustClauses.push({
      value: "(function:mana-rock or function:manarock or function:utility-mana-rock or function:mana-rock-with-sets-mechanic)",
      source: "phase1:function",
    });
    strippedTerms.push("mana rocks", "mana rock", "mana generating artifact", "mana generating artifacts");
    return;
  }

  // --- Alternate/alternative casting cost ---
  // e.g. "alternative casting cost", "alternate cost", "alternating casting cost"
  const hasAlternateCastingCostIntent =
    /\b(?:alternate|alternating|alternative)\s+(?:casting\s+)?cost\b/i.test(naturalQuery) ||
    /\bcast\s+(?:it\s+)?(?:for\s+)?(?:free|without\s+paying|at\s+(?:reduced|alternate|alternative))\b/i.test(naturalQuery);

  if (hasAlternateCastingCostIntent) {
    mustClauses.push({
      value: "(function:potentially-free or o:\"without paying\" or o:\"alternative cost\" or o:\"rather than\")",
      source: "phase1:function",
    });
    strippedTerms.push(
      "alternate", "alternating", "alternative", "casting cost", "alternate cost",
      "alternative cost", "alternating casting cost", "alternative casting cost",
      "cast for free", "without paying",
    );
    return;
  }

  // --- Thunder Junction ability words: "start your engines" / "max speed" ---
  // These are OTJ mechanic references, not haste synonyms.
  const hasStartYourEnginesIntent =
    /\bstart\s+your\s+engines?\b/i.test(naturalQuery);
  const hasMaxSpeedIntent =
    /\bmax\s+speed\b/i.test(naturalQuery);

  if (hasStartYourEnginesIntent || hasMaxSpeedIntent) {
    if (hasStartYourEnginesIntent) {
      mustClauses.push({ value: 'o:"start your engines"', source: "phase1:oracle" });
      strippedTerms.push("start your engines", "start your engine");
    }
    if (hasMaxSpeedIntent) {
      mustClauses.push({
        value: '(o:"max speed" or function:synergy-speed)',
        source: "phase1:oracle",
      });
      strippedTerms.push("max speed");
    }
    return;
  }

  // --- "Search library for a land" → land-tutor ---
  // "search your library for a land" / "tutor for a land" / "fetch a land from your library"
  // These are the canonical MTG ramp phrases. We must resolve them BEFORE the generic
  // type-detection pass, otherwise "land" would be picked up as a t:land filter and the
  // Phase 2 AI would produce the wrong query ("land cards that tutor" instead of
  // "cards that tutor for lands").
  const SEARCH_LIBRARY_FOR_LAND =
    // "search [your/the/a] [library/deck] for [a/the] land"
    /\bsearch(?:es|ing)?\b.{0,30}\b(?:library|deck)\b.{0,30}\blands?\b/i.test(naturalQuery) ||
    // "find [a/the] land in [your/the] library/deck"
    /\bfinds?\b.{0,25}\bland.{0,25}\b(?:library|deck)\b/i.test(naturalQuery) ||
    // "fetch [a/the/any] land [from/in] [your/the] library"
    /\bfetch(?:es|ing)?\b.{0,25}\bland.{0,25}\b(?:library|deck)\b/i.test(naturalQuery) ||
    // "tutor [for] [a] land" / "land tutor"
    /\b(?:tutor(?:s|ing)?(?:\s+for)?|tutors?\s+up)\s+(?:a\s+|an?\s+|the\s+)?lands?\b/i.test(naturalQuery) ||
    /\blands?\s+tutor\b/i.test(naturalQuery);

  if (SEARCH_LIBRARY_FOR_LAND) {
    mustClauses.push({
      value: "function:tutor-land",
      source: "phase1:function",
    });
    strippedTerms.push(
      "search your library", "search the library", "search my library",
      "search library", "searches library", "searching library",
      "search your deck", "search the deck",
      "find a land", "find the land", "find lands",
      "fetch a land", "fetch the land", "fetch lands",
      "tutor for a land", "tutor for the land", "tutor for lands",
      "tutor a land", "tutor lands", "land tutor",
      "from your library", "from the library", "from your deck",
      "in your library", "in the library",
      "for a land", "for the land", "for lands",
      "a land", "the land", "land", "lands",
      "library", "deck",
    );
    return;
  }

  // --- Library peeking / spying ---
  // "look at / peek / reveal / spy on [opponent's] library"
  const hasLibraryLookIntent =
    /\b(peek(?:ing)?|spy(?:ing)?|look\s+at|reveal[sd]?|see[s]?)\b.{0,30}\b(library|deck|top\s+of)\b/i.test(naturalQuery) ||
    /\b(library|deck|top\s+of).{0,30}\b(peek(?:ing)?|spy(?:ing)?|look\s+at|reveal[sd]?|see[s]?)\b/i.test(naturalQuery);

  if (hasLibraryLookIntent) {
    const targetsOpponentLibrary =
      /\bopponent[s']?\s+(?:library|deck)\b|\b(?:library|deck)\s+(?:of|belonging\s+to)\s+(?:an?\s+)?opponent\b/i.test(naturalQuery) ||
      /\b(?:reveal|look\s+at|peek|spy)\b.{0,20}\bopponent/i.test(naturalQuery);

    mustClauses.push({
      value: "(function:spy-library or function:peek-library or function:library-manipulation)",
      source: "phase1:function",
    });
    if (targetsOpponentLibrary) {
      mustClauses.push({ value: 'o:"opponent\'s library"', source: "phase1:oracle" });
    }
    strippedTerms.push(
      "peek", "peeks", "peeking", "spy", "spies", "spying",
      "look at", "reveal", "reveals", "see",
      "library", "deck", "top of",
      "opponent", "opponents", "opponent's",
    );
    return;
  }

  // --- Aristocrats ---
  // e.g. "aristocrats commander", "aristocrat payoffs", "aristocratic strategy"
  const hasAristocratsIntent =
    /\baristo(?:cra(?:ts?|cts?|tic)|arts?)\b/i.test(naturalQuery);

  if (hasAristocratsIntent) {
    mustClauses.push({
      value: "(function:sacrifice-outlet or function:sac-outlet or function:death-trigger or function:death-trigger-self or function:synergy-sacrifice)",
      source: "phase1:function",
    });
    strippedTerms.push(
      "aristocrats", "aristocrat", "aristocratic",
      "aristocract", "aristocracts", "aristocarts",
    );
    return;
  }
}

/**
 * Maps common in-game actions a user might express aversion to, into -o: oracle
 * text exclusions. e.g. "I hate shuffling" → -o:shuffle, "without targeting" → -o:target
 */
const AVERSION_ORACLE_INTENTS: Array<{
  detect: RegExp;
  oracleQuery: string;
  /** Keywords to exclude via mustNotClauses — for cases where shuffling/triggering only appears in reminder text */
  keywordExclusions?: string[];
  strip: string[];
}> = [
  {
    detect: /\b(?:i\s+)?(?:hate|avoid|dislike|don'?t\s+(?:want|like)|without|no)\s+(?:having\s+to\s+|needing\s+to\s+|to\s+)?shuffl(?:e|ing|ed)\b/i,
    oracleQuery: "shuffle",
    // cycling (landcycling variants) and transmute both involve shuffling only in reminder text,
    // which Scryfall's o: filter does not search, so we must exclude them by keyword
    keywordExclusions: ["cycling", "transmute"],
    strip: ["shuffle", "shuffling", "i hate", "hate", "avoid", "dislike", "without", "having to"],
  },
  {
    detect: /\b(?:i\s+)?(?:hate|avoid|dislike|don'?t\s+(?:want|like)|without|no)\s+(?:having\s+to\s+|to\s+)?target(?:ing)?\b/i,
    oracleQuery: "target",
    strip: ["target", "targeting", "hate", "avoid", "dislike"],
  },
  {
    detect: /\b(?:i\s+)?(?:hate|avoid|dislike|don'?t\s+(?:want|like)|without|no)\s+(?:having\s+to\s+|to\s+)?discard(?:ing)?\b/i,
    oracleQuery: "discard",
    strip: ["discard", "discarding", "hate", "avoid", "dislike"],
  },
  {
    detect: /\b(?:i\s+)?(?:hate|avoid|dislike|don'?t\s+(?:want|like)|without|no)\s+(?:(?:having\s+to\s+|to\s+)?flip(?:ping)?\s+(?:a\s+)?coins?|coin\s+flip(?:s|ping)?)\b/i,
    oracleQuery: '"flip a coin"',
    strip: ["flip", "flipping", "coin", "coins", "coin flip", "coin flips", "hate", "avoid"],
  },
  {
    detect: /\b(?:i\s+)?(?:hate|avoid|dislike|don'?t\s+(?:want|like)|without|no)\s+(?:having\s+to\s+|to\s+)?roll(?:ing)?\s*(?:dice|a\s+die|d\d+)?\b/i,
    oracleQuery: '"roll"',
    strip: ["roll", "rolling", "dice", "die", "hate", "avoid"],
  },
  {
    detect: /\b(?:i\s+)?(?:hate|avoid|dislike|don'?t\s+(?:want|like)|without|no)\s+(?:having\s+to\s+|to\s+)?sacrific(?:e|ing|ed)\b/i,
    oracleQuery: "sacrifice",
    strip: ["sacrifice", "sacrificing", "hate", "avoid", "dislike"],
  },
  {
    detect: /\b(?:i\s+)?(?:hate|avoid|dislike|don'?t\s+(?:want|like)|without|no)\s+(?:having\s+to\s+|to\s+)?paying?\s+life\b/i,
    oracleQuery: '"pay life"',
    strip: ["pay", "paying", "life", "hate", "avoid"],
  },
  {
    detect: /\b(?:i\s+)?(?:hate|avoid|dislike|don'?t\s+(?:want|like)|without|no)\s+(?:having\s+to\s+|to\s+)?mill(?:ing)?\b/i,
    oracleQuery: "mill",
    strip: ["mill", "milling", "hate", "avoid", "dislike"],
  },
];

function resolveAversionOracleIntents(naturalQuery: string): {
  mustNotClauses: QueryClause[];
  strippedTerms: string[];
} {
  const mustNotClauses: QueryClause[] = [];
  const strippedTerms: string[] = [];

  for (const intent of AVERSION_ORACLE_INTENTS) {
    if (intent.detect.test(naturalQuery)) {
      mustNotClauses.push({ value: `o:${intent.oracleQuery}`, source: "phase1:oracle" });
      for (const kw of intent.keywordExclusions ?? []) {
        mustNotClauses.push({ value: `kw:${kw}`, source: "phase1:keyword" });
      }
      strippedTerms.push(...intent.strip);
    }
  }

  return { mustNotClauses, strippedTerms };
}

/**
 * Common English words that are valid search terms in MTG queries but happen
 * to be within 1 edit of a real MTG keyword. Exempting them prevents false
 * keyword corrections (e.g. "leave" → "cleave", "heave" → "cleave").
 */
const FUZZY_KEYWORD_CORRECTION_BLOCKLIST = new Set([
  // "leave / leaves / leaving" sit 1 edit from "cleave"
  "leave", "leaves", "leaving",
  // other common verbs / prepositions near keywords
  "invoke",   // 1 edit from "convoke" (swap in→co)
  "evoke",    // 1 edit from "invoke" but also triggers on its own — keep safe
  "revoke",   // 1 edit from "convoke"
  "weave",    // 1 edit from "cleave"
  "heave",    // 1 edit from "cleave"
  // anatomy / art subjects near keywords
  "skull",    // 1 edit from "skulk"
  "skulls",   // 1 edit from "skulks"
]);

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
    if (FUZZY_KEYWORD_CORRECTION_BLOCKLIST.has(token)) continue;
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

/**
 * Returns true when the term (or any of its singular/plural forms) appears in the
 * query immediately after a negation phrase such as "not", "without", "non-", etc.
 * Used to route matched filters to mustNotClauses instead of mustClauses.
 */
function isTermNegated(naturalQuery: string, term: string): boolean {
  const lower = naturalQuery.toLowerCase();
  const forms = getTermForms(term).map(escapeRegex);
  const termPat = `(?:${forms.join("|")})`;

  const negWords =
    `(?:not|without|no|except(?:\\s+for)?|excluding|isn'?t|aren'?t` +
    `|is\\s+not|are\\s+not|that\\s+(?:is|are)\\s+not|rather\\s+than|other\\s+than)`;
  const qualifier = `(?:a\\s+|an\\s+|any\\s+|being\\s+(?:a\\s+|an\\s+)?)?`;

  if (new RegExp(`\\b${negWords}\\s+${qualifier}${termPat}\\b`, "i").test(lower)) return true;
  // "non-X" prefix form (e.g. "non-creature", "non-land")
  if (new RegExp(`\\bnon-${termPat}\\b`, "i").test(lower)) return true;
  // "non X" space-separated form (e.g. "non creature", "non land spells")
  if (new RegExp(`\\bnon\\s+${termPat}\\b`, "i").test(lower)) return true;

  return false;
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
    const preferred = [`synergy-${subject}`, `${subject}-synergy`].filter((tag) =>
      functionTags.has(tag)
    );
    const related = available
      .filter((tag) => tag.toLowerCase().includes("synergy") || tag.toLowerCase().includes("-matter"))
      .filter((tag) => tagContainsSubject(tag, subject))
      .sort((a, b) => a.length - b.length);

    const selected = [...new Set([...preferred, ...related])].slice(0, 4);
    // Only strip the subject when we actually found tags for it. If we strip
    // without emitting a clause the subject disappears entirely and the query
    // can end up empty. Keeping it lets it fall through to unresolved fragments
    // for AI resolution.
    if (selected.length === 0) continue;
    strippedTerms.push(subject, `${subject}s`);

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

// ---------------------------------------------------------------------------
// Card name detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `phrase` appears in `naturalQuery` immediately after a
 * relative pronoun or auxiliary verb — indicating it is used as a verb phrase
 * (oracle-text description) rather than a card name reference.
 *
 * Examples that should be blocked:
 *   "cards that deal damage to any target"   → "that deal" → verb context ✓
 *   "spells that counter a spell"            → "that counter" → verb context ✓
 *   "creatures that can fly"                 → "that can fly" → verb context ✓
 *
 * Examples that should NOT be blocked:
 *   "Lightning Bolt"                          → nothing before it
 *   "show me Counterspell"                    → "me" is not a verb-context word
 */
function isInVerbPhraseContext(naturalQuery: string, phrase: string): boolean {
  const lower = naturalQuery.toLowerCase();
  const pos = lower.indexOf(phrase.toLowerCase());
  if (pos < 0) return false;
  const before = lower.slice(0, pos).replace(/\s+$/, " ");
  // Matches text that ends with a relative pronoun or auxiliary verb
  // (optionally followed by a short adverb like "not", "also", "always")
  return /\b(?:that|which|who(?:m)?|can|could|will|would|do(?:es)?|did|may|might|must|should|shall)\s+(?:(?:not|also|only|always|never|even|still|just)\s+)?$/.test(before);
}

/**
 * Pre-pass: find multi-word (2+ words) card names as contiguous word windows
 * BEFORE structural parsing runs, so those words cannot be misidentified as
 * creature types, subtypes, formats, etc.
 *
 * Strategy: for each window of non-stopword tokens (lengths 5→2), take the
 * full original-word span between the first and last token of that window
 * (preserving stopwords like "the" that are inside the name), and check it
 * against the card name catalog.  We deliberately skip single-word matches
 * here — those are handled more carefully in the post-pass.
 *
 * Returns the canonical card name and the raw word tokens to reserve
 * (add to both semanticRoleTokens and strippedTerms before structural
 * parsing, so parsers ignore them).
 */
function cardNamePrePass(
  naturalQuery: string
): { canonical: string; reservedWords: string[] } | null {
  if (!hasCardNameIndex()) return null;

  const words = naturalQuery
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length < 2) return null;

  // Indices of words that are NOT stopwords
  const usefulIndices: number[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!STOPWORDS.has(words[i])) usefulIndices.push(i);
  }
  if (usefulIndices.length < 2) return null;

  const MAX_WINDOW = Math.min(6, usefulIndices.length);

  for (let len = MAX_WINDOW; len >= 2; len--) {
    for (let start = 0; start <= usefulIndices.length - len; start++) {
      const selectedIndices = usefulIndices.slice(start, start + len);
      const rangeStart = selectedIndices[0];
      const rangeEnd = selectedIndices[selectedIndices.length - 1];

      // Full-span phrase: include stopwords between the outer useful tokens
      // e.g. "jace the mind sculptor" for Jace, the Mind Sculptor
      const fullPhrase = words.slice(rangeStart, rangeEnd + 1).join(" ");
      const canonical = lookupCardName(fullPhrase);
      if (canonical && !isInVerbPhraseContext(naturalQuery, fullPhrase)) {
        return {
          canonical,
          reservedWords: words.slice(rangeStart, rangeEnd + 1),
        };
      }

      // Useful-only phrase: just the non-stopword tokens (no gaps)
      // e.g. "emrakul aeons torn" for Emrakul, the Aeons Torn
      const usefulPhrase = selectedIndices.map((i) => words[i]).join(" ");
      if (usefulPhrase !== fullPhrase) {
        const canonical2 = lookupCardName(usefulPhrase);
        if (canonical2 && !isInVerbPhraseContext(naturalQuery, usefulPhrase)) {
          return {
            canonical: canonical2,
            reservedWords: selectedIndices.map((i) => words[i]),
          };
        }
      }
    }
  }

  return null;
}

/**
 * Post-pass: called after all structural parsing, finds card name references
 * in what remains.  Handles:
 *   1. Explicit "named/called <Name>" patterns (always tried first).
 *   2. Bare multi-word card names in the leftover non-structural tokens.
 *   3. Single-word card names, but only when the word is the *sole* useful
 *      token remaining (user typed essentially just the card name).
 */
function detectCardNamePostPass(
  naturalQuery: string,
  strippedTerms: string[]
): { clauses: QueryClause[]; extraStripped: string[] } {
  const clauses: QueryClause[] = [];
  const extraStripped: string[] = [];
  if (!hasCardNameIndex()) return { clauses, extraStripped };

  // --- Pass 1: explicit "named / called <Name>" ---
  const NAMED_RE =
    /\b(?:named?|called)\s+([A-Za-z][A-Za-z'',.‐\- ]{0,60}?)(?=\s+(?:in|from|with|that|or|and|but|which|where)|\s*[,;]|\s*$)/gi;
  for (const match of naturalQuery.matchAll(NAMED_RE)) {
    const rawName = match[1].trim();
    const nameWords = rawName.split(/\s+/);
    // Try progressively shorter substrings so we always grab the longest valid name
    for (let len = nameWords.length; len >= 1; len--) {
      const candidate = nameWords.slice(0, len).join(" ");
      const canonical = lookupCardName(candidate);
      if (canonical) {
        clauses.push({ value: `name:"${canonical}"`, source: "phase1:cardname" });
        extraStripped.push(
          match[0].toLowerCase().split(/\s+/)[0], // "named" / "called"
          ...nameWords.slice(0, len).map((w) => w.toLowerCase())
        );
        break;
      }
    }
    // Whether or not a catalog match was found, strip "named"/"called" so it
    // doesn't pollute unresolved fragments sent to the AI.
    const keyword = match[0].toLowerCase().split(/\s+/)[0];
    if (!extraStripped.includes(keyword)) extraStripped.push(keyword);
  }

  // If an explicit pattern already resolved a name, we're done.
  if (clauses.length > 0) return { clauses, extraStripped };

  // --- Pass 2: bare card name in the remaining text ---
  const allStripped = [...strippedTerms, ...extraStripped];
  let remaining = naturalQuery.toLowerCase();
  for (const term of allStripped) {
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    remaining = remaining.replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ");
  }

  // Keep apostrophes and hyphens — they appear in real card names
  const tokens = remaining
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) return { clauses, extraStripped };

  const usefulCount = tokens.filter((t) => !STOPWORDS.has(t)).length;
  const usedPositions = new Set<number>();

  outer: for (
    let len = Math.min(6, tokens.length);
    len >= 1;
    len--
  ) {
    for (let start = 0; start <= tokens.length - len; start++) {
      let overlaps = false;
      for (let i = start; i < start + len; i++) {
        if (usedPositions.has(i)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      const candidate = tokens.slice(start, start + len).join(" ");
      const canonical = lookupCardName(candidate);
      if (!canonical) continue;

      // Single-word names are too ambiguous unless the word is the only
      // useful token left (i.e. the user typed essentially just the card name).
      if (len === 1 && usefulCount > 1) continue;

      // Skip names that appear as verb phrases in the original query
      // (e.g. "cards that deal damage" — "deal damage" is oracle text, not a name)
      if (len >= 2 && isInVerbPhraseContext(naturalQuery, candidate)) continue;

      clauses.push({ value: `name:"${canonical}"`, source: "phase1:cardname" });
      extraStripped.push(...tokens.slice(start, start + len));
      for (let i = start; i < start + len; i++) usedPositions.add(i);
      break outer;
    }
  }

  return { clauses, extraStripped };
}

/**
 * Within a single comma-delimited segment, extract all card names using a
 * greedy longest-first scan.  "and" / "or" connector words between names are
 * skipped so that "Call of the Ring and Black Market Connections" yields both
 * names while a card that legitimately contains "and" (e.g. "Sword of Law
 * and Order") is still found whole because the longest-first search tries the
 * full phrase before shorter substrings.
 */
type SegmentNameResult = {
  /** The Scryfall filter to emit.
   *  Exact matches: `name:"Canonical Name"` (quoted = exact).
   *  Partial matches: `name:word` (unquoted = Scryfall substring search). */
  scryfall: string;
  /** True when the name was verified against the card-names catalog. */
  isExact: boolean;
};

function resolveNamesInSegment(segment: string): SegmentNameResult[] {
  const words = segment
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const results: SegmentNameResult[] = [];
  let pos = 0;
  const MAX_NAME_LEN = 6;

  while (pos < words.length) {
    // Skip bare connector words between names
    if (words[pos] === "and" || words[pos] === "or") {
      pos++;
      continue;
    }

    // Greedy longest-first: try the longest run of words that forms a card name
    let matched = false;
    for (let len = Math.min(MAX_NAME_LEN, words.length - pos); len >= 1; len--) {
      const candidate = words.slice(pos, pos + len).join(" ");
      const canonical = lookupCardName(candidate);
      if (canonical) {
        results.push({ scryfall: `name:"${canonical}"`, isExact: true });
        pos += len;
        matched = true;
        break;
      }
    }

    if (!matched) pos++;
  }

  // If the entire segment yielded no catalog match AND it normalises to a
  // single meaningful word, treat it as a partial (substring) name search.
  // This lets users type e.g. "Animar" and get name:animar → Scryfall will
  // find "Animar, Soul of Elements" via its own substring matching.
  if (results.length === 0) {
    const meaningful = words.filter((w) => !STOPWORDS.has(w) && w !== "and" && w !== "or");
    if (meaningful.length === 1) {
      results.push({ scryfall: `name:${meaningful[0]}`, isExact: false });
    }
  }

  return results;
}

/**
 * Re-join pairs of comma-split segments that together form a known card name.
 *
 * Problem: "Animar, Soul of Elements" contains a comma, so a naive comma-split
 * produces ["animar", "soul of elements"] — two fragments that don't match
 * individually.  This pass greedily scans consecutive pairs and merges them
 * when the joined text is a known card name, restoring the full name for the
 * subsequent resolver to find.
 *
 * Tries both "X, Y" (exact — comma intact as in the real name) and "X Y"
 * (simplified — comma stripped, for the simplified index).
 */
function mergeCommaSplitNameFragments(segments: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < segments.length) {
    if (i < segments.length - 1) {
      const withComma = segments[i] + ", " + segments[i + 1];
      if (lookupCardName(withComma)) {
        result.push(withComma);
        i += 2;
        continue;
      }
      const withSpace = segments[i] + " " + segments[i + 1];
      if (lookupCardName(withSpace)) {
        result.push(withSpace);
        i += 2;
        continue;
      }
    }
    result.push(segments[i]);
    i++;
  }
  return result;
}

/**
 * Detect a comma-separated (or "and"-joined) list of card names, e.g.
 *   "Phyrexian Arena, Call of the Ring, Black Market Connections"
 *   "Phyrexian Arena, Call of the Ring and Black Market Connections"
 *   "Lightning Bolt, Counterspell, and Giant Growth"   (Oxford comma)
 *   "Animar, Soul of Elements, Lightning Bolt"         (name contains comma)
 *
 * If at least 2 names are resolved the whole query short-circuits to a single
 * OR name: clause with no structural parsing or AI call needed.
 *
 * Returns null when the query doesn't look like a card name list.
 */
function detectCardNameList(
  naturalQuery: string
): { clause: QueryClause; strippedWords: string[] } | null {
  if (!hasCardNameIndex()) return null;
  if (!naturalQuery.includes(",")) return null;

  // Split on commas; strip leading "and"/"or" from each piece (handles Oxford
  // comma: "A, B, and C" → ["A", "B", "C"])
  let segments = naturalQuery
    .split(",")
    .map((s) => s.trim().replace(/^(?:and|or)\s+/i, "").trim())
    .filter(Boolean);
  if (segments.length < 2) return null;

  // Re-join adjacent fragments that belong to the same comma-containing name
  // (e.g. ["animar", "soul of elements"] → ["animar, soul of elements"])
  segments = mergeCommaSplitNameFragments(segments);

  const allResults: SegmentNameResult[] = [];
  const strippedWords: string[] = [];

  for (const segment of segments) {
    const segResults = resolveNamesInSegment(segment);
    allResults.push(...segResults);
    for (const r of segResults) {
      // Strip the words so they don't pollute structural parsing
      const filterText = r.scryfall.replace(/^name:/i, "").replace(/"/g, "");
      strippedWords.push(...filterText.toLowerCase().split(/\s+/));
    }
  }

  // Commit to list mode when at least 2 catalog-verified (exact) names are found.
  // Requiring 2 exact matches prevents false positives from structural queries
  // that happen to contain a comma followed by a word that is incidentally also
  // a card name (e.g. "mutant, ninja or turtle creatures that synergize with …"
  // — "Ninja" is a real card but the query is asking for creature subtypes, not
  // a list of cards).  A genuine card-name list will always have 2+ confirmed names.
  const exactCount = allResults.filter((r) => r.isExact).length;
  if (exactCount < 2 || allResults.length < 2) return null;

  const nameValue =
    allResults.length === 1
      ? allResults[0].scryfall
      : `(${allResults.map((r) => r.scryfall).join(" or ")})`;

  return {
    clause: { value: nameValue, source: "phase1:cardname" },
    strippedWords,
  };
}

/**
 * Detects queries of the form "cards similar to X", "cards like X",
 * "similar to X", "alternatives to X", etc., where X resolves to a known
 * card name in the catalog.
 *
 * Returns the canonical card name when a match is found, or null otherwise.
 */
type BypassDetectResult = { cardName: string; strippedWords: string[] } | null;

function buildBypassStrippedWords(
  fullMatch: string,
  captureGroup: string,
  consumedInputWords: string[],
  canonical: string
): string[] {
  const triggerText = fullMatch.slice(0, fullMatch.length - captureGroup.length);
  const triggerWords = triggerText.toLowerCase().replace(/[^a-z]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const canonicalWords = canonical.toLowerCase().replace(/[^a-z0-9'\s-]/g, " ").split(/\s+/).filter(Boolean);
  return [...new Set([...triggerWords, ...consumedInputWords, ...canonicalWords])];
}

/**
 * Detects "art like X" / "cards with art like X" queries where the user wants
 * cards whose illustration shares the same visual art tags as a named card.
 *
 * Must run BEFORE detectSimilarToCardQuery so that "art like Bad River" is
 * captured here rather than being treated as functional similarity.
 */
function detectArtLikeCardQuery(naturalQuery: string): BypassDetectResult {
  if (!hasCardNameIndex()) return null;

  const ART_LIKE_PATTERNS: RegExp[] = [
    /\bart\s+(?:like|similar\s+to)\s+([\s\S]+)/i,
    /\bcards?\s+with\s+(?:art(?:work)?)\s+(?:like|similar\s+to)\s+([\s\S]+)/i,
    /\bartwork\s+(?:like|similar\s+to)\s+([\s\S]+)/i,
    /\blooks?\s+like\s+([\s\S]+)/i,
    /\billustration\s+(?:like|similar\s+to)\s+([\s\S]+)/i,
  ];

  const CONTEXT_STOPS = new Set([
    "in", "for", "from", "on", "at", "is", "are", "was", "were", "but",
    "which", "that", "where", "when", "if", "to",
  ]);

  for (const pattern of ART_LIKE_PATTERNS) {
    const match = naturalQuery.match(pattern);
    if (!match) continue;

    const rawText = match[1].trim();
    const words = rawText
      .toLowerCase()
      .replace(/[^a-z0-9'\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    for (let len = Math.min(words.length, 8); len >= 1; len--) {
      const candidate = words.slice(0, len).join(" ");
      const canonical = lookupCardName(candidate);
      if (canonical) {
        return { cardName: canonical, strippedWords: buildBypassStrippedWords(match[0], match[1], words.slice(0, len), canonical) };
      }
    }

    const nameWords: string[] = [];
    for (const w of words) {
      if (CONTEXT_STOPS.has(w)) break;
      nameWords.push(w);
      if (nameWords.length >= 6) break;
    }
    if (nameWords.length > 0) {
      const prefixCandidate = nameWords.join(" ");
      const canonical = lookupCardNameByPrefix(prefixCandidate);
      if (canonical) {
        return { cardName: canonical, strippedWords: buildBypassStrippedWords(match[0], match[1], nameWords, canonical) };
      }
    }
  }

  return null;
}

function detectSimilarToCardQuery(naturalQuery: string): BypassDetectResult {
  if (!hasCardNameIndex()) return null;

  const SIMILAR_PATTERNS: RegExp[] = [
    /\b(?:cards?|spells?|instants?|sorceries|enchantments?|artifacts?|creatures?|lands?)\s+similar\s+to\s+([\s\S]+)/i,
    /\bsimilar\s+(?:cards?\s+)?to\s+([\s\S]+)/i,
    /\b(?:cards?|spells?|instants?|sorceries|enchantments?|artifacts?|creatures?|lands?|something|anything)\s+like\s+([\s\S]+)/i,
    /\balternatives?\s+(?:to|for)\s+([\s\S]+)/i,
  ];

  const CONTEXT_STOPS = new Set([
    "in", "for", "from", "on", "at", "is", "are", "was", "were", "but",
    "which", "that", "where", "when", "if", "to",
  ]);

  for (const pattern of SIMILAR_PATTERNS) {
    const match = naturalQuery.match(pattern);
    if (!match) continue;

    const rawText = match[1].trim();
    const words = rawText
      .toLowerCase()
      .replace(/[^a-z0-9'\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    for (let len = Math.min(words.length, 8); len >= 1; len--) {
      const candidate = words.slice(0, len).join(" ");
      const canonical = lookupCardName(candidate);
      if (canonical) {
        return { cardName: canonical, strippedWords: buildBypassStrippedWords(match[0], match[1], words.slice(0, len), canonical) };
      }
    }

    const nameWords: string[] = [];
    for (const w of words) {
      if (CONTEXT_STOPS.has(w)) break;
      nameWords.push(w);
      if (nameWords.length >= 6) break;
    }
    if (nameWords.length > 0) {
      const prefixCandidate = nameWords.join(" ");
      const canonical = lookupCardNameByPrefix(prefixCandidate);
      if (canonical) {
        return { cardName: canonical, strippedWords: buildBypassStrippedWords(match[0], match[1], nameWords, canonical) };
      }
    }
  }

  return null;
}

/**
 * Detects queries where the user wants cards that synergize with a specific
 * named card — e.g. "cards that synergize with Glarb", "what goes well with
 * Atraxa", "combo pieces for Korvold".
 *
 * Must run AFTER the art-like and similar-to detectors so that phrases like
 * "cards like X" are handled by the more specific detector first.
 */
function detectSynergyWithCardQuery(naturalQuery: string): BypassDetectResult {
  if (!hasCardNameIndex()) return null;

  const SYNERGY_PATTERNS: RegExp[] = [
    /\bsynerg(?:ize|izes|izing|y|ies)\s+with\s+([\s\S]+)/i,
    /\bgo(?:es)?\s+well\s+with\s+([\s\S]+)/i,
    /\bpairs?\s+(?:well\s+)?with\s+([\s\S]+)/i,
    /\bworks?\s+(?:well\s+)?with\s+([\s\S]+)/i,
    /\bcombo\s+(?:pieces?\s+(?:for|with)|with)\s+([\s\S]+)/i,
    /\bcombos?\s+with\s+([\s\S]+)/i,
    /\b(?:cards?\s+(?:that\s+)?)?support\s+(?:for\s+)?([\s\S]+)/i,
    /\bbuild\s+around\s+([\s\S]+)/i,
    /\bcards?\s+for\s+(?:an?\s+)?([\s\S]+?)\s+deck\b/i,
    /\bgood\s+(?:with|in)\s+([\s\S]+)/i,
  ];

  const CONTEXT_STOPS = new Set([
    "in", "for", "from", "on", "at", "is", "are", "was", "were", "but",
    "which", "that", "where", "when", "if", "to",
  ]);

  for (const pattern of SYNERGY_PATTERNS) {
    const match = naturalQuery.match(pattern);
    if (!match) continue;

    const rawText = match[1].trim();
    const words = rawText
      .toLowerCase()
      .replace(/[^a-z0-9'\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    for (let len = Math.min(words.length, 8); len >= 1; len--) {
      const candidate = words.slice(0, len).join(" ");
      const canonical = lookupCardName(candidate);
      if (canonical) {
        return { cardName: canonical, strippedWords: buildBypassStrippedWords(match[0], match[1], words.slice(0, len), canonical) };
      }
    }

    const nameWords: string[] = [];
    for (const w of words) {
      if (CONTEXT_STOPS.has(w)) break;
      nameWords.push(w);
      if (nameWords.length >= 6) break;
    }
    if (nameWords.length > 0) {
      const prefixCandidate = nameWords.join(" ");
      const canonical = lookupCardNameByPrefix(prefixCandidate);
      if (canonical) {
        return { cardName: canonical, strippedWords: buildBypassStrippedWords(match[0], match[1], nameWords, canonical) };
      }
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
        phase0Normalized: false,
      },
    };
  }

  const mustClauses: QueryClause[] = [];
  const shouldClauses: QueryClause[] = [];
  const mustNotClauses: QueryClause[] = [];

  // Ensure catalog indexes (subtypes, card names, etc.) are ready before any
  // parsing step that depends on them.
  await ensureCatalogIndex();

  // Detect bypass intents (art-like, similar, synergy) but do NOT early-exit.
  // Mark the intent and strip the trigger phrase + card name so the rest of the
  // query (e.g. "that are not instants", "in commander") continues to be parsed.
  let bypassIntent: QueryIntent | null = null;
  let artLikeCardName: string | undefined;
  let similarToCardName: string | undefined;
  let synergyWithCardName: string | undefined;
  const bypassStrippedWords: string[] = [];

  const artLikeResult = detectArtLikeCardQuery(naturalQuery);
  if (artLikeResult) {
    bypassIntent = "art-like-cards";
    artLikeCardName = artLikeResult.cardName;
    bypassStrippedWords.push(...artLikeResult.strippedWords);
  }

  if (!bypassIntent) {
    const similarToResult = detectSimilarToCardQuery(naturalQuery);
    if (similarToResult) {
      bypassIntent = "similar-cards";
      similarToCardName = similarToResult.cardName;
      bypassStrippedWords.push(...similarToResult.strippedWords);
    }
  }

  if (!bypassIntent) {
    const synergyWithResult = detectSynergyWithCardQuery(naturalQuery);
    if (synergyWithResult) {
      bypassIntent = "synergy-with-card";
      synergyWithCardName = synergyWithResult.cardName;
      bypassStrippedWords.push(...synergyWithResult.strippedWords);
    }
  }

  for (const w of bypassStrippedWords) strippedTerms.push(w);

  // Early exit: comma-separated card name list ("Bolt, Counterspell, Growth")
  const cardNameList = detectCardNameList(naturalQuery);
  if (cardNameList) {
    return {
      naturalQuery,
      intent: "search",
      tokenizedQuery,
      noiseTokens: [],
      mustClauses: [cardNameList.clause],
      shouldClauses: [],
      mustNotClauses: [],
      unresolvedFragments: [],
      resolvedFragments: [],
      debug: {
        strippedTerms: cardNameList.strippedWords,
        aiBatchCalls: 0,
        aiSequentialCalls: 0,
        invalidTagsRemoved: 0,
        phase0Normalized: false,
      },
    };
  }

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
  for (const w of bypassStrippedWords) semanticRoleTokens.add(w);
  const triggerSubjectTokens = extractTriggerSubjectTokens(naturalQuery);

  // Pre-pass: detect multi-word card names before structural parsing so that
  // individual words of the name (e.g. "Giant" in "Giant Growth") are not
  // misidentified as creature types / subtypes.
  const prePassResult = cardNamePrePass(naturalQuery);
  if (prePassResult) {
    mustClauses.push({
      value: `name:"${prePassResult.canonical}"`,
      source: "phase1:cardname",
    });
    for (const word of prePassResult.reservedWords) {
      semanticRoleTokens.add(word);   // prevents TYPE_TOKENS from grabbing them
      strippedTerms.push(word);        // prevents catalog subtypes from grabbing them
    }
  }

  const matchedTypes: string[] = [];
  const negatedTypes: string[] = [];
  for (const type of TYPE_TOKENS) {
    const typeForms = getTermForms(type);
    // Check both singular ("creature") and plural ("creatures") forms against the semantic-role set,
    // because captured tokens may have been stored in plural form.
    const isSemanticRole = typeForms.some((f) => semanticRoleTokens.has(f));
    const isTriggerSubject = typeForms.some((f) => triggerSubjectTokens.has(f));
    if (synergySubjects.has(type) || isSemanticRole || isTriggerSubject) {
      // Don't strip synergy subjects here — let resolveSynergyFunctionClauses
      // strip them only if tags are found; otherwise they fall through to AI resolution.
      // Semantic-role tokens (subject/object markers) are noise and can be stripped.
      // Trigger-subject tokens must NOT be stripped — AI needs them for context.
      if (isSemanticRole && !isTriggerSubject) strippedTerms.push(...typeForms);
      continue;
    }
    if (buildTermFormsPattern(typeForms).test(naturalQuery)) {
      if (isTermNegated(naturalQuery, type)) {
        negatedTypes.push(type);
      } else {
        matchedTypes.push(type);
      }
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
  for (const type of negatedTypes) {
    mustNotClauses.push({ value: `t:${type}`, source: "phase1:type" });
  }

  const catalogTokens = tokenizeNaturalQuery(naturalQuery);
  const matchedSubtypes = new Set<string>();
  const alreadyHandled = new Set([
    ...strippedTerms.map((t) => t.toLowerCase()),
    ...FORMAT_TOKENS.map((f) => f.toLowerCase()),
    ...Object.keys(COLOR_IDENTITY),
    ...semanticRoleTokens,
    ...triggerSubjectTokens,
  ]);

  // Collect supertypes first (position tracked via original query token)
  const supertypeMatches: { canonical: string; queryToken: string }[] = [];

  for (const token of catalogTokens) {
    if (STOPWORDS.has(token) || alreadyHandled.has(token)) continue;
    const superMatch = matchSupertype(token);
    if (superMatch) {
      const stLower = superMatch.toLowerCase();
      if (!matchedSubtypes.has(stLower)) {
        matchedSubtypes.add(stLower);
        strippedTerms.push(...getTermForms(stLower));
        if (isTermNegated(naturalQuery, stLower)) {
          mustNotClauses.push({ value: `t:${quoteIfNeeded(stLower)}`, source: "phase1:subtype" });
        } else {
          supertypeMatches.push({ canonical: stLower, queryToken: token });
        }
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
  type CatalogMatch = { canonical: string; queryToken: string; isWithContext?: boolean };
  const subtypeMatches: CatalogMatch[] = [];

  for (let i = 0; i < catalogTokens.length; i++) {
    const token = catalogTokens[i];
    if (STOPWORDS.has(token) || alreadyHandled.has(token)) continue;

    const bigram =
      i < catalogTokens.length - 1
        ? `${catalogTokens[i]} ${catalogTokens[i + 1]}`
        : null;

    const addSubtypeMatch = (stLower: string, queryToken: string, matchIndex: number, extraStrip?: string) => {
      if (matchedSubtypes.has(stLower)) return;
      matchedSubtypes.add(stLower);
      strippedTerms.push(...getTermForms(stLower));
      if (extraStrip) strippedTerms.push(extraStrip);

      let isWithContext = false;
      let prevIndex = matchIndex - 1;
      while (prevIndex >= 0) {
        const pt = catalogTokens[prevIndex];
        if (pt === "with") {
          isWithContext = true;
          if (!strippedTerms.includes("with")) {
            strippedTerms.push("with");
          }
          break;
        }
        if (!STOPWORDS.has(pt) && !matchedSubtypes.has(pt) && !matchedSubtypes.has(singularizeSubject(pt))) {
          break;
        }
        prevIndex--;
      }

      if (isTermNegated(naturalQuery, stLower)) {
        mustNotClauses.push({ value: `t:${quoteIfNeeded(stLower)}`, source: "phase1:subtype" });
      } else {
        subtypeMatches.push({ canonical: stLower, queryToken, isWithContext });
      }
    };

    if (bigram) {
      const bigramMatch = matchSubtype(bigram);
      if (bigramMatch && !synergySubjects.has(bigramMatch.name.toLowerCase())) {
        addSubtypeMatch(bigramMatch.name.toLowerCase(), bigram, i, bigram);
        continue;
      }
    }

    const subMatch = matchSubtype(token);
    if (subMatch) {
      const stLower = subMatch.name.toLowerCase();
      if (synergySubjects.has(stLower) || synergySubjects.has(token)) {
        // Don't strip here — resolveSynergyFunctionClauses will strip the subject
        // only if it finds matching tags. If it finds nothing, the subject must
        // remain in the text so it reaches the AI resolver as an unresolved fragment.
        continue;
      }
      addSubtypeMatch(stLower, token, i);
      continue;
    }

    if (token.length >= 5 && !matchedSubtypes.has(token)) {
      const fuzzy = fuzzyMatchSubtype(token, shouldUseFuzzyMatch);
      if (fuzzy) {
        const stLower = fuzzy.name.toLowerCase();
        if (!synergySubjects.has(stLower)) {
          addSubtypeMatch(stLower, token, i, token);
        }
      }
    }
  }

  if (subtypeMatches.length > 0) {
    const overrides = new Map(subtypeMatches.map((m) => [m.canonical, m.queryToken]));
    const groups = groupByConnector(naturalQuery, subtypeMatches.map((m) => m.canonical), overrides);

    for (const group of groups) {
      const mappedTerms = group.map((term) => {
        const match = subtypeMatches.find((m) => m.canonical === term);
        const quoted = quoteIfNeeded(term);
        if (match?.isWithContext) {
          return `(t:${quoted} or art:${quoted})`;
        }
        return `t:${quoted}`;
      });

      if (mappedTerms.length === 1) {
        mustClauses.push({ value: mappedTerms[0], source: "phase1:subtype" });
      } else {
        mustClauses.push({ value: `(${mappedTerms.join(" or ")})`, source: "phase1:subtype" });
      }
    }
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
  // Strip single-color modifier prefixes that are made redundant once the color
  // term itself is stripped. "mono-blue" → "blue" is stripped above, leaving "mono"
  // as an orphaned fragment that confuses the Phase 2 AI into picking tags like
  // function:color-count-matters. Strip these modifiers unconditionally so they
  // never reach Phase 2 as unresolved noise.
  if (/\bmono[-\s]/i.test(lower)) strippedTerms.push("mono");
  if (/\bpure[-\s]/i.test(lower)) strippedTerms.push("pure");
  if (/\bsingle[-\s]color(?:ed)?\b/i.test(lower)) strippedTerms.push("single");
  const commanderDeck = hasCommanderDeckContext(naturalQuery);

  // Detect colors that are explicitly negated ("not blue", "without red", etc.)
  // and emit them as must-not clauses. Also mask them from positive color extraction.
  const { negatedColorLetters, maskedQuery: colorMaskedQuery } = detectColorNegations(lower);
  if (negatedColorLetters) {
    for (const c of negatedColorLetters) {
      mustNotClauses.push({ value: `c:${c}`, source: "phase1:color" });
    }
  }

  // Detect standalone color shorthands ("wubr", "rg", "wu", "w", …).
  // Shorthands take priority over incidental color words (e.g. "blue" in "blue artifacts
  // with flash in wubr color identity") so they must be checked before extractColorIdentityFromText.
  const colorShorthand = detectColorShorthand(colorMaskedQuery);
  if (colorShorthand) strippedTerms.push(colorShorthand.matchedText);

  const commanderColor =
    resolveCommanderColorIdentity(naturalQuery) ||
    colorShorthand?.colors ||
    extractColorIdentityFromText(colorMaskedQuery) ||
    null;
  if (/\bcolor\s+identity\b/i.test(naturalQuery)) {
    strippedTerms.push("color identity", "color", "identity");
  }

  if (commanderDeck) {
    mustClauses.push({ value: "f:commander", source: "phase1:commander" });
    strippedTerms.push("commander");
    if (commanderColor) {
      mustClauses.push({ value: `id<=${commanderColor}`, source: "phase1:color" });
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
      // Default to color identity (id:) — it's the safer, broader filter and works well
      // for both casual searches ("blue creatures") and deck-building contexts.
      // Only use card color (c:) when the query explicitly references the card's own color
      // (e.g. "card color is blue", "blue color symbol").
      const useCardColorExplicitly =
        /\bcard\s+colou?r\b|\bcolou?r\s+(?:of\s+the\s+card|symbol|pip)\b/i.test(naturalQuery);
      const useIdentityFilter = !useCardColorExplicitly;

      // Card color (c): default exact (c=), use superset (c:) only for inclusion language.
      // Color identity (id): default superset (id:), use exact (id=) only for explicit
      // "exactly/only/mono-X" language — because id: is the natural fit for commander
      // compatibility and "what cards have this identity" queries.
      const isColorInclusionQuery = detectColorInclusionIntent(naturalQuery);
      const isExactIdentityQuery = detectExactColorIdentityIntent(naturalQuery);

      if (useIdentityFilter) {
        mustClauses.push({
          value: isExactIdentityQuery ? `id=${commanderColor}` : `id:${commanderColor}`,
          source: "phase1:color",
        });

        // Dual-filter edge case: when a color shorthand drives the identity (e.g. "wubr
        // color identity"), individual color words like "blue" or "mono-blue" also describe
        // the card's own color and should emit a secondary c: filter.
        if (colorShorthand) {
          const wordColor = extractColorIdentityFromText(lower);
          if (wordColor && wordColor !== commanderColor) {
            mustClauses.push({
              value: isColorInclusionQuery ? `c:${wordColor}` : `c=${wordColor}`,
              source: "phase1:color",
            });
          }
        }
      } else {
        mustClauses.push({
          value: isColorInclusionQuery ? `c:${commanderColor}` : `c=${commanderColor}`,
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
    // Strip attribution verbs that precede "by [artist]" (e.g. "illustrated by", "drawn by", "painted by")
    const attributionPrefix = /\b(illustrat\w*|drawn|painted|created|artwork?)\s+by\b/i.exec(naturalQuery);
    if (attributionPrefix) {
      strippedTerms.push(attributionPrefix[1].toLowerCase());
    }
  }

  const keywordList = await getMtgKeywordList();
  const { correctedQuery, matchedTypos } = applyFuzzyKeywordCorrections(
    naturalQuery,
    keywordList
  );
  strippedTerms.push(...matchedTypos);

  // --- Generic grant/give/make <keyword> detection ---
  // "give your creatures flying", "grant all permanents indestructible", "make others hexproof"
  // Runs against correctedQuery so typos ("indestrucible") are already normalised.
  // For each MTG keyword, if a grant verb immediately precedes an optional recipient and the
  // keyword itself, emit the most precise tag available:
  //   - function:<keyword> when a dedicated tagger "granter" tag exists (most precise — only
  //     matches cards that grant the keyword, not cards that merely have it themselves)
  //   - o:<keyword> as fallback for keywords without a dedicated granter function tag
  {
    // Keywords that have a dedicated Scryfall tagger granter function tag (gives-<slug>).
    // These are strictly more precise than oracle text: they match cards that grant the
    // ability to others, not cards that merely have it themselves.
    // All entries confirmed present in data/tagger-tags.json.
    const KEYWORD_GRANT_FUNCTION_TAG: Readonly<Record<string, string>> = {
      indestructible: "function:gives-indestructible",
      hexproof: "function:gives-hexproof",
      haste: "function:gives-haste",
      protection: "function:gives-protection",
      flying: "function:gives-flying",
      trample: "function:gives-trample",
      vigilance: "function:gives-vigilance",
      lifelink: "function:gives-lifelink",
      deathtouch: "function:gives-deathtouch",
      reach: "function:gives-reach",
      menace: "function:gives-menace",
      prowess: "function:gives-prowess",
      flash: "function:gives-flash",
      ward: "function:gives-ward",
      shroud: "function:gives-shroud",
      shadow: "function:gives-shadow",
      "first strike": "function:gives-first-strike",
      "double strike": "function:gives-double-strike",
    };

    const GRANT_VERBS =
      /\b(?:give[sd]?|giving|grant[sd]?|granting|make[sd]?|making)\b/i;
    const RECIPIENT_OPT =
      "(?:(?:your|all|each|every|other|others|target|a|an|any|friendly)\\s+)?(?:(?:creatures?|permanents?|things?|cards?|tokens?)\\s+)?";

    if (GRANT_VERBS.test(correctedQuery)) {
      // Sort longest keywords first so multi-word variants ("first strike") win over "strike"
      const sortedKeywords = [...keywordList].sort((a, b) => b.length - a.length);
      const alreadyMatched = new Set<string>();
      for (const kw of sortedKeywords) {
        const kwLower = kw.toLowerCase();
        // Skip if a longer keyword already covered this word (e.g. skip "strike" once "first strike" matched)
        if ([...alreadyMatched].some((m) => m.includes(kwLower))) continue;

        const kwEscape = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
        const pattern = new RegExp(
          `\\b(?:give[sd]?|giving|grant[sd]?|granting|make[sd]?|making)\\s+${RECIPIENT_OPT}${kwEscape}s?\\b`,
          "i"
        );
        const match = pattern.exec(correctedQuery);
        if (!match) continue;

        const functionTag = KEYWORD_GRANT_FUNCTION_TAG[kwLower];
        const clauseValue = functionTag ?? `o:${/\s/.test(kw) ? `"${kw}"` : kwLower}`;
        const clauseSource: ClauseSource = functionTag ? "phase1:function" : "phase1:oracle";
        if (!mustClauses.some((c) => c.value === clauseValue)) {
          mustClauses.push({ value: clauseValue, source: clauseSource });
        }

        // Strip the entire matched phrase (grant verb + recipient + keyword) so it doesn't
        // survive as an unresolved fragment that Phase 2 might misinterpret (e.g., "make others"
        // being resolved as function:grows-others).
        const matchedPhrase = match[0].toLowerCase();
        const phraseWords = matchedPhrase.match(/[a-z]+/g) || [];
        strippedTerms.push(...phraseWords);
        alreadyMatched.add(kwLower);
      }
    }
  }

  const keywordFilters = await resolveKeywordFilters(correctedQuery);
  const positiveKeywords: string[] = [];
  for (const keyword of keywordFilters) {
    const kw = keyword.toLowerCase();
    
    // Skip keywords that are substrings of already-reserved words from card names
    // e.g. "delve" shouldn't match if "delver" is already reserved
    let isPartOfReservedWord = false;
    for (const reserved of strippedTerms) {
      if (reserved.includes(kw) && reserved !== kw) {
        isPartOfReservedWord = true;
        break;
      }
    }
    if (isPartOfReservedWord) continue;
    
    strippedTerms.push(kw);
    // Also strip any synonym phrase that expanded to this keyword
    for (const { pattern, keyword: synKeyword } of KEYWORD_SYNONYM_STRIPS) {
      if (synKeyword === kw) {
        const matches = naturalQuery.match(pattern);
        if (matches) strippedTerms.push(...matches.map((m) => m.toLowerCase()));
      }
    }
    if (isTermNegated(naturalQuery, kw)) {
      mustNotClauses.push({
        value: `kw:${/\s/.test(kw) ? `"${kw}"` : kw}`,
        source: "phase1:keyword",
      });
    } else {
      positiveKeywords.push(kw);
    }
  }
  mustClauses.push(
    ...buildGroupedClauses(
      groupByConnector(naturalQuery, positiveKeywords),
      "kw",
      "phase1:keyword",
      (k) => (/\s/.test(k) ? `"${k}"` : k)
    )
  );

  const strategyResult = detectStrategyClauses(correctedQuery);
  mustClauses.push(...strategyResult.clauses);
  strippedTerms.push(...strategyResult.strippedTerms);

  const statResult = resolveNumericStatFilters(naturalQuery);
  mustClauses.push(...statResult.clauses);
  strippedTerms.push(...statResult.strippedTerms);

  const synergyResult = await resolveSynergyFunctionClauses(synergySubjects);
  mustClauses.push(...synergyResult.clauses);
  strippedTerms.push(...synergyResult.strippedTerms);

  applyOracleIntentHeuristics(naturalQuery, mustClauses, strippedTerms);

  const aversionResult = resolveAversionOracleIntents(naturalQuery);
  mustNotClauses.push(...aversionResult.mustNotClauses);
  strippedTerms.push(...aversionResult.strippedTerms);

  // --- Explicit MTG action verb detection ---
  // When the user names a specific game action (exile, destroy, counter, bounce),
  // emit oracle text directly so the exact method is preserved. This prevents the
  // verb fragment from reaching phase 2 where it collapses into a broad removal
  // archetype that ignores the specific method the user asked for.
  {
    const EXPLICIT_ACTION_RULES: Array<{
      detect: RegExp;
      oracle: string[];
      strip: string[];
    }> = [
      {
        // "exile a creature", "that exiles target permanent", "to exile each artifact"
        detect:
          /\b(?:that\s+|to\s+|can\s+|will\s+|would\s+)?exiles?\s+(?:a\s+|an\s+|target\s+|each\s+|all\s+|any\s+)?(?:creature|permanent|artifact|enchantment|land|card|spell|token|planeswalker)s?\b/i,
        oracle: ["o:exile"],
        strip: ["exile", "exiles"],
      },
      {
        // "destroy a creature", "that destroys target artifact"
        detect:
          /\b(?:that\s+|to\s+|can\s+|will\s+|would\s+)?destroys?\s+(?:a\s+|an\s+|target\s+|each\s+|all\s+|any\s+)?(?:creature|permanent|artifact|enchantment|land|card|token|planeswalker)s?\b/i,
        oracle: ["o:destroy"],
        strip: ["destroy", "destroys"],
      },
      {
        // "counter a spell", "that counters target ability"
        detect:
          /\b(?:that\s+|to\s+|can\s+)?counters?\s+(?:a\s+|an?\s+|target\s+)?(?:spell|ability)s?\b/i,
        oracle: ["o:counter"],
        strip: ["counter", "counters"],
      },
      {
        // "bounce a creature", "bounces target permanent"
        detect:
          /\bbounce[sd]?\s+(?:a\s+|an?\s+|target\s+|each\s+|all\s+|any\s+)?(?:creature|permanent|artifact|enchantment|land|token)s?\b/i,
        oracle: ["o:return", "o:hand"],
        strip: ["bounce", "bounces", "bounced"],
      },
    ];

    for (const rule of EXPLICIT_ACTION_RULES) {
      if (!rule.detect.test(naturalQuery)) continue;
      for (const oracleValue of rule.oracle) {
        if (!mustClauses.some((c) => c.value === oracleValue)) {
          mustClauses.push({ value: oracleValue, source: "phase1:oracle" });
        }
      }
      strippedTerms.push(...rule.strip);
    }
  }

  // --- Card face / layout IS-flag detection ---
  // Specific abbreviations and layout terms that map unambiguously to Scryfall
  // is: flags. Handled deterministically so they never reach the AI as fragments.
  {
    const IS_FLAG_RULES: Array<{
      detect: RegExp;
      flag: string;
      strip: string[];
    }> = [
      {
        // "mdfc", "modal double-faced", "double-faced modal"
        detect: /\b(?:mdfc|modal\s+double[-\s]faced|double[-\s]faced\s+modal)\b/i,
        flag: "is:mdfc",
        strip: ["mdfc", "modal double-faced", "double faced modal", "modal", "double-faced", "double faced"],
      },
      {
        // "tdfc", "transform double-faced", "transforming double-faced"
        detect: /\b(?:tdfc|transform(?:ing)?\s+double[-\s]faced|double[-\s]faced\s+transform(?:ing)?)\b/i,
        flag: "is:tdfc",
        strip: ["tdfc", "transform double-faced", "transforming double-faced", "double faced transform"],
      },
      {
        // "dfc", "double-faced card(s)" — generic, catches both tdfc and mdfc
        // Disqualify when a more specific term (mdfc/tdfc) was already detected
        detect: /\b(?:dfc|double[-\s]faced\s+cards?)\b/i,
        flag: "is:dfc",
        strip: ["dfc", "double-faced card", "double faced card", "double-faced cards", "double faced cards"],
      },
      {
        // "meld card(s)", "is meld", "are meld"
        detect: /\b(?:meld\s+cards?|(?:is|are)\s+(?:a\s+)?meld)\b/i,
        flag: "is:meld",
        strip: ["meld"],
      },
      {
        // "split card(s)"
        detect: /\bsplit\s+cards?\b/i,
        flag: "is:split",
        strip: ["split"],
      },
      {
        // "flip card(s)"
        detect: /\bflip\s+cards?\b/i,
        flag: "is:flip",
        strip: ["flip"],
      },
      {
        // "saga card(s)" — Scryfall uses t:saga but this ensures deterministic handling
        detect: /\bsaga\s+cards?\b/i,
        flag: "t:saga",
        strip: ["saga"],
      },
      {
        // Only trigger is:funny for explicit Un-set / silver-border / acorn requests.
        // Generic vibe words like "funny" or "hilarious" are handled by STOPWORDS
        // so they don't become unresolved fragments — they describe desired game feel,
        // not a request for literally silver-bordered / acorn cards.
        detect: /\b(?:silver[-\s]border(?:ed)?|acorn\s+cards?|un[-\s]?sets?(?:\s+cards?)?|un-?glued|un-?hinged|un-?stable|un-?finityy?|undone)\b/i,
        flag: "is:funny",
        strip: ["silver border", "silver-border", "silver bordered", "acorn", "un-set", "unset", "unglued", "un-glued", "unhinged", "un-hinged", "unstable", "un-stable", "unfinity", "un-finity"],
      },
    ];

    // Track which flags were already emitted so more-specific rules win over generic ones
    const emittedIsFlags = new Set<string>();
    for (const rule of IS_FLAG_RULES) {
      if (!rule.detect.test(naturalQuery)) continue;
      // Skip is:dfc if is:mdfc or is:tdfc was already emitted (more specific wins)
      if (rule.flag === "is:dfc" && (emittedIsFlags.has("is:mdfc") || emittedIsFlags.has("is:tdfc"))) {
        continue;
      }
      if (!mustClauses.some((c) => c.value === rule.flag)) {
        mustClauses.push({ value: rule.flag, source: "phase1:is-flag" });
      }
      emittedIsFlags.add(rule.flag);
      strippedTerms.push(...rule.strip);
    }
  }

  // --- Named land cycle detection ---
  // Specific MTG land cycle names and "N color land" patterns that map
  // unambiguously to function: tags. Prevents the AI from mis-classifying
  // e.g. "3 color lands" as function:color-count-matters.
  {
    const LAND_CYCLE_RULES: Array<{
      detect: RegExp;
      tags: string[];
      strip: string[];
    }> = [
      {
        // "triland(s)", "triome(s)", "tri-land(s)", "3 color land(s)", "three color land(s)"
        detect: /\b(?:trilands?|triomes?|tri-lands?|(?:3|three)[-\s]?color(?:ed)?\s+lands?|lands?\s+(?:that\s+(?:produce|add|tap\s+for)\s+)?(?:three|3)\s+colors?)\b/i,
        tags: ["function:triland"],
        // Strip both compound phrases AND the individual residual tokens so that
        // after type-detection removes "lands", the leftover "3 color" / "three color"
        // doesn't survive as an unresolved fragment.
        strip: [
          "triland", "trilands", "triome", "triomes", "tri-land", "tri-lands",
          "3 color lands", "3 color land", "three color lands", "three color land",
          "3-color lands", "3-color land", "three-color lands", "three-color land",
          "3", "three", "color", "colors", "colored", "colour", "colours", "coloured",
        ],
      },
      {
        // "dual land(s)", "original dual(s)", "ABU dual(s)" — the Power 9 era duals
        detect: /\b(?:dual\s+lands?|original\s+duals?|abu\s+duals?|original\s+dual\s+lands?|abu\s+dual\s+lands?)\b/i,
        tags: ["function:dual-land"],
        strip: ["dual land", "dual lands", "original dual", "original duals", "abu dual", "abu duals", "original dual land", "original dual lands", "abu dual land", "abu dual lands"],
      },
      {
        // "fetchland(s)", "fetch land(s)"
        detect: /\b(?:fetchlands?|fetch\s+lands?)\b/i,
        tags: ["function:fetchland"],
        strip: ["fetchland", "fetchlands", "fetch land", "fetch lands"],
      },
      {
        // "shockland(s)", "shock land(s)"
        detect: /\b(?:shocklands?|shock\s+lands?)\b/i,
        tags: ["function:shockland"],
        strip: ["shockland", "shocklands", "shock land", "shock lands"],
      },
      {
        // "painland(s)", "pain land(s)"
        detect: /\b(?:painlands?|pain\s+lands?)\b/i,
        tags: ["function:painland"],
        strip: ["painland", "painlands", "pain land", "pain lands"],
      },
      {
        // "filterland(s)", "filter land(s)"
        detect: /\b(?:filterlands?|filter\s+lands?)\b/i,
        tags: ["function:filterland"],
        strip: ["filterland", "filterlands", "filter land", "filter lands"],
      },
      {
        // "bounceland(s)", "bounce land(s)"
        detect: /\b(?:bouncelands?|bounce\s+lands?)\b/i,
        tags: ["function:bounceland"],
        strip: ["bounceland", "bouncelands", "bounce land", "bounce lands"],
      },
      {
        // "manland(s)", "man land(s)", "creatureland(s)", "creature land(s)"
        detect: /\b(?:manlands?|man\s+lands?|creaturelands?|creature\s+lands?)\b/i,
        tags: ["is:manland"],
        strip: ["manland", "manlands", "man land", "man lands", "creatureland", "creaturelands", "creature land", "creature lands"],
      },
      {
        // "checkland(s)", "check land(s)"
        detect: /\b(?:checklands?|check\s+lands?)\b/i,
        tags: ["function:cycle-checkland"],
        strip: ["checkland", "checklands", "check land", "check lands"],
      },
      {
        // "fastland(s)", "fast land(s)"
        detect: /\b(?:fastlands?|fast\s+lands?)\b/i,
        tags: ["function:cycle-fastland"],
        strip: ["fastland", "fastlands", "fast land", "fast lands"],
      },
      {
        // "tangoland(s)", "tango land(s)", "battle land(s)" (BFZ dual tap-lands)
        detect: /\b(?:tangolands?|tango\s+lands?|battle\s+lands?)\b/i,
        tags: ["function:cycle-tangoland"],
        strip: ["tangoland", "tangolands", "tango land", "tango lands", "battle land", "battle lands"],
      },
      {
        // "scryland(s)", "scry land(s)"
        detect: /\b(?:scrylands?|scry\s+lands?)\b/i,
        tags: ["function:cycle-scryland"],
        strip: ["scryland", "scrylands", "scry land", "scry lands"],
      },
      {
        // "canopyland(s)", "canopy land(s)"
        detect: /\b(?:canopylands?|canopy\s+lands?)\b/i,
        tags: ["function:cycle-canopy-land"],
        strip: ["canopyland", "canopylands", "canopy land", "canopy lands"],
      },
      {
        // "slowland(s)", "slow land(s)"
        detect: /\b(?:slowlands?|slow\s+lands?)\b/i,
        tags: ["function:slowland"],
        strip: ["slowland", "slowlands", "slow land", "slow lands"],
      },
    ];

    for (const rule of LAND_CYCLE_RULES) {
      if (!rule.detect.test(naturalQuery)) continue;
      for (const tag of rule.tags) {
        if (!mustClauses.some((c) => c.value === tag)) {
          mustClauses.push({ value: tag, source: "phase1:is-flag" });
        }
      }
      strippedTerms.push(...rule.strip);
    }
  }

  // Post-pass: detect card names in remaining text (handles "named/called X"
  // and bare card names that survived structural parsing).  Skip if the
  // pre-pass already found a card name.
  if (!prePassResult) {
    const postPassResult = detectCardNamePostPass(naturalQuery, strippedTerms);
    mustClauses.push(...postPassResult.clauses);
    strippedTerms.push(...postPassResult.extraStripped);
  }

  const { unresolvedFragments, noiseTokens } = buildUnresolvedFragments(
    naturalQuery,
    strippedTerms
  );

  return {
    naturalQuery,
    intent: bypassIntent ?? (commanderDeck ? "commander-deck" : "search"),
    similarToCardName,
    artLikeCardName,
    synergyWithCardName,
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
      phase0Normalized: false,
    },
  };
}

