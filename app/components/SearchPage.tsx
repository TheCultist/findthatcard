"use client";

import React, { useState, FormEvent, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ShieldCheckIcon,
  PaintBrushIcon,
  QueueListIcon,
  ChevronDownIcon,
} from "@heroicons/react/24/outline";
import { SearchResponse, ErrorResponse, CardResult } from "@/types/scryfall";
import { getRandomExamples } from "@/lib/example-queries";
import { getRandomProTip } from "@/lib/pro-tips";
import CookieBanner from "@/app/components/CookieBanner";
import { fetchSymbolData } from "@/lib/scryfall/symbols";
import useAdBlockDetection from "@/app/hooks/useAdBlockDetection";
import CardCard from "@/app/components/CardCard";
import AdBanner from "@/app/components/AdBanner";
import QueryTokenPreview from "@/app/components/QueryTokenPreview";
import { COLOR_NAMES } from "@/lib/query-tokens";
import { formatErrorMessage } from "@/lib/utils/errors";
import CardDetailPanel from "@/app/components/CardDetailPanel";
import ThemeToggle from "@/app/components/ThemeToggle";
import BugReportButton from "@/app/components/BugReportButton";

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

function cavernHoldBanner(key: string) {
  return (
    <div key={key} className="col-span-full my-4">
      <p className="mb-1 text-[10px] text-muted">Advertisement</p>
      <a
        href="https://cavernhold.pxf.io/yZ2rMG"
        target="_blank"
        rel="noopener noreferrer sponsored"
        className="block w-full cursor-pointer"
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
  const [faqExpandedIndex, setFaqExpandedIndex] = useState<number | null>(null);
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

      try {
        const shouldUpdateUrl = options.updateUrl ?? page === 1;
        if (shouldUpdateUrl && page === 1) {
          const nextUrl = buildSearchUrl(searchQuery);
          const currentUrl = `${pathname}${searchParams.toString() ? `?${searchParams}` : ""}`;
          if (nextUrl !== currentUrl) {
            await Promise.resolve(router.push(nextUrl, { scroll: false })).catch((e) => {
              console.warn("[Search] router.push failed:", e);
            });
          }
        }

        setLoading(true);
        setError(null);
        if (page === 1) {
          setResults(null);
          setEditableQuery("");
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
            setError(formatErrorMessage(errorData.error ?? "An error occurred"));
            if (errorData.scryfallQuery && page === 1) {
              setEditableQuery(errorData.scryfallQuery);
            }
            return;
          }

          setResults(data as SearchResponse);
          setCurrentPage(data.page);
          setPageInput(String(data.page));
          if (page === 1) {
            setEditableQuery(data.scryfallQuery);
          }
        } catch (err) {
          const message =
            err instanceof TypeError
              ? "Failed to connect to the server. Please try again."
              : formatErrorMessage(err);
          setError(message);
          console.error("Search error:", err);
        } finally {
          setLoading(false);
        }
      } catch (err) {
        console.error("[Search] handleSearch failed:", err);
        setError(formatErrorMessage(err));
        setLoading(false);
      }
    },
    [pathname, router, searchParams]
  );

  useEffect(() => {
    setExampleQueries(getRandomExamples(4));
  }, []);

  useEffect(() => {
    fetchSymbolData();
  }, []);

  useEffect(() => {
    const urlQuery = getQueryFromUrl().trim();
    if (!urlQuery || urlQuery === lastUrlQueryRef.current) {
      return;
    }
    lastUrlQueryRef.current = urlQuery;
    setQuery(urlQuery);
    setCurrentPage(1);
    setPageInput("1");
    void handleSearch(urlQuery, 1, { updateUrl: false }).catch((err) => {
      console.error("[Search] URL-driven search failed:", err);
      setError(formatErrorMessage(err));
      setLoading(false);
    });
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


  useEffect(() => {
    if (results && !loading) {
      // Small delay to ensure DOM is updated before scrolling
      setTimeout(() => {
        const queryElement = document.getElementById("query-display");
        if (queryElement) {
          queryElement.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
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
    <main className="min-h-screen bg-background px-3 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-4 flex justify-end">
          <ThemeToggle />
        </div>

        <section className="relative overflow-hidden rounded-2xl border border-border bg-surface px-4 py-6 shadow-[0_1px_0_0_hsl(var(--border)),0_20px_50px_-20px_rgba(0,0,0,0.08)] sm:rounded-3xl sm:px-10 sm:py-14 dark:shadow-[0_1px_0_0_hsl(var(--border)),0_20px_50px_-25px_rgba(0,0,0,0.5)]">
          <div className="relative animate-fade-up">
            <div className="text-center">
              <Link
                href="/"
                className="inline-flex justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                <h1 className="font-display mb-2 text-3xl font-bold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
                  Find That Card
                </h1>
              </Link>
              <p className="mx-auto max-w-2xl text-base font-medium text-muted sm:text-xl">
                Search Magic: The Gathering cards using natural language.
              </p>
              <p className="mt-3 text-xs text-muted-soft">
                Work in progress &amp; constantly evolving — if a search doesn&apos;t give you what you want, let us know via the{" "}
                <span className="font-medium text-muted">bug button</span> in the bottom right.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="mt-5 sm:mt-8">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                <label htmlFor="search-query" className="sr-only">
                  Search Magic: The Gathering cards
                </label>
                <input
                  id="search-query"
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder='Try "white creatures" or "dragons in the art"'
                  className="min-h-[44px] flex-1 rounded-xl border border-border bg-surface-muted px-4 py-3.5 text-base text-foreground placeholder-muted transition-colors duration-200 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 focus:ring-offset-2 focus:ring-offset-background sm:py-3"
                  disabled={loading}
                  enterKeyHint="search"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-describedby={loading ? "search-loading" : undefined}
                />
                <button
                  type="submit"
                  disabled={loading}
                  id={loading ? "search-loading" : undefined}
                  aria-busy={loading}
                  className="min-h-[44px] cursor-pointer rounded-xl bg-accent px-7 py-3.5 font-semibold text-white shadow-lg shadow-accent/20 transition-colors duration-200 hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 sm:py-3"
                >
                  {loading ? "Searching..." : "Search"}
                </button>
              </div>
            </form>

            {exampleQueries.length > 0 && (
              <div className="mt-4 -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-hide sm:mx-0 sm:mt-6 sm:flex-wrap sm:justify-center sm:px-0">
                {exampleQueries.map((example, index) => (
                  <button
                    key={`${example}-${index}`}
                    onClick={() => handleChipClick(example)}
                    disabled={loading}
                    className="min-h-[44px] min-w-[44px] flex-shrink-0 cursor-pointer rounded-full border border-border-muted bg-surface-muted px-4 py-2.5 text-sm font-medium text-muted transition-colors duration-200 hover:border-accent/50 hover:bg-accent-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30 focus:ring-offset-2 focus:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:min-w-0 sm:py-1.5 sm:text-base"
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
          <section
            className="mb-8 mt-6 text-base text-muted sm:mb-10 sm:mt-10"
            aria-labelledby="intro-heading"
          >
            <div className="mx-auto max-w-4xl">
              <p
                id="intro-heading"
                className="text-center text-base font-medium text-foreground sm:text-lg"
              >
                No Scryfall syntax to memorize. Just describe what you want — the tool figures out
                the query.
              </p>

              {/* Feature cards — clickable example searches */}
              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
                {[
                  {
                    icon: <ShieldCheckIcon className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />,
                    label: "Card intent",
                    description: "Removal, ramp, tutors, tokens, or any role you can describe.",
                    example: "Dimir removal spells",
                  },
                  {
                    icon: <PaintBrushIcon className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />,
                    label: "Art and flavor",
                    description: "Dragons, angels, swords, landscapes, or other artwork subjects.",
                    example: "cards with dragon artwork",
                  },
                  {
                    icon: <QueueListIcon className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />,
                    label: "Formats and rules",
                    description: "Commander, Modern, Pauper, plus colors, keywords, and mechanics.",
                    example: "Commander legal ramp under 3 mana",
                  },
                ].map(({ icon, label, description, example }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => handleChipClick(example)}
                    className="group cursor-pointer rounded-xl border border-border bg-surface-muted px-4 py-4 text-left transition hover:border-accent/50 hover:bg-accent-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:rounded-2xl sm:px-6 sm:py-6"
                  >
                    <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-accent/40 bg-accent/10 text-accent sm:mb-4 sm:h-12 sm:w-12">
                      {icon}
                    </div>
                    <p className="text-center text-xs font-semibold uppercase tracking-wide text-muted sm:text-sm">
                      {label}
                    </p>
                    <p className="mt-1.5 text-center text-sm leading-relaxed text-foreground sm:mt-2 sm:text-base">
                      {description}
                    </p>
                    <p className="mt-2 text-center text-xs text-accent opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                      Try: {example} →
                    </p>
                  </button>
                ))}
              </div>

              {/* How it works — standalone FAQ section */}
              <section className="mt-8 sm:mt-10" aria-labelledby="faq-heading">
                <h2
                  id="faq-heading"
                  className="mb-4 text-center text-xs font-semibold uppercase tracking-[0.15em] text-muted sm:mb-5 sm:text-sm"
                >
                  How it works
                </h2>
                <dl className="divide-y divide-border/50 rounded-2xl border border-border bg-surface-muted text-sm sm:text-base">
                  {(
                    [
                      {
                        q: "How do I find a Magic card I can't remember?",
                        a: "Describe what you remember in plain English — a color, mechanic, artwork detail, or how it played. For example: \"blue instant that counters spells for 2 mana\", \"black creature with deathtouch and lifelink\", or \"art with a lighthouse\". The tool converts your description into a Scryfall query automatically.",
                      },
                      {
                        q: "Can I search Commander, Modern, or Pauper cards?",
                        a: "Yes. Include the format in your query and results are filtered by legality. For example: \"Commander legal ramp spells under 3 mana\", \"Modern removal instant\", or \"Pauper blue fliers\". Supported formats include Commander, Modern, Pauper, Standard, Pioneer, Legacy, Vintage, and more.",
                      },
                      {
                        q: "Does it support Scryfall Tagger art and function tags?",
                        a: (
                          <>
                            Yes — both in natural language and directly. Use{" "}
                            <code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">art:</code>{" "}
                            for artwork subjects (e.g.{" "}
                            <code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">art:dragon</code>,{" "}
                            <code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">art:lighthouse</code>) and{" "}
                            <code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">function:</code>{" "}
                            for card roles (e.g.{" "}
                            <code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">function:removal</code>,{" "}
                            <code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">function:card-advantage</code>
                            {'). You can also just describe the art or role in plain language — '}
                            <code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">cards with dragon artwork</code>
                            {" or "}
                            <code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">removal spells</code>
                            {" both work."}
                          </>
                        ),
                      },
                      {
                        q: "Can I type Scryfall syntax directly?",
                        a: (
                          <>
                            Yes. If your query looks like Scryfall syntax — e.g.{" "}
                            <code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">t:creature c:r cmc&lt;=3</code>{" "}
                            or{" "}
                            <code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">
                              name:&quot;Sol Ring&quot; game:paper
                            </code>{" "}
                            — it is passed directly to Scryfall without any conversion. You can also edit the generated query after a natural language search.
                          </>
                        ),
                      },
                      {
                        q: "How do I search by color or color identity?",
                        a: "Use color names, guild names, or shard/wedge names directly. For example: \"Dimir creatures\", \"Gruul aggro\", \"white and green ramp\", or \"Temur spells\". You can also specify \"exactly Rakdos\" vs \"including black and red\" if you need strict or inclusive color filtering.",
                      },
                    ] as { q: string; a: string | React.ReactNode }[]
                  ).map((item, index) => {
                    const isExpanded = faqExpandedIndex === index;
                    return (
                      <div key={index}>
                        <dt>
                          <button
                            type="button"
                            onClick={() => setFaqExpandedIndex(isExpanded ? null : index)}
                            aria-expanded={isExpanded}
                            aria-controls={`faq-answer-${index}`}
                            id={`faq-question-${index}`}
                            className={`flex w-full cursor-pointer items-center justify-between gap-4 px-5 py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 ${
                              isExpanded
                                ? "text-accent"
                                : "text-foreground hover:bg-accent-muted/20 hover:text-accent"
                            }`}
                          >
                            <span className="font-medium leading-snug">{item.q}</span>
                            <ChevronDownIcon
                              className={`h-4 w-4 flex-shrink-0 transition-transform duration-200 ${
                                isExpanded ? "rotate-180 text-accent" : "text-muted"
                              }`}
                              aria-hidden="true"
                            />
                          </button>
                        </dt>
                        <dd
                          id={`faq-answer-${index}`}
                          role="region"
                          aria-labelledby={`faq-question-${index}`}
                          className="grid motion-safe:transition-[grid-template-rows] motion-safe:duration-200 motion-safe:ease-out"
                          style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
                        >
                          <div className="overflow-hidden">
                            <div className="border-t border-border/50 px-5 py-4 leading-relaxed text-muted-soft">
                              {item.a}
                            </div>
                          </div>
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </section>

              <p className="mt-5 text-center text-sm text-muted-soft">
                Results are powered by Scryfall and updated in real time. A project by{" "}
                <Link href="/about" className="text-accent hover:underline">
                  Cardboard Cultist
                </Link>
                .
              </p>
            </div>
          </section>
        )}

        {/* Ad Space / Adblock Message */}
        {trimmedQuery && (
          <div className="mb-8 flex justify-center">
            {adBlockDetected ? (
              <div className="w-full max-w-2xl rounded-lg border border-border bg-surface-muted p-4 text-center">
                <p className="text-base text-muted">
                  <span className="font-medium text-foreground">Find That Card is supported by ads.</span>
                  <br />
                  <span className="text-sm text-muted-soft">
                    A single, non-intrusive ad helps keep this site free. Please consider whitelisting{" "}
                    <span className="font-medium text-muted">findthatcard.net</span> in your ad blocker.
                  </span>
                </p>
              </div>
            ) : (
              <AdBanner slot="4024965634" className="w-full max-w-2xl" />
            )}
          </div>
        )}

        {(editableQuery || sourceQuery || results) && !loading && (
          <div id="query-display" className="relative z-50 mb-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 sm:px-4 sm:py-2.5">
                <span className="whitespace-nowrap text-sm text-muted">Query:</span>
                <div className="relative min-w-0 flex-1">
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
                    className={`w-full resize-none overflow-hidden bg-transparent font-mono text-sm leading-relaxed text-accent focus:outline-none sm:text-base ${
                      isEditingQuery
                        ? "relative z-10 opacity-100"
                        : "pointer-events-none absolute inset-0 h-full opacity-0"
                    }`}
                    disabled={loading}
                    placeholder="Edit Scryfall query..."
                  />
                  {!isEditingQuery && (
                    <div
                      className="cursor-text text-accent"
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
                  className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none sm:py-2 sm:text-base"
                >
                  Search
                </button>
                <a
                  href={`https://scryfall.com/search?q=${encodeURIComponent(editableQuery)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-1 cursor-pointer items-center justify-center rounded-lg border border-border bg-surface-muted px-4 py-2.5 text-center text-sm text-foreground transition-colors duration-200 hover:border-accent/50 hover:bg-accent-muted/30 sm:flex-none sm:py-2 sm:text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <span className="sm:hidden">Scryfall</span>
                  <span className="hidden sm:inline">View on Scryfall</span>
                </a>
              </div>
            </div>
            {(() => {
              // Detect a single id: or id= token in the current query.
              const idMatch = editableQuery.match(/\bid([=:])([a-z]+)/i);
              if (!idMatch) return null;
              const currentOp = idMatch[1]!;   // ":" or "="
              const idValue = idMatch[2]!.toLowerCase();
              const targetOp = currentOp === ":" ? "=" : ":";
              // Normalize to WUBRG order for the color name lookup.
              const wubrg = "wubrg";
              const normalized = idValue.split("").sort((a, b) => wubrg.indexOf(a) - wubrg.indexOf(b)).join("");
              const fullName = COLOR_NAMES[normalized] ?? idValue.toUpperCase();
              // Trim the parenthetical so we just get e.g. "Jund" not "Jund (Black + Red + Green)".
              const shortName = fullName.split(" (")[0];
              const altQuery = editableQuery.replace(
                new RegExp(`\\bid${currentOp === ":" ? ":" : "="}${idValue}\\b`, "i"),
                `id${targetOp}${idValue}`
              );
              const label = targetOp === "="
                ? `Exact ${shortName} identity (id=)`
                : `Playable in ${shortName} (id:)`;
              return (
                <div className="mt-2 flex items-center gap-2 text-sm text-muted">
                  <span className="text-muted-soft">Also try:</span>
                  <button
                    onClick={() => {
                      setEditableQuery(altQuery);
                      setCurrentPage(1);
                      setPageInput("1");
                      handleSearch(altQuery, 1, { updateUrl: false });
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface-muted px-3 py-1 text-sm font-medium text-foreground transition-colors hover:border-accent/50 hover:bg-accent-muted"
                  >
                    {label}
                  </button>
                </div>
              );
            })()}
          </div>
        )}

        {error && (
          <div className="mb-6 rounded-lg border border-red-300 bg-red-50/30 p-4 text-red-600 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400">
            <p className="font-medium">Error</p>
            <p className="text-base">{error}</p>
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-accent-muted border-t-accent" />
            {proTip && (
              <div className="w-full max-w-2xl rounded-2xl border border-border bg-surface-muted px-5 py-4 text-sm">
                <span className="text-xs font-semibold uppercase tracking-wider text-accent">
                  Pro tip
                </span>
                <p className="mt-2 text-base text-foreground">{proTip}</p>
              </div>
            )}
          </div>
        )}

        {results && (
          <div id="results-section" className="mb-10">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-surface-muted px-3 py-2.5 text-sm text-foreground sm:mb-5 sm:gap-3 sm:px-4 sm:py-3 sm:text-base">
              <div>
                Found {results.total.toLocaleString()} card{results.total !== 1 ? "s" : ""}
                {results.total > 0 && (
                  <span className="ml-1 text-muted-soft sm:ml-2">
                    (p.{results.page}, {results.cards.length} shown)
                  </span>
                )}
              </div>
            </div>

            {results.cards.length === 0 ? (
              <div className="rounded-2xl border border-border bg-surface-muted p-10 text-center text-foreground">
                No cards found. Try a different search query.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
                  {(() => {
                    const items: React.ReactNode[] = [];
                    const cardCount = results.cards.length;

                    results.cards.forEach((card, index) => {
                      items.push(
                        <CardCard
                          key={card.id}
                          card={card}
                          onCardClick={setSelectedCard}
                        />
                      );

                      // Insert CavernHold ad banner after 20th card if we have 30+ results
                      if (cardCount >= 30 && index === 19) {
                        items.push(cavernHoldBanner("ad-20"));
                      }

                      // Insert CavernHold ad banner after 40th card if we have 50+ results
                      if (cardCount >= 50 && index === 39) {
                        items.push(cavernHoldBanner("ad-40"));
                      }
                    });

                    return items;
                  })()}
                </div>

                {(results.has_more || results.page > 1) && (
                    <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:mt-8 sm:gap-4">
                    <div className="flex w-full items-center justify-center gap-3 rounded-2xl border border-border bg-surface-muted px-3 py-3 text-base text-foreground sm:w-auto sm:gap-4 sm:px-4">
                      <button
                        onClick={() => handlePageChange(results.page - 1)}
                        disabled={loading || results.page === 1}
                        className="min-h-[44px] rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent/50 hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:px-4 sm:text-base"
                      >
                        Previous
                      </button>
                      <span className="text-sm text-muted sm:text-base">
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
                                  ? "rounded-lg border border-accent bg-accent-muted px-3 py-2 text-base font-semibold text-accent"
                                  : "rounded-lg border border-border bg-surface-muted px-3 py-2 text-base text-foreground transition-colors hover:border-accent/50 hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
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
                        className="min-h-[44px] rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent/50 hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:px-4 sm:text-base"
                      >
                        Next
                      </button>
                    </div>
                    {Math.ceil(results.total / results.per_page) >= 5 && (
                      <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface-muted px-3 py-2.5 text-sm text-foreground sm:px-4 sm:py-3 sm:text-base">
                        <label htmlFor="page-jump" className="text-xs text-muted sm:text-sm">
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
                          className="w-16 rounded-lg border border-border bg-surface px-2 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 sm:w-20 sm:px-3 sm:text-base"
                          disabled={loading}
                          inputMode="numeric"
                        />
                        <button
                          onClick={handleJumpToPage}
                          disabled={loading}
                          className="min-h-[44px] rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground transition-colors hover:border-accent/50 hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:text-base"
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

        <footer className="mt-10 border-t border-border pt-6 pb-[calc(6rem+env(safe-area-inset-bottom))] text-center text-xs text-muted sm:mt-16 sm:pt-8 sm:pb-24 sm:text-sm">
          <p>
            Unofficial fan content. Card data and images from{" "}
            <a
              href="https://scryfall.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              Scryfall
            </a>{" "}
            and community tags from{" "}
            <a
              href="https://tagger.scryfall.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              Scryfall Tagger
            </a>
            . Not endorsed by Wizards of the Coast or Scryfall.
          </p>
          <p className="mt-2">
            <Link href="/about" className="text-accent hover:underline">
              About
            </Link>
            <span className="mx-2 text-muted-soft">•</span>
            <Link href="/privacy" className="text-accent hover:underline">
              Privacy Policy
            </Link>
          </p>
        </footer>
      </div>

      <CookieBanner />

      {selectedCard && (
        <CardDetailPanel
          key={selectedCard.id}
          card={selectedCard}
          onClose={() => setSelectedCard(null)}
        />
      )}

      <BugReportButton userQuery={sourceQuery} scryfallQuery={editableQuery} />
    </main>
  );
}
