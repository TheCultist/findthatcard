import type { CardPrices, CardResult } from "@/types/scryfall";
import { getCardTraderLink } from "@/lib/cardtrader/links";

// Fixed locale so server and client render the same string (no hydration mismatch).
const FORMATTERS = {
  usd: new Intl.NumberFormat("en", { style: "currency", currency: "USD" }),
  eur: new Intl.NumberFormat("en", { style: "currency", currency: "EUR" }),
};

/** "$0.55" / "€0.42", or null when Scryfall has no listing for that currency. */
export function formatPrice(prices: CardPrices, currency: keyof CardPrices): string | null {
  const raw = prices[currency];
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? FORMATTERS[currency].format(value) : null;
}

/**
 * TCGPlayer only ships to North America; everyone else buys from CardTrader (EU).
 * Decides which store is shown first. Client-only: falls back to CardTrader first.
 */
export function prefersTcgPlayer(): boolean {
  if (typeof navigator === "undefined") return false;
  const region = navigator.language.split("-")[1]?.toUpperCase();
  return region === "US" || region === "CA";
}

export type StoreId = "cardtrader" | "tcgplayer";

/** Dark tile the brand wordmarks are designed for (CardTrader's is white); shared by grid and panel. */
export const STORE_BUTTON_CLASS =
  "rounded-lg border border-stone-400/60 bg-stone-600 transition-colors hover:border-stone-400 hover:bg-stone-500 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export interface StoreOffer {
  id: StoreId;
  name: string;
  logo: string;
  /** Affiliate link, or null when the store can't be linked (no partner link configured). */
  href: string | null;
  price: string | null;
}

/** The two affiliate stores for a card, preferred store first. Shared by the grid and the panel. */
export function getStoreOffers(card: CardResult, tcgFirst: boolean): StoreOffer[] {
  const cardtrader: StoreOffer = {
    id: "cardtrader",
    name: "CardTrader",
    logo: "/brand/cardtrader.svg",
    href: getCardTraderLink(card.name, card.set_name, card.set_code, card.collector_number),
    price: formatPrice(card.prices, "eur"),
  };
  const tcgplayer: StoreOffer = {
    id: "tcgplayer",
    name: "TCGPlayer",
    logo: "/brand/tcgplayer.svg",
    href: card.tcgplayer_link,
    price: formatPrice(card.prices, "usd"),
  };
  return tcgFirst ? [tcgplayer, cardtrader] : [cardtrader, tcgplayer];
}
