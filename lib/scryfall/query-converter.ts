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
import { maskSynergyWithComplements } from "@/lib/search-pipeline/phase1/synergyPartnerMask";
import { escapeRegex } from "@/lib/utils/text";

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

function normalizeFormatFunctionTags(query: string): string {
  return FORMAT_NAMES.reduce((acc, format) => {
    // Use (?![-\w]) instead of \b to prevent incorrectly matching compound tagger tags
    // whose prefix is a format name, e.g. function:commander-tax-evasion would be
    // truncated to f:commander-tax-evasion by \b matching at the hyphen.
    const pattern = new RegExp(`(^|\\s|\\()(-)?function:${format}(?![-\\w])`, "gi");
    return acc.replace(pattern, (_match, prefix, negation) => {
      const negated = negation ? "-" : "";
      return `${prefix}${negated}f:${format}`;
    });
  }, query);
}

function normalizeWhitespace(query: string): string {
  return query
    .replace(/\s{2,}/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

function normalizeLeadingStrayToken(query: string): string {
  // Strip leading stray "i" or "I" (often from "I need" leaking into AI output)
  const updated = query.replace(/^\s*[iI]\s+/i, "").trim();
  if (updated !== query) {
    return normalizeWhitespace(updated);
  }

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

  return normalizeWhitespace(result.join(" "));
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
  const wantsCommanderFormat =
    /\b(commander[-\s]?legal|legal\s+in\s+commander|for\s+commander|commander\s+format|in\s+commander|edh[-\s]?legal|legal\s+in\s+edh|for\s+edh|edh\s+format|in\s+edh)\b/i.test(
      lower
    ) ||
    (/\blegal\b/i.test(lower) && /\bcommander\b/i.test(lower));
  const multipleFormats = (query.match(/\bf:[a-z]+\b/gi) || []).length >= 2;
  const myCommanderDeck = hasCommanderDeckContext(naturalQuery);
  const wantsCommanders =
    !multipleFormats &&
    /\b(commanders?|commander cards?|commander creatures?|can be commanders?)\b/i.test(lower) &&
    !wantsCommanderFormat &&
    !myCommanderDeck &&
    // Exclude mechanic phrases — "commander's tax/damage/ninjutsu/eminence" refers to
    // game mechanics, not commander creatures.
    !/\bcommander[''s]*\s+(?:tax|damage|ninjutsu|eminence|storm)\b/i.test(lower);

  let updated = query;

  if (wantsCommanderFormat || multipleFormats) {
    updated = updated.replace(/\bis:commander\b/gi, "");
    if (!/\bf:commander\b/i.test(updated) && wantsCommanderFormat) {
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

function normalizeInstantSorceryTypeChain(query: string): string {
  const instantPattern = /(^|\s)(t|type):instant\b/gi;
  const sorceryPattern = /(^|\s)(t|type):sorcery\b/gi;
  const hasInstant = instantPattern.test(query);
  const hasSorcery = sorceryPattern.test(query);
  if (!hasInstant || !hasSorcery) {
    return query;
  }

  const hasNegatedInstantOrSorcery = /\s-(?:t|type):(instant|sorcery)\b/i.test(query);
  if (hasNegatedInstantOrSorcery) {
    return query;
  }

  const alreadyGrouped = /\((?:[^()]*\b(?:t|type):instant\b[^()]*)\bor\b(?:[^()]*\b(?:t|type):sorcery\b[^()]*)\)/i.test(
    query
  );
  if (alreadyGrouped) {
    return query;
  }

  let updated = query.replace(instantPattern, " ").replace(sorceryPattern, " ");
  updated = normalizeWhitespace(updated);
  return normalizeWhitespace(`(t:instant or t:sorcery) ${updated}`);
}

/** Reserved for future burn-tag selection logic. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

type DamageTarget = "opponent" | "creature" | "planeswalker" | "player" | "any" | "battle" | "general";

/**
 * Function tags for opponent- / player-target burn and direct life-loss (normalizeBurnIntent).
 * Single source for `DAMAGE_TAG_FAMILIES.opponent` / `player` and Phase 3 spell-cast ping fixes.
 */
export const OPPONENT_BURN_DAMAGE_FUNCTION_TAGS = [
  "burn-player",
  "burn-player-each",
  "burn-any",
  "opponent-loses-life",
  "life-drain",
  "drain-life",
  "lifegain-to-damage",
] as const;

const DAMAGE_TAG_FAMILIES: Record<DamageTarget, string[]> = {
  opponent: [...OPPONENT_BURN_DAMAGE_FUNCTION_TAGS],
  creature: [
    "burn-creature", "burn-any", "removal-creature-burn", "removal-burn",
  ],
  planeswalker: [
    "burn-planeswalker", "burn-any", "removal-planeswalker-burn", "removal-burn",
  ],
  player: [...OPPONENT_BURN_DAMAGE_FUNCTION_TAGS],
  battle: [
    "burn-battle", "burn-any", "removal-battle-burn", "removal-burn",
  ],
  any: [
    "burn-any", "burn-creature", "burn-player", "burn-planeswalker",
    "removal-burn", "opponent-loses-life",
  ],
  general: [
    "burn", "burn-any", "burn-creature", "burn-player",
    "removal-burn",
  ],
};

const STRAY_DAMAGE_TAG_PATTERN = /\bfunction:(burn(?:-[a-z0-9-]+)?|opponent-loses-life|life-drain|drain-life|lifegain-to-damage|combat-neutral-damage-trigger|damage-[a-z0-9-]+|spite-damage|retaliate-(?:to-)?damage|fractional-life-damage|transcendental-life-damage|removal-(?:creature-)?burn|removal-(?:planeswalker-)?burn|removal-(?:battle-)?burn|single-target-spell)\b/gi;

function detectDamageTarget(naturalQuery: string): DamageTarget | null {
  const lower = naturalQuery.toLowerCase();
  const hasDamageIntent =
    /\b(direct damage|burn)\b/i.test(lower) ||
    /\bdeal[st]?\s+.*?\bdamage\b/i.test(lower) ||
    /\bdamage[sd]?\s+(?:target\s+)?(?:opponent|creature|player|planeswalker|battle|any|each)\b/i.test(lower) ||
    /\bthat\s+damage[sd]?\b/i.test(lower) ||
    /\bdamage[sd]?\s+(?:the|a|an|each|target)\b/i.test(lower);
  if (!hasDamageIntent) return null;
  const hasDisqualifier = /\b(prevent|prevention|redirect|redirection|multiply|multiplier)\b/i.test(lower);
  if (hasDisqualifier) return null;

  if (/\bany\s+target\b/i.test(lower)) return "any";
  if (/\bopponents?\b/i.test(lower)) return "opponent";
  if (/\bcreatures?\b/i.test(lower) && /\bdamage\b/i.test(lower)) return "creature";
  if (/\bplaneswalkers?\b/i.test(lower)) return "planeswalker";
  if (/\bplayers?\b/i.test(lower)) return "player";
  if (/\bbattles?\b/i.test(lower)) return "battle";
  return "general";
}

function normalizeBurnIntent(
  naturalQuery: string,
  query: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reserved for future tag-aware burn selection
  _tagContext?: TaggerTagContext
): string {
  const target = detectDamageTarget(naturalQuery);
  if (!target) return query;

  let updated = query;
  const desiredTags = DAMAGE_TAG_FAMILIES[target];

  for (const tag of desiredTags) {
    if (!new RegExp(`\\bfunction:${escapeRegex(tag)}\\b`, "i").test(updated)) {
      updated = `${updated} function:${tag}`;
    }
  }

  const desiredSet = new Set(desiredTags);
  const chainTags: string[] = [];
  let strayMatch: RegExpExecArray | null;
  while ((strayMatch = STRAY_DAMAGE_TAG_PATTERN.exec(updated)) !== null) {
    const slug = (strayMatch[1] || "").toLowerCase();
    if (!slug) continue;
    if (desiredSet.has(slug)) {
      chainTags.push(`function:${slug}`);
    }
  }

  const dedupedChainTags = Array.from(new Set(chainTags));
  if (dedupedChainTags.length >= 2) {
    updated = updated.replace(STRAY_DAMAGE_TAG_PATTERN, " ");
    updated = normalizeWhitespace(updated);
    updated = normalizeWhitespace(`${updated} (${dedupedChainTags.join(" or ")})`);
  }

  updated = updated.replace(/\bo:"[^"]*damage[^"]*"\b/gi, "");
  updated = updated.replace(/\bo:damage\b/gi, "");
  updated = updated.replace(/\bo:"?(player|opponent|any target|target)"?\b/gi, "");

  return normalizeWhitespace(updated);
}

type ArchetypeQualifier = {
  name: string;
  detect: RegExp;
  tags: string[];
  suppressTypes?: string[];
};

type ArchetypeEntry = {
  name: string;
  description: string;
  detect: RegExp;
  disqualify?: RegExp;
  defaultTags: string[];
  qualifiers?: ArchetypeQualifier[];
  strayPattern?: RegExp;
  /** If the assembled Scryfall query already contains this kw:X token, skip injecting
   *  function: tags — Phase 1 already expressed the intent more precisely. */
  skipIfKw?: string;
};

/**
 * Canonical Scryfall function tags for the **hate-magnet** (“you become the archenemy”) archetype:
 * group slug, extra turns, mass LD, lockdown, storm-style wins, taxes, infect, etc.
 *
 * Single source of truth for:
 * - The `hate-magnet` registry entry’s `defaultTags`
 * - Phase 1 / other code that needs the full set or a **subset** via {@link hateMagnetFunctionTagsExcluding}
 */
export const HATE_MAGNET_FUNCTION_TAGS = [
  "group-slug",
  "extra-turn",
  "mass-land-denial",
  "lockdown",
  "lockdown-permanent",
  "storm",
  "storm-like",
  "tax",
  "cast-tax",
  "infect",
] as const;

export type HateMagnetFunctionTag = (typeof HATE_MAGNET_FUNCTION_TAGS)[number];

/**
 * Hate-magnet tags minus any omitted names (case-insensitive). Order matches {@link HATE_MAGNET_FUNCTION_TAGS}.
 *
 * - **`omit` omitted or empty** → returns **all** hate-magnet tags (e.g. “don’t be the archenemy” with no subset kept).
 * - **`omit: "extra-turn"`** → every tag except extra turns (e.g. “extra turns but not stax”).
 * - **Multiple omits** → `hateMagnetFunctionTagsExcluding(["extra-turn", "storm"])`, etc.
 */
export function hateMagnetFunctionTagsExcluding(
  omit?: string | readonly string[]
): string[] {
  const omitList =
    omit === undefined
      ? []
      : typeof omit === "string"
        ? [omit]
        : [...omit];
  if (omitList.length === 0) {
    return [...HATE_MAGNET_FUNCTION_TAGS];
  }
  const omitSet = new Set(omitList.map((t) => t.toLowerCase()));
  return HATE_MAGNET_FUNCTION_TAGS.filter((t) => !omitSet.has(t.toLowerCase()));
}

const ARCHETYPE_REGISTRY: ArchetypeEntry[] = [
  {
    name: "removal",
    description: "Destroy, exile, bounce, or tuck permanents",
    detect: /\b(removal|remove[sd]?|destroy[sd]?|exile[sd]?|kill\s+spell|kill\s+spells)\b/i,
    disqualify: /\b(graveyard|reanimate|return|recursion)\b/i,
    defaultTags: ["removal", "spot-removal", "repeatable-removal", "oblivion-ring-effect"],
    qualifiers: [
      {
        name: "creature",
        detect: /\bcreature\s+(removal|destroy|exile)|(?:removal|remove|destroy|exile|kill)\s+(?:target\s+|a\s+|the\s+)?creatures?\b/i,
        tags: ["removal-creature", "removal-creature-burn", "removal-creature-fight", "removal-exile", "removal-destroy", "spot-removal"],
        suppressTypes: ["creature"],
      },
      {
        name: "enchantment",
        detect: /\benchantment\s+(removal|destroy|exile)|(?:removal|remove|destroy|exile)\s+(?:target\s+|a\s+|the\s+)?enchantments?\b/i,
        tags: ["removal-enchantment"],
        suppressTypes: ["enchantment"],
      },
      {
        name: "artifact",
        detect: /\bartifact\s+(removal|destroy|exile)|(?:removal|remove|destroy|exile)\s+(?:target\s+|a\s+|the\s+)?artifacts?\b/i,
        tags: ["removal-artifact"],
        suppressTypes: ["artifact"],
      },
      {
        name: "planeswalker",
        detect: /\bplaneswalker\s+(removal|destroy|exile)|(?:removal|remove|destroy|exile)\s+(?:target\s+|a\s+|the\s+)?planeswalkers?\b/i,
        tags: ["removal-planeswalker", "removal-planeswalker-burn"],
        suppressTypes: ["planeswalker"],
      },
      {
        name: "land",
        detect: /\bland\s+(removal|destroy)|(?:removal|remove|destroy)\s+(?:target\s+|a\s+|the\s+)?lands?\b/i,
        tags: ["removal-land"],
        suppressTypes: ["land"],
      },
      {
        name: "permanent",
        detect: /\bpermanent\s+(removal|destroy|exile)|(?:removal|remove|destroy|exile)\s+(?:target\s+|a\s+|the\s+)?permanents?\b/i,
        tags: ["removal-permanent", "removal-exile", "removal-destroy", "removal-bounce"],
      },
      {
        name: "noncreature",
        detect: /\bnon-?creature\s+(removal|destroy|exile)|(?:removal|remove|destroy|exile)\s+(?:target\s+|a\s+|the\s+)?non-?creatures?\b/i,
        tags: ["removal-noncreature", "removal-enchantment", "removal-artifact", "removal-planeswalker", "removal-land"],
      },
      {
        name: "any",
        detect: /\b(?:any(?:\s+target)?|anything|flexible|versatile)\s+(?:removal|remove[sd]?|destroy[sd]?|exile[sd]?)|(?:removal|remove[sd]?|destroy[sd]?|exile[sd]?)\s+(?:any(?:thing)?|anything)\b/i,
        tags: ["removal-exile", "removal-destroy", "removal-bounce", "removal-permanent", "spot-removal"],
      },
    ],
    strayPattern: /\bfunction:(removal(?:-[a-z0-9-]+)?|spot-removal|repeatable-removal|swap-removal|mass-removal|multi-removal|creature-removal|artifact-removal|enchantment-removal|land-removal|planeswalker-removal)\b/gi,
  },
  {
    name: "ramp",
    description: "Accelerate mana production or cheat mana costs",
    detect: /\b(ramp|mana\s+ramp|mana\s+accel(?:eration)?|ramp\s+(?:spells?|cards?|effects?))\b/i,
    defaultTags: ["ramp", "mana-ramp"],
  },
  {
    name: "tokens",
    description: "Create or multiply creature/artifact/treasure tokens",
    detect: /\b(token\s+(?:generat(?:or|ion|e|es|ing)|creat(?:or|ion|e|es|ing)|mak(?:er?|es?|ing))|(?:make|create|generate|produce)s?\s+tokens?)\b/i,
    defaultTags: ["repeatable-token-generator", "repeatable-creature-tokens", "young-pyromancer-ability"],
    qualifiers: [
      {
        name: "treasure",
        detect: /\btreasure\s+tokens?\b/i,
        tags: ["repeatable-token-generator", "repeatable-artifact-tokens"],
      },
      {
        name: "creature",
        detect: /\bcreature\s+tokens?\b/i,
        tags: ["repeatable-token-generator", "repeatable-creature-tokens"],
      },
      {
        name: "artifact",
        detect: /\bartifact\s+tokens?\b/i,
        tags: ["repeatable-token-generator", "repeatable-artifact-tokens"],
      },
      {
        name: "noncreature",
        detect: /\bnon-?creature\s+tokens?\b/i,
        tags: ["repeatable-token-generator", "repeatable-noncreature-tokens"],
      },
    ],
    strayPattern: /\bfunction:(repeatable-(?:token-generator|creature-tokens|artifact-tokens|noncreature-tokens)|token-doubler|token-increaser|tokenfall)\b/gi,
  },
  {
    name: "reanimator",
    description: "Return permanents from graveyard to battlefield",
    detect: /\b(reanimate[sd]?|reanimation|reanimate\s+(?:creature|artifact|permanent)|graveyard\s+(?:recursion|return|recur)|return(?:s|ed|ing)?\s+from\s+(?:the\s+)?graveyard|raise\s+dead)\b/i,
    defaultTags: ["reanimate", "reanimate-creature", "reanimate-permanent", "reanimate-from-any"],
    qualifiers: [
      {
        name: "creature",
        detect: /\breanimate\s+creatures?\b|\bcreature\s+reanima/i,
        tags: ["reanimate", "reanimate-creature", "reanimate-from-any"],
      },
      {
        name: "artifact",
        detect: /\breanimate\s+artifacts?\b|\bartifact\s+reanima/i,
        tags: ["reanimate", "reanimate-artifact", "reanimate-from-any"],
      },
      {
        name: "self",
        detect: /\breanimate\s+(?:it)?self\b|\bself-reanimate\b|\breturn\s+(?:it)?self\s+from\s+(?:the\s+)?graveyard\b/i,
        tags: ["reanimate-self", "self-reanimate"],
      },
    ],
    strayPattern: /\bfunction:(reanimate(?:-[a-z0-9-]+)?|self-reanimate|graveyard-fuel(?:-[a-z0-9-]+)?)\b/gi,
  },
  {
    name: "mill",
    description: "Put cards from libraries into graveyards",
    // detect runs on the natural query. skipIfKw ensures we don't inject function:mill-* tags
    // when Phase 1 already emitted kw:mill — they would AND together and over-restrict results.
    detect: /\b(mill(?:s|ed|ing)?)\b/i,
    skipIfKw: "mill",
    disqualify: /\b(windmill|sawmill|treadmill)\b/i,
    defaultTags: ["mill", "mill-opponent", "mill-any"],
    qualifiers: [
      {
        name: "self",
        detect: /\bself[- ]?mill\b|\bmill\s+(?:your)?self\b|\bmill\s+(?:your\s+own\s+)?(?:library|deck)\b/i,
        tags: ["mill-self", "self-mill", "mill"],
      },
      {
        name: "opponent",
        detect: /\bmill\s+(?:the\s+|your\s+)?opponents?\b|\bmill\s+(?:their|enemy)\b/i,
        tags: ["mill-opponent", "mill", "mill-any"],
      },
      {
        name: "each",
        detect: /\bmill\s+each\b|\beveryone\s+mills?\b/i,
        tags: ["mill-each", "mill", "mill-any"],
      },
    ],
    strayPattern: /\bfunction:(mill(?:-[a-z0-9-]+)?|self-mill)\b/gi,
  },
  {
    name: "blink",
    description: "Exile a permanent and return it to the battlefield to re-trigger ETB effects",
    detect: /\b(blink(?:s|ed|ing)?|flicker(?:s|ed|ing)?|exile\s+(?:and|then)\s+return)\b/i,
    defaultTags: ["blink", "flicker", "flicker-creature", "flicker-permanent"],
    qualifiers: [
      {
        name: "creature",
        detect: /\b(?:blink|flicker)\s+creatures?\b|\bcreature\s+(?:blink|flicker)/i,
        tags: ["blink", "flicker", "flicker-creature"],
      },
      {
        name: "artifact",
        detect: /\b(?:blink|flicker)\s+artifacts?\b/i,
        tags: ["blink", "flicker", "flicker-artifact"],
      },
      {
        name: "permanent",
        detect: /\b(?:blink|flicker)\s+permanents?\b/i,
        tags: ["blink", "flicker", "flicker-permanent", "flicker-nonland"],
      },
      {
        name: "self",
        detect: /\b(?:blink|flicker)\s+(?:it)?self\b|\bself[- ]?(?:blink|flicker)/i,
        tags: ["flicker-self"],
      },
    ],
    strayPattern: /\bfunction:(blink(?:-[a-z0-9-]+)?|flicker(?:-[a-z0-9-]+)?|graveflicker)\b/gi,
  },
  {
    name: "discard",
    description: "Force discarding cards or benefit from discarding",
    detect: /\b(discard(?:s|ed|ing)?|hand\s+disruption|hand\s+attack)\b/i,
    defaultTags: ["discard", "discard-outlet", "discard-matters"],
    qualifiers: [
      {
        name: "self",
        detect: /\bself[- ]?discard\b|\bdiscard\s+(?:your\s+own|your|my)\b|\bdiscard\s+outlet\b|\bloot(?:s|ed|ing)?\b/i,
        tags: ["discard", "discard-outlet", "free-discard-outlet", "self-discard-matters"],
      },
      {
        name: "opponent",
        detect: /\b(?:discard|hand\s+disruption|hand\s+attack)\s+.*opponents?\b|\bopponents?\s+discards?\b|\bforced?\s+discard\b/i,
        tags: ["discard", "opponent-discard-matters", "random-discard", "specter-ability", "thoughtseize"],
      },
    ],
    strayPattern: /\bfunction:(discard(?:-[a-z0-9-]+)?|free-discard-outlet|self-discard-matters|opponent-discard-matters|random-discard|discarded-type-matters)\b/gi,
  },
  {
    name: "card-draw",
    description: "Draw extra cards or generate card advantage",
    detect: /\b(card\s+draw|draw\s+(?:engine|cards?|spells?)|draw(?:ing)?\s+(?:a\s+)?(?:lot|tons?|extra)\b|card\s+advantage)\b/i,
    disqualify: /\bcantrips?\b/i,
    defaultTags: ["draw-engine", "repeatable-draw", "pure-draw", "impulse-draw", "burst-draw", "card-advantage"],
    strayPattern: /\bfunction:(draw(?:-[a-z0-9-]+)?|repeatable-draw|pure-draw|repeatable-pure-draw|impulse-draw|impulsive-draw|repeatable-impulsive-draw|burst-draw|draw-engine|drawlink|force-draw)\b/gi,
  },
  {
    name: "cantrip",
    description: "Spells that replace themselves by drawing a card (e.g. Brainstorm, Ponder, Opt)",
    detect: /\bcantrips?\b/i,
    defaultTags: ["cantrip"],
    // When cantrip intent is detected, strip any draw-engine tags injected by a
    // prior card-draw archetype classification and replace with function:cantrip.
    strayPattern: /\bfunction:(draw(?:-[a-z0-9-]+)?|repeatable-draw|pure-draw|repeatable-pure-draw|impulse-draw|impulsive-draw|burst-draw|draw-engine|card-advantage)\b/gi,
  },
  {
    name: "counterspell",
    description: "Counter spells and permission magic (hard and soft counters)",
    detect: /\bcounterspells\b|\bcounter\s+spells?\b/i,
    defaultTags: ["counterspell"],
    strayPattern: /\bfunction:(counterspell(?:-[a-z0-9-]+)?)\b/gi,
  },
  {
    name: "recursion",
    description: "Graveyard recursion and self-recursion effects",
    detect: /\brecursion\b/i,
    defaultTags: ["recursion"],
    strayPattern: /\bfunction:recursion\b/gi,
  },
  {
    name: "mana-dork",
    description: "Creatures that tap to produce mana (e.g. Llanowar Elves, Birds of Paradise)",
    detect: /\bmana[\s-]?dorks?\b/i,
    defaultTags: ["mana-dork"],
    strayPattern: /\bfunction:mana-dork\b/gi,
  },
  {
    name: "anthem",
    description: "Permanent effects that buff all creatures you control (e.g. Glorious Anthem)",
    detect: /\banthems?\b/i,
    defaultTags: ["anthem"],
    strayPattern: /\bfunction:anthem\b/gi,
  },
  {
    name: "lord",
    description: "Tribal lords that grant +1/+1 or abilities to creatures of a specific type",
    detect: /\b(?:tribal\s+)?lords?\b/i,
    disqualify: /\blord\s+of\s+the\b|\btime\s+lords?\b/i,
    defaultTags: ["lord"],
    strayPattern: /\bfunction:lord\b/gi,
  },
  {
    name: "voltron",
    description: "Buff a single creature with equipment or auras to win via commander damage",
    detect: /\b(voltron|equipment\s+(?:matters?|synerg|deck|theme)|aura\s+(?:matters?|synerg|deck|theme))\b/i,
    defaultTags: ["synergy-equipment", "synergy-aura", "sneak-equipment", "sneak-aura"],
    strayPattern: /\bfunction:(synergy-equipment(?:-[a-z0-9-]+)?|synergy-aura|sneak-equipment|sneak-aura)\b/gi,
  },
  {
    name: "stax",
    description: "Tax or restrict opponents' actions (casting, attacking, untapping)",
    detect: /\b(stax|tax\s+(?:effects?|spells?|cards?)|hatebears?|hate\s+bears?)\b/i,
    defaultTags: ["tax", "tax-attack", "tax-block", "cast-tax", "kismet-effect"],
    strayPattern: /\bfunction:(tax(?:-[a-z0-9-]+)?|cast-tax)\b/gi,
  },
  {
    name: "landfall",
    description: "Trigger effects when lands enter the battlefield",
    detect: /\b(landfall|lands?\s+matter|lands?\s+entering)\b/i,
    defaultTags: ["landfall", "landfall-other"],
    strayPattern: /\bfunction:(landfall(?:-[a-z0-9-]+)?|islandfall)\b/gi,
  },
  {
    name: "infect",
    description: "Deal damage as poison counters or infect/toxic mechanics",
    detect: /\b(infect|poison(?:\s+counters?)?|toxic|poisonous)\b/i,
    disqualify: /\b(poison\s+(?:ivy|dart|frog|breath))\b/i,
    defaultTags: ["infect", "poison", "poison-opponents", "gives-infect", "synergy-infect", "synergy-poison"],
    strayPattern: /\bfunction:(infect|poison(?:-[a-z0-9-]+)?|gives-infect|gives-poisonous|synergy-infect|synergy-poison|gains-infect)\b/gi,
  },
  {
    name: "storm",
    description: "Copy spells based on number of spells cast this turn",
    detect: /\b(storm(?:\s+(?:count|deck|off|cards?))?)\b/i,
    disqualify: /\b(storm\s+(?:crow|herald|fleet|breath|entity|scale|seeker|sewer|the\s+vault))\b/i,
    defaultTags: ["storm", "storm-like", "storm-count-matters", "gives-storm"],
    strayPattern: /\bfunction:(storm(?:-[a-z0-9-]+)?|gives-storm|commander-storm)\b/gi,
  },
  {
    name: "extra-combat",
    description: "Grant additional combat phases in a turn",
    detect: /\b(extra\s+combat|additional\s+combat|multiple\s+combats?)\b/i,
    defaultTags: ["extra-combat", "extra-combat-phase"],
    strayPattern: /\bfunction:(extra-combat(?:-[a-z0-9-]+)?)\b/gi,
  },
  {
    name: "pillow-fort",
    description: "Prevent or tax opponents from attacking you",
    detect: /\b(pillow\s*fort|prevent(?:s|ed|ing)?\s+(?:players?\s+from\s+)?attack(?:s|ed|ing)?|stop\s+attack(?:s|ing)?|(?:tax|cost)\s+(?:to\s+)?attack(?:s|ing)?|can'?t\s+(?:be\s+)?attack(?:ed|ing)?|attack\s+(?:prevention|tax|cost|restrict))\b/i,
    defaultTags: ["prevent-attack", "prevent-attacker", "tax-attack"],
    strayPattern: /\bfunction:(prevent-attack(?:er)?|tax-attack)\b/gi,
  },
  {
    name: "enchantress",
    description: "Draw a card whenever an enchantment is cast or enters; enchantress-effect payoffs",
    detect: /\benchantress(?:\s+(?:cards?|deck|theme|payoff|synerg(?:y|ies)|effects?|commander))?\b/i,
    defaultTags: ["enchantress"],
    strayPattern: /\bfunction:enchantress\b/gi,
  },
  {
    name: "tutor",
    description: "Search, fetch, or find specific cards from your library or deck",
    detect: /\b(tutor(?:s|ed|ing)?|(?:acts?|works?|functions?)\s+like\s+a\s+tutor|fetch(?:es|ed|ing)?\s+(?:a\s+)?card|find\s+(?:a\s+)?card\s+(?:from|in)\s+(?:your\s+)?(?:library|deck))\b/i,
    defaultTags: ["tutor", "tutor-to-hand"],
    qualifiers: [
      {
        name: "creature",
        detect: /\b(?:tutors?|fetch(?:es)?|finds?)\s+(?:for\s+)?(?:an?\s+)?creatures?\b|\bcreatures?\s+tutors?\b/i,
        tags: ["tutor-creature"],
      },
      {
        name: "enchantment",
        detect: /\b(?:tutors?|fetch(?:es)?|finds?)\s+(?:for\s+)?(?:an?\s+)?enchantments?\b|\benchantments?\s+tutors?\b/i,
        tags: ["tutor-enchantment"],
      },
      {
        name: "land",
        detect: /\b(?:tutors?|fetch(?:es)?|finds?)\s+(?:for\s+)?(?:an?\s+)?lands?\b|\blands?\s+tutors?\b/i,
        tags: ["tutor-land"],
      },
      {
        name: "artifact",
        detect: /\b(?:tutors?|fetch(?:es)?|finds?)\s+(?:for\s+)?(?:an?\s+)?artifacts?\b|\bartifacts?\s+tutors?\b/i,
        tags: ["tutor-artifact"],
      },
      {
        name: "instant",
        detect: /\b(?:tutors?|fetch(?:es)?|finds?)\s+(?:for\s+)?(?:an?\s+)?instants?\b|\binstants?\s+tutors?\b/i,
        tags: ["tutor-instant"],
      },
      {
        name: "sorcery",
        detect: /\b(?:tutors?|fetch(?:es)?|finds?)\s+(?:for\s+)?(?:an?\s+)?sorcer(?:y|ies)\b|\bsorcer(?:y|ies)\s+tutors?\b/i,
        tags: ["tutor-sorcery"],
      },
      {
        name: "planeswalker",
        detect: /\b(?:tutors?|fetch(?:es)?|finds?)\s+(?:for\s+)?(?:an?\s+)?planeswalkers?\b|\bplaneswalkers?\s+tutors?\b/i,
        tags: ["tutor-planeswalker"],
      },
    ],
    strayPattern: /\bfunction:(tutor(?!-land)(?:-[a-z0-9-]+)?|hate-tutor)\b/gi,
  },
  {
    name: "finisher",
    description: "End the game on the spot: 'you win the game' effects, Craterhoof-style overrun pumps, or primary win conditions",
    detect: /\b(?:finishers?|game[-\s]enders?|win[-\s]?cons?|win\s+conditions?|wincons?|close(?:s|d|ing)?\s+(?:out\s+)?(?:the\s+)?game|end(?:s|ed|ing)?\s+(?:the\s+)?game|alpha\s+strikes?|overrun\s+effects?|craterhoof\s+effects?|swing\s+(?:for\s+)?(?:lethal|the\s+win)|lethal\s+(?:blow|damage|swing|attack)|seal(?:s|ed|ing)?\s+(?:the\s+)?game)\b/i,
    defaultTags: ["win-condition", "alternate-win-condition", "automatic-win", "overrun"],
    strayPattern: /\bfunction:(win-condition|alternate-win-condition|automatic-win|overrun)\b/gi,
  },
  {
    name: "aristocrats",
    description: "Sacrifice creatures for value: sacrifice outlets, death triggers, and payoffs when creatures die",
    detect: /\baristo(?:cra(?:ts?|cts?|tic)|arts?)\b/i,
    defaultTags: ["sacrifice-outlet", "sac-outlet", "death-trigger", "death-trigger-self", "synergy-sacrifice", "blood-artist-ability"],
    strayPattern: /\bfunction:(?:sacrifice-outlet|sac-outlet|death-trigger-self|death-trigger|synergy-sacrifice|sacrifice-self|alternate-cost-sacrifice)\b/gi,
  },
  {
    name: "group-slug",
    description: "Deal damage or impose costs on all opponents simultaneously",
    detect: /\bgroup[-\s]slug\b/i,
    defaultTags: ["group-slug"],
    strayPattern: /\bfunction:group-slug\b/gi,
  },
  {
    name: "group-hug",
    description: "Benefit all players equally: draw cards for everyone, accelerate everyone's mana, etc.",
    detect: /\b(?:group[-\s]hug|benefit\s+(?:all|every(?:one)?|each)\s+(?:players?|opponents?)|(?:draw|give|gain)\s+(?:cards?|mana|life)\s+for\s+(?:everyone|all\s+players?)|everyone\s+(?:draws?|gets?|gains?)|politic(?:al)?\s+(?:card|deck|effect)|makes?\s+friends?|be\s+(?:the\s+)?nice\s+(?:player|guy))\b/i,
    defaultTags: ["group-hug", "selective-group-hug"],
    strayPattern: /\bfunction:(group-hug|selective-group-hug)\b/gi,
  },
  {
    name: "hate-magnet",
    description: "Cards that make you the archenemy: group slug, stax, extra turns, land destruction, lockdown, storm, or infect strategies that antagonise the whole table",
    detect: /\b(?:archenemy\s+(?:card|effect|magnet|effect)|make\s+(?:everyone|all\s+(?:players?|opponents?))\s+(?:hate|target|attack)\s+(?:you|me)|paint\s+a\s+target\s+on\s+(?:your|my)\s+back|everyone\s+hates?\s+(?:you|me)|become\s+(?:the\s+)?archenemy|table\s+(?:archenemy|target|hate)|make\s+(?:people|opponents?|players?)\s+hate\s+(?:you|me)|cards?\s+(?:that\s+)?(?:everyone|people|opponents?)\s+hates?|most\s+hated\s+cards?|most\s+annoying\s+cards?)\b/i,
    defaultTags: [...HATE_MAGNET_FUNCTION_TAGS],
    strayPattern: /\bfunction:(group-slug|extra-turn|mass-land-denial|lockdown(?:-[a-z0-9-]+)?|storm(?:-[a-z0-9-]+)?|tax|cast-tax|infect)\b/gi,
  },
  // ── Hate archetypes ────────────────────────────────────────────────────────
  {
    name: "hate-etb",
    description: "Prevent or punish opponents' creatures from triggering enters-the-battlefield abilities",
    detect: /\b(?:hate-?etb|etb-?hate|stop\s+(?:opponents?'?s?\s+)?etb|prevent(?:s|ed|ing)?\s+etb|anti-?etb|etb\s+(?:hate|hosers?|prevention|stopper?)|suppress(?:es|ed|ing)?\s+etb|stop\s+etb\s+triggers?)\b/i,
    defaultTags: ["hate-etb"],
    strayPattern: /\bfunction:hate-etb\b/gi,
  },
  {
    name: "graveyard-hate",
    description: "Exile or permanently neutralize opponents' graveyards",
    detect: /\b(?:graveyard[-\s]hate|hate[-\s]graveyard|anti[-\s]graveyard|punish(?:es|ing)?\s+graveyard|stop\s+graveyard\s+(?:strategies?|decks?|play)|graveyard\s+(?:hate|hosers?|prevention)|exile\s+opponents?'?s?\s+graveyard)\b/i,
    defaultTags: ["graveyard-hate", "hate-graveyard", "hate-graveyard-cast"],
    strayPattern: /\bfunction:(graveyard-hate|hate-graveyard(?:-[a-z0-9-]+)?)\b/gi,
  },
  {
    name: "artifact-hate",
    description: "Punish, restrict, or hate against artifacts and artifact strategies",
    detect: /\b(?:artifact[-\s]hate|hate[-\s]artifacts?|anti[-\s]artifact|punish(?:es|ing)?\s+artifacts?|hate\s+against\s+artifacts?)\b/i,
    defaultTags: ["hate-artifact", "hate-artifact-creature", "hate-artifact-land"],
    strayPattern: /\bfunction:hate-artifact(?:-[a-z0-9-]+)?\b/gi,
  },
  {
    name: "enchantment-hate",
    description: "Punish, restrict, or hate against enchantments",
    detect: /\b(?:enchantment[-\s]hate|hate[-\s]enchantments?|anti[-\s]enchantment|punish(?:es|ing)?\s+enchantments?|hate\s+against\s+enchantments?)\b/i,
    defaultTags: ["hate-enchantment", "hate-enchantment-creature"],
    strayPattern: /\bfunction:hate-enchantment(?:-[a-z0-9-]+)?\b/gi,
  },
  {
    name: "token-hate",
    description: "Prevent or punish opponents from creating or benefiting from tokens",
    detect: /\b(?:token[-\s]hate|hate[-\s]tokens?|anti[-\s]token|punish(?:es|ing)?\s+tokens?|stop\s+tokens?|hate\s+(?:against\s+)?tokens?)\b/i,
    defaultTags: ["hate-token", "hate-token-creature"],
    strayPattern: /\bfunction:hate-token(?:-[a-z0-9-]+)?\b/gi,
  },
  {
    name: "draw-hate",
    description: "Punish or restrict opponents from drawing extra cards",
    detect: /\b(?:draw[-\s]hate|hate[-\s]draw|anti[-\s]draw|punish(?:es|ing)?\s+(?:card\s+)?draw(?:ing)?|stop\s+(?:opponents?'?s?\s+)?(?:card\s+)?draw(?:ing)?|hate\s+(?:against\s+)?(?:card\s+)?draw(?:ing)?)\b/i,
    defaultTags: ["hate-draw", "draw-hate"],
    strayPattern: /\bfunction:(hate-draw|draw-hate)\b/gi,
  },
  {
    name: "lifegain-hate",
    description: "Prevent or punish opponents from gaining life",
    detect: /\b(?:lifegain[-\s]hate|hate[-\s]lifegain|life\s*gain[-\s]hate|anti[-\s]lifegain|punish(?:es|ing)?\s+(?:life\s+)?gain(?:ing)?|stop\s+(?:opponents?'?s?\s+)?(?:life\s+)?gain(?:ing)?|prevent(?:s|ed|ing)?\s+(?:opponents?'?s?\s+)?life\s*gain)\b/i,
    defaultTags: ["hate-lifegain"],
    strayPattern: /\bfunction:hate-lifegain\b/gi,
  },
  {
    name: "storm-hate",
    description: "Shut down or punish storm and spell-copy strategies",
    detect: /\b(?:storm[-\s]hate|hate[-\s]storm|anti[-\s]storm|punish(?:es|ing)?\s+storm|stop\s+storm|hate\s+(?:against\s+)?storm)\b/i,
    defaultTags: ["hate-storm"],
    strayPattern: /\bfunction:hate-storm\b/gi,
  },
  {
    name: "ramp-hate",
    description: "Punish or restrict mana ramp and mana acceleration",
    detect: /\b(?:ramp[-\s]hate|hate[-\s]ramp|anti[-\s]ramp|punish(?:es|ing)?\s+ramp(?:ing)?|stop\s+ramp(?:ing)?|hate\s+(?:against\s+)?ramp(?:ing)?)\b/i,
    defaultTags: ["hate-ramp"],
    strayPattern: /\bfunction:hate-ramp\b/gi,
  },
  {
    name: "nonbasic-hate",
    description: "Punish or restrict non-basic lands",
    detect: /\b(?:non-?basic[-\s](?:land[-\s])?hate|hate[-\s]non-?basic\s+lands?|anti[-\s]non-?basic|punish(?:es|ing)?\s+non-?basic\s+lands?|non-?basic\s+land\s+hate)\b/i,
    defaultTags: ["hate-nonbasic-land"],
    strayPattern: /\bfunction:hate-nonbasic-land\b/gi,
  },
  {
    name: "flying-hate",
    description: "Punish or destroy creatures with flying",
    detect: /\b(?:flying[-\s]hate|hate[-\s]flying|anti[-\s]flying|punish(?:es|ing)?\s+flying|hate\s+(?:against\s+)?flying)\b/i,
    defaultTags: ["hate-flying", "flying-hate"],
    strayPattern: /\bfunction:(hate-flying|flying-hate)\b/gi,
  },
  {
    name: "flash-hate",
    description: "Prevent or punish opponents from playing spells at instant speed",
    detect: /\b(?:flash[-\s]hate|hate[-\s]flash|anti[-\s]flash|punish(?:es|ing)?\s+flash|stop\s+flash|hate\s+(?:against\s+)?flash)\b/i,
    defaultTags: ["hate-flash"],
    strayPattern: /\bfunction:hate-flash\b/gi,
  },
  {
    name: "hexproof-hate",
    description: "Bypass, remove, or punish hexproof on permanents",
    detect: /\b(?:hexproof[-\s]hate|hate[-\s]hexproof|anti[-\s]hexproof|punish(?:es|ing)?\s+hexproof|bypass(?:es|ed|ing)?\s+hexproof|ignore\s+hexproof)\b/i,
    defaultTags: ["hate-hexproof"],
    strayPattern: /\bfunction:hate-hexproof\b/gi,
  },
  {
    name: "indestructible-hate",
    description: "Bypass or punish indestructible permanents",
    detect: /\b(?:indestructible[-\s]hate|hate[-\s]indestructible|anti[-\s]indestructible|punish(?:es|ing)?\s+indestructible|bypass(?:es|ed|ing)?\s+indestructible|ignore\s+indestructible)\b/i,
    defaultTags: ["hate-indestructible"],
    strayPattern: /\bfunction:hate-indestructible\b/gi,
  },
  {
    name: "copy",
    description: "Create token copies of permanents or copy spells on the stack",
    detect: /\b(?:cop(?:y|ies|ying)|clone[sd]?|cloning|create[sd]?\s+(?:a\s+)?cop(?:y|ies)|fork(?:ing|s)?)\b/i,
    disqualify: /\b(?:copy\s+of\s+a\s+card|copy\s+opponent|copy\s+target\s+(?:instant|sorcery)|graveyard\s+cop)\b/i,
    defaultTags: ["clone", "copy-permanent", "copy-spell", "creates-oracle-copy"],
    qualifiers: [
      {
        name: "spell",
        detect: /\bcop(?:y|ies|ying)\s+(?:a\s+)?(?:instant|sorcery|spells?)\b|\bfork(?:ing|s)?\b|\bspell\s+cop(?:y|ies)\b/i,
        tags: ["copy-spell", "copy-instant", "copy-sorcery"],
      },
      {
        name: "creature",
        detect: /\bcop(?:y|ies|ying)\s+(?:a\s+)?creatures?\b|\bclone[sd]?\s+(?:a\s+)?creatures?\b|\bcreature\s+cop(?:y|ies)\b/i,
        tags: ["clone", "copy-creature"],
      },
      {
        name: "permanent",
        detect: /\bcop(?:y|ies|ying)\s+(?:a\s+)?permanents?\b|\bpermanent\s+cop(?:y|ies)\b/i,
        tags: ["copy-permanent", "clone"],
      },
      {
        name: "artifact",
        detect: /\bcop(?:y|ies|ying)\s+(?:a\s+)?artifacts?\b|\bartifact\s+cop(?:y|ies)\b/i,
        tags: ["copy-artifact"],
      },
      {
        name: "enchantment",
        detect: /\bcop(?:y|ies|ying)\s+(?:a\s+)?enchantments?\b|\benchantment\s+cop(?:y|ies)\b/i,
        tags: ["copy-enchantment"],
      },
    ],
    strayPattern: /\bfunction:(?:clone|copy-(?:permanent|creature|spell|instant|sorcery|artifact|enchantment|token|legendary|nonland|noncreature)|creates-oracle-copy)\b/gi,
  },
  // ── Card-name effect archetypes ─────────────────────────────────────────
  // Card names that have become generic shorthand for an effect category.
  {
    name: "fog",
    description: "Prevent all combat damage this turn (Fog effects)",
    detect: /\b(?:fog(?:s|ged|ging)?(?:\s+(?:effects?|like|style))?|prevent(?:s|ed|ing)?\s+(?:all\s+)?combat\s+damage)\b/i,
    disqualify: /\bfog\s+(?:bank|patch|elemental|of\s+(?:war|gnomes))\b/i,
    defaultTags: ["fog", "fog-limited", "fog-selective", "pseudo-fog"],
    strayPattern: /\bfunction:(?:fog(?:-[a-z0-9-]+)?|pseudo-fog)\b/gi,
  },
  {
    name: "wheel",
    description: "Each player discards their hand and draws a new hand (Wheel of Fortune effects)",
    detect: /\bwheels?(?:\s+(?:effects?|like|style|of\s+fortune))?\b/i,
    disqualify: /\bwheel\s+of\s+(?:sun|fate)\b/i,
    defaultTags: ["wheel"],
    strayPattern: /\bfunction:wheel\b/gi,
  },
  {
    name: "curiosity",
    description: "Draw a card whenever a creature deals combat damage to a player (Curiosity effects)",
    detect: /\bcuriosity\s+(?:effects?|like|style|triggers?)\b|\bdraw\s+(?:a\s+)?cards?\s+(?:when(?:ever)?\s+)?(?:deals?|combat)\s+damage/i,
    defaultTags: ["curiosity", "curiosity-like"],
    strayPattern: /\bfunction:curiosity(?:-[a-z0-9-]+)?\b/gi,
  },
  {
    name: "brainstorm",
    description: "Draw cards and put cards back on top of your library (Brainstorm-style card selection)",
    detect: /\bbrainstorms?(?:\s+(?:effects?|like|style))?\b/i,
    defaultTags: ["brainstorm"],
    strayPattern: /\bfunction:brainstorm\b/gi,
  },
  {
    name: "impact-tremors",
    description: "Deal damage to opponents whenever a creature enters the battlefield (Impact Tremors effects)",
    detect: /\bimpact\s*tremors?\s*(?:effects?|like)?\b|\bdamage\s+(?:when(?:ever)?\s+)?(?:a\s+)?creatures?\s+enters?\b/i,
    defaultTags: ["impact-effect"],
    strayPattern: /\bfunction:impact-effect\b/gi,
  },
];

function normalizeArchetypeIntents(
  naturalQuery: string,
  query: string
): string {
  // If Phase 1 resolved the query to a specific card name, skip archetype injection —
  // "flicker" should be either the card OR the mechanic, not both ANDed together.
  if (/\bname:/i.test(query)) {
    return query;
  }

  const lower = maskSynergyWithComplements(naturalQuery).toLowerCase();
  let updated = query;

  for (const archetype of ARCHETYPE_REGISTRY) {
    if (!archetype.detect.test(lower)) continue;
    if (archetype.disqualify?.test(lower)) continue;

    // Detect qualifier match before checking skipIfKw so that a refined intent (e.g.
    // "self mill") can override the Phase-1 kw:X token rather than being suppressed by it.
    let desiredTags = archetype.defaultTags;
    let qualifierMatched = false;

    if (archetype.qualifiers) {
      for (const qualifier of archetype.qualifiers) {
        if (qualifier.detect.test(lower)) {
          desiredTags = qualifier.tags;
          qualifierMatched = true;
          break;
        }
      }
    }

    if (archetype.skipIfKw) {
      const kwPattern = new RegExp(`(?:^|\\s)kw:${archetype.skipIfKw}\\b`, "i");
      if (kwPattern.test(updated)) {
        if (!qualifierMatched) {
          // Phase 1 already expressed the general intent via kw:X; don't AND with function: tags.
          continue;
        }
        // A qualifier refines the intent beyond what kw:X captures — replace kw:X with the
        // qualifier-specific function: tags instead of AND-ing both together.
        updated = updated.replace(
          new RegExp(`\\bkw:${archetype.skipIfKw}\\b`, "gi"),
          " ",
        );
        updated = normalizeWhitespace(updated);
      }
    }

    // Before stripping, record any specific (non-default) qualifier tags already in the query.
    // These were emitted by Phase 1 or Phase 2 for targets that the detect regexes below may
    // not pick up (e.g. "remove enchantments and artifacts" → both removal-enchantment and
    // removal-artifact are present, but the qualifier loop only matches the first one).
    // We preserve them so they are not silently lost when the strayPattern strips them.
    const defaultTagSet = new Set(archetype.defaultTags);
    const preservedSpecificTags: string[] = [];
    if (archetype.strayPattern) {
      const findPattern = new RegExp(archetype.strayPattern.source, "gi");
      let pm: RegExpExecArray | null;
      while ((pm = findPattern.exec(updated)) !== null) {
        const slug = pm[1]?.toLowerCase();
        if (slug && !defaultTagSet.has(slug)) {
          preservedSpecificTags.push(slug);
        }
      }
    }

    // When specific qualifier tags are already present but no qualifier pattern matched
    // (desiredTags is still the default set), skip the generic tag expansion entirely and
    // just restore the specific tags as an OR group. This prevents double-tagging like:
    //   (function:removal or ...) function:removal-enchantment function:removal-artifact
    // and ensures the restored tags are OR'd (not AND'd) since they represent alternative
    // removal methods, not cumulative requirements.
    const qualifierWasDetected = desiredTags !== archetype.defaultTags;
    if (!qualifierWasDetected && preservedSpecificTags.length > 0) {
      if (archetype.strayPattern) {
        const cleanPattern = new RegExp(archetype.strayPattern.source, archetype.strayPattern.flags);
        updated = updated.replace(cleanPattern, " ");
      }
      updated = updated.replace(/\(\s*(?:-?(?:and|or)\s*)*\)/gi, " ");
      updated = normalizeWhitespace(updated);
      const orChain = preservedSpecificTags.map((slug) => `function:${slug}`);
      if (orChain.length >= 2) {
        updated = `${updated} (${orChain.join(" or ")})`;
      } else {
        updated = `${updated} ${orChain[0]}`;
      }
      updated = normalizeWhitespace(updated);
      continue;
    }

    if (archetype.strayPattern) {
      const cleanPattern = new RegExp(archetype.strayPattern.source, archetype.strayPattern.flags);
      updated = updated.replace(cleanPattern, " ");
    }

    for (const tag of desiredTags) {
      // Use (?!-) instead of \b so we don't accidentally strip a compound tag that
      // starts with this tag name (e.g. "function:tutor" must not strip "function:tutor-land").
      const tagPattern = new RegExp(`\\bfunction:${escapeRegex(tag)}(?!-)`, "gi");
      updated = updated.replace(tagPattern, " ");
    }
    // Remove parenthetical groups that are now empty or contain only "or" separators
    // after stripping tags (e.g. "( or or or )" left over from an expanded OR chain).
    updated = updated.replace(/\(\s*(?:-?(?:and|or)\s*)*\)/gi, " ");
    updated = normalizeWhitespace(updated);

    const orChain = desiredTags.map((t) => `function:${t}`);
    if (orChain.length >= 2) {
      updated = `${updated} (${orChain.join(" or ")})`;
    } else if (orChain.length === 1) {
      updated = `${updated} ${orChain[0]}`;
    }

    // Re-add any specific qualifier tags that were preserved above but not included
    // in desiredTags (they cover additional targets beyond what the qualifier detected,
    // e.g. both enchantment and artifact when the qualifier loop only matched enchantment).
    const desiredTagSet = new Set(desiredTags);
    for (const slug of preservedSpecificTags) {
      if (!desiredTagSet.has(slug)) {
        updated = `${updated} function:${slug}`;
      }
    }
  }

  return normalizeWhitespace(updated);
}

export type ArchetypeMenuEntry = {
  name: string;
  description: string;
  qualifiers?: string[];
};

export function getArchetypeMenu(): ArchetypeMenuEntry[] {
  const damageEntry: ArchetypeMenuEntry = {
    name: "damage",
    description: "Deal direct damage or burn to opponents, creatures, planeswalkers, or any target",
    qualifiers: ["opponent", "creature", "planeswalker", "player", "any", "battle", "general"],
  };

  const archetypeEntries = ARCHETYPE_REGISTRY.map((entry) => {
    const result: ArchetypeMenuEntry = {
      name: entry.name,
      description: entry.description,
    };
    if (entry.qualifiers && entry.qualifiers.length > 0) {
      result.qualifiers = entry.qualifiers.map((q) => q.name);
    }
    return result;
  });

  return [damageEntry, ...archetypeEntries];
}

export function lookupArchetypeTags(
  archetype: string,
  qualifier?: string
): string[] | null {
  if (archetype === "damage") {
    const target = (qualifier || "general") as DamageTarget;
    return DAMAGE_TAG_FAMILIES[target] || DAMAGE_TAG_FAMILIES.general;
  }

  const entry = ARCHETYPE_REGISTRY.find(
    (e) => e.name.toLowerCase() === archetype.toLowerCase()
  );
  if (!entry) return null;

  if (qualifier && entry.qualifiers) {
    const q = entry.qualifiers.find(
      (q) => q.name.toLowerCase() === qualifier.toLowerCase()
    );
    if (q) return q.tags;
  }

  return entry.defaultTags;
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
    updated = `${updated} (${additions.join(" or ")})`.trim();
  }

  return normalizeWhitespace(updated);
}

/** Counts parenthesized art OR groups like (art:x or art:y). */
function countArtOrGroups(query: string): number {
  const matches = query.match(/\(\s*art:/gi);
  return matches ? matches.length : 0;
}

/** Collects all art/atag/arttag tokens and replaces them with a single OR chain. Leaves query unchanged when it already has multiple (art:... or ...) groups (AND of concepts). */
function normalizeArtTagsToOrChain(query: string): string {
  if (countArtOrGroups(query) >= 2) return query;
  // Preserve explicit AND intent when multiple standalone art tags are already
  // present as separate clauses (e.g. "art:goth art:woman art:cleavage").
  const standaloneArtAndChain =
    /(?:^|\s)(?:art|atag|arttag):[^\s()]+(?:\s+(?:art|atag|arttag):[^\s()]+){1,}(?:\s|$)/i;
  if (standaloneArtAndChain.test(query)) return query;

  const artPattern = /\b(?:art|atag|arttag):([^\s()]+)(?=\s|$|\))/gi;
  const tags: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = artPattern.exec(query)) !== null) {
    const slug = match[1];
    if (slug && !tags.some((t) => t.toLowerCase() === `art:${slug.toLowerCase()}`)) {
      tags.push(`art:${slug}`);
    }
  }
  if (tags.length < 2) return query;
  let updated = query.replace(artPattern, " ");
  updated = normalizeWhitespace(updated);
  updated = `${updated} (${tags.join(" or ")})`.trim();
  return normalizeWhitespace(updated);
}

/** Function tags that create/make tokens. Used to expand "make tokens" to OR chain. */
const TOKEN_GENERATION_FUNCTION_TAGS = [
  "repeatable-token-generator",
  "repeatable-creature-tokens",
  "repeatable-artifact-tokens",
  "repeatable-noncreature-tokens",
  "young-pyromancer-ability",
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
  let eligibleTags = TOKEN_GENERATION_FUNCTION_TAGS.filter((tag) =>
    availableTags.includes(tag.toLowerCase())
  );
  if (eligibleTags.length <= 1) {
    return query;
  }

  // When the user asks for a specific token type, exclude tags that produce other types.
  const wantsCreatureTokens =
    /\bcreature\s+tokens?\b|\btoken\s+creatures?\b/i.test(naturalQuery);
  const wantsArtifactTokens =
    /\b(?:artifact|treasure|food|clue|gold|blood|map|junk)\s+tokens?\b|\btoken\s+(?:artifact|treasure|food|clue)s?\b/i.test(naturalQuery);
  const wantsLandTokens =
    /\bland\s+tokens?\b|\btoken\s+lands?\b/i.test(naturalQuery);
  const wantsNoncreatureTokens =
    /\bnon-?creature\s+tokens?\b|\btoken\s+non-?creatures?\b/i.test(naturalQuery);

  type TagName = typeof TOKEN_GENERATION_FUNCTION_TAGS[number];
  let tagsToExclude: Set<TagName> | null = null;

  if (wantsCreatureTokens && !wantsArtifactTokens && !wantsLandTokens) {
    tagsToExclude = new Set<TagName>([
      "repeatable-token-generator",
      "repeatable-artifact-tokens",
      "repeatable-noncreature-tokens",
      "create-land-tokens",
    ]);
  } else if (wantsLandTokens && !wantsCreatureTokens && !wantsArtifactTokens) {
    tagsToExclude = new Set<TagName>([
      "repeatable-token-generator",
      "repeatable-creature-tokens",
      "repeatable-artifact-tokens",
      "repeatable-noncreature-tokens",
      "young-pyromancer-ability",
      "creates-token-of-a-card",
      "creates-oracle-token",
      "creates-card-token",
    ]);
  } else if (wantsArtifactTokens && !wantsCreatureTokens && !wantsLandTokens) {
    tagsToExclude = new Set<TagName>([
      "repeatable-token-generator",
      "repeatable-creature-tokens",
      "repeatable-noncreature-tokens",
      "create-land-tokens",
      "young-pyromancer-ability",
      "creates-token-of-a-card",
      "creates-oracle-token",
      "creates-card-token",
    ]);
  } else if (wantsNoncreatureTokens && !wantsCreatureTokens) {
    tagsToExclude = new Set<TagName>([
      "repeatable-token-generator",
      "repeatable-creature-tokens",
      "young-pyromancer-ability",
    ]);
  }

  if (tagsToExclude) {
    const narrowed = eligibleTags.filter((tag) => !(tagsToExclude as Set<TagName>).has(tag));
    if (narrowed.length > 0) eligibleTags = narrowed;
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

function stripFranchiseCreatureTypeConfusion(
  naturalQuery: string,
  query: string
): string {
  const isAvatarFranchise =
    /\bavatar\s+the\s+last\s+airbender\b|\bairbender\b|\blikes\s+avatar\b|\bfrom\s+avatar\b/i.test(
      naturalQuery
    );
  if (!isAvatarFranchise) return query;
  const updated = query.replace(/\s*-?t:avatar\b/gi, " ");
  return normalizeWhitespace(updated);
}

function stripSubjectiveQualifierTags(
  naturalQuery: string,
  query: string
): string {
  const hasSubjectiveQualifier =
    /\b(easy|simple|accessible|beginner|new\s+player|for\s+(?:a\s+)?new\s+player)\b/i.test(
      naturalQuery
    );
  if (!hasSubjectiveQualifier) {
    return query;
  }
  const updated = query.replace(
    /\s*-?function:any-player-ability\b/gi,
    " "
  );
  return normalizeWhitespace(updated);
}

/**
 * Phase 2 sometimes emits o:casual / o:fun / o:play when the user means table
 * meta ("casual commander pod"), not oracle text. Those AND together and
 * usually return zero hits. Strip them when the natural language is clearly
 * playgroup / format talk; always strip o:casual (almost never a real search axis).
 */
function stripPlaygroupMetaOracleFilters(
  naturalQuery: string,
  query: string
): string {
  const playgroupTalk =
    /\b(?:casual|cedh|kitchen\s*table|low\s*power|precon|pre-con)\b/i.test(
      naturalQuery
    ) &&
    /\b(?:commander|edh|pod|meta|table|group)\b/i.test(naturalQuery);
  let updated = query.replace(/\s*-?o:casual\b/gi, " ");
  if (playgroupTalk) {
    updated = updated.replace(/\s*-?o:fun\b/gi, " ");
    updated = updated.replace(/\s*-?o:play\b/gi, " ");
  }
  return normalizeWhitespace(updated);
}

/**
 * Phase 2 may emit o:combo / o:"combo with" when the user means synergy
 * ("combos with mana dorks"), not oracle text containing the word "combo".
 * Those AND with other o: filters and usually return zero hits.
 */
function stripColloquialComboOracleFilters(
  naturalQuery: string,
  query: string
): string {
  if (!/\bo:combo\b|o:"combo/i.test(query)) {
    return query;
  }
  const synergyTalk =
    /\bcombos?\s+with\b/i.test(naturalQuery) ||
    /\b(?:stuff|things|cards)\s+that\s+.*\bcombo/i.test(naturalQuery) ||
    /\bshenanigans\b/i.test(naturalQuery) ||
    /\b(?:synergy|synergizes?|pairs?\s+with|works?\s+with)\b/i.test(
      naturalQuery
    );
  if (!synergyTalk) {
    return query;
  }
  let updated = query.replace(/\s*-?o:combo\b/gi, " ");
  updated = updated.replace(/\s*-?o:"combo\s+with"/gi, " ");
  updated = updated.replace(/\s*-?o:'combo\s+with'/gi, " ");
  updated = updated.replace(/\s*-?o:"combos\s+with"/gi, " ");
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
  // Remove empty OR branches inside parentheses (case-insensitive "or").
  updated = updated.replace(/\(\s*OR\s+([^)]+)\)/gi, "($1)");
  updated = updated.replace(/\(\s*([^)]+)\s+OR\s*\)/gi, "($1)");
  // Drop parentheses that only contain ORs, e.g. rogue "(or)" from empty OR-merge slots.
  updated = updated.replace(/\(\s*(?:OR\s*)+\)/gi, "");
  updated = updated.replace(/\(\s*or\s*\)/gi, "");
  // Collapse repeated OR tokens that can be introduced by removals.
  updated = updated.replace(/\bOR(?:\s+OR)+\b/gi, "OR");
  updated = updated.replace(/\bor(?:\s+or)+\b/gi, "or");
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

  // If Phase 1 already resolved the query to a card name, don't also inject strategy
  // tags for the same keyword — "flicker" should be either the card OR the mechanic,
  // not both ANDed together (which would return only cards that both ARE named "Flicker"
  // AND carry flicker function tags).
  if (/\bname:/i.test(query)) {
    return query;
  }

  const queryLower = query.toLowerCase();
  const negated = new Set(detectNegatedStrategies(naturalQuery).map((entry) => entry.toLowerCase()));
  const missing = detected.filter((strategy) => {
    if (queryLower.includes(`strategy:${strategy.toLowerCase()}`)) return false;
    if (queryLower.includes(`-strategy:${strategy.toLowerCase()}`)) return false;
    // Don't re-append if the strategy's oracletags are already expanded in the query
    // (e.g. after a second finalizeScryfallQuery pass following invalid-tag removal)
    const canonicalName = resolveStrategyName(strategy) ?? strategy;
    const entry = STRATEGY_ORACLETAGS.find(
      (e) => e.strategy.toLowerCase() === canonicalName.toLowerCase()
    );
    if (entry && entry.oracletags.some((tag) => queryLower.includes(tag.toLowerCase()))) {
      return false;
    }
    return true;
  });

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
  normalizedQuery = normalizeInstantSorceryTypeChain(normalizedQuery);
  normalizedQuery = normalizeBurnIntent(naturalQuery, normalizedQuery, tagContext);
  normalizedQuery = normalizeArchetypeIntents(naturalQuery, normalizedQuery);
  normalizedQuery = normalizeTokenGenerationIntent(
    naturalQuery,
    normalizedQuery,
    tagContext
  );
  normalizedQuery = normalizeArtIntent(naturalQuery, normalizedQuery, tagContext);
  normalizedQuery = normalizeArtTagsToOrChain(normalizedQuery);
  normalizedQuery = normalizeBounceCounterspellOr(naturalQuery, normalizedQuery);
  normalizedQuery = quoteOracleTextPhrases(normalizedQuery);
  normalizedQuery = normalizeOrphanedOr(normalizedQuery);
  // normalizeEtbOracleText removed: the blanket o:"enters the battlefield" → o:"~ enters"
  // rewrite was incorrect for trigger queries (e.g. "whenever a creature enters or leaves").
  // Phase 1 now emits function:etb-other-creature directly for the other-ETB case.
  normalizedQuery = stripFranchiseCreatureTypeConfusion(
    naturalQuery,
    normalizedQuery
  );
  normalizedQuery = stripSubjectiveQualifierTags(naturalQuery, normalizedQuery);
  normalizedQuery = stripPlaygroupMetaOracleFilters(
    naturalQuery,
    normalizedQuery
  );
  normalizedQuery = stripColloquialComboOracleFilters(
    naturalQuery,
    normalizedQuery
  );
  normalizedQuery = normalizeLeadingStrayToken(normalizedQuery);
  normalizedQuery = dedupeTokens(normalizedQuery);
  // Second pass: dedupeTokens preserves "(", "or", ")" triples; strip empty (or) groups again.
  normalizedQuery = normalizeOrphanedOr(normalizedQuery);

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
