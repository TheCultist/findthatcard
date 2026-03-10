import { applyCommanderContextFromNaturalQuery, hasCommanderDeckContext } from "@/lib/commander-context";
import { applyKeywordFiltersFromNaturalQuery } from "@/lib/mtg-keywords";
import { assembleQueryFromIR } from "@/lib/search-pipeline/assembleQuery";
import { Phase3Result, SearchPipelineIR } from "@/lib/search-pipeline/types";
import { getCatalog } from "@/lib/scryfall/catalogs";
import {
  EFFECTIVE_MAX_QUERY_LENGTH,
  PREFER_BEST_PREFIX,
  finalizeScryfallQuery,
  lookupArchetypeTags,
  truncateScryfallQuery,
} from "@/lib/scryfall/query-converter";
import { applySetFiltersFromNaturalQuery } from "@/lib/scryfall/sets";
import { getTaggerTagContext } from "@/lib/tagger/context";
import { validateTaggerTags } from "@/lib/tagger/validation";

const DEFAULT_GAME_FILTER = "game:paper";
const KNOWN_TYPE_CATALOGS = [
  "card-types",
  "supertypes",
  "artifact-types",
  "battle-types",
  "creature-types",
  "enchantment-types",
  "land-types",
  "planeswalker-types",
  "spell-types",
] as const;
const BASE_TYPE_FALLBACK = [
  "artifact",
  "battle",
  "creature",
  "enchantment",
  "instant",
  "kindred",
  "land",
  "planeswalker",
  "sorcery",
  "tribal",
  "conspiracy",
  "phenomenon",
  "plane",
  "scheme",
  "vanguard",
  "dungeon",
  "attraction",
  "sticker",
  "ongoing",
  "snow",
  "basic",
  "legendary",
  "world",
  "token",
];

let knownTypeTermsPromise: Promise<Set<string>> | null = null;

async function getKnownTypeTerms(): Promise<Set<string>> {
  if (!knownTypeTermsPromise) {
    knownTypeTermsPromise = (async () => {
      const terms = new Set<string>(BASE_TYPE_FALLBACK.map((v) => v.toLowerCase()));
      for (const catalog of KNOWN_TYPE_CATALOGS) {
        const values = await getCatalog(catalog);
        for (const value of values) {
          const normalized = value.toLowerCase().trim();
          if (normalized) terms.add(normalized);
        }
      }
      return terms;
    })();
  }
  return knownTypeTermsPromise;
}

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
  if (/\b(for|in)\s+commanders?\b/i.test(naturalQuery)) return scryfallQuery;
  const wantsCommanderCreature =
    /\b(?:a|an|my)\s+(?:easy\s+)?commander\b|\bcommander\s+from\b|\bcommanders?\s+(?:from|in)\b|\bcan\s+be\s+commanders?\b|\bcommanders\b/i.test(
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

async function removeUnknownTypeFilters(scryfallQuery: string): Promise<string> {
  const knownTypes = await getKnownTypeTerms();
  return scryfallQuery.replace(/(^|\s)-?(?:t|type):([a-z][a-z-]*)\b/gi, (full, leading, rawType) => {
    const normalized = String(rawType || "").toLowerCase().trim();
    if (!normalized || knownTypes.has(normalized)) {
      return full;
    }
    return leading || " ";
  }).replace(/\s{2,}/g, " ").trim();
}

function stripPreferBestPrefix(value: string): string {
  return value.replace(/^prefer:best\s+/i, "").trim();
}

function normalizeIdentityScopeInOrChains(query: string): string {
  const idPattern = /\bid(?:entity)?(?:<=|>=|=|:)\s*[wubrgc]{1,5}\b/gi;
  const idMatches = query.match(idPattern) || [];
  const hasOrChain = /\bOR\b/i.test(query) || /\bor\b/i.test(query);
  if (!hasOrChain || idMatches.length === 0) return query;

  const normalizedIds = Array.from(
    new Set(idMatches.map((m) => m.toLowerCase().replace(/\s+/g, "")))
  );
  let updated = query.replace(idPattern, " ").replace(/\s{2,}/g, " ").trim();
  if (normalizedIds.length === 1) {
    updated = `(${updated}) ${normalizedIds[0]}`.replace(/\s{2,}/g, " ").trim();
  }
  return updated;
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
  // Clean up orphaned OR operators left inside groups after tag removal:
  //   "(X or or Y)" → "(X or Y)"  (middle removal)
  //   "(X or )"     → "(X)"       (trailing or)
  //   "(or X)"      → "(X)"       (leading or)
  //   "(or)"        → ""          (empty group)
  updated = updated.replace(/\bor\s+or\b/gi, "or");
  updated = updated.replace(/\(\s*([^)]+?)\s+or\s*\)/gi, "($1)");
  updated = updated.replace(/\(\s*or\s+([^)]+)\)/gi, "($1)");
  updated = updated.replace(/\(\s*or\s*\)/gi, "");
  return updated.replace(/\s{2,}/g, " ").trim();
}

function injectArchetypeTagsFromResolvedFragments(
  ir: SearchPipelineIR,
  query: string
): string {
  let updated = query;

  // Iterate in original query order so OR-connected archetype fragments are merged
  // into a single OR chain rather than AND-ed together.
  let orGroupChains: string[][] = [];

  const flushArchetypeOrGroup = () => {
    if (orGroupChains.length === 0) return;
    const allTags = orGroupChains.flat();
    if (allTags.length === 1) {
      updated = `${updated} ${allTags[0]}`;
    } else {
      updated = `${updated} (${allTags.join(" or ")})`;
    }
    orGroupChains = [];
  };

  for (const unresolved of ir.unresolvedFragments) {
    const fragment = ir.resolvedFragments.find(
      (f) => f.archetype && f.fragment.toLowerCase() === unresolved.text.toLowerCase()
    );
    if (!fragment?.archetype) {
      if (!unresolved.orConnected) flushArchetypeOrGroup();
      continue;
    }
    const tags = lookupArchetypeTags(fragment.archetype, fragment.qualifier ?? undefined);
    if (!tags || tags.length === 0) {
      if (!unresolved.orConnected) flushArchetypeOrGroup();
      continue;
    }
    const orChain = tags.map((t) => `function:${t}`);
    if (unresolved.orConnected && orGroupChains.length > 0) {
      orGroupChains.push(orChain);
    } else {
      flushArchetypeOrGroup();
      orGroupChains.push(orChain);
    }
  }
  flushArchetypeOrGroup();

  return updated.replace(/\s{2,}/g, " ").trim();
}

export async function finalizeQuery(ir: SearchPipelineIR): Promise<Phase3Result> {
  const baseQuery = assembleQueryFromIR(ir);
  const queryWithoutPrefer = stripPreferBestPrefix(baseQuery);
  // Archetype-resolved Phase 2 fragments are injected here, not in assembleQueryFromIR,
  // so the emptiness check must come after injection — the base alone can be empty when
  // the entire query meaning comes from Phase 2 archetypes (e.g. "deal damage to any target").
  const withArchetypeTags = injectArchetypeTagsFromResolvedFragments(ir, queryWithoutPrefer);
  if (!withArchetypeTags) {
    throw new Error("Search pipeline produced an empty query");
  }
  const tagContext = await getTaggerTagContext(ir.naturalQuery);

  // For direct Scryfall syntax, use the query exactly as typed — no strategy expansion or other post-processing.
  let query: string;
  if (ir.intent === "direct-scryfall") {
    query = withArchetypeTags;
  } else {
    query = finalizeScryfallQuery({
      naturalQuery: ir.naturalQuery,
      rawQuery: withArchetypeTags,
      tagContext,
      maxLength: EFFECTIVE_MAX_QUERY_LENGTH,
    });
  }

  const isBypassIntent =
    ir.intent === "similar-cards" ||
    ir.intent === "art-like-cards" ||
    ir.intent === "synergy-with-card";

  if (ir.intent !== "direct-scryfall") {
    // For bypass intents (similar-cards, art-like, synergy), Phase 1 already ran
    // set detection with bypass-word exclusions, so skip Phase 3's second pass.
    // Without this, card names like "Sheoldred, the Apocalypse" would cause
    // "Apocalypse" to be re-detected as set:apc here.
    if (!isBypassIntent) {
      query = await applySetFiltersFromNaturalQuery(ir.naturalQuery, query);
    }
    query = await applyKeywordFiltersFromNaturalQuery(ir.naturalQuery, query);
    query = applyCommanderContextFromNaturalQuery(ir.naturalQuery, query);
    query = ensureCommanderCreatureFilter(ir.naturalQuery, query);
    query = removeTokenTypeFiltersForTokenGenerationIntent(ir.naturalQuery, query);
    query = removeDamageTargetTypeFilters(ir.naturalQuery, query);
    query = removeArchetypeTargetTypeFilters(ir.naturalQuery, query);
    query = await removeUnknownTypeFilters(query);
    query = applyDefaultGameFilter(query);
    query = query.replace(/^\s*[iI]\s+/i, "").trim();

  }

  let invalidTags: Array<{ type: "art" | "function"; tag: string }> = [];
  if (ir.intent !== "direct-scryfall") {
    query = normalizeIdentityScopeInOrChains(query);
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

    if (query.length > EFFECTIVE_MAX_QUERY_LENGTH) {
      query = truncateScryfallQuery(query, EFFECTIVE_MAX_QUERY_LENGTH);
    }
  }

  const queryForScryfall = prependPreferBest(query);
  return {
    queryForScryfall,
    queryForLogs: query,
    removedInvalidTags: invalidTags.map((entry) => `${entry.type}:${entry.tag}`),
  };
}

