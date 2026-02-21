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

let subtypeIndex: Map<string, SubtypeMatch> | null = null;
let supertypeSet: Set<string> | null = null;
let artistIndex: Map<string, string> | null = null;
let indexPromise: Promise<void> | null = null;

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

  console.log(
    `[Catalog Index] Built indexes: ${stMap.size} subtype forms, ` +
      `${spSet.size} supertype forms, ${artMap.size} artists`
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

export function matchArtistName(text: string): { name: string; matchedText: string } | null {
  if (!artistIndex) return null;
  const lower = text.toLowerCase();
  const direct = artistIndex.get(lower);
  if (direct) return { name: direct, matchedText: text };
  return null;
}

/**
 * Common English words that are close (levenshtein ≤ 1) to MTG subtype names or their
 * plurals but should never be treated as subtypes. Checked before fuzzy subtype matching.
 */
const SUBTYPE_FUZZY_BLOCKLIST = new Set([
  // "board" → "boars" (Boar creature type, levenshtein 1)
  "board", "boards",
  // "wipe" / "wipes" — MTG slang for mass removal, not a subtype
  "wipe", "wipes",
  // Other common English words adjacent to creature-type names
  "beards", "bards", "beats", "bears", "gears", "fears", "tears", "years",
  "forms", "forts", "words", "lords", "cords", "birds",
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

export function getSubtypeIndex(): Map<string, SubtypeMatch> | null {
  return subtypeIndex;
}

export function getArtistIndex(): Map<string, string> | null {
  return artistIndex;
}

ensureCatalogIndex().catch((error) => {
  console.warn("[Catalog Index] Warm-up failed:", error);
});
