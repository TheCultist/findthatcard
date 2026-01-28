"use client";

import { useState, FormEvent, useEffect } from "react";
import Link from "next/link";
import { SearchResponse, ErrorResponse, CardResult } from "@/types/scryfall";
import { getRandomExamples } from "@/lib/example-queries";
import CookieBanner from "./components/CookieBanner";

// Cache for mana symbol SVG URIs
const symbolCache = new Map<string, string>();
let symbolDataLoaded = false;
const symbolLoadCallbacks: Set<() => void> = new Set();

/**
 * Formats a string for use in CardTrader URLs: lowercase, replace spaces with hyphens
 * Also removes leading articles (A, An, The) as CardTrader URLs don't include them
 * Apostrophes are replaced with hyphens
 */
function formatForUrl(text: string): string {
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
const SET_NAME_MAPPING: Record<string, string> = {
  "commander: warhammer 40,000": "universes-beyond-warhammer-40-000",
  "commander-warhammer-40000": "universes-beyond-warhammer-40-000",
  "doctor-who": "universes-beyond-doctor-who",
  "fallout": "universes-beyond-fallout"
  // Add more mappings here as needed
  // Format: "Scryfall Set Name": "cardtrader-set-name"
};

/**
 * Gets the CardTrader set name for a given Scryfall set name
 * Returns the mapped name if it exists, otherwise returns null
 */
function getCardTraderSetName(scryfallSetName: string | null): string | null {
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
function getCardTraderLink(
  cardName: string,
  setName: string | null,
  setCode: string | null,
  collectorNumber: string | null
): string {
  const shareCode = process.env.NEXT_PUBLIC_CARDTRADER_SHARE_CODE || "thecultist";
  
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

export default function Home() {
  const [query, setQuery] = useState("");
  const [editableQuery, setEditableQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [exampleQueries, setExampleQueries] = useState<string[]>([]);
  const [adBlockDetected, setAdBlockDetected] = useState(false);

  // Load random examples on mount
  useEffect(() => {
    setExampleQueries(getRandomExamples(5));
  }, []);

  // Fetch symbol data once on mount
  useEffect(() => {
    fetchSymbolData();
  }, []);

  // Detect adblocker
  useEffect(() => {
    const checkAdBlock = () => {
      // Create a test element that adblockers typically hide
      const testAd = document.createElement("div");
      testAd.innerHTML = "&nbsp;";
      testAd.className = "adsbox";
      testAd.style.position = "absolute";
      testAd.style.left = "-9999px";
      testAd.style.height = "1px";
      document.body.appendChild(testAd);

      // Check if the element was hidden by adblocker
      setTimeout(() => {
        const isBlocked =
          testAd.offsetHeight === 0 ||
          testAd.style.display === "none" ||
          testAd.style.visibility === "hidden";
        
        setAdBlockDetected(isBlocked);
        document.body.removeChild(testAd);
      }, 100);
    };

    checkAdBlock();
  }, []);

  const handleSearch = async (searchQuery: string, page: number = 1) => {
    if (!searchQuery.trim()) {
      return;
    }

    setLoading(true);
    setError(null);
    if (page === 1) {
      setResults(null);
      setEditableQuery(""); // Clear query on new search, will be set from response
    }

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ naturalQuery: searchQuery, page }),
      });

      const data = await response.json();

      if (!response.ok) {
        const errorData = data as ErrorResponse;
        setError(errorData.error || "An error occurred");
        // Update editable query with the generated Scryfall query if available (even on error)
        if (errorData.scryfallQuery && page === 1) {
          setEditableQuery(errorData.scryfallQuery);
        }
        return;
      }

      setResults(data as SearchResponse);
      setCurrentPage(data.page);
      // Update editable query with the generated Scryfall query (only on first page)
      if (page === 1) {
        setEditableQuery(data.scryfallQuery);
      }
    } catch (err) {
      setError("Failed to connect to the server. Please try again.");
      console.error("Search error:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleEditableQuerySearch = () => {
    if (!editableQuery.trim()) {
      return;
    }
    setCurrentPage(1);
    handleSearch(editableQuery, 1);
  };

  const handlePageChange = (newPage: number) => {
    if (!results || newPage < 1 || (newPage > currentPage && !results.has_more)) {
      return;
    }
    const searchQuery = editableQuery || query;
    if (searchQuery) {
      handleSearch(searchQuery, newPage);
    }
  };

  // Scroll to query section when results change (after loading completes)
  useEffect(() => {
    if (results && !loading) {
      // Small delay to ensure DOM is updated
      setTimeout(() => {
        // Scroll to the query display section if it exists
        const queryElement = document.getElementById("query-display");
        if (queryElement) {
          queryElement.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          // Fallback: scroll to results section or top
          const resultsElement = document.getElementById("results-section");
          if (resultsElement) {
            resultsElement.scrollIntoView({ behavior: "smooth", block: "start" });
          } else {
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
        }
      }, 100);
    }
  }, [results?.page, loading]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCurrentPage(1);
    handleSearch(query, 1);
  };

  const handleChipClick = (chipQuery: string) => {
    setQuery(chipQuery);
    setCurrentPage(1);
    handleSearch(chipQuery, 1);
  };

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="mb-2 text-4xl font-bold tracking-tight sm:text-5xl">
            Find That Card
          </h1>
          <p className="text-lg text-gray-400">
            Search Magic: The Gathering cards using natural language.
            <span className="ml-1 text-sm text-gray-500">
              Supports art/function tags too
            </span>
          </p>
        </div>

        {/* Search Form */}
        <form onSubmit={handleSubmit} className="mb-6">
          <div className="flex flex-col gap-4 sm:flex-row">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Try "white creatures" or "cards with dragons in the art"'
              className="flex-1 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-blue-600 px-6 py-3 font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Searching..." : "Search"}
            </button>
          </div>
        </form>

        {/* Example Chips */}
        {exampleQueries.length > 0 && (
          <div className="mb-6 flex flex-wrap gap-2">
            {exampleQueries.map((example, index) => (
              <button
                key={`${example}-${index}`}
                onClick={() => handleChipClick(example)}
                disabled={loading}
                className="rounded-full border border-gray-700 bg-gray-900 px-4 py-1.5 text-sm text-gray-300 transition-colors hover:border-gray-600 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {example}
              </button>
            ))}
          </div>
        )}

        {/* Ad Space / Adblock Message */}
        <div className="mb-8 flex justify-center">
          {adBlockDetected ? (
            <div className="w-full max-w-2xl rounded-lg border border-gray-700 bg-gray-900/50 p-4 text-center">
              <p className="text-sm text-gray-400">
                <span className="font-medium text-gray-300">Find That Card is supported by ads.</span>
                <br />
                <span className="text-xs text-gray-500">
                  A single, non-intrusive ad helps keep this site free. Please consider whitelisting{" "}
                  <span className="font-medium text-gray-400">findthat.card</span> in your ad blocker.
                </span>
              </p>
            </div>
          ) : (
            <div className="flex h-24 w-full max-w-2xl items-center justify-center rounded-lg border border-dashed border-gray-800 bg-gray-900/50 text-sm text-gray-600">
              Ad space
            </div>
          )}
        </div>

        {/* Query Display - Editable */}
        {editableQuery && (
          <div id="query-display" className="mb-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex-1 flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-4 py-2 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20">
                <span className="text-xs text-gray-500 whitespace-nowrap">Query:</span>
                <input
                  type="text"
                  value={editableQuery}
                  onChange={(e) => setEditableQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleEditableQuerySearch();
                    }
                  }}
                  className="flex-1 bg-transparent text-sm text-blue-400 focus:outline-none font-mono"
                  disabled={loading}
                  placeholder="Edit Scryfall query..."
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleEditableQuerySearch}
                  disabled={loading || !editableQuery.trim()}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Search
                </button>
                <a
                  href={`https://scryfall.com/search?q=${encodeURIComponent(editableQuery)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-sm text-gray-300 transition-colors hover:border-gray-600 hover:bg-gray-700"
                >
                  View on Scryfall
                </a>
              </div>
            </div>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="mb-6 rounded-lg border border-red-800 bg-red-950/30 p-4 text-red-400">
            <p className="font-medium">Error</p>
            <p className="text-sm">{error}</p>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="flex justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-700 border-t-blue-600"></div>
          </div>
        )}

        {/* Results */}
        {results && (
          <div id="results-section" className="mb-8">
            <div className="mb-4 flex items-center justify-between text-sm text-gray-400">
              <div>
                Found {results.total.toLocaleString()} card{results.total !== 1 ? "s" : ""}
                {results.total > 0 && (
                  <span className="ml-2">
                    (Page {results.page}, showing {results.cards.length} card{results.cards.length !== 1 ? "s" : ""})
                  </span>
                )}
              </div>
            </div>

            {results.cards.length === 0 ? (
              <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-8 text-center text-gray-400">
                No cards found. Try a different search query.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {(() => {
                    const items: React.ReactNode[] = [];
                    const cardCount = results.cards.length;
                    
                    results.cards.forEach((card, index) => {
                      // Add the card
                      items.push(<CardCard key={card.id} card={card} />);
                      
                      // Insert ad banner after 20th card if we have 30+ results
                      if (cardCount >= 30 && index === 19) {
                        items.push(
                          <div key={`ad-20`} className="col-span-full my-4">
                            <div className="flex h-24 w-full items-center justify-center rounded-lg border border-dashed border-gray-800 bg-gray-900/50 text-sm text-gray-600">
                              Ad banner
                            </div>
                          </div>
                        );
                      }
                      
                      // Insert ad banner after 40th card if we have 50+ results
                      if (cardCount >= 50 && index === 39) {
                        items.push(
                          <div key={`ad-40`} className="col-span-full my-4">
                            <div className="flex h-24 w-full items-center justify-center rounded-lg border border-dashed border-gray-800 bg-gray-900/50 text-sm text-gray-600">
                              Ad banner
                            </div>
                          </div>
                        );
                      }
                    });
                    
                    return items;
                  })()}
                </div>

                {/* Pagination Controls */}
                {(results.has_more || results.page > 1) && (
                  <div className="mt-8 flex items-center justify-center gap-4">
                    <button
                      onClick={() => handlePageChange(results.page - 1)}
                      disabled={loading || results.page === 1}
                      className="rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:border-gray-600 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Previous
                    </button>
                    <span className="text-sm text-gray-400">
                      Page {results.page} of {Math.ceil(results.total / results.per_page)}
                    </span>
                    <button
                      onClick={() => handlePageChange(results.page + 1)}
                      disabled={loading || !results.has_more}
                      className="rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:border-gray-600 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <footer className="mt-16 border-t border-gray-800 pt-8 pb-24 text-center text-xs text-gray-500">
          <p>
            Unofficial fan content. Card data and images from{" "}
            <a
              href="https://scryfall.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
            >
              Scryfall
            </a>{" "}
            and community tags from{" "}
            <a
              href="https://tagger.scryfall.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
            >
              Scryfall Tagger
            </a>
            . Not endorsed by Wizards of the Coast or Scryfall.
          </p>
          <p className="mt-2">
            <Link
              href="/privacy"
              className="text-blue-400 hover:underline"
            >
              Privacy Policy
            </Link>
          </p>
        </footer>
      </div>

      {/* Cookie Consent Banner */}
      <CookieBanner />
    </main>
  );
}

/**
 * Fetches symbol data from Scryfall API and caches SVG URIs
 */
async function fetchSymbolData(): Promise<void> {
  if (symbolDataLoaded) {
    return; // Already loaded
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
      // Notify all waiting components
      symbolLoadCallbacks.forEach(callback => callback());
      symbolLoadCallbacks.clear();
    }
  } catch (error) {
    console.error("Error fetching symbol data:", error);
  }
}

/**
 * Renders mana cost symbols from a mana cost string (e.g., "{1}{R}{G}" or "{1}{R} / {2}{G}" for split cards)
 */
function ManaCost({ manaCost }: { manaCost: string }) {
  const [, forceUpdate] = useState(0);
  
  useEffect(() => {
    if (!symbolDataLoaded) {
      // Register callback to re-render when symbols are loaded
      const callback = () => forceUpdate(prev => prev + 1);
      symbolLoadCallbacks.add(callback);
      return () => {
        symbolLoadCallbacks.delete(callback);
      };
    }
  }, []);

  // Check if this is a split card mana cost (contains " / ")
  const isSplitCost = manaCost.includes(" / ");
  
  if (isSplitCost) {
    // Split the mana cost by " / " and render each side separately
    const costs = manaCost.split(" / ");
    
    return (
      <div className="flex items-center gap-1 flex-shrink-0">
        {costs.map((cost, costIndex) => {
          const symbols = cost.match(/\{[^}]+\}/g) || [];
          
          return (
            <div key={costIndex} className="flex items-center gap-0.5">
              {symbols.length > 0 ? (
                symbols.map((symbol, symbolIndex) => {
                  const svgUri = symbolCache.get(symbol);
                  
                  if (!svgUri) {
                    return (
                      <span key={`${symbol}-${symbolIndex}`} className="text-xs text-gray-400 whitespace-nowrap">
                        {symbol}
                      </span>
                    );
                  }

                  return (
                    <img
                      key={`${symbol}-${symbolIndex}`}
                      src={svgUri}
                      alt={symbol}
                      className="h-4 w-4 inline-block flex-shrink-0"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.style.display = "none";
                        const textSpan = document.createElement("span");
                        textSpan.textContent = symbol;
                        textSpan.className = "text-xs text-gray-400 whitespace-nowrap";
                        target.parentElement?.appendChild(textSpan);
                      }}
                    />
                  );
                })
              ) : (
                <span className="text-xs text-gray-400 whitespace-nowrap">
                  {cost}
                </span>
              )}
              {costIndex < costs.length - 1 && (
                <span className="text-xs text-gray-500 mx-0.5">/</span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Regular single mana cost
  const symbols = manaCost.match(/\{[^}]+\}/g) || [];

  // If no symbols found, show the raw mana cost as fallback
  if (symbols.length === 0) {
    return (
      <span className="text-xs text-gray-400 whitespace-nowrap">
        {manaCost}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-0.5 flex-shrink-0">
      {symbols.map((symbol, index) => {
        const svgUri = symbolCache.get(symbol);
        
        if (!svgUri) {
          // Fallback: show text if symbol not found in cache yet
          return (
            <span key={`${symbol}-${index}`} className="text-xs text-gray-400 whitespace-nowrap">
              {symbol}
            </span>
          );
        }

        return (
          <img
            key={`${symbol}-${index}`}
            src={svgUri}
            alt={symbol}
            className="h-4 w-4 inline-block flex-shrink-0"
            onError={(e) => {
              // Fallback: show text if image fails to load
              const target = e.target as HTMLImageElement;
              target.style.display = "none";
              const textSpan = document.createElement("span");
              textSpan.textContent = symbol;
              textSpan.className = "text-xs text-gray-400 whitespace-nowrap";
              target.parentElement?.appendChild(textSpan);
            }}
          />
        );
      })}
    </div>
  );
}

function CardCard({ card }: { card: CardResult }) {
  const handleClick = () => {
    window.open(card.scryfall_uri, "_blank", "noopener,noreferrer");
  };

  return (
    <div
      onClick={handleClick}
      className="group cursor-pointer rounded-lg border border-gray-800 bg-gray-900 p-4 transition-all hover:border-gray-700 hover:shadow-lg hover:shadow-blue-500/10"
    >
      {/* Card Image */}
      {(card.image_uris.normal || card.image_uris.small) ? (
        <div className="mb-3 aspect-[5/7] overflow-hidden rounded border border-gray-800 bg-gray-950">
          <img
            src={card.image_uris.normal || card.image_uris.small || ""}
            alt={card.name}
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              // Try fallback to small if normal fails
              if (card.image_uris.small && target.src !== card.image_uris.small) {
                target.src = card.image_uris.small;
              } else {
                target.style.display = "none";
              }
            }}
          />
        </div>
      ) : (
        <div className="mb-3 flex aspect-[5/7] items-center justify-center rounded border border-gray-800 bg-gray-950 text-xs text-gray-600">
          No image
        </div>
      )}

      {/* Card Name & Mana Cost */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="flex-1 min-w-0 font-semibold text-gray-100 group-hover:text-blue-400 line-clamp-2 pr-2">
          {card.name}
        </h3>
        <div className="flex-shrink-0 mt-0.5 min-w-[60px] flex items-center justify-end">
          {card.mana_cost ? (
            <ManaCost manaCost={card.mana_cost} />
          ) : (
            <span className="text-xs text-gray-500">—</span>
          )}
        </div>
      </div>

      {/* CardTrader Affiliate Link */}
      <a
        href={getCardTraderLink(card.name, card.set_name, card.set_code, card.collector_number)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="block rounded border border-gray-700 bg-gray-800/50 p-3 text-center text-xs text-gray-400 transition-colors hover:border-blue-600 hover:bg-gray-800 hover:text-blue-400"
      >
        Buy on CardTrader
      </a>
    </div>
  );
}
