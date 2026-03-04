import { fetchCardByName } from "@/lib/scryfall/lookup";
import { fetchTaggerCardData, TaggerCardData } from "@/lib/scryfall/tagger-graphql";

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
  /^repeated keyword$/i,   // structural observation, not a function
  /^\d+(?:ph|points?)$/i,  // point-system markers ("7ph", "3points")
  /^(?:ante|manual-dexterity|silver-bordered|acorn|un-set)/i, // format/legality labels
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
  const selected = selectBestTags(tagger.functionTags, 4);

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
