import { SearchResponse, CardResult, ScryfallCard } from "@/types/scryfall";
import { getTcgPlayerLink } from "@/lib/tcgplayer/links";
import { CARDS_PER_PAGE } from "@/lib/scryfall/client";

type CardSearchResponse = {
  data?: ScryfallCard[];
};
const SCRYFALL_USER_AGENT =
  process.env.SCRYFALL_USER_AGENT || "find-that-card/1.0 (+https://findthatcard.net)";

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
  }
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

  const cardResults = await Promise.all(
    slicedData.map(async (card): Promise<CardResult | null> => {
      // Check if this card is an alchemy card
      const isAlchemy =
        card.set_name?.toLowerCase().includes("alchemy") ||
        card.set_type?.toLowerCase() === "alchemy";

      // If card is alchemy and query doesn't explicitly ask for alchemy, replace with non-alchemy version
      if (isAlchemy && !explicitlyAsksForAlchemy && card.oracle_id) {
        try {
          // Fetch a non-alchemy print of this card using oracle_id
          const baseCardResponse = await fetch(
            `https://api.scryfall.com/cards/search?q=prefer:best+oracle_id:${card.oracle_id}+-is:alchemy+-is:digital+-is:rebalanced&unique=prints&order=released&dir=asc&limit=1`,
            {
              headers: {
                "User-Agent": SCRYFALL_USER_AGENT,
              },
            }
          );

          if (baseCardResponse.ok) {
            const baseCardData: CardSearchResponse = await baseCardResponse.json();
            if (baseCardData.data && baseCardData.data.length > 0) {
              // Replace the alchemy card with the non-alchemy version
              const basePrint = baseCardData.data[0];
              // Use the non-alchemy card's data instead
              card = basePrint as ScryfallCard;
            } else {
              // No non-alchemy version found - exclude this card by returning null
              return null;
            }
          } else {
            // If search fails, try alternative: get all prints and filter client-side
            const printsResponse = await fetch(
              `https://api.scryfall.com/cards/search?q=prefer:best+oracle_id:${card.oracle_id}&unique=prints&order=released&dir=asc`,
              {
                headers: {
                  "User-Agent": SCRYFALL_USER_AGENT,
                },
              }
            );

            if (printsResponse.ok) {
              const printsData: CardSearchResponse = await printsResponse.json();
              // Find the first non-alchemy, non-digital, non-rebalanced print
              const basePrint = printsData.data?.find((print) => {
                const printSetName = (print.set_name || "").toLowerCase();
                const printSetType = (print.set_type || "").toLowerCase();
                const printIsDigital = print.digital === true;
                return (
                  !printSetName.includes("alchemy") &&
                  printSetType !== "alchemy" &&
                  !printIsDigital
                );
              });

              if (basePrint) {
                // Replace with non-alchemy version
                card = basePrint as ScryfallCard;
              } else {
                // No non-alchemy version found - exclude this card
                return null;
              }
            } else {
              // If we can't fetch prints, exclude the alchemy card
              return null;
            }
          }
        } catch (error) {
          // If fetching fails, exclude the alchemy card
          console.warn(
            `Failed to fetch non-alchemy version for ${card.name}, excluding from results:`,
            error
          );
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

      // For alchemy cards when explicitly requested, fetch the base card name for CardTrader links
      // Also check if set is digital/online-only and find a non-digital set
      let cardName = card.name;
      let setName = card.set_name || null;
      let setType = card.set_type || null;

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
      const cardIsAlchemy =
        card.set_name?.toLowerCase().includes("alchemy") ||
        card.set_type?.toLowerCase() === "alchemy";
      const isDigital = card.digital === true;

      if (cardIsAlchemy && card.oracle_id) {
        // Handle alchemy cards - fetch base card name for CardTrader links
        try {
          // Fetch a non-alchemy print of this card using oracle_id
          const baseCardResponse = await fetch(
            `https://api.scryfall.com/cards/search?q=prefer:best+oracle_id:${card.oracle_id}+-is:alchemy+-is:digital+-is:rebalanced&unique=prints&order=released&dir=asc&limit=1`,
            {
              headers: {
                "User-Agent": SCRYFALL_USER_AGENT,
              },
            }
          );

          if (baseCardResponse.ok) {
            const baseCardData: CardSearchResponse = await baseCardResponse.json();
            if (baseCardData.data && baseCardData.data.length > 0) {
              const basePrint = baseCardData.data[0];
              // Use the first non-alchemy print's name (this should be the base card name)
              cardName = basePrint.name;
            }
          } else {
            // If search fails, try alternative: get all prints and filter client-side
            const printsResponse = await fetch(
              `https://api.scryfall.com/cards/search?q=prefer:best+oracle_id:${card.oracle_id}&unique=prints&order=released&dir=asc`,
              {
                headers: {
                  "User-Agent": SCRYFALL_USER_AGENT,
                },
              }
            );

            if (printsResponse.ok) {
              const printsData: CardSearchResponse = await printsResponse.json();
              // Find the first non-alchemy, non-digital, non-rebalanced print
              const basePrint = printsData.data?.find((print) => {
                const printSetName = (print.set_name || "").toLowerCase();
                const printSetType = (print.set_type || "").toLowerCase();
                const printIsDigital = print.digital === true;
                return (
                  !printSetName.includes("alchemy") &&
                  printSetType !== "alchemy" &&
                  !printIsDigital
                );
              });

              if (basePrint) {
                // Use the base print's name if this is an alchemy card
                cardName = basePrint.name;
              }
            }
          }
        } catch (error) {
          // If fetching fails, fall back to using the alchemy card name
          console.warn(
            `Failed to fetch base card name for alchemy card ${card.name}:`,
            error
          );
        }
      } else if (isDigital && card.oracle_id) {
        // Handle digital-only cards (non-alchemy) - find a non-digital set
        try {
          // Fetch a non-digital print of this card using oracle_id
          const baseCardResponse = await fetch(
            `https://api.scryfall.com/cards/search?q=prefer:best+oracle_id:${card.oracle_id}+-is:digital+-is:alchemy+-is:rebalanced&unique=prints&order=released&dir=asc&limit=1`,
            {
              headers: {
                "User-Agent": SCRYFALL_USER_AGENT,
              },
            }
          );

          if (baseCardResponse.ok) {
            const baseCardData: CardSearchResponse = await baseCardResponse.json();
            if (baseCardData.data && baseCardData.data.length > 0) {
              const basePrint = baseCardData.data[0];
              // Update set name and type to use non-digital set
              setName = basePrint.set_name || setName;
              setType = basePrint.set_type || setType;
            }
          } else {
            // If search fails, try alternative: get all prints and filter client-side
            const printsResponse = await fetch(
              `https://api.scryfall.com/cards/search?q=prefer:best+oracle_id:${card.oracle_id}&unique=prints&order=released&dir=asc`,
              {
                headers: {
                  "User-Agent": SCRYFALL_USER_AGENT,
                },
              }
            );

            if (printsResponse.ok) {
              const printsData: CardSearchResponse = await printsResponse.json();
              // Find the first non-digital, non-alchemy, non-rebalanced print
              const basePrint = printsData.data?.find((print) => {
                const printSetName = (print.set_name || "").toLowerCase();
                const printSetType = (print.set_type || "").toLowerCase();
                const printIsDigital = print.digital === true;
                return (
                  !printIsDigital &&
                  !printSetName.includes("alchemy") &&
                  printSetType !== "alchemy"
                );
              });

              if (basePrint) {
                // Update set name and type to use non-digital set
                setName = basePrint.set_name || setName;
                setType = basePrint.set_type || setType;
              }
            }
          }
        } catch (error) {
          // If fetching fails, fall back to using the digital set name
          console.warn(
            `Failed to fetch non-digital set for card ${card.name}:`,
            error
          );
        }
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
        set_name: setName, // Use non-digital set name if card was digital-only
        set_type: setType, // Use non-digital set type if card was digital-only
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
    })
  );

  // Filter out null results (excluded alchemy cards)
  const cards: CardResult[] = cardResults.filter(
    (card): card is CardResult => {
      return card !== null;
    }
  );

  const cardsShownSoFar = (page - 1) * CARDS_PER_PAGE + cards.length;
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
