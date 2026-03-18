import { ensureScryfallCatalogCache, getCatalog } from "@/lib/scryfall/catalogs";

export type SubtypeMatch = {
  name: string;
  category: string;
};

const IRREGULAR_PLURALS: Record<string, string> = {
  elf: "elves",
  dwarf: "dwarves",
  wolf: "wolves",
  werewolf: "werewolves",
  ox: "oxen",
  mouse: "mice",
  locus: "loci",
  fungus: "fungi",
  goose: "geese",
  octopus: "octopi",
  djinn: "djinn",
  fish: "fish",
  sheep: "sheep",
  sphinx: "sphinxes",
};

const REVERSE_IRREGULAR: Record<string, string> = {};
for (const [singular, plural] of Object.entries(IRREGULAR_PLURALS)) {
  REVERSE_IRREGULAR[plural] = singular;
}

function pluralize(singular: string): string[] {
  const lower = singular.toLowerCase();
  const irregular = IRREGULAR_PLURALS[lower];
  if (irregular) return [lower, irregular];
  if (lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("z") || lower.endsWith("sh") || lower.endsWith("ch")) {
    return [lower, `${lower}es`];
  }
  if (lower.endsWith("y") && lower.length > 2 && !/[aeiou]/.test(lower[lower.length - 2])) {
    return [lower, `${lower.slice(0, -1)}ies`];
  }
  return [lower, `${lower}s`];
}

function singularize(token: string): string {
  const lower = token.toLowerCase();
  const irregular = REVERSE_IRREGULAR[lower];
  if (irregular) return irregular;
  if (lower.endsWith("ies") && lower.length > 4) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("ves") && lower.length > 4) return `${lower.slice(0, -3)}f`;
  if (lower.endsWith("xes") || lower.endsWith("shes") || lower.endsWith("ches") || lower.endsWith("zes") || lower.endsWith("ses")) {
    return lower.slice(0, -2);
  }
  if (lower.endsWith("s") && !lower.endsWith("ss") && lower.length > 3) return lower.slice(0, -1);
  return lower;
}

const SUBTYPE_SOURCES: Array<{ catalog: string; category: string }> = [
  { catalog: "creature-types", category: "creature" },
  { catalog: "artifact-types", category: "artifact" },
  { catalog: "enchantment-types", category: "enchantment" },
  { catalog: "land-types", category: "land" },
  { catalog: "spell-types", category: "spell" },
  { catalog: "battle-types", category: "battle" },
  { catalog: "planeswalker-types", category: "planeswalker" },
];

type CardNameIndexPair = {
  exact: Map<string, string>;      // lowercase as-is → canonical
  simplified: Map<string, string>; // punctuation-stripped lowercase → canonical
};

let subtypeIndex: Map<string, SubtypeMatch> | null = null;
let supertypeSet: Set<string> | null = null;
let artistIndex: Map<string, string> | null = null;
let cardNameIndexPair: CardNameIndexPair | null = null;
let indexPromise: Promise<void> | null = null;

/**
 * Normalise a card name for fuzzy lookup: lowercase, strip apostrophes,
 * remove commas, convert hyphens to spaces, collapse whitespace.
 * Used when building the simplified index AND when normalising query text.
 */
function simplifyForNameLookup(text: string): string {
  return text
    .toLowerCase()
    .replace(/'/g, "")      // Gaea's → gaeas
    .replace(/,/g, "")      // Jace, the → jace the
    .replace(/-/g, " ")     // Well-Read → well read
    .replace(/\s+/g, " ")
    .trim();
}

async function buildIndexes(): Promise<void> {
  await ensureScryfallCatalogCache();

  const stMap = new Map<string, SubtypeMatch>();
  for (const { catalog, category } of SUBTYPE_SOURCES) {
    const entries = await getCatalog(catalog as Parameters<typeof getCatalog>[0]);
    for (const name of entries) {
      const entry: SubtypeMatch = { name, category };
      const lower = name.toLowerCase();

      stMap.set(lower, entry);
      for (const form of pluralize(lower)) {
        if (!stMap.has(form)) stMap.set(form, entry);
      }

      if (lower.includes("-")) {
        const spaced = lower.replace(/-/g, " ");
        stMap.set(spaced, entry);
        for (const form of pluralize(spaced)) {
          if (!stMap.has(form)) stMap.set(form, entry);
        }
      }
      if (lower.includes(" ")) {
        const hyphenated = lower.replace(/\s+/g, "-");
        stMap.set(hyphenated, entry);
      }
    }
  }
  subtypeIndex = stMap;

  const spSet = new Set<string>();
  const supertypes = await getCatalog("supertypes");
  for (const name of supertypes) {
    const lower = name.toLowerCase();
    spSet.add(lower);
    for (const form of pluralize(lower)) {
      spSet.add(form);
    }
  }
  supertypeSet = spSet;

  const artMap = new Map<string, string>();
  const artists = await getCatalog("artist-names");
  for (const name of artists) {
    artMap.set(name.toLowerCase(), name);
  }
  artistIndex = artMap;

  const cardNames = await getCatalog("card-names");
  const cnExact = new Map<string, string>();
  const cnSimplified = new Map<string, string>();
  for (const name of cardNames) {
    const lower = name.toLowerCase();
    cnExact.set(lower, name);
    const simplified = simplifyForNameLookup(name);
    if (simplified !== lower && !cnSimplified.has(simplified)) {
      cnSimplified.set(simplified, name);
    }
    
    // For double-faced cards (with //), also index the front face name
    if (name.includes(" // ")) {
      const frontFace = name.split(" // ")[0].trim();
      const frontLower = frontFace.toLowerCase();
      // Only add if not already present (prefer exact full names)
      if (!cnExact.has(frontLower)) {
        cnExact.set(frontLower, name);
      }
      const frontSimplified = simplifyForNameLookup(frontFace);
      if (frontSimplified !== frontLower && !cnSimplified.has(frontSimplified)) {
        cnSimplified.set(frontSimplified, name);
      }
    }
  }
  cardNameIndexPair = { exact: cnExact, simplified: cnSimplified };

  console.log(
    `[Catalog Index] Built indexes: ${stMap.size} subtype forms, ` +
      `${spSet.size} supertype forms, ${artMap.size} artists, ` +
      `${cnExact.size} card names (${cnSimplified.size} simplified forms)`
  );
}

export async function ensureCatalogIndex(): Promise<void> {
  if (subtypeIndex !== null) return;

  if (indexPromise === null) {
    indexPromise = buildIndexes().catch((error) => {
      indexPromise = null;
      throw error;
    });
  }

  await indexPromise;
}

export function matchSubtype(token: string): SubtypeMatch | null {
  if (!subtypeIndex) return null;
  const lower = token.toLowerCase();
  const direct = subtypeIndex.get(lower);
  if (direct) return direct;
  const singular = singularize(lower);
  if (singular !== lower) return subtypeIndex.get(singular) ?? null;
  return null;
}

export function matchSupertype(token: string): string | null {
  if (!supertypeSet) return null;
  const lower = token.toLowerCase();
  if (supertypeSet.has(lower)) {
    const singular = singularize(lower);
    return singular.charAt(0).toUpperCase() + singular.slice(1);
  }
  return null;
}

/**
 * Common English words that are close (levenshtein ≤ 1) to MTG subtype names or their
 * plurals but should never be treated as subtypes. Checked before fuzzy subtype matching.
 */
const SUBTYPE_FUZZY_BLOCKLIST = new Set([
  // "board" → "boars" (Boar creature type, levenshtein 1)
  "board", "boards",
  // "other" / "others" → "otter" / "otters" (Otter creature type, levenshtein 1)
  "other", "others",
  // "wipe" / "wipes" — MTG slang for mass removal, not a subtype
  "wipe", "wipes",
  // Other common English words adjacent to creature-type names
  "beards", "bards", "beats", "bears", "gears", "fears", "tears", "years",
  "forms", "forts", "words", "lords", "cords", "birds",
  // Common relational / grammar words that sit within edit-distance of creature types
  "target", "player", "players", "spell", "spells", "effect", "effects",
  "power", "token", "tokens", "counter", "counters", "trigger", "triggers",
  // "matter" / "matters" → "master" / "masters" (Master creature type, levenshtein 1)
  "matter", "matters",
  // "combat" → "wombat" (Wombat creature type, levenshtein 1 — first char c→w)
  "combat",
  // "buff" / "buffs" → "guff" / "guffs" (Guff planeswalker type, levenshtein 1 — first char b→g)
  "buff", "buffs", "buffing",
  // "pump" → common MTG jargon for combat tricks, not a subtype
  "pump", "pumps",
  // "boost" → common MTG jargon for power/toughness increases, not a subtype
  "boost", "boosts",
  // "mill" / "mills" → fuzzy-matches "wills" (plural of Will, a planeswalker type, levenshtein 1)
  // Mill is an MTG keyword action (kw:mill), not a card subtype.
  "mill", "mills", "milling",
]);

export function fuzzyMatchSubtype(
  token: string,
  distanceFn: (a: string, b: string) => boolean
): SubtypeMatch | null {
  if (!subtypeIndex) return null;
  const lower = token.toLowerCase();
  if (SUBTYPE_FUZZY_BLOCKLIST.has(lower)) return null;
  for (const [form, entry] of subtypeIndex.entries()) {
    if (form.includes(" ") || form.includes("-")) continue;
    if (distanceFn(lower, form)) return entry;
  }
  return null;
}

export function getArtistIndex(): Map<string, string> | null {
  return artistIndex;
}

/**
 * Look up a card name candidate against the catalog.
 * First tries an exact lowercase match, then a simplified match
 * (apostrophes stripped, commas removed, hyphens → spaces).
 * Returns the canonical card name or null if not found.
 */
export function lookupCardName(text: string): string | null {
  if (!cardNameIndexPair) return null;
  const lower = text.toLowerCase().trim();
  const exact = cardNameIndexPair.exact.get(lower);
  if (exact) return exact;
  const simplified = simplifyForNameLookup(text);
  return cardNameIndexPair.simplified.get(simplified) ?? null;
}

export function hasCardNameIndex(): boolean {
  return cardNameIndexPair !== null;
}

/**
 * Returns the shortest canonical card name whose simplified form starts with
 * the given prefix followed by a word boundary (space, comma, or end-of-string).
 *
 * Used when a user types a partial name such as "Animar" instead of the full
 * "Animar, Soul of Elements". Picks the shortest match to minimise false
 * positives when the prefix is ambiguous (e.g. "Sol" → "Sol Ring" not
 * "Sol'kanar the Swamp King").
 *
 * Returns null if no name starts with the given prefix.
 */
export function lookupCardNameByPrefix(prefix: string): string | null {
  if (!cardNameIndexPair) return null;
  const norm = simplifyForNameLookup(prefix);
  if (norm.length < 2) return null;

  let shortest: string | null = null;

  // Check the exact map first (lowercase card names)
  for (const [key, canonical] of cardNameIndexPair.exact) {
    if (key === norm || key.startsWith(norm + " ") || key.startsWith(norm + ",")) {
      if (shortest === null || canonical.length < shortest.length) {
        shortest = canonical;
      }
    }
  }
  if (shortest) return shortest;

  // Fall back to simplified map (punctuation-stripped forms)
  for (const [key, canonical] of cardNameIndexPair.simplified) {
    if (key === norm || key.startsWith(norm + " ")) {
      if (shortest === null || canonical.length < shortest.length) {
        shortest = canonical;
      }
    }
  }
  return shortest;
}

ensureCatalogIndex().catch((error) => {
  console.warn("[Catalog Index] Warm-up failed:", error);
});
