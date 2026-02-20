import { hasCommanderDeckContext, resolveCommanderColorIdentity } from "@/lib/commander-context";
import { getMtgKeywordList, resolveKeywordFilters } from "@/lib/mtg-keywords";
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

function extractColorIdentityFromText(lowerQuery: string): string | null {
  let best: string | null = null;
  let bestLength = 0;
  for (const [name, id] of Object.entries(COLOR_IDENTITY)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(lowerQuery) && name.length > bestLength) {
      best = id;
      bestLength = name.length;
    }
  }

  if (best) {
    return best;
  }

  const tokens = lowerQuery
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const token of tokens) {
    if (token.length < 5) continue;
    for (const [name, id] of Object.entries(COLOR_IDENTITY)) {
      if (name.includes(" ")) continue;
      if (SINGLE_COLOR_NAMES.has(name)) continue;
      if (name.length < 5) continue;
      const distance = levenshteinDistance(token, name);
      if (distance <= 1) {
        return id;
      }
    }
  }

  return best;
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

function extractSynergySubjects(naturalQuery: string): Set<string> {
  const subjects = new Set<string>();
  const lower = naturalQuery.toLowerCase();
  const patterns = [
    /\b([a-z][a-z-]{2,})\s+synerg(?:y|ies)\b/gi,
    /\bsynerg(?:ize|izes|izing|y|ies)\s+with\s+([a-z][a-z-]{2,})\b/gi,
    /\bwork(?:s)?(?:\s+well)?\s+with\s+([a-z][a-z-]{2,})\b/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lower)) !== null) {
      const raw = (match[1] || "").trim();
      if (!raw) continue;
      const singular = singularizeSubject(raw);
      if (singular.length >= 3) {
        subjects.add(singular);
      }
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
  const strippedTerms: string[] = ["synergy", "synergies"];

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
    clauses.push({
      value: tagChain.length === 1 ? tagChain[0] : `(${tagChain.join(" OR ")})`,
      source: "phase1:function",
    });
  }

  return { clauses, strippedTerms };
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

  for (const format of FORMAT_TOKENS) {
    if (new RegExp(`\\b${format}\\b`, "i").test(naturalQuery)) {
      mustClauses.push({ value: `f:${format}`, source: "phase1:format" });
      strippedTerms.push(format);
    }
  }

  for (const type of TYPE_TOKENS) {
    if (synergySubjects.has(type)) {
      strippedTerms.push(type);
      continue;
    }
    if (new RegExp(`\\b${type}s?\\b`, "i").test(naturalQuery)) {
      mustClauses.push({ value: `t:${type}`, source: "phase1:type" });
      strippedTerms.push(type);
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
  const commanderDeck = hasCommanderDeckContext(naturalQuery);
  const commanderColor = resolveCommanderColorIdentity(naturalQuery) || extractColorIdentityFromText(lower);
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
      mustClauses.push({ value: `id:${commanderColor}`, source: "phase1:color" });
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

  const keywordList = await getMtgKeywordList();
  const { correctedQuery, matchedTypos } = applyFuzzyKeywordCorrections(
    naturalQuery,
    keywordList
  );
  strippedTerms.push(...matchedTypos);

  const keywordFilters = await resolveKeywordFilters(correctedQuery);
  for (const keyword of keywordFilters) {
    mustClauses.push({
      value: /\s/.test(keyword) ? `kw:"${keyword}"` : `kw:${keyword.toLowerCase()}`,
      source: "phase1:keyword",
    });
    strippedTerms.push(keyword.toLowerCase());
  }

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

