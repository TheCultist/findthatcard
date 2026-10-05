import { ScryfallError, ScryfallSearchResponse } from "@/types/scryfall";
import { scryfallFetch, SCRYFALL_BASE_URL } from "@/lib/scryfall/http";

export const CARDS_PER_PAGE = 60;

/** Scryfall answered with an error. A 4xx `message` is Scryfall's explanation of the query — safe to show. */
export class ScryfallResponseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Calculates which Scryfall page to fetch and the offset within that page
 * Since Scryfall returns ~175 cards per page and we want 60 per page:
 * - Our page 1 = Scryfall page 1, offset 0
 * - Our page 2 = Scryfall page 1, offset 60
 * - Our page 3 = Scryfall page 2, offset 0 (approximately)
 */
function calculateScryfallPage(ourPage: number): { scryfallPage: number; offset: number } {
  // Scryfall returns approximately 175 cards per page
  const SCRYFALL_CARDS_PER_PAGE = 175;
  const totalOffset = (ourPage - 1) * CARDS_PER_PAGE;
  const scryfallPage = Math.floor(totalOffset / SCRYFALL_CARDS_PER_PAGE) + 1;
  const offset = totalOffset % SCRYFALL_CARDS_PER_PAGE;
  return { scryfallPage, offset };
}

/**
 * Final touch-ups before the request. The pipeline owns the `prefer:` prefix (added to
 * generated queries in finalize, left alone for raw Scryfall input), so it is NOT forced here.
 */
function buildScryfallQuery(query: string): string {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  // Double-faced searches pick up art-series cards; exclude them unless the query addresses art.
  if (lower.includes("is:dfc") && !lower.includes("is:art") && !lower.includes("t:art")) {
    return `${trimmed} -is:art`;
  }
  return trimmed;
}

/**
 * Executes Scryfall search
 * May fetch multiple Scryfall pages if needed to get 60 cards
 */
export async function searchScryfall(
  query: string,
  page: number = 1
): Promise<{ response: ScryfallSearchResponse; offset: number }> {
  const { scryfallPage, offset } = calculateScryfallPage(page);
  const queryWithPrefer = buildScryfallQuery(query);

  const url = new URL(`${SCRYFALL_BASE_URL}/cards/search`);
  url.searchParams.set("q", queryWithPrefer);
  url.searchParams.set("unique", "cards");
  url.searchParams.set("page", scryfallPage.toString());

  console.log(
    `[Scryfall] Executing search with query: "${queryWithPrefer}" (our page ${page} -> Scryfall page ${scryfallPage}, offset ${offset})`
  );

  try {
    const response = await scryfallFetch(url.toString());

    if (!response.ok) {
      const errorData: ScryfallError = await response.json().catch(() => ({
        object: "error",
        code: "unknown",
        status: response.status,
        details: response.statusText,
      }));

      if (response.status === 404) {
        return {
          response: {
            object: "list",
            total_cards: 0,
            has_more: false,
            data: [],
          },
          offset: 0,
        };
      }

      throw new ScryfallResponseError(
        errorData.details || `Scryfall API error: ${response.statusText}`,
        response.status
      );
    }

    const data: ScryfallSearchResponse = await response.json();

    const cardsAvailable = data.data.length - offset;
    if (cardsAvailable < CARDS_PER_PAGE && data.has_more) {
      const nextPageUrl = new URL(`${SCRYFALL_BASE_URL}/cards/search`);
      nextPageUrl.searchParams.set("q", queryWithPrefer);
      nextPageUrl.searchParams.set("unique", "cards");
      nextPageUrl.searchParams.set("page", (scryfallPage + 1).toString());

      const nextResponse = await scryfallFetch(nextPageUrl.toString());

      if (nextResponse.ok) {
        const nextData: ScryfallSearchResponse = await nextResponse.json();
        // Combine cards from both pages
        const combinedData: ScryfallSearchResponse = {
          ...data,
          data: [...data.data, ...nextData.data],
        };
        return { response: combinedData, offset };
      }
    }

    return { response: data, offset };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to search Scryfall");
  }
}
