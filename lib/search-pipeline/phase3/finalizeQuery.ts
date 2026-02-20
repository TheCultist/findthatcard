import { applyCommanderContextFromNaturalQuery, hasCommanderDeckContext } from "@/lib/commander-context";
import { applyKeywordFiltersFromNaturalQuery } from "@/lib/mtg-keywords";
import { assembleQueryFromIR } from "@/lib/search-pipeline/assembleQuery";
import { Phase3Result, SearchPipelineIR } from "@/lib/search-pipeline/types";
import {
  EFFECTIVE_MAX_QUERY_LENGTH,
  PREFER_BEST_PREFIX,
  finalizeScryfallQuery,
  truncateScryfallQuery,
} from "@/lib/scryfall/query-converter";
import { applySetFiltersFromNaturalQuery } from "@/lib/scryfall/sets";
import { getTaggerTagContext } from "@/lib/tagger/context";
import { validateTaggerTags } from "@/lib/tagger/validation";

const DEFAULT_GAME_FILTER = "game:paper";

function applyDefaultGameFilter(query: string): string {
  const lower = query.toLowerCase();
  const hasGameFilter = /\b(game|in):(paper|arena|mtgo)\b/.test(lower);
  const hasDigitalFilter = /\b-?is:(digital|alchemy|rebalanced)\b/.test(lower);
  if (hasGameFilter || hasDigitalFilter) return query;
  return `${query} ${DEFAULT_GAME_FILTER}`.trim();
}

function ensureCommanderCreatureFilter(naturalQuery: string, scryfallQuery: string): string {
  if (hasCommanderDeckContext(naturalQuery)) return scryfallQuery;
  if (/\bis:commander\b/i.test(scryfallQuery)) return scryfallQuery;
  // "for commander"/"in commander" means format context, not commander creatures.
  if (/\b(for|in)\s+commander\b/i.test(naturalQuery)) return scryfallQuery;
  const wantsCommanderCreature =
    /\b(?:a|an|my)\s+(?:easy\s+)?commander\b|\bcommander\s+from\b|\bcommanders?\s+(?:from|in)\b|\bcan\s+be\s+commanders?\b/i.test(
      naturalQuery
    );
  if (!wantsCommanderCreature) return scryfallQuery;
  return `${scryfallQuery.trim()} is:commander`.trim();
}

function extractTokenTypesFromGenerationIntent(naturalQuery: string): string[] {
  const matched = new Set<string>();
  const query = naturalQuery.toLowerCase();

  const directGenerationPattern =
    /\b(?:make|create|generate|produce)(?:s|d|ing)?\s+(?:a|an|any|some|multiple|many|\d+)?\s*([a-z][a-z-]*)\s+tokens?\b/gi;
  let directMatch: RegExpExecArray | null;
  while ((directMatch = directGenerationPattern.exec(query)) !== null) {
    const tokenType = (directMatch[1] || "").trim();
    if (tokenType) {
      matched.add(tokenType);
    }
  }

  const makerPattern = /\b([a-z][a-z-]*)\s+token\s+(?:generation|maker|makers)\b/gi;
  let makerMatch: RegExpExecArray | null;
  while ((makerMatch = makerPattern.exec(query)) !== null) {
    const tokenType = (makerMatch[1] || "").trim();
    if (tokenType) {
      matched.add(tokenType);
    }
  }

  return Array.from(matched);
}

const DAMAGE_TARGET_TYPES = new Set(["creature", "planeswalker", "player", "battle"]);

function removeDamageTargetTypeFilters(
  naturalQuery: string,
  scryfallQuery: string
): string {
  const lower = naturalQuery.toLowerCase();
  const hasDamageIntent =
    /\b(direct damage|burn)\b/i.test(lower) ||
    /\bdeal[st]?\s+.*?\bdamage\b/i.test(lower) ||
    /\bdamage[sd]?\s+(?:target\s+)?(?:opponent|creature|player|planeswalker|battle|any|each)\b/i.test(lower) ||
    /\bthat\s+damage[sd]?\b/i.test(lower) ||
    /\bdamage[sd]?\s+(?:the|a|an|each|target)\b/i.test(lower);
  if (!hasDamageIntent) return scryfallQuery;

  let updated = scryfallQuery;
  for (const typeName of DAMAGE_TARGET_TYPES) {
    const mentionedAsTarget = new RegExp(
      `\\b(?:damage[sd]?|burn|deal[st]?)\\s+(?:target\\s+|the\\s+|a\\s+|an\\s+|each\\s+)?${typeName}s?\\b`,
      "i"
    ).test(lower);
    if (!mentionedAsTarget) continue;
    const typePattern = new RegExp(`\\s*\\b(?:t|type):${typeName}\\b`, "gi");
    updated = updated.replace(typePattern, " ");
  }

  return updated.replace(/\s{2,}/g, " ").trim();
}

type ArchetypeTypeSuppressionRule = {
  intentPattern: RegExp;
  targetPattern: RegExp;
  suppressType: string;
};

const ARCHETYPE_TYPE_SUPPRESSIONS: ArchetypeTypeSuppressionRule[] = [
  {
    intentPattern: /\b(removal|remove[sd]?|destroy[sd]?|exile[sd]?|kill\s+spells?)\b/i,
    targetPattern: /\bcreature\s+(?:removal|destroy|exile)|(?:removal|remove|destroy|exile|kill)\s+(?:target\s+|a\s+|the\s+)?creatures?\b/i,
    suppressType: "creature",
  },
  {
    intentPattern: /\b(removal|remove[sd]?|destroy[sd]?|exile[sd]?)\b/i,
    targetPattern: /\benchantment\s+(?:removal|destroy|exile)|(?:removal|remove|destroy|exile)\s+(?:target\s+|a\s+|the\s+)?enchantments?\b/i,
    suppressType: "enchantment",
  },
  {
    intentPattern: /\b(removal|remove[sd]?|destroy[sd]?|exile[sd]?)\b/i,
    targetPattern: /\bartifact\s+(?:removal|destroy|exile)|(?:removal|remove|destroy|exile)\s+(?:target\s+|a\s+|the\s+)?artifacts?\b/i,
    suppressType: "artifact",
  },
  {
    intentPattern: /\b(removal|remove[sd]?|destroy[sd]?|exile[sd]?)\b/i,
    targetPattern: /\bplaneswalker\s+(?:removal|destroy|exile)|(?:removal|remove|destroy|exile)\s+(?:target\s+|a\s+|the\s+)?planeswalkers?\b/i,
    suppressType: "planeswalker",
  },
  {
    intentPattern: /\b(removal|remove[sd]?|destroy[sd]?)\b/i,
    targetPattern: /\bland\s+(?:removal|destroy)|(?:removal|remove|destroy)\s+(?:target\s+|a\s+|the\s+)?lands?\b/i,
    suppressType: "land",
  },
  {
    intentPattern: /\b(reanimate|reanimation|graveyard\s+recursion)\b/i,
    targetPattern: /\b(?:reanimate|return)\s+(?:target\s+|a\s+|the\s+)?creatures?\s+(?:from|to)\b|\bcreature\s+reanima/i,
    suppressType: "creature",
  },
  {
    intentPattern: /\b(reanimate|reanimation|graveyard\s+recursion)\b/i,
    targetPattern: /\b(?:reanimate|return)\s+(?:target\s+|a\s+|the\s+)?artifacts?\s+(?:from|to)\b|\bartifact\s+reanima/i,
    suppressType: "artifact",
  },
];

function removeArchetypeTargetTypeFilters(
  naturalQuery: string,
  scryfallQuery: string
): string {
  const lower = naturalQuery.toLowerCase();
  let updated = scryfallQuery;

  for (const rule of ARCHETYPE_TYPE_SUPPRESSIONS) {
    if (!rule.intentPattern.test(lower)) continue;
    if (!rule.targetPattern.test(lower)) continue;
    const typePattern = new RegExp(`\\s*\\b(?:t|type):${rule.suppressType}\\b`, "gi");
    updated = updated.replace(typePattern, " ");
  }

  return updated.replace(/\s{2,}/g, " ").trim();
}

function removeTokenTypeFiltersForTokenGenerationIntent(
  naturalQuery: string,
  scryfallQuery: string
): string {
  const tokenTypes = extractTokenTypesFromGenerationIntent(naturalQuery);
  if (tokenTypes.length === 0) {
    return scryfallQuery;
  }

  let updated = scryfallQuery;
  for (const tokenType of tokenTypes) {
    const escaped = tokenType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    updated = updated.replace(
      new RegExp(`\\s+-?(?:t|type):${escaped}\\b`, "gi"),
      " "
    );
  }

  return updated.replace(/\s{2,}/g, " ").trim();
}

function stripPreferBestPrefix(value: string): string {
  return value.replace(/^prefer:best\s+/i, "").trim();
}

function prependPreferBest(value: string): string {
  if (/^prefer:best\s+/i.test(value)) return value;
  return `${PREFER_BEST_PREFIX}${value}`.trim();
}

function removeInvalidTagsFromQuery(
  query: string,
  invalidTags: Array<{ type: "art" | "function"; tag: string }>
): string {
  let updated = query;
  for (const invalid of invalidTags) {
    const operators = invalid.type === "art" ? "(?:art|atag|arttag)" : "(?:function|otag|oracletag)";
    const escapedTag = invalid.tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\s*-?${operators}:(?:"${escapedTag}"|${escapedTag})\\b`, "gi");
    updated = updated.replace(pattern, " ");
  }
  return updated.replace(/\s{2,}/g, " ").trim();
}

export async function finalizeQuery(ir: SearchPipelineIR): Promise<Phase3Result> {
  const baseQuery = assembleQueryFromIR(ir);
  if (!baseQuery) {
    throw new Error("Search pipeline produced an empty query");
  }

  const queryWithoutPrefer = stripPreferBestPrefix(baseQuery);
  const tagContext = await getTaggerTagContext(ir.naturalQuery);
  let query = finalizeScryfallQuery({
    naturalQuery: ir.naturalQuery,
    rawQuery: queryWithoutPrefer,
    tagContext,
    maxLength: EFFECTIVE_MAX_QUERY_LENGTH,
  });

  let invalidTags: Array<{ type: "art" | "function"; tag: string }> = [];

  if (ir.intent !== "direct-scryfall") {
    query = await applySetFiltersFromNaturalQuery(ir.naturalQuery, query);
    query = await applyKeywordFiltersFromNaturalQuery(ir.naturalQuery, query);
    query = applyCommanderContextFromNaturalQuery(ir.naturalQuery, query);
    query = ensureCommanderCreatureFilter(ir.naturalQuery, query);
    query = removeTokenTypeFiltersForTokenGenerationIntent(ir.naturalQuery, query);
    query = removeDamageTargetTypeFilters(ir.naturalQuery, query);
    query = removeArchetypeTargetTypeFilters(ir.naturalQuery, query);
    query = applyDefaultGameFilter(query);
    query = query.replace(/^\s*[iI]\s+/i, "").trim();

    invalidTags = await validateTaggerTags(query);
    if (invalidTags.length > 0) {
      query = removeInvalidTagsFromQuery(query, invalidTags);
      query = finalizeScryfallQuery({
        naturalQuery: ir.naturalQuery,
        rawQuery: query,
        tagContext,
        maxLength: EFFECTIVE_MAX_QUERY_LENGTH,
      });
    }
  }

  if (query.length > EFFECTIVE_MAX_QUERY_LENGTH) {
    query = truncateScryfallQuery(query, EFFECTIVE_MAX_QUERY_LENGTH);
  }

  const queryForScryfall = prependPreferBest(query);
  return {
    queryForScryfall,
    queryForLogs: query,
    removedInvalidTags: invalidTags.map((entry) => `${entry.type}:${entry.tag}`),
  };
}

