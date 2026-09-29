/**
 * Search Pipeline V2 — deterministic validation + IR construction.
 *
 * Takes the AI's structured extraction and turns it into a `SearchPipelineIR`,
 * validating every value against local Scryfall catalogs / the Tagger tag
 * vocabulary / the archetype registry. Anything that fails validation is dropped
 * (never fuzzy-corrected into something else). The result is handed to the same
 * `resolveIntentClauses` + Phase 3 finalizer the legacy pipeline uses.
 */

import { getMtgKeywordList } from "@/lib/mtg-keywords";
import {
  getArtistIndex,
  lookupCardName,
  lookupCardNameFuzzy,
  matchSubtype,
  matchSupertype,
} from "@/lib/scryfall/catalog-index";
import { normalizeFormatSlug } from "@/lib/scryfall/formats";
import { fetchCardByName } from "@/lib/scryfall/lookup";
import { lookupArchetypeTags } from "@/lib/scryfall/query-converter";
import { validateTaggerTag } from "@/lib/tagger/validation";
import type {
  QueryClause,
  ResolvedFragment,
  SearchPipelineIR,
  UnresolvedFragment,
} from "@/lib/search-pipeline/types";
import type { V2Extraction } from "@/lib/search-pipeline/v2/schema";

const BASE_TYPES = new Set([
  "creature", "artifact", "enchantment", "instant", "sorcery",
  "planeswalker", "land", "battle", "kindred", "tribal",
]);

// Allowed operator/code vocabularies. Validated defensively because the Claude
// provider treats the JSON schema as a hint, not a hard constraint — so any AI
// scalar may arrive malformed (wrong type, out-of-enum, or an array).
const NUMERIC_OPS = new Set(["<", "<=", "=", ">=", ">"]);
const RARITY_OPS = new Set([":", "<=", ">="]);
const COLOR_OPS = new Set([":", "=", ">=", "<="]);
const STAT_FIELDS = new Set(["mv", "pow", "tou", "loy"]);
const RARITY_CODES = new Set(["c", "u", "r", "m"]);

/** Normalizes a possibly-scalar-or-array AI value into a clean string array. */
function toStringArray(value: unknown): string[] {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value];
  return arr.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function toObjectArray<T>(value: unknown): T[] {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value];
  return arr.filter((v): v is T => v !== null && typeof v === "object");
}

/**
 * The schema only requires `intent`; every other field may be missing, null,
 * a scalar where an array was expected, or an array where a scalar was. Coerce
 * the whole object once so the rest of the builder can assume the declared shape.
 */
function normalizeExtraction(raw: Partial<V2Extraction> | null | undefined): V2Extraction {
  const e = (raw ?? {}) as Record<string, unknown>;
  const scalar = <T>(v: unknown): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null)) as T | null;
  return {
    intent: (typeof e.intent === "string" ? e.intent : "search") as V2Extraction["intent"],
    cardName: typeof scalar(e.cardName) === "string" ? scalar<string>(e.cardName) : null,
    colors: scalar<V2Extraction["colors"]>(e.colors),
    typesAll: toStringArray(e.typesAll),
    typesAny: toStringArray(e.typesAny),
    negatedTypes: toStringArray(e.negatedTypes),
    subtypes: toStringArray(e.subtypes),
    supertypes: toStringArray(e.supertypes),
    stats: toObjectArray<V2Extraction["stats"][number]>(e.stats),
    rarity: scalar<V2Extraction["rarity"]>(e.rarity),
    year: scalar<V2Extraction["year"]>(e.year),
    keywords: toStringArray(e.keywords),
    format: typeof scalar(e.format) === "string" ? scalar<string>(e.format) : null,
    set: typeof scalar(e.set) === "string" ? scalar<string>(e.set) : null,
    artist: typeof scalar(e.artist) === "string" ? scalar<string>(e.artist) : null,
    artSubjects: toStringArray(e.artSubjects),
    functionTags: toStringArray(e.functionTags),
    archetypes: toObjectArray<V2Extraction["archetypes"][number]>(e.archetypes).filter(
      (a) => typeof a.name === "string"
    ),
    oraclePhrases: toStringArray(e.oraclePhrases),
    negatedOraclePhrases: toStringArray(e.negatedOraclePhrases),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

let keywordSlugsPromise: Promise<Set<string>> | null = null;
/** Slugified MTG keyword names (flying, double-strike, …) for validating `kw:`. */
function getKeywordSlugs(): Promise<Set<string>> {
  keywordSlugsPromise ??= getMtgKeywordList().then((list) => new Set(list.map(slugify)));
  return keywordSlugsPromise;
}

/**
 * Scryfall `a:` is a substring match, so a partial like "Guay" is a valid user
 * request. Accept exact catalog names (canonicalized) or any substring of one;
 * drop names no illustrator contains.
 */
function resolveArtist(raw: string): string | null {
  const needle = raw.trim().toLowerCase();
  if (!needle) return null;
  const index = getArtistIndex();
  if (!index) return raw.trim();
  const exact = index.get(needle);
  if (exact) return exact;
  for (const key of index.keys()) if (key.includes(needle)) return raw.trim();
  return null;
}

function normalizeType(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/s$/, "");
  return BASE_TYPES.has(t) ? t : null;
}

function slugify(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

const COLOR_LETTERS = /[^wubrgc]/g;

// Oracle verbs whose subject-verb agreement varies across card wordings
// ("Creatures lose all abilities" vs "…loses all abilities"). A quoted phrase
// is an exact substring, so o:"lose all abilities" silently misses the
// inflected form. Splitting the leading verb into its own stem token keeps
// both AND-ed constraints while matching every inflection (o:"lose" is a
// substring of "loses").
const INFLECTABLE_ORACLE_VERBS = new Set([
  "lose", "gain", "draw", "destroy", "sacrifice", "exile", "return", "discard",
  "counter", "create", "enter", "deal", "put", "search", "reveal", "shuffle",
  "tap", "untap", "cast", "die", "fight", "mill", "scry", "attack", "block",
  "become", "get", "have", "cost", "prevent", "copy", "trigger",
]);

// A bare number as an oracle token ("tap for two" → o:"two") is noise: rules text
// writes amounts as symbols ({C}{C}) or in phrases the token can't anchor to.
const BARE_NUMBER_TOKEN =
  /^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|x)$/i;

/**
 * "lose all abilities" → ["lose", "all abilities"]; "loses all abilities" →
 * ["lose", "all abilities"]; "whenever you cast" → unchanged.
 * ponytail: first-word-only check — a verb mid-phrase ("creatures lose all
 * abilities") stays quoted; extend to a scan if such extractions show up.
 */
function splitInflectedVerbPhrase(phrase: string): string[] {
  const words = phrase.split(/\s+/);
  if (words.length < 2) return [phrase];
  const first = words[0].toLowerCase();
  const stem = first.endsWith("s") && !first.endsWith("ss") ? first.slice(0, -1) : first;
  if (!INFLECTABLE_ORACLE_VERBS.has(stem)) return [phrase];
  return [stem, words.slice(1).join(" ")];
}

function emptyIR(naturalQuery: string): SearchPipelineIR {
  return {
    naturalQuery,
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [],
    debug: {
      strippedTerms: [],
      aiBatchCalls: 0,
      aiSequentialCalls: 0,
      invalidTagsRemoved: 0,
      phase0Normalized: false,
    },
  };
}

/**
 * Resolves a card name to its canonical catalog form. Tries exact, then local
 * fuzzy (≤2 edits), then — only for named-card intents — one Scryfall fuzzy
 * lookup. Returns null when nothing plausible matches.
 */
async function resolveCardName(raw: string | null, allowRemote: boolean): Promise<string | null> {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^["']|["']$/g, "");
  if (!cleaned) return null;
  const exact = lookupCardName(cleaned);
  if (exact) return exact;
  const fuzzy = lookupCardNameFuzzy(cleaned, 2);
  if (fuzzy) return fuzzy;
  if (allowRemote) {
    const remote = await fetchCardByName(cleaned);
    if (remote?.name) return remote.name;
  }
  return null;
}

export async function buildIRFromExtraction(
  rawExtraction: Partial<V2Extraction>,
  naturalQuery: string
): Promise<SearchPipelineIR> {
  const extraction = normalizeExtraction(rawExtraction);
  const ir = emptyIR(naturalQuery);
  const must: QueryClause[] = ir.mustClauses;
  const mustNot: QueryClause[] = ir.mustNotClauses;

  // --- Named-card intents: hand the card name to resolveIntentClauses ---
  // The intent resolver is a pipeline step, not a bypass: every other field the
  // user expressed ("…that aren't instants", "…in modern") is still built below
  // and AND-ed with the resolver's clause.
  if (
    extraction.intent === "similar-cards" ||
    extraction.intent === "art-like-cards" ||
    extraction.intent === "synergy-with-card"
  ) {
    const canonical = await resolveCardName(extraction.cardName, true);
    const name = canonical ?? extraction.cardName?.trim() ?? "";
    if (name) {
      ir.intent = extraction.intent;
      if (extraction.intent === "similar-cards") ir.similarToCardName = name;
      if (extraction.intent === "art-like-cards") ir.artLikeCardName = name;
      if (extraction.intent === "synergy-with-card") ir.synergyWithCardName = name;
    }
    // No usable card name — treat as a normal search.
  }

  // --- Literal card-name search ---
  if (ir.intent === "search" && extraction.cardName) {
    const canonical = await resolveCardName(extraction.cardName, true);
    if (canonical) {
      must.push({ value: `name:"${canonical}"`, source: "phase1:cardname" });
    }
  }

  // --- Colors ---
  if (extraction.colors && typeof extraction.colors.letters === "string") {
    const letters = extraction.colors.letters.toLowerCase().replace(COLOR_LETTERS, "");
    if (letters) {
      const field = extraction.colors.mode === "color" ? "c" : "id";
      const op = COLOR_OPS.has(extraction.colors.op) ? extraction.colors.op : ":";
      // combine "or" = the letters are alternatives ("red or green") → OR-group
      // per letter. Anything else (missing/garbage — the AI may ignore the enum)
      // defaults to "and": one combined token, the historical behavior.
      const uniqueLetters = [...new Set(letters)];
      if (extraction.colors.combine === "or" && uniqueLetters.length > 1) {
        must.push({
          value: `(${uniqueLetters.map((l) => `${field}${op}${l}`).join(" or ")})`,
          source: "phase1:color",
        });
      } else {
        must.push({ value: `${field}${op}${letters}`, source: "phase1:color" });
      }
    }
  }

  // --- Types / supertypes / subtypes ---
  // typesAll = compound type ("artifact creature") → AND each. typesAny =
  // enumerated alternatives ("instants or sorceries") → OR-group, since a single
  // card is rarely two base types and AND-ing them returns zero cards.
  for (const t of extraction.typesAll) {
    const norm = normalizeType(t);
    if (norm) must.push({ value: `t:${norm}`, source: "phase1:type" });
  }
  const anyTypeClauses = extraction.typesAny
    .map(normalizeType)
    .filter((t): t is string => t !== null)
    .map((t) => `t:${t}`);
  if (anyTypeClauses.length === 1) {
    must.push({ value: anyTypeClauses[0], source: "phase1:type" });
  } else if (anyTypeClauses.length > 1) {
    must.push({ value: `(${[...new Set(anyTypeClauses)].join(" or ")})`, source: "phase1:type" });
  }
  for (const t of extraction.negatedTypes) {
    const norm = normalizeType(t);
    if (norm) mustNot.push({ value: `t:${norm}`, source: "phase1:type" });
  }
  for (const s of extraction.supertypes) {
    const sup = matchSupertype(s);
    if (sup) must.push({ value: `t:${sup.toLowerCase()}`, source: "phase1:type" });
  }
  for (const s of extraction.subtypes) {
    const sub = matchSubtype(s);
    if (sub) must.push({ value: `t:${sub.name.toLowerCase()}`, source: "phase1:subtype" });
  }

  // --- Stats / rarity / year (each field defensively validated) ---
  for (const stat of extraction.stats ?? []) {
    if (!stat || !STAT_FIELDS.has(stat.field) || !NUMERIC_OPS.has(stat.op) || !isFiniteNumber(stat.value)) {
      continue;
    }
    must.push({ value: `${stat.field}${stat.op}${Math.round(stat.value)}`, source: "phase1:stat" });
  }
  if (extraction.rarity) {
    // `codes` may arrive as a scalar, an array, or the legacy `code` key.
    const rawCodes = toStringArray(
      (extraction.rarity as { codes?: unknown }).codes ?? (extraction.rarity as { code?: unknown }).code
    ).map((c) => c.toLowerCase());
    const codes = [...new Set(rawCodes.filter((c) => RARITY_CODES.has(c)))];
    const op = RARITY_OPS.has(extraction.rarity.op) ? extraction.rarity.op : ":";
    if (codes.length === 1) {
      must.push({ value: `r${op}${codes[0]}`, source: "phase1:rarity" });
    } else if (codes.length > 1) {
      // Multiple rarities are alternatives ("common and uncommon") → OR them.
      must.push({ value: `(${codes.map((c) => `r:${c}`).join(" or ")})`, source: "phase1:rarity" });
    }
  }
  if (extraction.year && isFiniteNumber(extraction.year.year) && NUMERIC_OPS.has(extraction.year.op)) {
    const yr = Math.round(extraction.year.year);
    if (yr >= 1993 && yr <= 2100) {
      must.push({ value: `year${extraction.year.op}${yr}`, source: "phase1:stat" });
    }
  }

  // --- Keywords (validated against the MTG keyword catalog, emitted as kw:) ---
  if (extraction.keywords.length > 0) {
    const known = await getKeywordSlugs();
    for (const kw of extraction.keywords) {
      const slug = slugify(kw);
      if (slug && known.has(slug)) must.push({ value: `kw:${slug}`, source: "phase1:keyword" });
    }
  }

  // --- Format (allowlisted Scryfall slugs; aliases like "pauper edh" → paupercommander) ---
  if (extraction.format) {
    const fmt = normalizeFormatSlug(extraction.format);
    if (fmt) must.push({ value: `f:${fmt}`, source: "phase1:format" });
  }

  // --- Artist (must match or be contained in a catalog illustrator name) ---
  if (extraction.artist) {
    const artist = resolveArtist(extraction.artist);
    if (artist) must.push({ value: `a:"${artist}"`, source: "phase1:artist" });
  }

  // --- Art subjects (validated against art vocabulary, OR-grouped) ---
  const artSlugs: string[] = [];
  for (const subject of extraction.artSubjects) {
    const slug = slugify(subject);
    if (slug && (await validateTaggerTag("art", slug))) artSlugs.push(`art:${slug}`);
  }
  if (artSlugs.length === 1) {
    must.push({ value: artSlugs[0], source: "phase1:art" });
  } else if (artSlugs.length > 1) {
    must.push({ value: `(${artSlugs.join(" or ")})`, source: "phase1:art" });
  }

  // --- Function tags (validated against function vocabulary) ---
  // Multiple function tags describe alternative gameplay roles for one broad
  // concept (e.g. "control spells" -> counterspell / bounce / conditional-control),
  // so they are OR-grouped like the legacy Phase 2 resolver. AND-ing them would
  // require a single card to carry every role and collapse to zero results.
  const fnTags: string[] = [];
  for (const tag of extraction.functionTags) {
    const slug = slugify(tag);
    if (slug && (await validateTaggerTag("function", slug))) fnTags.push(`function:${slug}`);
  }

  // --- Archetypes (validated; routed through resolvedFragments so Phase 3 injects them) ---
  const unresolved: UnresolvedFragment[] = ir.unresolvedFragments;
  const resolved: ResolvedFragment[] = ir.resolvedFragments;
  extraction.archetypes.forEach((arch, i) => {
    const name = arch.name.trim().toLowerCase();
    const qualifier = typeof arch.qualifier === "string" ? arch.qualifier.trim().toLowerCase() || undefined : undefined;
    if (!name) return;
    if (!lookupArchetypeTags(name, qualifier)) return; // unknown archetype — drop
    const key = `__archetype_${i}_${name}${qualifier ? `_${qualifier}` : ""}`;
    unresolved.push({ text: key, category: "effect" });
    resolved.push({
      fragment: key,
      tags: [],
      confidence: 1,
      category: "effect",
      archetype: name,
      qualifier,
    });
  });

  // Function tags are alternative gameplay roles for one concept → OR-grouped.
  // When the model ALSO chose an archetype (it is told to pick one channel but
  // small models routinely emit both — "removal" + archetype removal), the tags
  // describe the same concept as the archetype: fold them into the archetype's
  // OR family instead of AND-ing a second function clause that over-narrows.
  // ponytail: assumes archetype + tags = one concept; a query that genuinely
  // wants archetype AND an orthogonal tag ("tokens" + "cast-trigger-you") is
  // re-narrowed by finalize's dedicated injectors, not here.
  if (fnTags.length > 0 && resolved.length > 0) {
    resolved[0].tags.push(...fnTags);
  } else if (fnTags.length === 1) {
    must.push({ value: fnTags[0], source: "phase1:function" });
  } else if (fnTags.length > 1) {
    must.push({ value: `(${fnTags.join(" or ")})`, source: "phase1:function" });
  }

  // --- Oracle phrases (verb-initial phrases split so inflections still match) ---
  for (const phrase of extraction.oraclePhrases) {
    const p = phrase.trim().replace(/^["']|["']$/g, "");
    if (!p || BARE_NUMBER_TOKEN.test(p)) continue;
    for (const part of splitInflectedVerbPhrase(p)) {
      must.push({ value: `o:"${part}"`, source: "phase1:oracle" });
    }
  }
  for (const phrase of extraction.negatedOraclePhrases) {
    const p = phrase.trim().replace(/^["']|["']$/g, "");
    if (!p) continue;
    for (const part of splitInflectedVerbPhrase(p)) {
      mustNot.push({ value: `o:"${part}"`, source: "phase1:oracle" });
    }
  }

  // --- Safety net: never hand Phase 3 a completely empty IR ---
  if (must.length === 0 && mustNot.length === 0 && resolved.length === 0) {
    unresolved.push({ text: naturalQuery, category: "semantic" });
  }

  return ir;
}
