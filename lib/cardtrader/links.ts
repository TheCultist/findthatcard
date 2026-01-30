/**
 * Formats a string for use in CardTrader URLs: lowercase, replace spaces with hyphens
 * Also removes leading articles (A, An, The) as CardTrader URLs don't include them
 * Apostrophes are replaced with hyphens
 */
export function formatForUrl(text: string): string {
  // Remove leading articles (A, An, The) for CardTrader URL compatibility
  let cleaned = text.trim();
  const articleMatch = cleaned.match(/^(a|an|the)\s+(.+)$/i);
  if (articleMatch) {
    cleaned = articleMatch[2]; // Use the part after the article
  }

  return cleaned
    .toLowerCase()
    .replace(/'/g, "-") // Replace apostrophes with hyphens
    .replace(/[":,]/g, "") // Remove quotes, colons, commas
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/[^\w-]/g, "-") // Replace any remaining non-word chars with hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, ""); // Remove leading/trailing hyphens
}

/**
 * Mapping dictionary for set names that differ between Scryfall and CardTrader
 * Key: Scryfall set name (case-insensitive, will be normalized for lookup)
 * Value: CardTrader set name (should be the exact name to use in CardTrader URLs)
 *
 * Example:
 * - Scryfall: "Commander: Warhammer 40,000"
 * - CardTrader: "universes-beyond-warhammer-40-000"
 */
export const SET_NAME_MAPPING: Record<string, string> = {
  "commander: warhammer 40,000": "universes-beyond-warhammer-40-000",
  "commander-warhammer-40000": "universes-beyond-warhammer-40-000",
  "doctor-who": "universes-beyond-doctor-who",
  "fallout": "universes-beyond-fallout",
  "assassin-s-creed": "universes-beyond-assassin-s-creed",
  "strixhaven-mystical-archive": "mystical-archive",
  "neon-dynasty-commander": "commander-kamigawa-neon-dynasty",
  // Add more mappings here as needed
  // Format: "Scryfall Set Name": "cardtrader-set-name"
};

/**
 * Gets the CardTrader set name for a given Scryfall set name
 * Returns the mapped name if it exists, otherwise returns null
 */
export function getCardTraderSetName(
  scryfallSetName: string | null
): string | null {
  if (!scryfallSetName) {
    return null;
  }

  // Normalize the Scryfall set name for lookup (lowercase)
  const normalized = scryfallSetName.toLowerCase().trim();

  // Check exact match first
  if (SET_NAME_MAPPING[normalized]) {
    return SET_NAME_MAPPING[normalized];
  }

  // Also check formatted version (with hyphens, etc.)
  const formatted = formatForUrl(scryfallSetName);
  if (SET_NAME_MAPPING[formatted]) {
    return SET_NAME_MAPPING[formatted];
  }

  // No mapping found, return null to use the original formatted name
  return null;
}

/**
 * Generates a CardTrader affiliate link
 * Tries to construct a card-specific URL using set code and collector number if available
 * Falls back to card name + set name format, then homepage
 *
 * Based on CardTrader URL patterns:
 * - Magic cards: /cards/[card-name]-[set-name]
 * - Pokémon cards: /cards/[card-name]-[collector-number]-[set-code]
 *
 * For Magic, we'll try: /cards/[card-name]-[set-name]?share_code=[code]
 */
export function getCardTraderLink(
  cardName: string,
  setName: string | null,
  setCode: string | null,
  collectorNumber: string | null
): string {
  const shareCode =
    process.env.NEXT_PUBLIC_CARDTRADER_SHARE_CODE || "thecultist";

  // Try to construct card-specific URL if we have set name and card name
  if (setName && cardName) {
    const formattedCardName = formatForUrl(cardName);

    // Check if there's a CardTrader-specific mapping for this set name
    const cardtraderSetName = getCardTraderSetName(setName);

    // Format set name: use mapped name if available, otherwise format the original
    let formattedSetName: string;
    if (cardtraderSetName) {
      // Use the mapped name directly (it should already be formatted)
      formattedSetName = cardtraderSetName;
    } else {
      // Format set name: lowercase, replace spaces with hyphens
      formattedSetName = formatForUrl(setName);

      // Handle commander products: move "commander" before expansion name only if it's the last word
      if (formattedSetName.endsWith("-commander")) {
        formattedSetName = formattedSetName.replace(/-commander$/, "");
        formattedSetName = `commander-${formattedSetName}`;
      }
    }

    // Construct URL: /cards/[card-name]-[set-name]?share_code=[code]
    return `https://www.cardtrader.com/en/cards/${formattedCardName}-${formattedSetName}?share_code=${shareCode}`;
  }

  // Fallback to homepage
  return `https://www.cardtrader.com/en?share_code=${shareCode}`;
}
