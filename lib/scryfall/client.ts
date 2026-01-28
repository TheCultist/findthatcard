import { ScryfallError, ScryfallSearchResponse } from "@/types/scryfall";
import { PREFER_BEST_PREFIX } from "@/lib/scryfall/query-converter";

const SCRYFALL_BASE_URL = "https://api.scryfall.com";
const SCRYFALL_USER_AGENT =
  process.env.SCRYFALL_USER_AGENT || "find-that-card/1.0 (+https://findthat.card)";
export const CARDS_PER_PAGE = 60;

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

function buildQueryWithPrefer(query: string): string {
  let queryWithPrefer = `${PREFER_BEST_PREFIX}${query}`;
  const queryLower = query.toLowerCase();
  if (
    queryLower.includes("is:dfc") &&
    !queryLower.includes("-is:art") &&
    !queryLower.includes("is:art") &&
    !queryLower.includes("t:art")
  ) {
    queryWithPrefer = `${PREFER_BEST_PREFIX}${query} -is:art`;
  }
  return queryWithPrefer;
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
  const queryWithPrefer = buildQueryWithPrefer(query);

  const url = new URL(`${SCRYFALL_BASE_URL}/cards/search`);
  url.searchParams.set("q", queryWithPrefer);
  url.searchParams.set("unique", "cards");
  url.searchParams.set("page", scryfallPage.toString());

  console.log(
    `[Scryfall] Executing search with query: "${queryWithPrefer}" (our page ${page} -> Scryfall page ${scryfallPage}, offset ${offset})`
  );

  try {
    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent": SCRYFALL_USER_AGENT,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorData: ScryfallError = await response.json().catch(() => ({
        object: "error",
        code: "unknown",
        status: response.status,
        details: response.statusText,
      }));

      throw new Error(errorData.details || `Scryfall API error: ${response.statusText}`);
    }

    const data: ScryfallSearchResponse = await response.json();

    // Check if we need to fetch more cards from the next Scryfall page
    const cardsAvailable = data.data.length - offset;
    if (cardsAvailable < CARDS_PER_PAGE && data.has_more) {
      // Fetch the next Scryfall page to get remaining cards
      const nextPageUrl = new URL(`${SCRYFALL_BASE_URL}/cards/search`);
      nextPageUrl.searchParams.set("q", queryWithPrefer);
      nextPageUrl.searchParams.set("unique", "cards");
      nextPageUrl.searchParams.set("page", (scryfallPage + 1).toString());

      const nextResponse = await fetch(nextPageUrl.toString(), {
        headers: {
          "User-Agent": SCRYFALL_USER_AGENT,
          Accept: "application/json",
        },
      });

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
