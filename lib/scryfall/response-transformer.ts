import { SearchResponse, CardResult, ScryfallCard } from "@/types/scryfall";
import { getTcgPlayerLink } from "@/lib/tcgplayer/links";
import { CARDS_PER_PAGE, searchScryfall } from "@/lib/scryfall/client";
import { scryfallFetch, SCRYFALL_BASE_URL } from "@/lib/scryfall/http";
import type { SearchSort } from "@/lib/search-sort";

type CardSearchResponse = {
  data?: ScryfallCard[];
  has_more?: boolean;
};

/**
 * Character budget for the parenthesised id group of a lookup query. Scryfall silently cuts `q`
 * at 1024 characters, and a cut inside the group is a 400; the fixed parts add ~60.
 */
const GROUP_BUDGET = 880;
/** Same-day printings of a few cards fit one page; this only guards against a runaway has_more. */
const SAME_DAY_MAX_PAGES = 5;
/** Pages with nothing to show that one request will skip; each costs a few lookups at 2/s. */
const MAX_SKIPPED_PAGES = 2;

function isAlchemyCard(card: ScryfallCard): boolean {
  return (
    card.set_name?.toLowerCase().includes("alchemy") ||
    card.set_type?.toLowerCase() === "alchemy"
  );
}

/** The client-side equivalent of `-is:alchemy -is:digital` for the unfiltered fallback. */
function isPaperPrint(print: ScryfallCard): boolean {
  return !isAlchemyCard(print) && print.digital !== true;
}

/** Greedily packs clauses into `(a or b or …)` groups that stay within the budget. */
function packGroups(clauses: string[]): string[] {
  const groups: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const clause of clauses) {
    if (current.length && length + 4 + clause.length > GROUP_BUDGET) {
      groups.push(`(${current.join(" or ")})`);
      current = [];
      length = 0;
    }
    current.push(clause);
    length += (current.length > 1 ? 4 : 0) + clause.length;
  }
  if (current.length) groups.push(`(${current.join(" or ")})`);
  return groups;
}

function searchUrl(params: Record<string, string>): string {
  const url = new URL(`${SCRYFALL_BASE_URL}/cards/search`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * Step 1 — one request per group: `unique=cards` collapses each oracle_id to a single printing
 * and `prefer:oldest` makes it one from the card's oldest release date. Which same-day printing
 * Scryfall picks is not the one the app wants, but its date is what step 2 needs. 404 is "no
 * matches"; returns null when Scryfall rejects the query and throws when it can't answer it.
 */
async function oldestPrints(
  query: string,
  wanted: Set<string>,
  accept: (print: ScryfallCard) => boolean
): Promise<Map<string, ScryfallCard> | null> {
  const response = await scryfallFetch(searchUrl({ q: `prefer:oldest ${query}`, unique: "cards" }));
  const found = new Map<string, ScryfallCard>();
  if (response.status === 404) return found;
  if (response.status === 429 || response.status >= 500) {
    throw new Error(`oldest printings lookup answered ${response.status}`);
  }
  if (!response.ok) return null;
  const data: CardSearchResponse = await response.json();
  for (const print of data.data ?? []) {
    const id = print.oracle_id;
    if (id && wanted.has(id) && !found.has(id) && accept(print)) found.set(id, print);
  }
  return found;
}

/**
 * Step 2 — the printings from each card's oldest date only, in `order=released dir=asc`, whose
 * first entry per card is exactly what the original one-query-per-card lookup returned (same
 * ordering over a subset that contains it: same date, set code, collector number). Replaces
 * entries of `prints` as it goes and throws on a failed request, so everything not reached keeps
 * step 1's printing.
 */
async function replaceWithFirstSameDayPrints(
  oldest: Map<string, ScryfallCard>,
  prints: Map<string, ScryfallCard>
): Promise<void> {
  const replaced = new Set<string>();
  const clauses = [...oldest]
    .filter(([, print]) => print.released_at)
    .map(([id, print]) => `(date=${print.released_at} oracle_id:${id})`);
  for (const group of packGroups(clauses)) {
    const wanted = new Set([...oldest.keys()].filter((id) => group.includes(id)));
    for (let page = 1; page <= SAME_DAY_MAX_PAGES; page++) {
      const response = await scryfallFetch(
        searchUrl({
          q: `prefer:best ${group} -is:alchemy -is:digital -is:rebalanced`,
          unique: "prints",
          order: "released",
          dir: "asc",
          page: String(page),
        })
      );
      if (!response.ok) throw new Error(`same-day printings lookup answered ${response.status}`);
      const data: CardSearchResponse = await response.json();
      for (const print of data.data ?? []) {
        const id = print.oracle_id;
        if (id && wanted.has(id) && !replaced.has(id)) {
          replaced.add(id);
          prints.set(id, print);
        }
      }
      if ([...wanted].every((id) => replaced.has(id)) || !data.has_more) break;
    }
  }
}

/**
 * Finds, for each oracle_id, the paper printing (not Alchemy, not digital, not rebalanced) that
 * the original per-card query returned — the first of `order=released dir=asc` — in a handful of
 * requests: one per ~15 ids to learn each card's oldest date, then one per ~13 ids for the
 * printings on those dates. If Scryfall rejects the filtered step-1 query, it is retried
 * unfiltered and filtered here (a card whose oldest printing is digital can't be settled that
 * way). If Scryfall stops answering, no further requests are sent. `prints` has the ids with a
 * paper printing; `unresolved` the ids nobody can say about yet, so neither absence is mistaken
 * for "no paper printing exists".
 */
async function findPaperPrints(
  oracleIds: Iterable<string>
): Promise<{ prints: Map<string, ScryfallCard>; unresolved: Set<string> }> {
  const ids = [...new Set(oracleIds)];
  const unresolved = new Set(ids);
  const oldest = new Map<string, ScryfallCard>();
  for (const group of packGroups(ids.map((id) => `oracle_id:${id}`))) {
    const wanted = new Set(ids.filter((id) => group.includes(id)));
    try {
      const filtered = await oldestPrints(`${group} -is:alchemy -is:digital -is:rebalanced`, wanted, () => true);
      const found = filtered ?? (await oldestPrints(group, wanted, isPaperPrint));
      if (!found) throw new Error("oldest printings lookup rejected, filtered and unfiltered");
      for (const [id, print] of found) oldest.set(id, print);
      for (const id of filtered ? wanted : found.keys()) unresolved.delete(id);
    } catch (error) {
      console.warn(`Paper-printing lookup stopped with ${unresolved.size} card(s) unresolved:`, error);
      break;
    }
  }

  const prints = new Map(oldest);
  try {
    if (oldest.size > 0) await replaceWithFirstSameDayPrints(oldest, prints);
  } catch (error) {
    console.warn("Same-day printings lookup failed; using the printings Scryfall preferred instead:", error);
  }
  return { prints, unresolved };
}

/**
 * Trims Scryfall response to only include necessary fields
 */
export async function transformScryfallResponse(
  scryfallQuery: string,
  page: number,
  offset: number,
  scryfallResponse: {
    total_cards: number;
    has_more: boolean;
    data: ScryfallCard[];
  },
  upstreamIncomplete: boolean = false
): Promise<SearchResponse> {
  // Check if query explicitly asks for alchemy/arena cards
  const queryLower = scryfallQuery.toLowerCase();
  const explicitlyAsksForAlchemy =
    queryLower.includes("is:alchemy") || queryLower.includes("game:arena");

  const slicedData = scryfallResponse.data.slice(offset, offset + CARDS_PER_PAGE);

  const getImageUris = (card: ScryfallCard) => {
    if (card.image_uris) {
      return card.image_uris;
    }

    const firstFaceWithImage = card.card_faces?.find((face) => face.image_uris);
    return firstFaceWithImage?.image_uris;
  };

  /** Replaced by its paper printing, or hidden when an Alchemy card has none. */
  const swapsToPaper = (card: ScryfallCard) =>
    !explicitlyAsksForAlchemy && !!card.oracle_id && (isAlchemyCard(card) || card.digital === true);
  const canBeHidden = (card: ScryfallCard) => swapsToPaper(card) && isAlchemyCard(card);
  // Alchemy names are looked up even when the card stays, so explicit queries still need the print.
  const needsPaperPrint = (card: ScryfallCard) => swapsToPaper(card) || (!!card.oracle_id && isAlchemyCard(card));

  // Page numbers are slices of Scryfall's list, so `rest` is what later pages will show. If all that
  // is left might be hidden, settle it now: otherwise Next could lead to an empty last page.
  const rest = scryfallResponse.data.slice(offset + CARDS_PER_PAGE);
  const checkRest = !scryfallResponse.has_more && rest.length <= CARDS_PER_PAGE && rest.every(canBeHidden);

  // Every card that needs its earliest paper printing, resolved up front in a few requests.
  const { prints: paperPrints, unresolved } = await findPaperPrints(
    [...slicedData, ...(checkRest ? rest : [])].filter(needsPaperPrint).map((card) => card.oracle_id as string)
  );

  const cardResults = slicedData.map((card): CardResult | null => {
    if (swapsToPaper(card)) {
      const basePrint = paperPrints.get(card.oracle_id as string);
      if (basePrint) {
        // Use the paper card's data instead
        card = basePrint;
      } else if (canBeHidden(card) && !unresolved.has(card.oracle_id as string)) {
        // No paper version exists - exclude this card. If the lookup never answered we can't know,
        // so it stays as it is and the response says so.
        return null;
      }
    }

    // Now process the card (which may have been replaced with a non-alchemy version)
    const imageUris = getImageUris(card);

    // For split cards and other multi-faced cards, prioritize card_faces mana costs
    let manaCost = card.mana_cost;
    if (card.card_faces && card.card_faces.length > 0) {
      // Get mana cost from all faces, separated by slash for split cards
      const faceManaCosts = card.card_faces
        .map((face) => face.mana_cost)
        .filter((cost): cost is string => !!cost);
      if (faceManaCosts.length > 0) {
        // Join with " / " to separate the costs visually
        // This ensures split cards show separate costs instead of combined
        manaCost = faceManaCosts.join(" / ");
      }
    }

    // For alchemy cards when explicitly requested, use the base card name for CardTrader links
    let cardName = card.name;

    // If card name starts with "A-", check all_parts for a non-A- version
    if (cardName.startsWith("A-") && card.all_parts && card.all_parts.length > 0) {
      // Look for a related card that doesn't start with "A-"
      const baseCardPart = card.all_parts.find(
        (part) => !part.name.startsWith("A-")
      );
      if (baseCardPart) {
        cardName = baseCardPart.name;
      }
    }

    // Re-check if card is alchemy (it might have been replaced above)
    const basePrint = card.oracle_id ? paperPrints.get(card.oracle_id) : undefined;
    if (isAlchemyCard(card) && basePrint) {
      // Alchemy card: the first non-alchemy print's name (this should be the base card name)
      cardName = basePrint.name;
    }

    return {
      id: card.id,
      name: cardName, // Use base name for alchemy cards, original name otherwise
      mana_cost: manaCost || null,
      type_line: card.type_line,
      oracle_text: card.oracle_text || null,
      image_uris: {
        normal: imageUris?.normal || imageUris?.large || null,
        small: imageUris?.small || null, // Fallback
      },
      card_faces: card.card_faces && card.card_faces.length > 1
        ? card.card_faces.map(face => ({
            name: face.name,
            image_uris: face.image_uris,
          }))
        : undefined,
      scryfall_uri: card.scryfall_uri,
      set_name: card.set_name || null,
      set_type: card.set_type || null,
      oracle_id: card.oracle_id || null,
      cardtrader_blueprint_ids: null, // Not used anymore - linking to homepage instead
      collector_number: card.collector_number || null,
      set_code: card.set || null,
      tcgplayer_id: card.tcgplayer_id ?? null,
      tcgplayer_link: getTcgPlayerLink({
        tcgplayerId: card.tcgplayer_id ?? null,
        destinationUrl: card.purchase_uris?.tcgplayer ?? null,
      }),
      prices: {
        // Foil-only printings have no non-foil listing; fall back so the card still shows a price.
        usd: card.prices?.usd ?? card.prices?.usd_foil ?? null,
        eur: card.prices?.eur ?? card.prices?.eur_foil ?? null,
      },
    };
  });

  // Filter out null results (excluded alchemy cards)
  const cards: CardResult[] = cardResults.filter(
    (card): card is CardResult => {
      return card !== null;
    }
  );

  const hasMore =
    scryfallResponse.has_more ||
    rest.length > CARDS_PER_PAGE ||
    rest.some((card) => {
      const id = card.oracle_id as string;
      return !canBeHidden(card) || paperPrints.has(id) || unresolved.has(id);
    });

  return {
    scryfallQuery,
    total: scryfallResponse.total_cards,
    has_more: hasMore,
    page,
    per_page: CARDS_PER_PAGE,
    cards,
    excluded: slicedData.length - cards.length,
    incomplete: upstreamIncomplete || slicedData.some((card) => card.oracle_id && unresolved.has(card.oracle_id)),
  };
}

/**
 * One page of results as the app shows it. A page whose cards were all hidden is skipped so Next
 * doesn't land on nothing; page numbers still map to Scryfall's list, so skipping loses no card.
 */
export async function searchResultsPage(
  scryfallQuery: string,
  page: number,
  sort: SearchSort | null = null
): Promise<SearchResponse> {
  let excludedBefore = 0;
  for (let target = page; ; target++) {
    const { response, offset, incomplete } = await searchScryfall(scryfallQuery, target, sort);
    const result = await transformScryfallResponse(scryfallQuery, target, offset, response, incomplete);
    const keepGoing =
      result.cards.length === 0 && result.has_more && !result.incomplete && target - page < MAX_SKIPPED_PAGES;
    if (!keepGoing) {
      const excluded = excludedBefore + result.excluded;
      return target === page ? result : { ...result, excluded, from_page: page };
    }
    excludedBefore += result.excluded;
  }
}
