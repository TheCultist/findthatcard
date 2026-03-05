"use client";

import { useState, FormEvent, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { ShieldCheckIcon, PaintBrushIcon, QueueListIcon } from "@heroicons/react/24/outline";
import { SearchResponse, ErrorResponse, CardResult } from "@/types/scryfall";
import { getRandomExamples } from "@/lib/example-queries";
import { getRandomProTip } from "@/lib/pro-tips";
import CookieBanner from "@/app/components/CookieBanner";
import { fetchSymbolData } from "@/lib/scryfall/symbols";
import useAdBlockDetection from "@/app/hooks/useAdBlockDetection";
import CardCard from "@/app/components/CardCard";
import AdBanner from "@/app/components/AdBanner";
import QueryTokenPreview from "@/app/components/QueryTokenPreview";
import CardDetailPanel from "@/app/components/CardDetailPanel";
import ThemeToggle from "@/app/components/ThemeToggle";

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
  const editableInputRef = useRef<HTMLTextAreaElement | null>(null);

  const [query, setQuery] = useState("");
  const [editableQuery, setEditableQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [exampleQueries, setExampleQueries] = useState<string[]>([]);
  const [proTip, setProTip] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [isEditingQuery, setIsEditingQuery] = useState(false);
  const [selectedCard, setSelectedCard] = useState<CardResult | null>(null);
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
        setSourceQuery(searchQuery);
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
        setPageInput(String(data.page));
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
    setPageInput("1");
    handleSearch(urlQuery, 1, { updateUrl: false });
  }, [getQueryFromUrl, handleSearch]);

  useEffect(() => {
    if (loading) {
      setProTip(getRandomProTip());
    }
  }, [loading]);

  // Auto-resize the textarea to fit its content whenever the query or editing state changes
  useEffect(() => {
    if (isEditingQuery && editableInputRef.current) {
      const el = editableInputRef.current;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [editableQuery, isEditingQuery]);

  const handleEditableQuerySearch = () => {
    if (!editableQuery.trim()) {
      return;
    }
    setCurrentPage(1);
    setPageInput("1");
    handleSearch(editableQuery, 1, { updateUrl: false });
  };

  const handleEditableQueryFocus = () => {
    setIsEditingQuery(true);
  };

  const handleEditableQueryBlur = () => {
    setIsEditingQuery(false);
  };

  const handleTokenOverlayClick = () => {
    setIsEditingQuery(true);
    requestAnimationFrame(() => {
      editableInputRef.current?.focus();
    });
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

  const handleJumpToPage = () => {
    if (!results) {
      return;
    }
    const parsedPage = Number.parseInt(pageInput, 10);
    if (Number.isNaN(parsedPage)) {
      setPageInput(String(results.page));
      return;
    }
    const maxPage = Math.max(1, Math.ceil(results.total / results.per_page));
    const clampedPage = Math.min(Math.max(parsedPage, 1), maxPage);
    setPageInput(String(clampedPage));
    if (clampedPage !== results.page) {
      handlePageChange(clampedPage);
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
  }, [results, loading]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCurrentPage(1);
    setPageInput("1");
    handleSearch(query, 1);
  };

  const handleChipClick = (chipQuery: string) => {
    setQuery(chipQuery);
    setCurrentPage(1);
    setPageInput("1");
    handleSearch(chipQuery, 1);
  };

  const trimmedQuery = query.trim();

  return (
    <main className="min-h-screen bg-gradient-to-b from-blue-50/50 via-white to-white px-3 py-6 dark:from-gray-950 dark:via-gray-950 dark:to-gray-950 sm:px-6 sm:py-10 lg:px-8">
      <div className="mx-auto max-w-7xl">
        {/* Theme Toggle - Top Right */}
        <div className="mb-4 flex justify-end">
          <ThemeToggle />
        </div>

        <section className="relative overflow-hidden rounded-2xl border border-gray-200/80 bg-gradient-to-b from-white to-blue-50/30 px-4 py-6 shadow-[0_0_0_1px_rgba(59,130,246,0.12),0_20px_60px_-20px_rgba(59,130,246,0.08),0_8px_24px_-8px_rgba(0,0,0,0.06)] dark:border-gray-800/60 dark:from-gray-950/80 dark:to-gray-900/60 dark:shadow-[0_0_0_1px_rgba(59,130,246,0.08),0_20px_60px_-30px_rgba(15,23,42,0.9)] sm:rounded-3xl sm:px-10 sm:py-14">
          <div className="relative">
            {/* Header */}
            <div className="text-center">
              <Link
                href="/"
                className="inline-flex justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                <h1 className="mb-2 text-3xl font-bold tracking-tight bg-gradient-to-r from-gray-900 via-blue-800 to-indigo-900 bg-clip-text text-transparent dark:from-gray-100 dark:via-blue-300 dark:to-indigo-200 sm:text-5xl lg:text-6xl">
                  Find That Card
                </h1>
              </Link>
              <p className="mx-auto max-w-2xl text-base font-medium text-gray-700 dark:text-gray-400 sm:text-xl">
                Search Magic: The Gathering cards using natural language.
              </p>
            </div>

            {/* Search Form */}
            <form onSubmit={handleSubmit} className="mt-5 sm:mt-8">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder='Try "white creatures" or "dragons in the art"'
                  className="flex-1 rounded-xl border border-gray-300 bg-white/70 px-4 py-3.5 text-base text-gray-900 placeholder-gray-400 shadow-[inset_0_1px_0_rgba(0,0,0,0.04)] focus:border-blue-500/70 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-gray-700/80 dark:bg-gray-950/70 dark:text-gray-100 dark:placeholder-gray-500 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:py-3"
                  disabled={loading}
                  enterKeyHint="search"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-7 py-3.5 font-semibold text-white shadow-[0_10px_30px_-16px_rgba(59,130,246,0.8)] transition-all hover:from-blue-500 hover:to-indigo-500 hover:shadow-[0_14px_34px_-14px_rgba(99,102,241,0.7)] disabled:cursor-not-allowed disabled:opacity-50 sm:py-3"
                >
                  {loading ? "Searching..." : "Search"}
                </button>
              </div>
            </form>

            {/* Example Chips */}
            {exampleQueries.length > 0 && (
              <div className="mt-4 -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-hide sm:mx-0 sm:mt-6 sm:flex-wrap sm:justify-center sm:px-0">
                {exampleQueries.map((example, index) => (
                  <button
                    key={`${example}-${index}`}
                    onClick={() => handleChipClick(example)}
                    disabled={loading}
                    className="flex-shrink-0 rounded-full border border-gray-300 bg-gray-50/60 px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:border-blue-500/40 hover:bg-blue-50/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700/70 dark:bg-gray-900/60 dark:text-gray-300 dark:hover:border-blue-500/40 dark:hover:bg-gray-800/80 sm:py-1.5 sm:text-base"
                  >
                    {example}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Static intro content - hidden during search */}
        {!loading && !results && !editableQuery && (
        <section className="mb-8 mt-6 text-base text-gray-700 dark:text-gray-400 sm:mb-10 sm:mt-10">
          <div className="mx-auto max-w-4xl text-center">
            <p className="text-base font-medium text-gray-800 dark:text-gray-200 sm:text-lg">
              Find That Card is a Magic: The Gathering search tool that lets you describe cards in
              plain language.
            </p>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-500">
              Find That Card is a project by{" "}
              <Link href="/about" className="text-blue-400 hover:underline">
                Cardboard Cultist
              </Link>
              .
            </p>
            <div className="mt-4 grid grid-cols-1 gap-3 text-center sm:mt-6 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
              <div className="rounded-xl border border-gray-200 bg-gray-50/40 px-4 py-4 shadow-[0_18px_40px_-28px_rgba(0,0,0,0.1)] transition hover:border-blue-500/30 hover:bg-gray-50/60 dark:border-gray-800/80 dark:bg-gray-900/40 dark:shadow-[0_18px_40px_-28px_rgba(15,23,42,0.9)] dark:hover:border-blue-500/30 dark:hover:bg-gray-900/60 sm:rounded-2xl sm:px-6 sm:py-6">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-blue-500/40 bg-blue-500/10 text-blue-400 sm:mb-4 sm:h-12 sm:w-12">
                  <ShieldCheckIcon className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />
                </div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 sm:text-sm">
                  Card intent
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-gray-700 dark:text-gray-300 sm:mt-2 sm:text-base">
                  Removal, ramp, tutors, tokens, or any role you can describe.
                </p>
              </div>
              <div className="rounded-xl border border-gray-200 bg-gray-50/40 px-4 py-4 shadow-[0_18px_40px_-28px_rgba(0,0,0,0.1)] transition hover:border-violet-500/30 hover:bg-gray-50/60 dark:border-gray-800/80 dark:bg-gray-900/40 dark:shadow-[0_18px_40px_-28px_rgba(15,23,42,0.9)] dark:hover:border-violet-500/30 dark:hover:bg-gray-900/60 sm:rounded-2xl sm:px-6 sm:py-6">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-violet-500/40 bg-violet-500/10 text-violet-400 sm:mb-4 sm:h-12 sm:w-12">
                  <PaintBrushIcon className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />
                </div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 sm:text-sm">
                  Art and flavor
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-gray-700 dark:text-gray-300 sm:mt-2 sm:text-base">
                  Dragons, angels, swords, landscapes, or other artwork subjects.
                </p>
              </div>
              <div className="rounded-xl border border-gray-200 bg-gray-50/40 px-4 py-4 shadow-[0_18px_40px_-28px_rgba(0,0,0,0.1)] transition hover:border-amber-500/30 hover:bg-gray-50/60 dark:border-gray-800/80 dark:bg-gray-900/40 dark:shadow-[0_18px_40px_-28px_rgba(15,23,42,0.9)] dark:hover:border-amber-500/30 dark:hover:bg-gray-900/60 sm:rounded-2xl sm:px-6 sm:py-6">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-500 sm:mb-4 sm:h-12 sm:w-12">
                  <QueueListIcon className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />
                </div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 sm:text-sm">
                  Formats and rules
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-gray-700 dark:text-gray-300 sm:mt-2 sm:text-base">
                  Commander, Modern, Pauper, plus colors, keywords, and mechanics.
                </p>
              </div>
            </div>
            <p className="mt-5 text-sm text-gray-500">
              Results are powered by Scryfall and updated in real time.
            </p>
          </div>
        </section>
        )}

        {/* Ad Space / Adblock Message */}
        {trimmedQuery && (
          <div className="mb-8 flex justify-center">
            {adBlockDetected ? (
              <div className="w-full max-w-2xl rounded-lg border border-gray-300 bg-gray-50/50 p-4 text-center dark:border-gray-700 dark:bg-gray-900/50">
                <p className="text-base text-gray-600 dark:text-gray-400">
                  <span className="font-medium text-gray-800 dark:text-gray-300">Find That Card is supported by ads.</span>
                  <br />
                  <span className="text-sm text-gray-500">
                    A single, non-intrusive ad helps keep this site free. Please consider whitelisting{" "}
                    <span className="font-medium text-gray-700 dark:text-gray-400">findthat.card</span> in your ad blocker.
                  </span>
                </p>
              </div>
            ) : (
              <AdBanner slot="4024965634" className="w-full max-w-2xl" />
            )}
          </div>
        )}

        {/* Query Display - Editable */}
        {(editableQuery || sourceQuery || results) && !loading && (
          <div id="query-display" className="relative z-50 mb-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <div className="flex-1 flex items-start gap-2 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-gray-800 dark:bg-gray-900 sm:px-4 sm:py-2.5">
                <span className="mt-0.5 text-sm text-gray-500 whitespace-nowrap">Query:</span>
                <div className="relative flex-1 min-w-0">
                  <textarea
                    ref={editableInputRef}
                    value={editableQuery}
                    rows={1}
                    onChange={(e) => {
                      setEditableQuery(e.target.value);
                      e.target.style.height = "auto";
                      e.target.style.height = `${e.target.scrollHeight}px`;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleEditableQuerySearch();
                      }
                    }}
                    onFocus={handleEditableQueryFocus}
                    onBlur={handleEditableQueryBlur}
                    className={`w-full bg-transparent text-sm text-blue-600 focus:outline-none font-mono dark:text-blue-400 sm:text-base resize-none overflow-hidden leading-relaxed ${
                      isEditingQuery
                        ? "relative z-10 opacity-100"
                        : "absolute inset-0 opacity-0 pointer-events-none h-full"
                    }`}
                    disabled={loading}
                    placeholder="Edit Scryfall query..."
                  />
                  {!isEditingQuery && (
                    <div
                      className="text-blue-500 cursor-text dark:text-blue-300"
                      onClick={handleTokenOverlayClick}
                    >
                      <QueryTokenPreview
                        scryfallQuery={editableQuery}
                        sourceQuery={sourceQuery || query}
                        variant="inline"
                        className="gap-1.5"
                      />
                    </div>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleEditableQuerySearch}
                  disabled={loading || !editableQuery.trim()}
                  className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none sm:py-2 sm:text-base"
                >
                  Search
                </button>
                <a
                  href={`https://scryfall.com/search?q=${encodeURIComponent(editableQuery)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 rounded-lg border border-gray-300 bg-gray-100 px-4 py-2.5 text-center text-sm text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-600 dark:hover:bg-gray-700 sm:flex-none sm:py-2 sm:text-base"
                >
                  <span className="sm:hidden">Scryfall</span>
                  <span className="hidden sm:inline">View on Scryfall</span>
                </a>
              </div>
            </div>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="mb-6 rounded-lg border border-red-300 bg-red-50/30 p-4 text-red-600 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400">
            <p className="font-medium">Error</p>
            <p className="text-base">{error}</p>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600 dark:border-gray-700 dark:border-t-blue-500"></div>
            {proTip && (
              <div className="w-full max-w-2xl rounded-2xl border border-gray-200 bg-gray-50/50 px-5 py-4 text-sm text-gray-600 shadow-[0_18px_40px_-28px_rgba(0,0,0,0.1)] dark:border-gray-800/70 dark:bg-gray-900/50 dark:text-gray-400 dark:shadow-[0_18px_40px_-28px_rgba(15,23,42,0.9)]">
                <span className="text-xs font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
                  Pro tip
                </span>
                <p className="mt-2 text-base text-gray-700 dark:text-gray-300">{proTip}</p>
              </div>
            )}
          </div>
        )}

        {/* Results */}
        {results && (
          <div id="results-section" className="mb-10">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gray-200 bg-gray-50/40 px-3 py-2.5 text-sm text-gray-700 shadow-[0_18px_40px_-28px_rgba(0,0,0,0.1)] dark:border-gray-800/70 dark:bg-gray-900/40 dark:text-gray-300 dark:shadow-[0_18px_40px_-28px_rgba(15,23,42,0.9)] sm:mb-5 sm:gap-3 sm:px-4 sm:py-3 sm:text-base">
              <div>
                Found {results.total.toLocaleString()} card{results.total !== 1 ? "s" : ""}
                {results.total > 0 && (
                  <span className="ml-1 text-gray-500 dark:text-gray-500 sm:ml-2 sm:text-gray-400 dark:sm:text-gray-300">
                    (p.{results.page}, {results.cards.length} shown)
                  </span>
                )}
              </div>
            </div>

            {results.cards.length === 0 ? (
              <div className="rounded-2xl border border-gray-200 bg-gray-50/50 p-10 text-center text-gray-700 shadow-[0_18px_40px_-28px_rgba(0,0,0,0.1)] dark:border-gray-800/80 dark:bg-gray-900/50 dark:text-gray-300 dark:shadow-[0_18px_40px_-28px_rgba(15,23,42,0.9)]">
                No cards found. Try a different search query.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
                  {(() => {
                    const items: React.ReactNode[] = [];
                    const cardCount = results.cards.length;

                    results.cards.forEach((card, index) => {
                      // Add the card
                      items.push(
                        <CardCard
                          key={card.id}
                          card={card}
                          onCardClick={setSelectedCard}
                        />
                      );

                      // Insert CavernHold ad banner after 20th card if we have 30+ results
                      if (cardCount >= 30 && index === 19) {
                        items.push(
                          <div key="ad-20" className="col-span-full my-4">
                            <p className="mb-1 text-[10px] text-gray-400">Advertisement</p>
                            <a
                              href="https://cavernhold.pxf.io/yZ2rMG"
                              target="_blank"
                              rel="noopener noreferrer sponsored"
                              className="block w-full"
                            >
                              <Image
                                src="/brand/ch_ad_banner_horizontal.png"
                                alt="CavernHold – Now that you found your cards, carry them in style."
                                width={1200}
                                height={200}
                                className="w-full rounded-xl"
                                priority={false}
                              />
                            </a>
                          </div>
                        );
                      }

                      // Insert CavernHold ad banner after 40th card if we have 50+ results
                      if (cardCount >= 50 && index === 39) {
                        items.push(
                          <div key="ad-40" className="col-span-full my-4">
                            <p className="mb-1 text-[10px] text-gray-400">Advertisement</p>
                            <a
                              href="https://cavernhold.pxf.io/yZ2rMG"
                              target="_blank"
                              rel="noopener noreferrer sponsored"
                              className="block w-full"
                            >
                              <Image
                                src="/brand/ch_ad_banner_horizontal.png"
                                alt="CavernHold – Now that you found your cards, carry them in style."
                                width={1200}
                                height={200}
                                className="w-full rounded-xl"
                                priority={false}
                              />
                            </a>
                          </div>
                        );
                      }
                    });

                    return items;
                  })()}
                </div>

                {/* Pagination Controls */}
                {(results.has_more || results.page > 1) && (
                  <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:mt-8 sm:gap-4">
                    <div className="flex w-full items-center justify-center gap-3 rounded-2xl border border-gray-200 bg-gray-50/40 px-3 py-3 text-base text-gray-700 shadow-[0_18px_40px_-28px_rgba(0,0,0,0.1)] dark:border-gray-800/70 dark:bg-gray-900/40 dark:text-gray-300 dark:shadow-[0_18px_40px_-28px_rgba(15,23,42,0.9)] sm:w-auto sm:gap-4 sm:px-4">
                      <button
                        onClick={() => handlePageChange(results.page - 1)}
                        disabled={loading || results.page === 1}
                        className="min-h-[44px] rounded-lg border border-gray-300 bg-white/60 px-3 py-2 text-sm font-medium text-gray-800 transition-colors hover:border-gray-400 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-950/60 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800 sm:min-h-0 sm:px-4 sm:text-base"
                      >
                        Previous
                      </button>
                      <span className="text-sm text-gray-600 dark:text-gray-400 sm:text-base">
                        {results.page} / {Math.ceil(results.total / results.per_page)}
                      </span>
                      <div className="hidden flex-wrap items-center gap-2 sm:flex">
                        {(() => {
                          const totalPages = Math.max(
                            1,
                            Math.ceil(results.total / results.per_page)
                          );
                          const startPage = Math.max(1, results.page - 3);
                          const endPage = Math.min(totalPages, results.page + 3);
                          const pages = [];

                          for (let page = startPage; page <= endPage; page += 1) {
                            pages.push(page);
                          }

                          return pages.map((page) => (
                            <button
                              key={`page-${page}`}
                              onClick={() => handlePageChange(page)}
                              disabled={loading || page === results.page}
                              className={
                                page === results.page
                                  ? "rounded-lg border border-blue-500/50 bg-blue-500/10 px-3 py-2 text-base font-semibold text-blue-600 dark:text-blue-300"
                                  : "rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-base text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:border-gray-600 dark:hover:bg-gray-800"
                              }
                            >
                              {page}
                            </button>
                          ));
                        })()}
                      </div>
                      <button
                        onClick={() => handlePageChange(results.page + 1)}
                        disabled={loading || !results.has_more}
                        className="min-h-[44px] rounded-lg border border-gray-300 bg-white/60 px-3 py-2 text-sm font-medium text-gray-800 transition-colors hover:border-gray-400 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-950/60 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800 sm:min-h-0 sm:px-4 sm:text-base"
                      >
                        Next
                      </button>
                    </div>
                    {Math.ceil(results.total / results.per_page) >= 5 && (
                      <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-gray-50/40 px-3 py-2.5 text-sm text-gray-700 dark:border-gray-800/70 dark:bg-gray-900/40 dark:text-gray-300 sm:px-4 sm:py-3 sm:text-base">
                        <label htmlFor="page-jump" className="text-xs text-gray-500 sm:text-sm">
                          Jump to
                        </label>
                        <input
                          id="page-jump"
                          type="number"
                          min={1}
                          max={Math.ceil(results.total / results.per_page)}
                          value={pageInput}
                          onChange={(e) => setPageInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleJumpToPage();
                            }
                          }}
                          className="w-16 rounded-lg border border-gray-300 bg-white/60 px-2 py-2 text-sm text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-950/60 dark:text-gray-200 sm:w-20 sm:px-3 sm:text-base"
                          disabled={loading}
                          inputMode="numeric"
                        />
                        <button
                          onClick={handleJumpToPage}
                          disabled={loading}
                          className="min-h-[44px] rounded-lg border border-gray-300 bg-white/60 px-3 py-2 text-sm text-gray-800 transition-colors hover:border-gray-400 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-950/60 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800 sm:min-h-0 sm:text-base"
                        >
                          Go
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <footer className="mt-10 border-t border-gray-200 pt-6 pb-[calc(6rem+env(safe-area-inset-bottom))] text-center text-xs text-gray-500 dark:border-gray-800 sm:mt-16 sm:pt-8 sm:pb-24 sm:text-sm">
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
            <Link href="/about" className="text-blue-400 hover:underline">
              About
            </Link>
            <span className="mx-2 text-gray-600">•</span>
            <Link href="/privacy" className="text-blue-400 hover:underline">
              Privacy Policy
            </Link>
          </p>
        </footer>
      </div>

      {/* Cookie Consent Banner */}
      <CookieBanner />

      {/* Card Detail Panel */}
      {selectedCard && (
        <CardDetailPanel
          key={selectedCard.id}
          card={selectedCard}
          onClose={() => setSelectedCard(null)}
        />
      )}
    </main>
  );
}
