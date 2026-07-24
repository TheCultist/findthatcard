import { applyCommanderContextFromNaturalQuery, hasCommanderDeckContext } from "@/lib/commander-context";
import { applyKeywordFiltersFromNaturalQuery } from "@/lib/mtg-keywords";
import { assembleQueryFromIR } from "@/lib/search-pipeline/assembleQuery";
import { Phase3Result, SearchPipelineIR } from "@/lib/search-pipeline/types";
import { getCatalog } from "@/lib/scryfall/catalogs";
import { isPauperCommanderContext, stripRedundantTypesForCommanderEligible } from "@/lib/scryfall/formats";
import {
  EFFECTIVE_MAX_QUERY_LENGTH,
  OPPONENT_BURN_DAMAGE_FUNCTION_TAGS,
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
  if (/\bis:paupercommander\b/i.test(scryfallQuery)) return scryfallQuery;
  if (/\bis:commander\b/i.test(scryfallQuery)) return scryfallQuery;
  // "for commander"/"in commander" means format context, not commander creatures.
  if (/\b(for|in)\s+commanders?\b/i.test(naturalQuery)) return scryfallQuery;
  // Commander mechanic phrases don't mean "find commander creatures".
  if (/\bcommander[''s]*\s+(?:tax|damage|ninjutsu|eminence|storm)\b/i.test(naturalQuery)) return scryfallQuery;
  // Ignore "pauper commander" / PDH format phrasing when detecting commander eligibility.
  const withoutPdhFormat = naturalQuery
    .replace(/\bpauper\s*(?:edh|commander)\b/gi, " ")
    .replace(/\bp(?:e)?dh\b/gi, " ")
    .replace(/\bpaupercommander\b/gi, " ")
    .replace(/\bpaupermmander\b/gi, " ");
  const wantsCommanderCreature =
    /\b(?:a|an|my)\s+(?:easy\s+)?commander\b|\bcommander\s+from\b|\bcommanders?\s+(?:from|in)\b|\bcan\s+be\s+commanders?\b|\bcommanders\b/i.test(
      withoutPdhFormat
    );
  if (!wantsCommanderCreature) return scryfallQuery;
  // PDH commanders use is:paupercommander, not is:commander.
  if (isPauperCommanderContext(naturalQuery, scryfallQuery)) {
    return `${scryfallQuery.trim()} is:paupercommander`.trim();
  }
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

let planeswalkerSubtypeSetPromise: Promise<Set<string>> | null = null;

async function getPlaneswalkerSubtypeSet(): Promise<Set<string>> {
  if (!planeswalkerSubtypeSetPromise) {
    planeswalkerSubtypeSetPromise = (async () => {
      const values = await getCatalog("planeswalker-types");
      return new Set(values.map((v) => v.toLowerCase().trim()).filter(Boolean));
    })();
  }
  return planeswalkerSubtypeSetPromise;
}

/**
 * True when the query requires creature-type cards (positive t:creature / type:creature).
 * Negated -t:creature is ignored — that branch is "not creatures", not a creature search.
 */
function hasPositiveCreatureTypeFilter(query: string): boolean {
  const re = /(^|[\s(])(?:t|type):creature\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const tIdx = m.index + m[1].length;
    if (tIdx > 0 && query[tIdx - 1] === "-") continue;
    return true;
  }
  return false;
}

/**
 * Phase 2 can emit t:<planeswalker subtype> (e.g. t:dack) from noisy fragments. Combined with
 * t:creature from Phase 1, Scryfall returns 0 hits — no card is both a creature and a
 * planeswalker subtype. Strip PW-only subtypes when a positive creature filter is present.
 */
async function stripPlaneswalkerSubtypesWhenCreatureRequired(
  scryfallQuery: string
): Promise<string> {
  if (!hasPositiveCreatureTypeFilter(scryfallQuery)) return scryfallQuery;

  const pwSubtypes = await getPlaneswalkerSubtypeSet();
  let result = scryfallQuery;
  for (const pw of pwSubtypes) {
    if (pw.length < 2) continue;
    const escaped = pw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(
      new RegExp(`\\s*\\b(?:t|type):${escaped}\\b`, "gi"),
      " "
    );
  }
  return result.replace(/\s{2,}/g, " ").trim();
}

/**
 * True when the Scryfall query already constrains mana value (mv/cmc comparisons).
 * Used by {@link stripMvBoundRedundantFunctionTags} — not every redundant tag needs an mv bound;
 * each rule decides when it applies.
 */
function hasManaValueComparisonInQuery(scryfallQuery: string): boolean {
  return /\b(?:mv|cmc)(?:<=|>=|<|>|=)\s*\d+\b/i.test(scryfallQuery);
}

/**
 * Phase 2 sometimes maps colloquial words to Tagger function tags whose *meaning* overlaps
 * what Phase 1 already expressed as `mv`/`cmc` bounds. Stripping blindly would break queries
 * where the user actually asked for that mechanical axis — each rule carries an
 * "explicit intent" predicate as a safeguard.
 *
 * Add a row here when QA finds another `function:*` that collides with mv/cmc filters;
 * keep one-off hacks out of the resolver.
 */
type MvBoundRedundantFunctionTagRule = {
  /** Slug after `function:` (e.g. `cheaper-than-mv`). */
  tag: string;
  /** If true, keep the tag even when an mv/cmc bound is present. */
  userExplicitlyWantsFeature: (naturalQuery: string) => boolean;
};

/**
 * User explicitly wants the Tagger "cheaper than MV" mechanic (pay less than printed
 * mana value / cost reduction), not colloquial "cheap" meaning low mana cost.
 *
 * When this is true, we must NOT strip function:cheaper-than-mv even if mv<= is present.
 */
function explicitlyWantsCheaperThanMvMechanic(naturalQuery: string): boolean {
  const q = naturalQuery.toLowerCase();
  // Colloquial "under N mana" — NOT the mechanic (do not preserve the tag for this).
  if (/\bcheaper\s+than\s+\d+\s*(?:mana|mv|cmc)?\b/i.test(q)) {
    return false;
  }
  // Possessor + "mana" must allow a space ("their mana value", not "theirmana").
  const poss = "(?:its|their|the|my)";
  const manaMvCmc = "(?:mana\\s+value|converted\\s+mana(?:\\s+cost)?|mana\\s+cost|mv|cmc)";
  return (
    new RegExp(`\\bcheaper\\s+than\\s+${poss}\\s+${manaMvCmc}\\b`, "i").test(q) ||
    /\bcheaper\s+than\s+mv\b/i.test(q) ||
    new RegExp(`\\bpay\\s+less\\s+than\\s+${poss}\\s+${manaMvCmc}\\b`, "i").test(q) ||
    new RegExp(`\\bcost(?:s|ing)?\\s+less\\s+than\\s+${poss}\\s+${manaMvCmc}\\b`, "i").test(q) ||
    new RegExp(`\\bcast\\s+for\\s+less\\s+than\\s+${poss}\\s+${manaMvCmc}\\b`, "i").test(q) ||
    new RegExp(
      `\\bcards?\\s+that\\s+cost\\s+less\\s+than\\s+${poss}\\s+${manaMvCmc}\\b`,
      "i"
    ).test(q) ||
    /\bspells?\s+that\s+cost\s+less\s+than\s+(?:their|its|the|my)\b/i.test(q) ||
    /\bcost\s+reduction\b/i.test(q) ||
    /\breduces?\s+(?:the\s+)?(?:mana\s+)?cost\s+(?:of|to|for)\b/i.test(q) ||
    /\balternate\s+cost\b/i.test(q) ||
    /\bproportional\s+discount\b/i.test(q)
  );
}

const MV_BOUND_REDUNDANT_FUNCTION_TAG_RULES: MvBoundRedundantFunctionTagRule[] = [
  {
    tag: "cheaper-than-mv",
    userExplicitlyWantsFeature: explicitlyWantsCheaperThanMvMechanic,
  },
];

function stripMvBoundRedundantFunctionTags(
  naturalQuery: string,
  scryfallQuery: string
): string {
  if (!hasManaValueComparisonInQuery(scryfallQuery)) return scryfallQuery;

  let result = scryfallQuery;
  for (const rule of MV_BOUND_REDUNDANT_FUNCTION_TAG_RULES) {
    const escaped = rule.tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`\\bfunction:${escaped}\\b`, "i").test(result)) continue;
    if (rule.userExplicitlyWantsFeature(naturalQuery)) continue;
    result = result
      .replace(new RegExp(`\\s*\\bfunction:${escaped}\\b`, "gi"), " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return result;
}

/**
 * OGW **Support** keyword (`kw:support`) vs colloquial "support cards" / "tribal support"
 * (deck role). Phase 2 often mis-emit kw:support; combined with f:commander + function
 * OR-chains it can yield **zero** Scryfall hits.
 */
function explicitlyWantsSupportKeywordMechanic(naturalQuery: string): boolean {
  const q = naturalQuery.toLowerCase();
  return (
    /\bsupport\s+\d+\b/.test(q) ||
    /\bsupport\s+keyword\b/.test(q) ||
    /\bkeyword\s+support\b/.test(q) ||
    /\bmechanic\s+support\b/.test(q) ||
    /\bogw\s+support\b/.test(q)
  );
}

function isDeckbuildingSupportColloquialism(naturalQuery: string): boolean {
  const q = naturalQuery.toLowerCase();
  return (
    /\bsupport\s+cards?\b/.test(q) ||
    /\b(?:tribal|deck|archetype|commander)\s+support\b/.test(q) ||
    /\bsupport\s+pieces?\b/.test(q) ||
    /\bsupport\s+for\s+(?:a|an|my|the)\s+/i.test(q)
  );
}

function stripMisleadingKwSupportForDeckbuilding(
  naturalQuery: string,
  scryfallQuery: string
): string {
  if (!/\bkw:support\b/i.test(scryfallQuery)) return scryfallQuery;
  if (explicitlyWantsSupportKeywordMechanic(naturalQuery)) return scryfallQuery;
  if (!isDeckbuildingSupportColloquialism(naturalQuery)) return scryfallQuery;
  return scryfallQuery
    .replace(/\s*\bkw:support\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Phase 2 often maps "ping all opponents when [noncreature] spell" to archetype **group-slug**,
 * which drops the spell-cast condition. Replace with **function:** tags + spell-type oracle
 * (see {@link normalizeSpellCastPingOpponentsOracle}).
 */
function wantsSpellCastNoncreatureDamageOpponents(naturalQuery: string): boolean {
  const q = naturalQuery.toLowerCase();
  const hasSpellCast =
    /\bspell\s+is\s+played\b/.test(q) ||
    /\bspell\s+is\s+cast\b/.test(q) ||
    /\bwhen(?:ever)?\s+you\s+cast\b/.test(q) ||
    /\bwhen(?:ever)?\s+a\s+noncreature\s+spell\b/.test(q);
  const hasNoncreature =
    /\bnoncreature\s+spell\b/.test(q) || /\binstant\s+or\s+sorcery\b/.test(q);
  const hasOpponentDamage =
    /\b(?:ping|pings|pinging)\b/.test(q) ||
    /\bdeal[st]?\s+[^\n]{0,40}\bdamage\b/i.test(q) ||
    /\bdamage\b[^\n]{0,40}\bopponents?\b/i.test(q);
  // Include common typo "oponents" (missing first p) — Phase 0 may not always run in tests.
  const hasOpponents =
    /\b(?:all\s+)?opponents?\b/.test(q) ||
    /\boponents?\b/.test(q) ||
    /\beach\s+opponent\b/.test(q);
  return hasSpellCast && hasNoncreature && hasOpponentDamage && hasOpponents;
}

/**
 * When the user asks for "permanents", add is:permanent. Guards skip game-object uses
 * of "permanent" (target permanent, each permanent, reanimate permanents, etc.) and
 * cases where a more specific type filter is already present.
 */
function injectPermanentTypeFilter(naturalQuery: string, query: string): string {
  const q = naturalQuery.toLowerCase();
  if (!/\bpermanents?\b/.test(q)) return query;
  // Already filtered to a specific permanent subtype — adding -instant/-sorcery is redundant
  if (/\b(?:t|type):(?:creature|artifact|enchantment|land|planeswalker|battle)\b/i.test(query)) return query;
  // Already has the filter
  if (/\bis:permanent\b/i.test(query)) return query;
  // "non-permanent" or "permanent" used as an adjective meaning "lasting"
  if (/\bnon-?permanent\b/i.test(q)) return query;
  if (/\bpermanents?\s+(?:counter|bonus|boost|buff|effect|aura)\b/i.test(q)) return query;
  // Game-object references: "target permanent", "a permanent dies", "each permanent", etc.
  if (/\b(?:target|each|every|any|a|an|another)\s+permanents?\b/i.test(q)) return query;
  if (/\bwhen(?:ever)?\s+(?:a\s+|an\s+|each\s+|the\s+)?permanents?\b/i.test(q)) return query;
  // Action-verb objects: "reanimate permanents", "exile permanents", etc.
  if (
    /\b(?:reanimate[sd]?|return(?:s|ed|ing)?|exile[sd]?|destroy(?:s|ed|ing)?|sacrifice[sd]?|bounce[sd]?|blink[sd]?|kill[sd]?|remove[sd]?|copies?)\s+(?:\w+\s+){0,3}permanents?\b/i.test(
      q
    )
  )
    return query;
  return `${query} is:permanent`.replace(/\s{2,}/g, " ").trim();
}

/**
 * When the user asks for permanents that create tokens on a spell-cast trigger
 * (e.g., "whenever you cast a spell, create a token"), Phase 2 classifies the
 * fragment as archetype:tokens but drops the cast-trigger condition because the
 * archetype rule suppresses extra tags. Inject function:cast-trigger-you here
 * when the assembled query already has token-generation archetype tags and the
 * natural query clearly expresses a cast trigger.
 */
function injectCastTriggerTagForTokenSpellCreation(
  naturalQuery: string,
  query: string
): string {
  const q = naturalQuery.toLowerCase();
  const hasCastTrigger =
    /\bwhen(?:ever)?\s+(?:i\s+|you\s+)?cast\b/.test(q) ||
    /\beach\s+(?:time\s+)?(?:you\s+)?cast\b/.test(q) ||
    /\bon\s+(?:each\s+)?cast\b/.test(q);
  if (!hasCastTrigger) return query;
  if (/\bfunction:cast-trigger-you\b/i.test(query)) return query;
  // Only inject when a token-generation archetype tag is already present —
  // prevents adding the cast tag to unrelated queries that mention "cast".
  const hasTokenFunctionTag =
    /\bfunction:(?:repeatable-token-generator|repeatable-creature-tokens|young-pyromancer-ability)\b/i.test(
      query
    );
  if (!hasTokenFunctionTag) return query;
  return `${query} function:cast-trigger-you`.replace(/\s{2,}/g, " ").trim();
}

/**
 * "destroy/exile/kill creatures WITH [keyword]" — the keyword qualifies the
 * TARGET, not the card being searched.  Phase 1 (frozen) always emits kw:X for
 * any MTG keyword it encounters; combined with removal function tags that
 * yields results that ARE flyers with destroy-text rather than spells that
 * destroy flyers.  Detect the pattern and demote kw:X → o:X so Scryfall
 * matches oracle text (e.g. "Destroy target creature with flying.") instead.
 *
 * Only fires when:
 *  – at least one removal function tag is present (the card IS removal)
 *  – the natural query contains "[remove-verb] creatures with [keyword]"
 *  – a matching kw:[keyword] exists in the assembled query
 */
/**
 * "whenever you cast an instant or sorcery spell" — the user is quoting a
 * triggered-ability condition, not asking for instants/sorceries themselves.
 *
 * Phase 1 (frozen) sees "instant or sorcery" and emits (t:instant or t:sorcery).
 * Phase 2 resolves the "whenever you cast" fragment but OR-joins it with o:spell,
 * which matches millions of cards.
 *
 * When the natural query IS a "whenever you cast [types]" trigger condition:
 *   – remove the misapplied spell-type filters (they are not card-type constraints)
 *   – replace the vague Phase-2 oracle clause with the precise trigger phrase
 */
function normalizeWheneverCastTrigger(
  naturalQuery: string,
  scryfallQuery: string
): string {
  const q = naturalQuery.toLowerCase().trim();
  if (!/\bwhenever\s+you\s+cast\b/.test(q)) return scryfallQuery;

  // Skip if the user is filtering the SOURCE card's type ("creatures with whenever you cast").
  if (/\b(?:creatures?|artifacts?|enchantments?|permanents?)\s+(?:with|that|which)\b/i.test(q)) {
    return scryfallQuery;
  }

  // Extract the trigger object, e.g. "an instant or sorcery spell" / "a noncreature spell"
  const castMatch = q.match(/\bwhenever\s+you\s+cast\s+([\s\S]+?)(?:\s*[,.]|$)/);
  const castObject = castMatch ? castMatch[1].trim() : null;

  let updated = scryfallQuery;

  // Remove spell-type filters that were emitted for the TRIGGER's types, not the card.
  const SPELL_TYPES = ["instant", "sorcery", "creature", "artifact", "enchantment", "land", "planeswalker"];
  for (const type of SPELL_TYPES) {
    // Only remove when the natural query mentions this type as part of the cast condition.
    const inCastCondition = new RegExp(
      `\\bwhenever\\s+you\\s+cast[^.]*\\b${type}\\b`
    ).test(q);
    if (!inCastCondition) continue;
    // Remove grouped "(t:X or t:Y)" or bare "t:X".
    updated = updated.replace(new RegExp(`\\s*\\(\\s*(?:t|type):${type}[^)]*\\)`, "gi"), " ");
    updated = updated.replace(new RegExp(`\\s*\\(?\\s*(?:t|type):${type}\\b[^)]*\\)?`, "gi"), " ");
  }

  // Remove the vague Phase-2 oracle clause: (o:"whenever you cast" or o:spell)
  updated = updated
    .replace(/\(\s*o:"whenever you cast"\s+or\s+o:spell\s*\)/gi, " ")
    .replace(/o:"whenever you cast"\s+or\s+o:spell/gi, " ")
    .replace(/\bo:spell\b/gi, " ");

  // Inject the precise oracle phrase.
  if (castObject) {
    const oraclePhrase = `whenever you cast ${castObject}`;
    const oracleTag = `o:"${oraclePhrase}"`;
    if (!updated.includes(oracleTag)) {
      updated = `${updated} ${oracleTag}`.trim();
    }
  } else if (!/o:"whenever you cast/i.test(updated)) {
    updated = `${updated} o:"whenever you cast"`.trim();
  }

  return updated.replace(/\s{2,}/g, " ").trim();
}

function demoteRemovalTargetKeyword(
  naturalQuery: string,
  scryfallQuery: string
): string {
  if (!/\bfunction:(?:removal[\w-]*|spot-removal)\b/i.test(scryfallQuery)) return scryfallQuery;
  if (!/\bkw:\w/i.test(scryfallQuery)) return scryfallQuery;

  // Matches "[remove-verb] ... creatures with [keyword]"
  // The lookahead up to 60 chars lets intervening words like "all" or "target" pass through.
  const REMOVAL_TARGET_KW_RE =
    /\b(?:destroy|exile|remove|kill|eliminate|counter|bounce|fight)\b[\s\S]{0,60}?\bcreatures?\s+with\s+([\w]+(?:\s+[\w]+)?)\b/i;
  const m = REMOVAL_TARGET_KW_RE.exec(naturalQuery);
  if (!m) return scryfallQuery;

  // Only use the first token (keywords like "first strike" are two words; kw: would have
  // been emitted as kw:first or kw:"first strike" — handling single-token covers 95% of cases).
  const kwToken = m[1].trim().toLowerCase().split(/\s+/)[0];
  const escaped = kwToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const kwRe = new RegExp(`\\bkw:${escaped}\\b`, "gi");
  if (!kwRe.test(scryfallQuery)) return scryfallQuery;

  return scryfallQuery
    .replace(kwRe, `o:${kwToken}`)
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripMisleadingGroupSlugForSpellCastTriggers(
  naturalQuery: string,
  scryfallQuery: string
): string {
  if (!/\bfunction:group-slug\b/i.test(scryfallQuery)) return scryfallQuery;
  if (!wantsSpellCastNoncreatureDamageOpponents(naturalQuery)) return scryfallQuery;

  return scryfallQuery
    .replace(/\s*\bfunction:group-slug\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Precompiled: any opponent-burn family tag present (see {@link OPPONENT_BURN_DAMAGE_FUNCTION_TAGS}). */
const OPPONENT_BURN_TAG_PATTERN = new RegExp(
  `\\bfunction:(?:${OPPONENT_BURN_DAMAGE_FUNCTION_TAGS.join("|")})\\b`,
  "i"
);

function hasOpponentBurnFunctionTag(query: string): boolean {
  return OPPONENT_BURN_TAG_PATTERN.test(query);
}

/**
 * Prefer Tagger **function:** tags over oracle for cast + damage-to-opponents; keep **only**
 * spell-type oracle (`noncreature spell` vs `instant or sorcery`) where Tagger has no exact
 * substitute. `function:cast-trigger-you` covers "whenever you cast" phrasing; opponent burn
 * tags cover damage / each opponent (oracle `o:damage` + `o:"each opponent"` are redundant
 * once burn tags are present — see normalizeBurnIntent).
 */
function normalizeSpellCastPingOpponentsOracle(
  naturalQuery: string,
  scryfallQuery: string
): string {
  if (!wantsSpellCastNoncreatureDamageOpponents(naturalQuery)) return scryfallQuery;

  const useNoncreatureSpellOracle = /\bnoncreature\s+spell\b/i.test(naturalQuery);

  let q = scryfallQuery
    .replace(/\s*\bo:opponent\b/gi, " ")
    // Drop oracle anchors superseded by function tags (may come from Phase 2).
    .replace(/\s*\bo:damage\b/gi, " ")
    .replace(/\s*o:"each opponent"/gi, " ")
    .replace(/\s*o:"whenever you cast"/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (useNoncreatureSpellOracle) {
    q = q.replace(/\s*o:"instant or sorcery"/gi, " ").replace(/\s{2,}/g, " ").trim();
  }

  const spellTypeToken = useNoncreatureSpellOracle
    ? 'o:"noncreature spell"'
    : 'o:"instant or sorcery"';

  if (
    spellTypeToken === 'o:"noncreature spell"'
      ? !/o:"noncreature spell"/i.test(q)
      : !/o:"instant or sorcery"/i.test(q)
  ) {
    q = `${q} ${spellTypeToken}`.trim();
  }

  if (!/\bfunction:cast-trigger-you\b/i.test(q)) {
    q = `${q} function:cast-trigger-you`.trim();
  }

  if (!hasOpponentBurnFunctionTag(q)) {
    const orChain = OPPONENT_BURN_DAMAGE_FUNCTION_TAGS.map((t) => `function:${t}`).join(" or ");
    q = `${q} (${orChain})`.trim();
  }

  return q.replace(/\s{2,}/g, " ").trim();
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

export function removeInvalidTagsFromQuery(
  query: string,
  invalidTags: Array<{ type: "art" | "function"; tag: string }>
): string {
  let updated = query;
  for (const invalid of invalidTags) {
    const operators = invalid.type === "art" ? "(?:art|atag|arttag)" : "(?:function|otag|oracletag)";
    const escapedTag = invalid.tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Require a true token boundary: do not match `function:storm` inside `function:storm-like`
    // when stripping a shorter invalid tag like `storm`.
    const pattern = new RegExp(
      `\\s*-?${operators}:(?:"${escapedTag}"|${escapedTag})(?![a-z0-9-])\\b`,
      "gi"
    );
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
      // Unknown archetype — fall back to emitting the fragment's raw tags so
      // they're not silently dropped (the assembler skips archetype-flagged
      // fragments, expecting this injector to handle them).
      if (fragment.tags.length > 0) {
        const rawChain = fragment.tags.filter((t) => t.trim().length > 0);
        if (rawChain.length > 0) {
          if (unresolved.orConnected && orGroupChains.length > 0) {
            orGroupChains.push(rawChain);
          } else {
            flushArchetypeOrGroup();
            orGroupChains.push(rawChain);
          }
          continue;
        }
      }
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

    // Extra tags from Phase 2 (e.g. function:cast-trigger-you alongside archetype:tokens)
    // are AND conditions that narrow the archetype — append them directly after flushing.
    // Strip any t:/type: tags — card-type filters must never come from Phase 2.
    const extraTags = fragment.tags.filter(
      (t) => t.trim().length > 0 && !/^(?:t|type):/i.test(t)
    );
    if (extraTags.length > 0 && !unresolved.orConnected) {
      flushArchetypeOrGroup();
      for (const tag of extraTags) {
        updated = `${updated} ${tag}`;
      }
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
  let withArchetypeTags = injectArchetypeTagsFromResolvedFragments(ir, queryWithoutPrefer);

  // "set in/on [plane]" fix: when Phase 1 already produced set: filters for a plane name,
  // function:shares-name-with-a-set is always wrong — that tag means the card's name literally
  // contains a set name, which is unrelated to lore-location queries like "cards set on Ravnica".
  if (/function:shares-name-with-a-set/.test(withArchetypeTags) && /\bset:[a-z0-9]+/i.test(withArchetypeTags)) {
    withArchetypeTags = withArchetypeTags
      .replace(/function:shares-name-with-a-set/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // "cards set on/in [plane]" → art:[plane]
  // "Set on" / "set in" means the card's story takes place there, which is best expressed as
  // an art search. Phase 2 sees the bare plane name fragment and resolves it to o:[plane];
  // replace that with art:[plane] which matches cards whose art depicts that location.
  const SET_LOCATION_RE = /\bset\s+(?:on|in|at|within)\s+([a-z]+(?:\s+[a-z]+)?)\b/i;
  const setLocationMatch = SET_LOCATION_RE.exec(ir.naturalQuery);
  if (setLocationMatch) {
    const plane = setLocationMatch[1].trim().toLowerCase();
    // Replace the first word of the plane name (e.g. "ravnica" from "ravnica the city of guilds")
    const planeFirstWord = plane.split(/\s+/)[0];
    withArchetypeTags = withArchetypeTags
      .replace(new RegExp(`\\bo:${planeFirstWord}\\b`, "i"), `art:${planeFirstWord}`)
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // Medallion/Monument-style fix: "discounts blue spells/creatures" means the card reduces
  // casting costs for spells of that colour — not a self-discount and not a colour-identity filter.
  // Phase 1 (frozen) emits id:[letter] from the colour word; Phase 2 emits function:discount-self.
  // Map to oracle text matching actual card wording (e.g. Sapphire Medallion, Kefnet's Monument).
  const MEDALLION_RE =
    /discount(?:s|ing)?\s+(?:the\s+cost\s+of\s+)?(white|blue|black|red|green)\s+(creature|instant|sorcery|sorceries|spell)/i;
  const medallionMatch = MEDALLION_RE.exec(ir.naturalQuery);
  if (medallionMatch) {
    const colorName = medallionMatch[1].toLowerCase();
    const colorLetter = { white: "w", blue: "u", black: "b", red: "r", green: "g" }[colorName]!;
    const colorCap = colorName[0].toUpperCase() + colorName.slice(1);
    const spellType = medallionMatch[2].toLowerCase();
    // "creature" → "creature spells"; "spell/sorcery/instant" → "[Color] spells"
    const oracleSubject =
      spellType === "creature" ? `${colorCap} creature spells` : `${colorCap} spells`;
    withArchetypeTags = withArchetypeTags
      .replace(new RegExp(`\\bid:${colorLetter}\\b`, "i"), "")
      .replace(/function:discount-self/g, `o:"${oracleSubject}" o:"less to cast"`)
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  if (!withArchetypeTags) {
    // Last-resort fallback: assemble o: oracle terms from any unresolved fragment text
    // so the pipeline never crashes with an empty query. This handles cases where
    // Phase 2 returns an archetype that isn't in the registry and no raw tags were provided.
    const oracleTerms = ir.unresolvedFragments
      .flatMap((f) => f.text.toLowerCase().split(/\s+/))
      .filter((w) => w.length >= 3 && !/^\d+$/.test(w))
      .slice(0, 4)
      .map((w) => `o:${w}`);
    if (oracleTerms.length > 0) {
      withArchetypeTags = oracleTerms.join(" ");
      console.warn(`[Phase3] Empty query fallback for "${ir.naturalQuery}" → ${withArchetypeTags}`);
    } else {
      throw new Error("Search pipeline produced an empty query");
    }
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
    // ensureCommander may add is:commander after finalizeScryfallQuery — strip again.
    query = stripRedundantTypesForCommanderEligible(query);
    query = removeTokenTypeFiltersForTokenGenerationIntent(ir.naturalQuery, query);
    query = removeDamageTargetTypeFilters(ir.naturalQuery, query);
    query = removeArchetypeTargetTypeFilters(ir.naturalQuery, query);
    query = await removeUnknownTypeFilters(query);
    query = await stripPlaneswalkerSubtypesWhenCreatureRequired(query);
    query = stripMvBoundRedundantFunctionTags(ir.naturalQuery, query);
    query = stripMisleadingKwSupportForDeckbuilding(ir.naturalQuery, query);
    query = normalizeWheneverCastTrigger(ir.naturalQuery, query);
    query = demoteRemovalTargetKeyword(ir.naturalQuery, query);
    query = stripMisleadingGroupSlugForSpellCastTriggers(ir.naturalQuery, query);
    query = normalizeSpellCastPingOpponentsOracle(ir.naturalQuery, query);
    query = injectCastTriggerTagForTokenSpellCreation(ir.naturalQuery, query);
    query = injectPermanentTypeFilter(ir.naturalQuery, query);
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

