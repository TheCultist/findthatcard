/**
 * Shared constants for Phase 1 NLP parsing.
 *
 * FROZEN — do not add new entries here. New colloquial phrasings belong in the
 * Phase 1.5 structured-extraction prompt, not in deterministic constant lists.
 */

export const FORMAT_TOKENS = [
  "standard",
  "modern",
  "legacy",
  "vintage",
  "pioneer",
  "pauper",
  "commander",
  "brawl",
] as const;

export const TYPE_TOKENS = [
  "creature",
  "artifact",
  "enchantment",
  "instant",
  "sorcery",
  "planeswalker",
  "land",
  "battle",
] as const;

/** Maps color names (including guild/shard/wedge/nephilim names) to WUBRG strings. */
export const COLOR_IDENTITY: Record<string, string> = {
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
  "yore-tiller": "wubr",
  breya: "wubr",
  "non-green": "wubr",
  nongreen: "wubr",
  "witch-maw": "wubg",
  atraxa: "wubg",
  "non-red": "wubg",
  nonred: "wubg",
  "dune-brood": "wbrg",
  saskia: "wbrg",
  "non-blue": "wbrg",
  nonblue: "wbrg",
  "glint-eye": "ubrg",
  yidris: "ubrg",
  "non-white": "ubrg",
  nonwhite: "ubrg",
  "ink-treader": "wurg",
  kynaios: "wurg",
  "non-black": "wurg",
  nonblack: "wurg",
  // 5-color
  "5 color": "wubrg",
  fivecolor: "wubrg",
  fivecolors: "wubrg",
  // Colorless
  colorless: "c",
};

export const SINGLE_COLOR_NAMES = new Set(["white", "blue", "black", "red", "green", "colorless"]);

/** English words with no card-search meaning that should be ignored as unresolved fragments. */
export const STOPWORDS = new Set([
  "a", "an", "the", "for", "to", "from", "with", "without", "of", "in", "on",
  "that", "which", "cards", "card", "best", "good", "great", "strong", "easy",
  "simple", "want", "need", "find", "show", "me", "please", "you", "your",
  "yours", "it", "its", "when", "this", "these", "those", "they", "them",
  "their", "set", "sets", "edition", "editions", "printing", "printings",
  "legal", "illegal", "playable", "other", "others", "both", "also", "any",
  "some", "all", "most", "every", "are", "can", "could", "would", "should",
  "have", "has", "had", "been", "being", "about", "like", "or", "and", "but",
  "not", "nor", "yet", "so", "either", "neither", "versus", "vs",
  // Modal / auxiliary verbs
  "will", "shall", "did", "does", "do", "might", "may",
  // Conversational social pronouns
  "everyone", "someone", "anybody", "nobody", "somebody",
  "ourselves", "themselves", "myself", "yourself",
  // Common filler adjectives / adverbs
  "really", "super", "very", "totally", "absolutely", "pretty", "quite",
  "actually", "basically", "literally",
  // Vibe / mood descriptors — describe desired game feel, NOT Scryfall filters
  "funny", "fun", "cool", "hilarious", "crazy", "insane", "wild", "broken",
  "busted", "op", "overpowered", "underrated", "underplayed", "spicy", "spice",
  "unique", "interesting", "weird", "strange", "unusual", "powerful", "epic",
  "awesome",
]);

/** Maps English number words to their numeric value. */
export const WORD_TO_NUMBER: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};

/**
 * Maps natural-language comparison phrases to Scryfall operator strings.
 * Evaluated in order — first match wins.
 */
export const COMPARISON_OP_PATTERNS: Array<[RegExp, string]> = [
  [/less\s+than|fewer\s+than|below/i, "<"],
  [/more\s+than|greater\s+than|above|higher\s+than/i, ">"],
  [/at\s+most|at\s+max(?:imum)?|or\s+(?:less|fewer)|up\s+to|no\s+more\s+than/i, "<="],
  [/at\s+least|at\s+min(?:imum)?|or\s+(?:more|greater)|no\s+less\s+than/i, ">="],
  [/equal(?:\s+to)?|exactly/i, "="],
];

/** Maps rarity names to Scryfall single-letter codes. */
export const RARITY_NAME_TO_CODE: Record<string, string> = {
  common: "c",
  uncommon: "u",
  rare: "r",
  mythic: "m",
  "mythic rare": "m",
};
