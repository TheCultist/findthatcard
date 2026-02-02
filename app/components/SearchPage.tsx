"use client";

import { useState, FormEvent, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { ShieldCheckIcon, PaintBrushIcon, QueueListIcon } from "@heroicons/react/24/outline";
import { SearchResponse, ErrorResponse } from "@/types/scryfall";
import { getRandomExamples } from "@/lib/example-queries";
import CookieBanner from "@/app/components/CookieBanner";
import { fetchSymbolData } from "@/lib/scryfall/symbols";
import useAdBlockDetection from "@/app/hooks/useAdBlockDetection";
import CardCard from "@/app/components/CardCard";
import AdBanner from "@/app/components/AdBanner";

type SearchOptions = {
  updateUrl?: boolean;
};

const isSimpleQuery = (value: string) => /^[a-zA-Z0-9 ]+$/.test(value);

const slugifyQuery = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const buildSearchUrl = (searchQuery: string) => {
  const trimmed = searchQuery.trim();
  if (!trimmed) {
    return "/search";
  }

  if (isSimpleQuery(trimmed)) {
    const slug = slugifyQuery(trimmed);
    if (slug) {
      return `/search/${slug}`;
    }
  }

  return `/search?q=${encodeURIComponent(trimmed)}`;
};

const getQueryFromSlug = (slug: string | string[]) => {
  const slugValue = Array.isArray(slug) ? slug.join(" ") : slug;
  return slugValue.replace(/-/g, " ");
};

export default function SearchPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useParams<{ slug?: string | string[] }>();
  const lastUrlQueryRef = useRef("");

  const [query, setQuery] = useState("");
  const [editableQuery, setEditableQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [exampleQueries, setExampleQueries] = useState<string[]>([]);
  const adBlockDetected = useAdBlockDetection();

  const getQueryFromUrl = useCallback(() => {
    const paramQuery = searchParams.get("q");
    if (paramQuery) {
      return paramQuery;
    }
    if (params?.slug) {
      const slugValue = params.slug;
      if (Array.isArray(slugValue) && slugValue.length === 0) {
        return "";
      }
      return getQueryFromSlug(slugValue);
    }
    return "";
  }, [params?.slug, searchParams]);

  const handleSearch = useCallback(
    async (searchQuery: string, page: number = 1, options: SearchOptions = {}) => {
      if (!searchQuery.trim()) {
        return;
      }

      const shouldUpdateUrl = options.updateUrl ?? page === 1;
      if (shouldUpdateUrl && page === 1) {
        const nextUrl = buildSearchUrl(searchQuery);
        const currentUrl = `${pathname}${searchParams.toString() ? `?${searchParams}` : ""}`;
        if (nextUrl !== currentUrl) {
          router.push(nextUrl, { scroll: false });
        }
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
    },
    [pathname, router, searchParams]
  );

  // Load random examples on mount
  useEffect(() => {
    setExampleQueries(getRandomExamples(4));
  }, []);

  // Fetch symbol data once on mount
  useEffect(() => {
    fetchSymbolData();
  }, []);

  // Sync initial search with URL (q= or /search/:slug)
  useEffect(() => {
    const urlQuery = getQueryFromUrl().trim();
    if (!urlQuery || urlQuery === lastUrlQueryRef.current) {
      return;
    }
    lastUrlQueryRef.current = urlQuery;
    setQuery(urlQuery);
    setCurrentPage(1);
    handleSearch(urlQuery, 1, { updateUrl: false });
  }, [getQueryFromUrl, handleSearch]);

  const handleEditableQuerySearch = () => {
    if (!editableQuery.trim()) {
      return;
    }
    setCurrentPage(1);
    handleSearch(editableQuery, 1, { updateUrl: false });
  };

  const handlePageChange = (newPage: number) => {
    if (!results || newPage < 1 || (newPage > currentPage && !results.has_more)) {
      return;
    }
    const searchQuery = editableQuery || query;
    if (searchQuery) {
      handleSearch(searchQuery, newPage, { updateUrl: false });
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
          <Link
            href="/"
            className="inline-flex justify-center hover:text-blue-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded"
          >
            <h1 className="mb-2 text-4xl font-bold tracking-tight sm:text-5xl">
              Find That Card
            </h1>
          </Link>
          <p className="text-lg text-gray-400">
            Search Magic: The Gathering cards using natural language.
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
          <div className="mb-6 flex flex-wrap justify-center gap-2">
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

        {/* Static intro content */}
        <section className="mb-8 text-sm text-gray-400">
          <div className="mx-auto max-w-4xl text-center">
            <p className="text-base text-gray-300">
              Find That Card is a Magic: The Gathering search tool that lets you describe cards in
              plain language.
            </p>
            <div className="mt-5 grid grid-cols-1 gap-3 text-center sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-2xl border border-gray-800/70 bg-gray-900/30 px-5 py-5">
                <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-blue-500/40 bg-blue-500/10 text-blue-400">
                  <ShieldCheckIcon className="h-6 w-6" aria-hidden="true" />
                </div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Card intent
                </p>
                <p className="mt-2 text-sm text-gray-300">
                  Removal, ramp, tutors, tokens, or any role you can describe.
                </p>
              </div>
              <div className="rounded-2xl border border-gray-800/70 bg-gray-900/30 px-5 py-5">
                <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-blue-500/40 bg-blue-500/10 text-blue-400">
                  <PaintBrushIcon className="h-6 w-6" aria-hidden="true" />
                </div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Art and flavor
                </p>
                <p className="mt-2 text-sm text-gray-300">
                  Dragons, angels, swords, landscapes, or other artwork subjects.
                </p>
              </div>
              <div className="rounded-2xl border border-gray-800/70 bg-gray-900/30 px-5 py-5">
                <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-blue-500/40 bg-blue-500/10 text-blue-400">
                  <QueueListIcon className="h-6 w-6" aria-hidden="true" />
                </div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Formats and rules
                </p>
                <p className="mt-2 text-sm text-gray-300">
                  Commander, Modern, Pauper, plus colors, keywords, and mechanics.
                </p>
              </div>
            </div>
            <p className="mt-4 text-xs text-gray-500">
              Results are powered by Scryfall and updated in real time.
            </p>
          </div>
        </section>

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
            <AdBanner slot="4024965634" className="w-full max-w-2xl" />
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
                            <AdBanner slot="1553106733" className="w-full" />
                          </div>
                        );
                      }

                      // Insert ad banner after 40th card if we have 50+ results
                      if (cardCount >= 50 && index === 39) {
                        items.push(
                          <div key={`ad-40`} className="col-span-full my-4">
                            <AdBanner slot="1553106733" className="w-full" />
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
