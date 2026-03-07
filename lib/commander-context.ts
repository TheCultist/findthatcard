/**
 * Handles "my commander" context from natural queries.
 * When players mention properties of their commander, they're typically
 * looking for cards for their deck (color identity) or synergy with a mechanic.
 */

const COLOR_WORDS: Record<string, string> = {
  white: "w",
  blue: "u",
  black: "b",
  red: "r",
  green: "g",
  azorius: "wu",
  rakdos: "br",
  dimir: "ub",
  boros: "rw",
  gruul: "rg",
  selesnya: "gw",
  orzhov: "wb",
  izzet: "ur",
  golgari: "bg",
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
  // 4-color identities
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
};

function normalizeForColorMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseColorIdentityFromPhrase(phrase: string): string | null {
  const normalized = normalizeForColorMatch(phrase);
  const words = normalized.split(/\s+/).filter(Boolean);

  // Check guild/shard/wedge nicknames first (multi-color only—skip white, green, etc.)
  const singleColors = new Set(["white", "blue", "black", "red", "green"]);
  for (const [name, id] of Object.entries(COLOR_WORDS)) {
    if (name.length <= 3 || singleColors.has(name)) continue;
    if (normalized.includes(name)) {
      return id;
    }
  }

  // Parse individual colors: "green and white", "green white", "green, white"
  const found = new Set<string>();
  for (const word of words) {
    const letter = COLOR_WORDS[word];
    if (letter) found.add(letter);
  }
  if (found.size === 0) return null;
  return [...found].sort().join("");
}

/**
 * Detects "my commander is [colors]" and returns id:X for deck color identity.
 * Uses id<= for "at most these colors" (cards legal in that commander's deck).
 */
export function resolveCommanderColorIdentity(naturalQuery: string): string | null {
  const lower = naturalQuery.toLowerCase();

  // "my commander is green and white" / "commander is green white" / "commander being green white"
  const colorMatch = lower.match(
    /\b(?:my\s+|the\s+)?commander\s+(?:is|being)\s+([^.]+?)(?:\.|,|and\s+(?:I|i)|$)/i
  );
  if (colorMatch) {
    const phrase = colorMatch[1] || "";
    const id = parseColorIdentityFromPhrase(phrase);
    if (id) return id;
  }

  // "I have a selesnya commander" / "GW commander"
  const haveMatch = lower.match(
    /\b(?:have|run|play|use)\s+(?:a\s+)?([^.]+?)\s+commander\b/i
  );
  if (haveMatch) {
    const phrase = haveMatch[1] || "";
    const id = parseColorIdentityFromPhrase(phrase);
    if (id) return id;
  }

  // "green white commander" at start
  const leadingMatch = lower.match(
    /^([a-z\s,]+?)\s+commander\s+(?:and|,|\.|$)/i
  );
  if (leadingMatch) {
    const phrase = leadingMatch[1] || "";
    const id = parseColorIdentityFromPhrase(phrase);
    if (id) return id;
  }

  // "for a red commander" / "for my red commander" / "playable with golgari commander"
  const cleanedFor = lower.replace(/\b(?:looking|search(?:ing)?)\s+for\b/g, "");
  const forMatch = cleanedFor.match(
    /\b(?:for|in|playable\s+with|goes\s+in)\s+(?:a\s+|my\s+|an\s+)?([^.]+?)\s+commander\b/i
  );
  if (forMatch) {
    const phrase = forMatch[1] || "";
    const id = parseColorIdentityFromPhrase(phrase);
    if (id) return id;
  }

  // "red commander deck"
  const deckMatch = lower.match(
    /\b([a-z\s,]+?)\s+commander\s+deck\b/i
  );
  if (deckMatch) {
    const phrase = deckMatch[1] || "";
    const id = parseColorIdentityFromPhrase(phrase);
    if (id) return id;
  }

  return null;
}

/**
 * Returns true if the query mentions "my commander" in a deck-building context.
 * Used to infer f:commander and to skip unrelated set matching.
 */
export function hasCommanderDeckContext(naturalQuery: string): boolean {
  const lower = naturalQuery.toLowerCase();
  
  if (/\bmy\s+commander\b|\bcommander\s+is\b|\bcommander\s+being\b|\bthe\s+commander\b|\bmy\s+general\b/i.test(lower)) {
    return true;
  }
  
  if (/\b(?:have|run|play|use|build(?:ing)?)\s+(?:a\s+)?[^.]+?\s+commander\b/i.test(lower)) {
    return true;
  }
  
  if (/\bcommander\s+deck\b/i.test(lower)) {
    return true;
  }
  
  const cleanedFor = lower.replace(/\b(?:looking|search(?:ing)?)\s+for\b/g, "");
  if (/\b(?:for|in|playable\s+with|goes\s+in)\s+(?:a\s+|my\s+|an\s+)?[^.]+?\s+commander\b/i.test(cleanedFor)) {
    return true;
  }

  return false;
}

/**
 * Injects id<=X and f:commander when "my commander is [colors]" is detected.
 */
export function applyCommanderContextFromNaturalQuery(
  naturalQuery: string,
  scryfallQuery: string
): string {
  if (!hasCommanderDeckContext(naturalQuery)) {
    return scryfallQuery;
  }

  let result = scryfallQuery;

  // Strip is:commander—user wants deck cards, not creatures that can be commanders
  result = result.replace(/\b-?is:commander\b/gi, " ").replace(/\s{2,}/g, " ").trim();

  // Add f:commander if not present (deck-building = format legal)
  if (!/\bf:commander\b/i.test(result)) {
    result = `${result} f:commander`.trim();
  }

  const colorId = resolveCommanderColorIdentity(naturalQuery);
  if (colorId) {
    // Replace any existing identity clause with id<= for deck building
    // (supports id:, id=, id<=, id:<=, and comparator variants).
    const idPattern = /\bid(?:entity)?(?::<=|:>=|[:=]|<=|>=|<|>)\s*[wubrgc]+\b/gi;
    result = result.replace(idPattern, "");
    result = `${result.trim()} id<=${colorId}`.trim();
  }

  // Remove Commander precon/set filters—user wants deck cards, not from a specific product
  const commanderPreconCodes =
    "c13|c14|c15|c16|c17|c18|c19|c20|c21|cmd|m21|dbl|mic|cmr|clb";
  result = result.replace(
    new RegExp(
      `-?(?:set|s|e|edition):(?:${commanderPreconCodes})\\b`,
      "gi"
    ),
    ""
  );
  result = result.replace(/\s+or\s+or\s+/gi, " or ");
  result = result.replace(/\(\s*or\s+/gi, "(").replace(/\s+or\s*\)/gi, ")");
  result = result.replace(/\s*\(\s*\)\s*/g, " ");

  return result.replace(/\s{2,}/g, " ").trim();
}
