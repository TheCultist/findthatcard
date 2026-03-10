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

  const tier1: string[] = [];
  const tier2: string[] = [];
  const tier3: string[] = [];

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
    query = `(art:"${tier1[0]}" art:"${tier1[1]}")`;
  } else if (tier1.length === 1 && tier2.length >= 1) {
    query = `(art:"${tier1[0]}" art:"${tier2[0]}")`;
  } else if (tier1.length === 1) {
    query = `art:"${tier1[0]}"`;
  } else if (tier2.length >= 2) {
    query = `(art:"${tier2[0]}" art:"${tier2[1]}")`;
  } else if (tier2.length === 1) {
    query = `art:"${tier2[0]}"`;
  } else if (tier3.length > 0) {
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
  const card = await fetchCardByName(cardName);
  if (!card) {
    console.warn(`[SimilarCards] Card not found: "${cardName}"`);
    return null;
  }

  console.log(`[SimilarCards] Resolving similar-cards query for: "${card.name}" (${card.set}/${card.collector_number})`);

  const tagger = await fetchTaggerCardData(card.set, card.collector_number);

  // oracle_text may span card faces (e.g. DFCs); join them if needed.
  const oracleText =
    card.oracle_text ??
    card.card_faces?.map((f) => f.oracle_text ?? "").filter(Boolean).join("\n");

  if (tagger) {
    return buildQueryFromTaggerData(tagger, oracleText);
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
 * signals for "similar cards" searches.  Excluded from the AND-chain entirely.
 */
const LOW_PRIORITY_PATTERNS: RegExp[] = [
  /^hate-/i,               // color-hate tags ("hate-white", "hate-black")
  /^anti-/i,               // anti-strategy tags
  /^hoser/i,               // hosers
];

/**
 * Tags that describe a card's general category but are far too common to be
 * useful discriminators in a "similar cards" AND-chain.  Matching on
 * `otag:"draw-engine"` returns thousands of cards; it adds noise rather than
 * focus.  These tags are only used as a last resort when no specific tags or
 * oracle-text clauses are available.
 */
const BROAD_FUNCTION_TAGS = new Set([
  "draw-engine", "card-advantage", "pure-draw", "burst-draw",
  "repeatable-draw", "impulse-draw", "impulsive-draw", "drawlink",
  "ramp", "mana-ramp",
  "removal", "spot-removal", "repeatable-removal",
  "lifegain", "lifegain-matters",
  "repeatable-token-generator",
  "counterspell",
  "tutor",
  "mill", "mill-opponent",
  "discard", "discard-outlet",
]);

function isMetaTag(tag: string): boolean {
  return tag.length < 3 || META_TAG_PATTERNS.some((p) => p.test(tag));
}

function isLowPriority(tag: string): boolean {
  return LOW_PRIORITY_PATTERNS.some((p) => p.test(tag));
}

function isBroadTag(tag: string): boolean {
  return BROAD_FUNCTION_TAGS.has(tag);
}

/**
 * Scores a tag by its specificity as a "similar cards" discriminator.
 * More hyphen-segments = narrower concept = better signal.
 * Only called on tags already filtered to exclude meta, low-priority,
 * and broad entries.
 */
function tagSpecificity(tag: string): number {
  return tag.split("-").length; // "opponent-loses-life" (3) > "draw-engine" (2) > "removal" (1)
}

/**
 * Keyword bonuses used to score oracle-text candidate phrases.
 * These keywords signal a card's distinctive mechanical role; a phrase
 * that contains them is a better "similar cards" discriminator than a
 * generic trigger condition like "a creature you control leaves".
 */
const ORACLE_PHRASE_BONUSES: Array<[RegExp, number]> = [
  [/\bcounters?\b/,                   4],  // counter mechanics are highly distinctive
  [/\ban?\s+opponent\b/,              3],  // opponent-targeted effects
  [/\bdraw(?:s|ing|n)?\b/,            3],  // draw-related triggers
  [/\bsacrifice[sd]?\b/,              3],  // sacrifice triggers
  [/\bdies?\b/,                       2],  // death triggers (less specific than sacrifice)
  [/\bfor\s+each\b/,                  2],  // scaling / "for each" effects
  [/\bequal\s+to\b/,                  2],  // proportional effects
  [/\bexile[sd]?\b/,                  2],  // exile-related effects
  [/\battack(?:s|ing)?\b/,            1],  // attack triggers
  [/\bengages?\b|\bcombat\b/,         1],  // combat triggers
];

function scorePhraseBonus(phrase: string): number {
  return ORACLE_PHRASE_BONUSES.reduce(
    (acc, [re, bonus]) => acc + (re.test(phrase) ? bonus : 0),
    0
  );
}

/**
 * Extracts 1-2 short, discriminating oracle-text clauses from a card's text.
 *
 * Generates multiple candidate phrases (trigger conditions, conditional
 * effect phrases, scaling patterns) and ranks them by how many
 * "distinctiveness keywords" (counters, opponent, sacrifice, etc.) they
 * contain.  The highest-scoring phrase wins each slot.
 *
 * This ensures that for a card like The Ozolith the counter-preservation
 * phrase ("if it had counters on it") is preferred over the generic trigger
 * condition ("a creature you control leaves"), while for Scrawling Crawler
 * the opponent-draw phrase ("an opponent draws") still wins naturally.
 *
 * Returns `o:"phrase"` strings ready to drop into a Scryfall query.
 */
function buildOracleTextClauses(oracleText: string): string[] {
  const text = oracleText
    .replace(/\{[^}]+\}/g, "")    // strip mana symbols
    .replace(/\([^)]*\)/g, "")    // strip reminder text
    .toLowerCase()
    .replace(/~/g, "this permanent")
    .trim();

  const candidates: Array<{ phrase: string; score: number }> = [];

  const addCandidate = (phrase: string, baseScore: number) => {
    const trimmed = phrase.trim().replace(/\s+/g, " ");
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount < 2 || wordCount > 7) return; // too short or too long to be useful
    candidates.push({ phrase: trimmed, score: baseScore + scorePhraseBonus(trimmed) });
  };

  // "Whenever [condition]" trigger phrases (base score 1 — good but not always the most distinctive)
  for (const m of text.matchAll(/\bwhenever\s+([^,.]+)/gi)) {
    const words = m[1].trim().split(/\s+/).slice(0, 5);
    while (words.length > 2 && /^(a|an|the|to|of|for|with|or|and)$/i.test(words[words.length - 1])) {
      words.pop();
    }
    addCandidate(words.join(" "), 1);
  }

  // "At the beginning of [phase]" — phase triggers
  for (const m of text.matchAll(/\bat\s+the\s+beginning\s+of\s+(\w+(?:\s+\w+)?)/gi)) {
    addCandidate(`at the beginning of ${m[1].trim()}`, 1);
  }

  // "When [X] enters" ETB triggers
  for (const m of text.matchAll(/\bwhen\s+([\w\s]{3,25})\s+enters\b/gi)) {
    addCandidate(`when ${m[1].trim()} enters`, 1);
  }

  // Distinctive effect / conditional phrases (higher base scores)
  const EFFECT_PATTERNS: Array<[RegExp, number]> = [
    [/\bif\s+it\s+had\s+\w+(?:\s+\w+)?\s+on\s+it\b/,                4], // "if it had counters on it"
    [/\bput\s+(?:those|all|that)\s+\w+\s+on\b/,                      4], // "put those counters on"
    [/\bmove\s+all\s+\w+\s+from\b/,                                  4], // "move all counters from"
    [/\ban?\s+opponent\s+draws\b/,                                    5], // "an opponent draws"
    [/\byou\s+draw\s+(?:a|your\s+\w+)\s+card\b/,                     3], // "you draw a card"
    [/\bthat\s+player\s+(?:loses|gains)\s+\d+\s+life\b/,             3], // "that player loses N life"
    [/\bequal\s+to\s+(?:the\s+)?number\s+of\s+[\w\s]{2,20}/,        3], // "equal to the number of X"
    [/\bfor\s+each\s+[\w]+(?:\s+\w+)?\s+(?:counter|token|creature)/,3], // "for each X counter"
    [/\b\+1\/\+1\s+counter\b/,                                       3], // "+1/+1 counter"
    [/\bdeal[sd]?\s+\d+\s+damage\s+to\b/,                           2], // "deals N damage to"
    [/\bgain[sd]?\s+\d+\s+life\b/,                                   2], // "gains N life"
    [/\blose[sd]?\s+\d+\s+life\b/,                                   2], // "loses N life"
    [/\bcreate[sd]?\s+\w+\s+\w+\s+token\b/,                         2], // "creates a X token"
    [/\bwhenever\s+you\s+(?:cast|play)\b/,                           3], // "whenever you cast"
  ];

  for (const [pattern, baseScore] of EFFECT_PATTERNS) {
    for (const m of text.matchAll(new RegExp(pattern.source, "gi"))) {
      addCandidate(m[0].trim().split(/\s+/).slice(0, 6).join(" "), baseScore);
    }
  }

  candidates.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : b.phrase.split(/\s+/).length - a.phrase.split(/\s+/).length
  );

  const result: string[] = [];
  for (const { phrase } of candidates) {
    if (result.length >= 2) break;
    const alreadyCovered = result.some((r) => {
      const existing = r.slice(3, -1); // strip o:" and "
      return existing.includes(phrase) || phrase.includes(existing);
    });
    if (!alreadyCovered) {
      result.push(`o:"${phrase}"`);
    }
  }

  return result;
}

/**
 * Builds the AND-chain items (otag: or o: clauses) for the similar-cards query.
 *
 * Slot assignment (limit = 2):
 *   Slot 1 — Best specific tagger tag (highest segment count, not broad/meta).
 *   Slot 2 — Oracle-text clause (PREFERRED over a second tagger tag).
 *            Oracle text is the ground truth for card mechanics; it is always
 *            more precise than a second community tag.  Tagger tags can be
 *            mislabeled or overly broad — the oracle text phrase directly
 *            fingerprints the trigger or effect that makes this card unique.
 *   Fallback — If no oracle text clause is available, fill with the next
 *              specific tagger tag, then broad tagger tags as a last resort.
 */
function buildAndChainItems(
  tags: string[],
  oracleText: string | undefined,
  limit: number
): string[] {
  const usable = tags.filter((t) => !isMetaTag(t) && !isLowPriority(t));
  const specificTags = usable
    .filter((t) => !isBroadTag(t))
    .sort((a, b) => tagSpecificity(b) - tagSpecificity(a));
  const broadTags = usable.filter((t) => isBroadTag(t));
  const oracleClauses = oracleText ? buildOracleTextClauses(oracleText) : [];

  const items: string[] = [];

  if (specificTags.length > 0) {
    items.push(`otag:"${specificTags[0]}"`);
  }

  for (const clause of oracleClauses) {
    if (items.length >= limit) break;
    items.push(clause);
  }

  for (let i = 1; i < specificTags.length; i++) {
    if (items.length >= limit) break;
    items.push(`otag:"${specificTags[i]}"`);
  }

  for (const tag of broadTags) {
    if (items.length >= limit) break;
    items.push(`otag:"${tag}"`);
  }

  return items;
}

function buildQueryFromTaggerData(tagger: TaggerCardData, oracleText?: string): string | null {
  const parts: string[] = [];

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

  const andItems = buildAndChainItems(tagger.functionTags, oracleText, 2);

  if (andItems.length > 0) {
    parts.push(andItems.length > 1 ? `(${andItems.join(" ")})` : andItems[0]);
  }

  const oracleUsed = andItems.some((item) => item.startsWith('o:"'));
  console.log(
    `[SimilarCards] Tagger data for "${tagger.name}": ` +
    `${relatedNames.size} related names, ` +
    `${tagger.functionTags.length} total tags -> ${andItems.length} AND-chain items: [${andItems.join(", ")}]` +
    (oracleUsed ? ` (oracle text used)` : "")
  );

  if (parts.length === 0) return null;

  const combined = parts.length === 1 ? parts[0] : `(${parts.join(" or ")})`;
  return `${combined} -name:"${tagger.name}"`;
}
