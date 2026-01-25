import { SearchResponse, CardResult, ScryfallCard } from "@/types/scryfall";

const MAX_QUERY_LENGTH = 400;

/**
 * Validates natural language query input
 */
export function validateNaturalQuery(query: string): { valid: boolean; error?: string } {
  if (!query || typeof query !== "string") {
    return { valid: false, error: "Query is required" };
  }

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "Query cannot be empty" };
  }

  if (trimmed.length > MAX_QUERY_LENGTH) {
    return {
      valid: false,
      error: `Query must be ${MAX_QUERY_LENGTH} characters or less`,
    };
  }

  return { valid: true };
}

const CARDS_PER_PAGE = 60;

/**
 * Trims Scryfall response to only include necessary fields
 */
export function transformScryfallResponse(
  scryfallQuery: string,
  page: number,
  offset: number,
  scryfallResponse: {
    total_cards: number;
    has_more: boolean;
    data: ScryfallCard[];
  }
): SearchResponse {
  // Slice the data starting from the offset, taking up to 60 cards
  const slicedData = scryfallResponse.data.slice(offset, offset + CARDS_PER_PAGE);
  
  const cards: CardResult[] = slicedData.map((card) => ({
    id: card.id,
    name: card.name,
    mana_cost: card.mana_cost || null,
    type_line: card.type_line,
    oracle_text: card.oracle_text || null,
    image_uris: {
      normal: card.image_uris?.normal || card.image_uris?.large || null,
      small: card.image_uris?.small || null, // Fallback
    },
    scryfall_uri: card.scryfall_uri,
  }));

  // Determine if there are more pages
  // Calculate how many cards we've shown so far (including this page)
  const cardsShownSoFar = (page - 1) * CARDS_PER_PAGE + cards.length;
  // We have more pages if we haven't shown all the cards yet
  const hasMore = cardsShownSoFar < scryfallResponse.total_cards;

  return {
    scryfallQuery,
    total: scryfallResponse.total_cards,
    has_more: hasMore,
    page,
    per_page: CARDS_PER_PAGE,
    cards,
  };
}

/**
 * Formats error messages for user display
 */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "An unexpected error occurred";
}
