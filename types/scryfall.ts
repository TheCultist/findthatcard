// Scryfall API response types
export interface ScryfallImageUris {
  small?: string;
  normal?: string;
  large?: string;
  png?: string;
  art_crop?: string;
  border_crop?: string;
}

export interface ScryfallCard {
  id: string;
  name: string;
  mana_cost?: string;
  type_line: string;
  oracle_text?: string;
  image_uris?: ScryfallImageUris;
  scryfall_uri: string;
}

export interface ScryfallSearchResponse {
  object: "list";
  total_cards: number;
  has_more: boolean;
  data: ScryfallCard[];
}

export interface ScryfallError {
  object: "error";
  code: string;
  status: number;
  details: string;
}

// API request/response types
export interface SearchRequest {
  naturalQuery: string;
  page?: number;
}

export interface SearchResponse {
  scryfallQuery: string;
  total: number;
  has_more: boolean;
  page: number;
  per_page: number;
  cards: CardResult[];
}

export interface CardResult {
  id: string;
  name: string;
  mana_cost: string | null;
  type_line: string;
  oracle_text: string | null;
  image_uris: {
    normal: string | null;
    small: string | null; // Fallback
  };
  scryfall_uri: string;
}

export interface ErrorResponse {
  error: string;
  details?: string;
  scryfallQuery?: string; // Include the generated query even on error
}
