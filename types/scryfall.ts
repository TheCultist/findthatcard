// Scryfall API response types
export interface ScryfallImageUris {
  small?: string;
  normal?: string;
  large?: string;
  png?: string;
  art_crop?: string;
  border_crop?: string;
}

export interface ScryfallCardFace {
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  image_uris?: ScryfallImageUris;
}

export interface ScryfallRelatedCard {
  id: string;
  name: string;
  type: string; // e.g., "token", "meld_part", "meld_result", "combo_piece"
  uri: string;
}

export interface ScryfallPurchaseUris {
  tcgplayer?: string;
}

export interface ScryfallCard {
  id: string;
  name: string;
  mana_cost?: string;
  type_line: string;
  oracle_text?: string;
  image_uris?: ScryfallImageUris;
  card_faces?: ScryfallCardFace[];
  scryfall_uri: string;
  set_name?: string;
  set?: string; // Set code (e.g., "lea", "war")
  set_type?: string; // Set type (e.g., "commander", "expansion", "alchemy")
  oracle_id?: string; // Oracle ID for finding base card (useful for alchemy cards)
  digital?: boolean; // Whether this is a digital-only card
  collector_number?: string; // Collector number for this printing
  all_parts?: ScryfallRelatedCard[]; // Related cards (tokens, meld parts, etc.)
  tcgplayer_id?: number; // TCGPlayer product ID for this printing
  purchase_uris?: ScryfallPurchaseUris; // Purchase links for this card
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
  card_faces?: Array<{
    name: string;
    image_uris?: ScryfallImageUris;
  }>;
  scryfall_uri: string;
  set_name: string | null;
  set_type: string | null;
  oracle_id: string | null;
  cardtrader_blueprint_ids: number[] | null; // CardTrader blueprint IDs for this card
  collector_number: string | null; // Collector number for this printing
  set_code: string | null; // Set code (e.g., "lea", "war")
  tcgplayer_id: number | null; // TCGPlayer product ID for this printing
  tcgplayer_link: string | null; // TCGPlayer partner link for this printing
}

export interface ErrorResponse {
  error: string;
  details?: string;
  scryfallQuery?: string; // Include the generated query even on error
}

// Detailed card face data (from single-card Scryfall API)
export interface CardDetailFace {
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  flavor_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  defense?: string;
  artist?: string;
  image_uris?: ScryfallImageUris;
}

// Full card detail data returned by the Scryfall single-card endpoint
export interface CardDetailData {
  id: string;
  name: string;
  mana_cost?: string;
  type_line: string;
  oracle_text?: string;
  flavor_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  defense?: string;
  image_uris?: ScryfallImageUris;
  card_faces?: CardDetailFace[];
  set: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  artist?: string;
  keywords?: string[];
  legalities?: Record<string, string>;
  colors?: string[];
  color_identity?: string[];
  cmc?: number;
  scryfall_uri: string;
  purchase_uris?: {
    tcgplayer?: string;
    cardhoarder?: string;
    cardmarket?: string;
  };
  tcgplayer_id?: number;
  released_at?: string;
  lang?: string;
}
