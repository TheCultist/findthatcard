import OpenAI from "openai";
import {
  getUserPrompt,
} from "@/lib/prompts";
import { buildSystemPrompt, selectPacks } from "@/lib/prompts/promptModules";
import { TaggerTagContext, extractArtKeywords } from "@/lib/tagger/context";
import {
  expandStrategyTags,
  resolveStrategyName,
  STRATEGY_ORACLETAGS,
} from "@/lib/strategies/oracletagStrategies";
import { hasCommanderDeckContext } from "@/lib/commander-context";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClient) {
    return openaiClient;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "The OPENAI_API_KEY environment variable is missing or empty."
    );
  }
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_SCRYFALL_QUERY_LENGTH = 1200;
export const PREFER_BEST_PREFIX = "prefer:best "; // 12 characters
export const EFFECTIVE_MAX_QUERY_LENGTH =
  MAX_SCRYFALL_QUERY_LENGTH - PREFER_BEST_PREFIX.length; // 588 characters
const FORMAT_NAMES = [
  "legacy",
  "modern",
  "standard",
  "pioneer",
  "vintage",
  "pauper",
  "commander",
  "brawl",
] as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeFormatFunctionTags(query: string): string {
  return FORMAT_NAMES.reduce((acc, format) => {
    const pattern = new RegExp(`(^|\\s|\\()(-)?function:${format}\\b`, "gi");
    return acc.replace(pattern, (_match, prefix, negation) => {
      const negated = negation ? "-" : "";
      return `${prefix}${negated}f:${format}`;
    });
  }, query);
}

function normalizeWhitespace(query: string): string {
  return query.replace(/\s{2,}/g, " ").trim();
}

function normalizeLeadingStrayToken(query: string): string {
  const tokens = splitQueryTokens(query);
  if (tokens.length < 2) {
    return query;
  }

  const hasFieldToken = tokens.some((token) => /^-?[a-z]+[:=]/i.test(token));
  if (!hasFieldToken) {
    return query;
  }

  const firstToken = tokens[0];
  if (!/^[iI]$/.test(firstToken)) {
    return query;
  }

  const remaining = tokens.slice(1).join(" ");
  return normalizeWhitespace(remaining);
}

function splitQueryTokens(query: string): string[] {
  const tokens: string[] = [];
  let buffer = "";
  let inQuotes = false;

  const pushBuffer = () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      tokens.push(trimmed);
    }
    buffer = "";
  };

  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];

    if (char === '"') {
      buffer += char;
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && (char === "(" || char === ")")) {
      pushBuffer();
      tokens.push(char);
      continue;
    }

    if (!inQuotes && /\s/.test(char)) {
      pushBuffer();
      continue;
    }

    buffer += char;
  }

  pushBuffer();
  return tokens;
}

function quoteOracleTextPhrases(query: string): string {
  const tokens = splitQueryTokens(query);
  const result: string[] = [];

  const isFieldToken = (token: string) => /^-?[a-z]+:/i.test(token);
  const oracleMatch = (token: string) => token.match(/^(-?)(o|oracle):(.+)$/i);

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    const match = oracleMatch(token);
    if (!match) {
      result.push(token);
      index += 1;
      continue;
    }

    const prefix = `${match[1]}${match[2]}:`;
    const value = match[3];
    if (value.startsWith('"') || value.startsWith("/")) {
      result.push(token);
      index += 1;
      continue;
    }

    const phraseParts = [value];
    let lookahead = index + 1;
    while (lookahead < tokens.length) {
      const next = tokens[lookahead];
      const lowerNext = next.toLowerCase();
      if (next === "(" || next === ")") {
        break;
      }
      if (lowerNext === "or" || lowerNext === "and" || lowerNext === "not") {
        break;
      }
      if (isFieldToken(next)) {
        break;
      }
      phraseParts.push(next);
      lookahead += 1;
    }

    if (phraseParts.length > 1) {
      result.push(`${prefix}"${phraseParts.join(" ")}"`);
      index = lookahead;
      continue;
    }

    result.push(token);
    index += 1;
  }

  return normalizeWhitespace(result.join(" "));
}

function dedupeTokens(query: string): string {
  const seen = new Set<string>();
  const tokens = splitQueryTokens(query);
  const result: string[] = [];
  const nonDedupedTokens = new Set(["or", "and", "not"]);

  for (const token of tokens) {
    const key = token.toLowerCase();
    if (token === "(" || token === ")") {
      result.push(token);
      continue;
    }
    if (nonDedupedTokens.has(key)) {
      result.push(token);
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(token);
  }

  return result.join(" ");
}

function normalizeCounterspellIntent(naturalQuery: string, query: string): string {
  const wantsCounterspells = /\bcounter\s*spells?\b|\bcounterspells?\b/i.test(naturalQuery);
  if (!wantsCounterspells) {
    return query;
  }

  let updated = query;
  const hasCounterspellTag = /\bfunction:counterspell\b/i.test(updated);
  if (!hasCounterspellTag) {
    updated = `${updated} function:counterspell`;
  }

  // If the user asked for counterspells, remove ability counter tags and oracle "counter" text.
  updated = updated.replace(/\bfunction:ability-counter\b/gi, "");
  updated = updated.replace(/\bo:"counterspell"\b/gi, "");
  updated = updated.replace(/\bo:"counter"\b/gi, "");
  updated = updated.replace(/\bo:counter\b/gi, "");
  updated = updated.replace(/\bo:"counter target spell"\b/gi, "");
  updated = updated.replace(/\bo:"counter target spell\."\b/gi, "");

  return normalizeWhitespace(updated);
}

function normalizeNotRedRequirement(naturalQuery: string, query: string): string {
  const wantsExcludeRed = /\b(not in|without|no|non[-\s]?|excluding|exclude)\s+red\b/i.test(
    naturalQuery
  );
  if (!wantsExcludeRed) {
    return query;
  }

  let updated = query;
  updated = updated.replace(/\b-?function:red-hate\b/gi, "");
  updated = updated.replace(/-c:r(?!ù)/gi, "-c:r");
  if (!/\b-c:r\b/i.test(updated)) {
    updated = `${updated} -c:r`;
  }

  return normalizeWhitespace(updated);
}

function normalizeManaCostSymbolIntent(naturalQuery: string, query: string): string {
  const wantsXInCost =
    /\b(x|x's)\b/i.test(naturalQuery) &&
    /\b(mana cost|cost)\b/i.test(naturalQuery);
  if (!wantsXInCost) {
    return query;
  }

  let updated = query;
  if (!/\bm:X\b/i.test(updated)) {
    updated = `${updated} m:X`;
  }
  updated = updated.replace(/\bo:"?X"?\b/gi, "");
  updated = updated.replace(/\bfunction:converted-mana-cost-matters\b/gi, "");

  return normalizeWhitespace(updated);
}

function normalizeCommanderIntent(naturalQuery: string, query: string): string {
  const lower = naturalQuery.toLowerCase();
  const wantsCommanderFormat = /\b(commander[-\s]?legal|legal\s+in\s+commander|for\s+commander|commander\s+format|in\s+commander|edh[-\s]?legal|legal\s+in\s+edh|for\s+edh|edh\s+format|in\s+edh)\b/i.test(
    lower
  );
  const myCommanderDeck = hasCommanderDeckContext(naturalQuery);
  const wantsCommanders =
    /\b(commanders?|commander cards?|commander creatures?|can be commanders?)\b/i.test(lower) &&
    !wantsCommanderFormat &&
    !myCommanderDeck;

  let updated = query;

  if (wantsCommanderFormat) {
    updated = updated.replace(/\bis:commander\b/gi, "");
    if (!/\bf:commander\b/i.test(updated)) {
      updated = `${updated} f:commander`;
    }
    return normalizeWhitespace(updated);
  }

  if (wantsCommanders) {
    if (/\bf:commander\b/i.test(updated) && !/\bis:commander\b/i.test(updated)) {
      updated = updated.replace(/\bf:commander\b/gi, "is:commander");
    }
    if (!/\bis:commander\b/i.test(updated)) {
      updated = `${updated} is:commander`;
    }
    return normalizeWhitespace(updated);
  }

  return updated;
}

function normalizeGameChangerIntent(naturalQuery: string, query: string): string {
  const lower = naturalQuery.toLowerCase();
  const wantsGameChangerList =
    /\b(game\s*changer\s*(list)?|gamechanger\s*(list)?|cards?\s+in\s+the\s+game\s*changer\s*(list)?)\b/i.test(
      lower
    );

  if (!wantsGameChangerList) {
    return query;
  }

  let updated = query;
  if (!/\bis:gamechanger\b/i.test(updated)) {
    updated = `${updated} is:gamechanger`;
  }
  return normalizeWhitespace(updated);
}

/**
 * When the user asks for banned or restricted cards in a format, the query must not
 * also require legality in that same format (f:X / legal:X). Remove those conflicting filters.
 */
function removeFormatLegalityWhenBannedOrRestricted(query: string): string {
  const bannedRestrictedFormats = new Set<string>();
  const banRestrictRegex = /\b(?:banned|restricted):([a-z]+)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = banRestrictRegex.exec(query)) !== null) {
    bannedRestrictedFormats.add(match[1].toLowerCase());
  }
  if (bannedRestrictedFormats.size === 0) {
    return query;
  }
  let updated = query;
  for (const format of bannedRestrictedFormats) {
    const escaped = escapeRegex(format);
    // Remove f:format, legal:format, format:format and their negated forms
    const legalityPattern = new RegExp(
      `\\s*-?(?:f|legal|format):${escaped}\\b\\s*`,
      "gi"
    );
    updated = updated.replace(legalityPattern, " ").trim();
  }
  return normalizeWhitespace(updated);
}

function normalizeCommanderIdentity(query: string): string {
  if (!/\bis:commander\b/i.test(query)) {
    return query;
  }
  return query.replace(/\bid:([wubrgc]{1,5})\b/gi, "id=$1");
}

function pickBurnFunctionTag(
  naturalQuery: string,
  tagContext?: TaggerTagContext
): string {
  const candidates =
    tagContext?.function.filter((tag) => tag.toLowerCase().startsWith("burn")) || [];
  if (candidates.length === 0) {
    return "burn";
  }

  const query = naturalQuery.toLowerCase();
  const selectors: Array<{ keyword: string; tokens: string[]; weight: number }> = [
    { keyword: "player", tokens: ["player", "players"], weight: 2 },
    { keyword: "opponent", tokens: ["opponent", "opponents"], weight: 2 },
    { keyword: "creature", tokens: ["creature", "creatures"], weight: 2 },
    { keyword: "planeswalker", tokens: ["planeswalker", "planeswalkers"], weight: 2 },
    { keyword: "any-target", tokens: ["any target"], weight: 1 },
    { keyword: "face", tokens: ["face"], weight: 1 },
  ];

  let best = candidates[0];
  let bestScore = -1;
  for (const tag of candidates) {
    const lower = tag.toLowerCase();
    let score = 0;
    for (const selector of selectors) {
      if (selector.tokens.some((token) => query.includes(token)) && lower.includes(selector.keyword)) {
        score += selector.weight;
      }
    }
    if (score > bestScore || (score === bestScore && tag.length < best.length)) {
      best = tag;
      bestScore = score;
    }
  }

  return best;
}

function normalizeBurnIntent(
  naturalQuery: string,
  query: string,
  tagContext?: TaggerTagContext
): string {
  const wantsDirectDamage =
    /\b(direct damage|burn)\b/i.test(naturalQuery) ||
    (/\bdeal(s|t)?\b/i.test(naturalQuery) && /\bdamage\b/i.test(naturalQuery));
  const hasDisqualifier = /\b(prevent|prevention|redirect|redirection|multiply|multiplier)\b/i.test(
    naturalQuery
  );

  if (!wantsDirectDamage || hasDisqualifier) {
    return query;
  }

  let updated = query;
  const burnTag = pickBurnFunctionTag(naturalQuery, tagContext);
  if (!/\bfunction:burn\b/i.test(updated) && !/\bfunction:burn-\w+\b/i.test(updated)) {
    updated = `${updated} function:${burnTag}`;
  }
  updated = updated.replace(/\bfunction:damage-\w+\b/gi, "");
  updated = updated.replace(/\bo:"[^"]*damage[^"]*"\b/gi, "");
  updated = updated.replace(/\bo:damage\b/gi, "");
  updated = updated.replace(/\bo:"?(player|opponent|any target|target)"?\b/gi, "");

  return normalizeWhitespace(updated);
}

function normalizeArtIntent(
  naturalQuery: string,
  query: string,
  tagContext?: TaggerTagContext
): string {
  const hasArtIntent =
    /\b(in the art|art|depicts|depicting|illustration|illustrations|featuring|shows|showing|artwork|art work|picture|pictured)\b/i.test(
      naturalQuery
    );
  if (!hasArtIntent) {
    return query;
  }

  const hasArtToken = /\b-?(?:art|atag|arttag):/i.test(query);
  if (hasArtToken) {
    return query;
  }

  const artKeywords = extractArtKeywords(naturalQuery);
  if (artKeywords.length === 0) {
    return query;
  }

  const normalizedContextTags =
    tagContext?.art?.map((tag) => tag.toLowerCase()) || [];
  const hasContext = normalizedContextTags.length > 0;

  const eligibleKeywords = artKeywords.filter((keyword) => {
    if (!hasContext) {
      return true;
    }
    return normalizedContextTags.includes(keyword.toLowerCase());
  });

  if (eligibleKeywords.length === 0) {
    return query;
  }

  let updated = query;

  for (const keyword of eligibleKeywords) {
    const escapedKeyword = escapeRegex(keyword);
    const oraclePattern = new RegExp(
      `\\b(o|oracle):(?:"${escapedKeyword}"|${escapedKeyword})\\b`,
      "gi"
    );
    if (oraclePattern.test(updated)) {
      updated = updated.replace(oraclePattern, `art:${keyword}`);
    }
  }

  if (!/\b-?(?:art|atag|arttag):/i.test(updated)) {
    const additions = eligibleKeywords.slice(0, 3).map((keyword) => `art:${keyword}`);
    updated = `${updated} ${additions.join(" ")}`.trim();
  }

  return normalizeWhitespace(updated);
}

/** Function tags that create/make tokens. Used to expand "make tokens" to OR chain. */
const TOKEN_GENERATION_FUNCTION_TAGS = [
  "repeatable-token-generator",
  "repeatable-creature-tokens",
  "repeatable-artifact-tokens",
  "repeatable-noncreature-tokens",
  "create-multiple-tokens",
  "creates-token-of-a-card",
  "creates-oracle-token",
  "creates-card-token",
  "create-land-tokens",
] as const;

function normalizeTokenGenerationIntent(
  naturalQuery: string,
  query: string,
  tagContext?: TaggerTagContext
): string {
  const wantsTokenGeneration =
    /\b(?:make|create|generat|produc)(?:e|es|ed|ing)?\s+tokens?\b|\btoken\s+makers?\b|\btoken\s+generators?\b|\bcards?\s+that\s+(?:make|create)\s+tokens?\b/i.test(
      naturalQuery
    );
  if (!wantsTokenGeneration) {
    return query;
  }

  const availableTags = tagContext?.function?.map((t) => t.toLowerCase()) || [];
  const eligibleTags = TOKEN_GENERATION_FUNCTION_TAGS.filter((tag) =>
    availableTags.includes(tag.toLowerCase())
  );
  if (eligibleTags.length <= 1) {
    return query;
  }

  const orChain = `(${eligibleTags.map((t) => `function:${t}`).join(" or ")})`;

  let updated = query;
  const hasAnyTokenTag = TOKEN_GENERATION_FUNCTION_TAGS.some((tag) =>
    new RegExp(`\\bfunction:${escapeRegex(tag)}\\b`, "i").test(updated)
  );
  if (!hasAnyTokenTag) {
    return query;
  }

  for (const tag of TOKEN_GENERATION_FUNCTION_TAGS) {
    updated = updated.replace(
      new RegExp(`\\s*-?function:${escapeRegex(tag)}\\b`, "gi"),
      " "
    );
  }

  updated = `${updated.trim()} ${orChain}`.trim();
  return normalizeWhitespace(updated);
}

function normalizeBounceCounterspellOr(naturalQuery: string, query: string): string {
  const wantsBounce = /\bbounce\b/i.test(naturalQuery);
  const wantsCounter = /\bcounter\s*spells?\b|\bcounterspells?\b/i.test(naturalQuery);
  const wantsEither = /\b(either|or)\b/i.test(naturalQuery);

  if (!wantsBounce || !wantsCounter || !wantsEither) {
    return query;
  }

  let updated = query;
  if (/\bfunction:counterspell-bounce\b/i.test(updated)) {
    updated = updated.replace(
      /\bfunction:counterspell-bounce\b/gi,
      "(function:bounce OR function:counterspell)"
    );
  }

  return normalizeWhitespace(updated);
}

function normalizeOrphanedOr(query: string): string {
  let updated = query;
  // Remove empty OR branches inside parentheses.
  updated = updated.replace(/\(\s*OR\s+([^)]+)\)/gi, "($1)");
  updated = updated.replace(/\(\s*([^)]+)\s+OR\s*\)/gi, "($1)");
  // Drop parentheses that only contain ORs.
  updated = updated.replace(/\(\s*(?:OR\s*)+\)/gi, "");
  // Collapse repeated OR tokens that can be introduced by removals.
  updated = updated.replace(/\bOR(?:\s+OR)+\b/gi, "OR");
  return normalizeWhitespace(updated);
}

function pickLandTutorTag(
  naturalQuery: string,
  tagContext?: TaggerTagContext
): string | null {
  if (!tagContext?.function || tagContext.function.length === 0) {
    return null;
  }

  const query = naturalQuery.toLowerCase();
  if (!/\btutor\b/.test(query) || !/\blands?\b/.test(query)) {
    return null;
  }

  const candidates = tagContext.function.filter((tag) => {
    const lower = tag.toLowerCase();
    return lower.includes("tutor") && lower.includes("land");
  });

  if (candidates.length === 0) {
    return null;
  }

  const landTypes = ["forest", "island", "mountain", "plains", "swamp", "gate", "desert", "cave"];
  const keywords = [
    { word: "basic", weight: 2 },
    { word: "any", weight: 1 },
    { word: "snow", weight: 1 },
  ];

  let bestLand = candidates[0];
  let bestScore = -1;

  for (const tag of candidates) {
    const lower = tag.toLowerCase();
    let score = 0;

    for (const entry of keywords) {
      if (query.includes(entry.word) && lower.includes(entry.word)) {
        score += entry.weight;
      }
    }

    for (const landType of landTypes) {
      if (query.includes(landType) && lower.includes(landType)) {
        score += 2;
      }
    }

    if (score > bestScore || (score === bestScore && tag.length < bestLand.length)) {
      bestLand = tag;
      bestScore = score;
    }
  }

  return bestLand;
}

function buildStrategyCandidates(): string[] {
  const candidates: string[] = [];
  for (const entry of STRATEGY_ORACLETAGS) {
    candidates.push(entry.strategy);
    for (const alias of entry.aliases || []) {
      candidates.push(alias);
    }
  }
  return candidates;
}

function detectStrategies(naturalQuery: string): string[] {
  const query = naturalQuery.toLowerCase();
  const found = new Set<string>();
  for (const candidate of buildStrategyCandidates()) {
    const normalized = candidate.toLowerCase();
    const isWordy = /^[a-z0-9 ]+$/.test(normalized);
    if (isWordy) {
      const pattern = new RegExp(`\\b${escapeRegex(normalized).replace(/ +/g, "\\s+")}\\b`, "i");
      if (pattern.test(naturalQuery)) {
        found.add(candidate);
      }
    } else if (query.includes(normalized)) {
      found.add(candidate);
    }
  }
  const resolved = new Set<string>();
  for (const entry of found) {
    const canonical = resolveStrategyName(entry) || entry;
    resolved.add(canonical);
  }
  return Array.from(resolved);
}

function detectNegatedStrategies(naturalQuery: string): string[] {
  const query = naturalQuery.toLowerCase();
  const found = new Set<string>();
  for (const candidate of buildStrategyCandidates()) {
    const normalized = candidate.toLowerCase();
    const isWordy = /^[a-z0-9 ]+$/.test(normalized);
    const escaped = escapeRegex(normalized).replace(/ +/g, "\\s+");
    const negationPattern = new RegExp(
      `\\b(?:not|non|without|excluding|exclude|no)\\b[\\s\\w-]{0,20}\\b${escaped}\\b`,
      "i"
    );
    const nonPrefixPattern = new RegExp(`\\bnon[-\\s]?${escaped}\\b`, "i");

    if (isWordy) {
      if (negationPattern.test(naturalQuery) || nonPrefixPattern.test(naturalQuery)) {
        found.add(candidate);
      }
    } else if (
      query.includes(`not ${normalized}`) ||
      query.includes(`without ${normalized}`) ||
      query.includes(`exclude ${normalized}`) ||
      query.includes(`non-${normalized}`)
    ) {
      found.add(candidate);
    }
  }

  const resolved = new Set<string>();
  for (const entry of found) {
    const canonical = resolveStrategyName(entry) || entry;
    resolved.add(canonical);
  }

  return Array.from(resolved);
}

function appendStrategyTags(query: string, naturalQuery: string): string {
  const detected = detectStrategies(naturalQuery);
  if (detected.length === 0) {
    return query;
  }

  const queryLower = query.toLowerCase();
  const negated = new Set(detectNegatedStrategies(naturalQuery).map((entry) => entry.toLowerCase()));
  const missing = detected.filter(
    (strategy) =>
      !queryLower.includes(`strategy:${strategy.toLowerCase()}`) &&
      !queryLower.includes(`-strategy:${strategy.toLowerCase()}`)
  );

  if (missing.length === 0) {
    return query;
  }

  const strategyTokens = missing.map((strategy) => {
    const value = /[^\w]/.test(strategy) ? `"${strategy}"` : strategy;
    const prefix = negated.has(strategy.toLowerCase()) ? "-strategy:" : "strategy:";
    return `${prefix}${value}`;
  });

  return `${query} ${strategyTokens.join(" ")}`.trim();
}

export function finalizeScryfallQuery(args: {
  naturalQuery: string;
  rawQuery: string;
  tagContext?: TaggerTagContext;
  maxLength?: number;
}): string {
  const {
    naturalQuery,
    rawQuery,
    tagContext,
    maxLength = EFFECTIVE_MAX_QUERY_LENGTH,
  } = args;

  // Clean up any markdown code blocks if the model adds them
  const cleanedQuery = rawQuery
    .replace(/^```[\w]*\n?/g, "")
    .replace(/```$/g, "")
    .trim();
  const queryWithStrategies = appendStrategyTags(cleanedQuery, naturalQuery);
  const expandedQuery = expandStrategyTags(queryWithStrategies);
  let normalizedQuery = normalizeFormatFunctionTags(expandedQuery);

  const landTutorTag = pickLandTutorTag(naturalQuery, tagContext);
  if (landTutorTag) {
    if (/\bfunction:tutor\b(?!-)/i.test(normalizedQuery)) {
      normalizedQuery = normalizedQuery.replace(
        /\bfunction:tutor\b(?!-)/gi,
        `function:${landTutorTag}`
      );
    }

    const toHandTag =
      tagContext?.function.find((tag) => tag === "tutor-to-hand") ||
      tagContext?.function.find((tag) => tag === "tutor-hand");
    const toBattlefieldTag = tagContext?.function.find(
      (tag) => tag === "tutor-to-battlefield"
    );

    const wantsHand = /\bhand\b/i.test(naturalQuery);
    const wantsBattlefield = /\b(battlefield|into play|onto the battlefield)\b/i.test(
      naturalQuery
    );
    const hasOr = /\bor\b/i.test(normalizedQuery);

    if (wantsHand && toHandTag) {
      const hasLandTag = new RegExp(`\\bfunction:${landTutorTag}\\b`, "i").test(
        normalizedQuery
      );
      const hasToHandTag = new RegExp(`\\bfunction:${toHandTag}\\b`, "i").test(
        normalizedQuery
      );
      if (hasOr || !hasLandTag || !hasToHandTag) {
        const additions: string[] = [];
        if (!hasLandTag) {
          additions.push(`function:${landTutorTag}`);
        }
        if (!hasToHandTag) {
          additions.push(`function:${toHandTag}`);
        }
        if (additions.length > 0) {
          normalizedQuery = `${normalizedQuery} ${additions.join(" ")}`.trim();
        }
      }
    } else if (wantsBattlefield && toBattlefieldTag) {
      const hasLandTag = new RegExp(`\\bfunction:${landTutorTag}\\b`, "i").test(
        normalizedQuery
      );
      const hasToBattlefieldTag = new RegExp(
        `\\bfunction:${toBattlefieldTag}\\b`,
        "i"
      ).test(normalizedQuery);
      if (hasOr || !hasLandTag || !hasToBattlefieldTag) {
        const additions: string[] = [];
        if (!hasLandTag) {
          additions.push(`function:${landTutorTag}`);
        }
        if (!hasToBattlefieldTag) {
          additions.push(`function:${toBattlefieldTag}`);
        }
        if (additions.length > 0) {
          normalizedQuery = `${normalizedQuery} ${additions.join(" ")}`.trim();
        }
      }
    }
  }

  normalizedQuery = normalizeCounterspellIntent(naturalQuery, normalizedQuery);
  normalizedQuery = normalizeNotRedRequirement(naturalQuery, normalizedQuery);
  normalizedQuery = normalizeManaCostSymbolIntent(naturalQuery, normalizedQuery);
  normalizedQuery = normalizeCommanderIntent(naturalQuery, normalizedQuery);
  normalizedQuery = normalizeGameChangerIntent(naturalQuery, normalizedQuery);
  normalizedQuery = removeFormatLegalityWhenBannedOrRestricted(normalizedQuery);
  normalizedQuery = normalizeCommanderIdentity(normalizedQuery);
  normalizedQuery = normalizeBurnIntent(naturalQuery, normalizedQuery, tagContext);
  normalizedQuery = normalizeTokenGenerationIntent(
    naturalQuery,
    normalizedQuery,
    tagContext
  );
  normalizedQuery = normalizeArtIntent(naturalQuery, normalizedQuery, tagContext);
  normalizedQuery = normalizeBounceCounterspellOr(naturalQuery, normalizedQuery);
  normalizedQuery = quoteOracleTextPhrases(normalizedQuery);
  normalizedQuery = normalizeOrphanedOr(normalizedQuery);
  normalizedQuery = normalizeLeadingStrayToken(normalizedQuery);
  normalizedQuery = dedupeTokens(normalizedQuery);

  if (!normalizedQuery) {
    throw new Error("Failed to generate Scryfall query (empty response)");
  }

  // Validate parentheses are balanced
  const openParens = (normalizedQuery.match(/\(/g) || []).length;
  const closeParens = (normalizedQuery.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    console.warn(
      `[OpenAI] Generated query has unbalanced parentheses (${openParens} open, ${closeParens} close): "${normalizedQuery}"`
    );
    // Try to fix by adding missing closing parentheses
    const fixedQuery = normalizedQuery + ")".repeat(openParens - closeParens);
    console.warn(
      `[OpenAI] Attempting to fix by adding closing parentheses: "${fixedQuery}"`
    );
    // Only use fixed query if it's still under the limit (accounting for prefer:best prefix)
    if (fixedQuery.length <= maxLength) {
      return fixedQuery;
    }
    // If fixed query is too long, throw error to trigger regeneration
    throw new Error(
      "Generated query has unbalanced parentheses and cannot be automatically fixed"
    );
  }

  // Validate length - truncate if necessary (accounting for prefer:best prefix)
  if (normalizedQuery.length > maxLength) {
    console.warn(
      `[OpenAI] Generated query exceeds ${maxLength} characters (${normalizedQuery.length}), truncating...`
    );
    return truncateScryfallQuery(normalizedQuery, maxLength);
  }

  return normalizedQuery;
}

/**
 * Truncates a Scryfall query to the maximum allowed length, trying to preserve word boundaries
 */
export function truncateScryfallQuery(
  query: string,
  maxLength: number = MAX_SCRYFALL_QUERY_LENGTH
): string {
  if (query.length <= maxLength) {
    return query;
  }

  let truncated = query.substring(0, maxLength).trim();
  // Try to truncate at a word boundary if possible (within 90% of max length)
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.9) {
    truncated = truncated.substring(0, lastSpace).trim();
  }

  return truncated;
}

/**
 * Checks if a query looks like a Scryfall query (contains operators like :, t:, c:, art:, etc.)
 * Only matches actual Scryfall operators, not just any word followed by a colon
 */
export function isScryfallQuery(query: string): boolean {
  const trimmed = query.trim();

  // List of known Scryfall operators (common ones)
  // These must be complete words immediately followed by a colon
  // This ensures "function tag:" doesn't match, but "function:" does
  const scryfallOperators = [
    "t:",
    "type:",
    "c:",
    "color:",
    "cmc:",
    "mana:",
    "m:",
    "power:",
    "p:",
    "toughness:",
    "loyalty:",
    "oracle:",
    "o:",
    "kw:",
    "keyword:",
    "art:",
    "atag:",
    "arttag:",
    "function:",
    "otag:",
    "oracletag:",
    "set:",
    "s:",
    "rarity:",
    "r:",
    "is:",
    "in:",
    "not:",
    "format:",
    "game:",
    "border:",
    "frame:",
    "lang:",
    "foil:",
    "promo:",
    "date:",
    "year:",
    "artist:",
    "watermark:",
    "banned:",
    "legal:",
    "id:",
    "id=",
    "name:",
    "number:",
    "block:",
    "set-type:",
  ];

  // Check if the query contains any Scryfall operator
  // Pattern: word boundary + operator word + colon (colon must immediately follow the word)
  // This ensures "function tag:" doesn't match because there's a space before "tag:"
  for (const operator of scryfallOperators) {
    // Escape special regex characters in the operator
    const escapedOperator = operator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match: word boundary + operator (colon must immediately follow, no space)
    const pattern = new RegExp(`\\b${escapedOperator}`, "i");
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

/**
 * Converts natural language query to Scryfall query string using OpenAI
 */
export async function convertToScryfallQuery(
  naturalQuery: string,
  regenerationPrompt?: string,
  tagContext?: TaggerTagContext,
  isRetry: boolean = false
): Promise<string> {
  // If it's already a Scryfall query, validate length and return it
  // Account for "prefer:best " prefix (12 characters)
  if (isScryfallQuery(naturalQuery)) {
    const trimmed = naturalQuery.trim();
    if (trimmed.length > EFFECTIVE_MAX_QUERY_LENGTH) {
      throw new Error(
        `Scryfall query exceeds maximum length of ${EFFECTIVE_MAX_QUERY_LENGTH} characters (${MAX_SCRYFALL_QUERY_LENGTH} total including "prefer:best " prefix). Please shorten your query.`
      );
    }
    return trimmed;
  }

  const userPrompt = regenerationPrompt || getUserPrompt(naturalQuery, tagContext);
  const systemPrompt = buildSystemPrompt(naturalQuery);

  // Log selected packs and prompt length in dev
  if (process.env.NODE_ENV === "development") {
    const selectedPacks = selectPacks(naturalQuery);
    console.log(`[OpenAI] Selected packs: ${selectedPacks.join(", ")}`);
    console.log(`[OpenAI] System prompt length: ${systemPrompt.length} chars`);
  }

  let query = "";
  try {
    const isGpt5 = OPENAI_MODEL.startsWith("gpt-5");

    if (isGpt5) {
      // Use Responses API for reasoning models (gpt-5-mini, gpt-5, etc.)
      // Use "low" effort for economical token usage - this is a relatively simple conversion task
      const completion = await getOpenAIClient().responses.create({
        model: OPENAI_MODEL,
        reasoning: {
          effort: "low", // Low effort balances speed and cost efficiency for query conversion
        },
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_output_tokens: 3000, // Reasonable limit: 388 char query + reasoning overhead
      });

      // Log response structure in dev for debugging
      if (process.env.NODE_ENV === "development") {
        console.log(`[OpenAI] Response structure (Responses API):`, {
          status: completion.status,
          outputLength: completion.output?.length,
          outputText: completion.output_text,
          usage: completion.usage,
          reasoningTokens: completion.usage?.output_tokens_details?.reasoning_tokens,
        });
      }

      // Handle incomplete responses
      if (completion.status === "incomplete") {
        const reason = completion.incomplete_details?.reason;
        if (reason === "max_output_tokens") {
          if (completion.output_text && completion.output_text.length > 0) {
            // Partial output available, use it
            query = completion.output_text.trim();
            console.warn(
              `[OpenAI] Response incomplete due to max_output_tokens, using partial output`
            );
          } else {
            // Ran out of tokens during reasoning, no output
            throw new Error(
              `Failed to generate Scryfall query: ran out of tokens during reasoning. Consider increasing max_output_tokens or simplifying the query.`
            );
          }
        } else {
          throw new Error(
            `Failed to generate Scryfall query: incomplete response (reason: ${reason})`
          );
        }
      } else {
        query = completion.output_text?.trim() || "";
      }
    } else {
      // Use Chat Completions API for non-reasoning models
      const completion = await getOpenAIClient().chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        stream: false,
        max_tokens: 1500,
      });

      // Log response structure in dev for debugging
      if (process.env.NODE_ENV === "development") {
        console.log(`[OpenAI] Response structure (Chat Completions):`, {
          choicesLength: completion.choices?.length,
          firstChoice: completion.choices?.[0],
          finishReason: completion.choices?.[0]?.finish_reason,
        });
      }

      query = completion.choices[0]?.message?.content?.trim() || "";
    }

    return finalizeScryfallQuery({
      naturalQuery,
      rawQuery: query,
      tagContext,
      maxLength: EFFECTIVE_MAX_QUERY_LENGTH,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("empty response")) {
      console.error(`[OpenAI] ${error.message}`, {
        model: OPENAI_MODEL,
        isGpt5: OPENAI_MODEL.startsWith("gpt-5"),
        rawQuery: query,
      });
    }
    // Log detailed error information
    if (process.env.NODE_ENV === "development") {
      console.error("[OpenAI] API call error details:", {
        model: OPENAI_MODEL,
        isGpt5: OPENAI_MODEL.startsWith("gpt-5"),
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : error,
      });
    }

    // If it's a validation error (unbalanced parentheses) and we haven't retried yet, try regenerating once
    if (!isRetry && error instanceof Error && error.message.includes("unbalanced parentheses")) {
      console.warn("[OpenAI] Query had unbalanced parentheses, attempting regeneration...");
      try {
        const retryPrompt = regenerationPrompt || getUserPrompt(naturalQuery, tagContext);
        const retryPromptWithFix = `${retryPrompt}\n\nIMPORTANT: The previous attempt had unbalanced parentheses. Please ensure all parentheses are properly closed and use the simplest possible query.`;
        return await convertToScryfallQuery(
          naturalQuery,
          retryPromptWithFix,
          tagContext,
          true
        );
      } catch (retryError) {
        console.error("[OpenAI] Retry also failed:", retryError);
        throw error; // Throw original error
      }
    }

    // Re-throw API errors with more context
    if (error instanceof Error) {
      console.error("OpenAI API error:", error.message);
      throw error;
    }

    console.error("OpenAI API error:", error);
    throw new Error("Failed to convert query. Please try again.");
  }
}
