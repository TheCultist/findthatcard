import { fetchCardByName } from "@/lib/scryfall/lookup";
import { fetchTaggerCardData, TaggerCardData } from "@/lib/scryfall/tagger-graphql";

/**
 * Builds a Scryfall query that finds cards whose illustration shares the same
 * visual art tags as the given card name.
 *
 * Fetches the card's ILLUSTRATION_TAG entries from the Scryfall Tagger and
 * assembles an AND-chain of `art:` filters.  The source card is excluded from
 * results via `-name:`.
 *
 * Returns null when the card cannot be found or has no usable art tags.
 */
export async function resolveArtLikeCardsQuery(cardName: string): Promise<string | null> {
  const card = await fetchCardByName(cardName);
  if (!card) {
    console.warn(`[ArtLike] Card not found: "${cardName}"`);
    return null;
  }

  console.log(`[ArtLike] Resolving art-like query for: "${card.name}" (${card.set}/${card.collector_number})`);

  const tagger = await fetchTaggerCardData(card.set, card.collector_number);
  if (!tagger) {
    console.warn(`[ArtLike] Tagger data unavailable for "${card.name}"`);
    return null;
  }

  return buildArtQueryFromTaggerData(tagger);
}

/**
 * Builds a Scryfall `art:` query from a card's illustration tags.
 *
 * Strategy: score tags by specificity, then build:
 *   - If 1+ compound tags exist: use the single best one as the anchor.
 *     Compound tags like "phyrexian-tears" or "river-island-landscape" are
 *     rare enough that one alone returns a useful result set.
 *   - If 2+ tier-2 (uncommon single-word) tags exist: AND the top 2.
 *     Two moderately specific tags together constrain well without being zero.
 *   - If only broad/ambient tags exist: OR the top 3 (returning their union
 *     is more useful than ANDing to nothing, or returning a single broad tag).
 *
 * A single compound tag beats three AND-chained tags every time — three
 * rare tags co-occurring on the same card is nearly impossible.
 */
function buildArtQueryFromTaggerData(tagger: TaggerCardData): string | null {
  const BROAD_TAGS = new Set([
    "forest", "island", "mountain", "plains", "swamp",
    "river", "lake", "ocean", "sea", "water",
    "sky", "cloud", "sun", "moon", "stars", "night", "day",
    "tree", "grass", "rock", "stone", "dirt", "ground",
    "fire", "flame", "smoke", "fog", "mist",
    "male", "female", "humanoid", "human", "person", "people",
    "elf", "goblin", "zombie", "vampire", "dragon",
    "armor", "sword", "shield", "staff",
    "background", "foreground",
  ]);

  const isCompound = (tag: string) => tag.includes("-") || tag.includes(" ");
  const isBroad = (tag: string) => BROAD_TAGS.has(tag.toLowerCase());

  const tier1: string[] = []; // compound tags — most specific
  const tier2: string[] = []; // uncommon single-word tags
  const tier3: string[] = []; // broad/ambient single-word tags

  for (const tag of tagger.artTags) {
    if (isCompound(tag)) {
      tier1.push(tag);
    } else if (isBroad(tag)) {
      tier3.push(tag);
    } else {
      tier2.push(tag);
    }
  }

  let query: string | null = null;

  if (tier1.length >= 2) {
    // Two compound tags AND-chained is a tight, visually coherent set.
    query = `(art:"${tier1[0]}" art:"${tier1[1]}")`;
  } else if (tier1.length === 1 && tier2.length >= 1) {
    // One compound tag + one specific single-word tag: AND them to narrow.
    query = `(art:"${tier1[0]}" art:"${tier2[0]}")`;
  } else if (tier1.length === 1) {
    // Only one compound tag available, use it alone.
    query = `art:"${tier1[0]}"`;
  } else if (tier2.length >= 2) {
    // Two moderately specific tags AND-chained gives a well-scoped result.
    query = `(art:"${tier2[0]}" art:"${tier2[1]}")`;
  } else if (tier2.length === 1) {
    // One specific tag — use it alone.
    query = `art:"${tier2[0]}"`;
  } else if (tier3.length > 0) {
    // Only broad tags available. OR them so the user at least sees results
    // (AND would return almost nothing; a single broad tag is too wide alone).
    const orTerms = tier3.slice(0, 3).map((t) => `art:"${t}"`).join(" or ");
    query = tier3.length > 1 ? `(${orTerms})` : orTerms;
  }

  console.log(
    `[ArtLike] Art tags for "${tagger.name}": ` +
    `${tagger.artTags.length} total (t1=${tier1.length}, t2=${tier2.length}, t3=${tier3.length})` +
    ` -> query: ${query ?? "none"}`
  );

  if (!query) return null;
  return `${query} -name:"${tagger.name}"`;
}

/**
 * Builds a Scryfall query that finds cards similar to the given card name.
 *
 * Two signals are combined with OR:
 *
 *   1. OR chain — card names from the Tagger's SIMILAR_TO, WORSE_THAN, and
 *      WITHOUT_BODY relationships.  These are community-curated relationships
 *      that directly indicate functional similarity.
 *
 *   2. AND chain — `otag:` filters built from the card's ORACLE_CARD_TAG
 *      taggings in the Tagger.  Cards matching ALL of those tags share the
 *      same functional role.
 *
 * The queried card itself is excluded from the results via `-name:`.
 *
 * Returns null when the card cannot be found or no meaningful query can be
 * built (e.g. card has no tagger data at all).
 */
export async function resolveSimilarCardsQuery(cardName: string): Promise<string | null> {
  // Step 1: resolve the canonical card via the Scryfall REST API so we get
  // a set code + collector number needed for the Tagger GraphQL query.
  const card = await fetchCardByName(cardName);
  if (!card) {
    console.warn(`[SimilarCards] Card not found: "${cardName}"`);
    return null;
  }

  console.log(`[SimilarCards] Resolving similar-cards query for: "${card.name}" (${card.set}/${card.collector_number})`);

  // Step 2: fetch tags and relationships from the Scryfall Tagger.
  const tagger = await fetchTaggerCardData(card.set, card.collector_number);

  if (tagger) {
    return buildQueryFromTaggerData(tagger);
  }

  console.warn(`[SimilarCards] Tagger data unavailable for "${card.name}", falling back to all_parts`);

  // Fallback: use all_parts combo pieces from the Scryfall API.
  const comboPieceNames = (card.all_parts ?? [])
    .filter((p) => p.component === "combo_piece" && p.name !== card.name)
    .map((p) => p.name)
    .slice(0, 8);

  if (comboPieceNames.length === 0) return null;

  const orNames = comboPieceNames.map((n) => `name:"${n}"`).join(" or ");
  const nameClause = comboPieceNames.length > 1 ? `(${orNames})` : orNames;
  return `${nameClause} -name:"${card.name}"`;
}

/**
 * Meta/structural tag patterns that don't describe a card's gameplay function.
 * These are product-cycle labels, physical attributes, point-system markers,
 * and other noise that shouldn't be used to find functionally similar cards.
 */
const META_TAG_PATTERNS: RegExp[] = [
  /^cycle-/i,              // product cycle labels ("cycle-cmd-alt-commander")
  /^oversized$/i,          // physical card attribute
  /^reserved-list$/i,      // collectibility label
  /^repeated.keyword$/i,   // structural observation, not a function
  /^\d+(?:ph|points?)$/i,  // point-system markers ("7ph", "3points")
  /^(?:ante|manual-dexterity|silver-bordered|acorn|un-set)/i, // format/legality labels
  /^meme$/i,               // community humour label, not a function
  /^interchangeable/i,     // card equivalence label ("interchangeable-name"), not a function
  /^staple$/i,             // popularity label, not a function
  /^old-/i,                // old-templating labels ("old-lifelink", "old-typeline"), not functional
  /^playtest-/i,           // playtest / preview labels
  /^functional-reprint$/i, // reprint classification, not a function
];

/**
 * Low-priority tag patterns: real but very narrow attributes that are poor
 * signals for "similar cards" searches.  These are used only when no better
 * tags are available.
 */
const LOW_PRIORITY_PATTERNS: RegExp[] = [
  /^hate-/i,               // color-hate tags ("hate-white", "hate-black")
  /^anti-/i,               // anti-strategy tags
  /^hoser/i,               // hosers
];

function isMetaTag(tag: string): boolean {
  return tag.length < 3 || META_TAG_PATTERNS.some((p) => p.test(tag));
}

function isLowPriority(tag: string): boolean {
  return LOW_PRIORITY_PATTERNS.some((p) => p.test(tag));
}

/**
 * Filters and ranks oracle tags, returning the `limit` most functionally
 * relevant ones.  Meta/structural tags are dropped entirely; low-priority
 * tags are pushed to the back and only used when better tags don't fill
 * the quota.
 */
function selectBestTags(tags: string[], limit: number): string[] {
  const high: string[] = [];
  const low: string[] = [];

  for (const tag of tags) {
    if (isMetaTag(tag)) continue;
    if (isLowPriority(tag)) {
      low.push(tag);
    } else {
      high.push(tag);
    }
  }

  return [...high, ...low].slice(0, limit);
}

function buildQueryFromTaggerData(tagger: TaggerCardData): string | null {
  const parts: string[] = [];

  // OR chain: card names from similarity relationships
  const relatedNames = new Set<string>();
  for (const name of [...tagger.similarTo, ...tagger.worseThan, ...tagger.withoutBody]) {
    relatedNames.add(name);
  }
  relatedNames.delete(tagger.name);

  if (relatedNames.size > 0) {
    const names = [...relatedNames];
    const orNames = names.map((n) => `name:"${n}"`).join(" or ");
    parts.push(names.length > 1 ? `(${orNames})` : orNames);
  }

  // AND chain: oracle function tags, filtered and ranked.
  const selected = selectBestTags(tagger.functionTags, 2);

  if (selected.length > 0) {
    const andChain = selected.map((tag) => `otag:"${tag}"`).join(" ");
    parts.push(selected.length > 1 ? `(${andChain})` : andChain);
  }

  console.log(
    `[SimilarCards] Tagger data for "${tagger.name}": ` +
    `${relatedNames.size} related names, ` +
    `${tagger.functionTags.length} total tags -> ${selected.length} selected: [${selected.join(", ")}]`
  );

  if (parts.length === 0) return null;

  const combined = parts.length === 1 ? parts[0] : `(${parts.join(" or ")})`;
  return `${combined} -name:"${tagger.name}"`;
}
