import { scryfallFetch, SCRYFALL_BASE_URL } from "@/lib/scryfall/http";

export interface ScryfallNamedCard {
  id: string;
  oracle_id: string;
  name: string;
  set: string;
  collector_number: string;
  type_line: string;
  oracle_text?: string;
  keywords: string[];
  colors?: string[];
  color_identity: string[];
  cmc: number;
  all_parts?: Array<{
    id: string;
    component: string;
    name: string;
    type_line: string;
  }>;
  card_faces?: Array<{
    name: string;
    type_line: string;
    oracle_text?: string;
  }>;
}

/**
 * Fetches a Magic card from Scryfall by fuzzy name match.
 * Returns null if the card cannot be found or the request fails.
 */
export async function fetchCardByName(name: string): Promise<ScryfallNamedCard | null> {
  try {
    const url = new URL(`${SCRYFALL_BASE_URL}/cards/named`);
    url.searchParams.set("fuzzy", name);

    const response = await scryfallFetch(url.toString());

    if (!response.ok) return null;

    return (await response.json()) as ScryfallNamedCard;
  } catch {
    return null;
  }
}
