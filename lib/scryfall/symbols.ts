// Cache for mana symbol SVG URIs
const symbolCache = new Map<string, string>();
let symbolDataLoaded = false;
const symbolLoadCallbacks: Set<() => void> = new Set();

/**
 * Fetches symbol data from Scryfall API and caches SVG URIs
 */
export async function fetchSymbolData(): Promise<void> {
  if (symbolDataLoaded) {
    return;
  }

  try {
    const response = await fetch("https://api.scryfall.com/symbology");
    if (!response.ok) {
      console.error("Failed to fetch symbol data from Scryfall");
      return;
    }

    const data = await response.json();
    if (data.data && Array.isArray(data.data)) {
      data.data.forEach((symbol: { symbol: string; svg_uri: string | null }) => {
        if (symbol.svg_uri) {
          symbolCache.set(symbol.symbol, symbol.svg_uri);
        }
      });
      symbolDataLoaded = true;
      symbolLoadCallbacks.forEach((callback) => callback());
      symbolLoadCallbacks.clear();
    }
  } catch (error) {
    console.error("Error fetching symbol data:", error);
  }
}

export function getSymbolSvg(symbol: string): string | undefined {
  return symbolCache.get(symbol);
}

export function isSymbolDataLoaded(): boolean {
  return symbolDataLoaded;
}

export function registerSymbolLoadCallback(callback: () => void): void {
  symbolLoadCallbacks.add(callback);
}

export function unregisterSymbolLoadCallback(callback: () => void): void {
  symbolLoadCallbacks.delete(callback);
}
