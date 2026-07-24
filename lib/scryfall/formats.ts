/**
 * Scryfall constructed-format allowlist + alias normalization.
 *
 * Single source of truth for extract prompt, buildIR validation, and
 * function:format → f:format rewrites in finalize.
 */

/** Canonical Scryfall `f:` / `format:` slugs. */
export const SCRYFALL_FORMATS = [
  "standard",
  "future",
  "historic",
  "timeless",
  "gladiator",
  "pioneer",
  "modern",
  "legacy",
  "pauper",
  "vintage",
  "penny",
  "commander",
  "oathbreaker",
  "standardbrawl",
  "brawl",
  "competitivebrawl",
  "alchemy",
  "paupercommander",
  "duel",
  "oldschool",
  "premodern",
  "predh",
  "tlr",
] as const;

export type ScryfallFormat = (typeof SCRYFALL_FORMATS)[number];

const FORMAT_SET = new Set<string>(SCRYFALL_FORMATS);

/** Compact list for the extraction prompt. */
export const SCRYFALL_FORMAT_PROMPT_LIST = SCRYFALL_FORMATS.join(", ");

/**
 * Natural-language / misspelled aliases → canonical Scryfall format slug.
 * Longer / more specific keys win via explicit multi-word checks first in
 * `normalizeFormatSlug`.
 */
const FORMAT_ALIASES: Record<string, ScryfallFormat> = {
  // Pauper Commander / PDH
  paupercommander: "paupercommander",
  pauperedh: "paupercommander",
  "pauper-edh": "paupercommander",
  "pauper edh": "paupercommander",
  "pauper commander": "paupercommander",
  pdh: "paupercommander",
  pedh: "paupercommander",
  paupermmander: "paupercommander", // common typo
  // Commander
  edh: "commander",
  // Penny
  "penny dreadful": "penny",
  pennydreadful: "penny",
  // Duel Commander
  "duel commander": "duel",
  duelcommander: "duel",
  // Old School
  "old school": "oldschool",
  "93/94": "oldschool",
  oldschool9394: "oldschool",
  // Future Standard
  "future standard": "future",
  futurestandard: "future",
  // Brawl variants
  "standard brawl": "standardbrawl",
  "competitive brawl": "competitivebrawl",
  // Tiny Leaders: Reborn
  "tiny leaders reborn": "tlr",
  "tiny leaders": "tlr",
  tinyleadersreborn: "tlr",
  tinyleaders: "tlr",
};

/**
 * Normalize a raw format string from the AI (or natural language) to a
 * canonical Scryfall slug, or null if unknown.
 */
export function normalizeFormatSlug(raw: string): ScryfallFormat | null {
  const trimmed = raw.trim().toLowerCase().replace(/[_]+/g, " ");
  if (!trimmed) return null;

  // Exact alias (spaces preserved)
  if (FORMAT_ALIASES[trimmed]) return FORMAT_ALIASES[trimmed];

  // Slug form: spaces/hyphens collapsed
  const slug = trimmed.replace(/[\s-]+/g, "").replace(/[^a-z0-9]/g, "");
  if (FORMAT_ALIASES[slug]) return FORMAT_ALIASES[slug];
  if (FORMAT_SET.has(slug)) return slug as ScryfallFormat;

  // Hyphenated slug that is already canonical (e.g. already in FORMAT_SET with hyphens — none today)
  const hyphenSlug = trimmed.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (FORMAT_SET.has(hyphenSlug)) return hyphenSlug as ScryfallFormat;
  if (FORMAT_ALIASES[hyphenSlug]) return FORMAT_ALIASES[hyphenSlug];

  return null;
}

/** True when the natural query (or existing Scryfall clause) refers to Pauper EDH / PDH. */
export function isPauperCommanderContext(naturalQuery: string, scryfallQuery = ""): boolean {
  const lower = naturalQuery.toLowerCase();
  if (
    /\bpauper\s*(?:edh|commander)\b/i.test(lower) ||
    /\bp(?:e)?dh\b/i.test(lower) ||
    /\bpaupercommander\b/i.test(lower) ||
    /\bpaupermmander\b/i.test(lower)
  ) {
    return true;
  }
  return /\bf:paupercommander\b/i.test(scryfallQuery);
}

/**
 * Formats that use a command-zone / leader card (commander-style constructed).
 * Subset of SCRYFALL_FORMATS.
 */
export const COMMANDER_FORMATS = [
  "commander",
  "oathbreaker",
  "standardbrawl",
  "brawl",
  "competitivebrawl",
  "paupercommander",
  "duel",
  "predh",
  "tlr",
] as const;

export type CommanderFormat = (typeof COMMANDER_FORMATS)[number];

/**
 * Scryfall `is:` flag for cards that can lead a deck in that commander format.
 * predh / tlr reuse is:commander; all brawl variants use is:brawler.
 */
export const COMMANDER_FORMAT_TO_ELIGIBLE_IS: Record<CommanderFormat, string> = {
  commander: "commander",
  predh: "commander",
  tlr: "commander",
  oathbreaker: "oathbreaker",
  standardbrawl: "brawler",
  brawl: "brawler",
  competitivebrawl: "brawler",
  paupercommander: "paupercommander",
  duel: "duelcommander",
};

/**
 * Distinct Scryfall commander-eligibility `is:` flags across all commander formats.
 * These already encode type/supertype constraints for that role, so pairing them with
 * t:creature / t:legendary is redundant and can wrongly exclude valid cards
 * (e.g. planeswalker commanders, uncommon PDH commanders that aren't legendary).
 */
export const COMMANDER_ELIGIBLE_IS_FLAGS = [
  ...new Set(Object.values(COMMANDER_FORMAT_TO_ELIGIBLE_IS)),
] as readonly string[];

const COMMANDER_ELIGIBLE_IS_RE = new RegExp(
  `\\bis:(?:${COMMANDER_ELIGIBLE_IS_FLAGS.map(escapeRegexLiteral).join("|")})\\b`,
  "i"
);

function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasCommanderEligibleFlag(query: string): boolean {
  return COMMANDER_ELIGIBLE_IS_RE.test(query);
}

/** Drop redundant t:creature / t:legendary when an is:commander-family flag is present. */
export function stripRedundantTypesForCommanderEligible(query: string): string {
  if (!hasCommanderEligibleFlag(query)) return query;
  return query
    .replace(/(^|\s)(?:t|type):(creature|legendary)\b/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
