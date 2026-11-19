"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getTokenMetadata, tokenizeQuery, QueryToken, TokenMetadata } from "@/lib/query-tokens";
import {
  applyCatalogSelection,
  catalogCurrentValue,
  catalogKindOf,
  getTokenVariants,
  type CatalogKind,
  type QueryVariantGroup,
} from "@/lib/query-variants";

type QueryTokenPreviewProps = {
  scryfallQuery: string;
  sourceQuery: string;
  variant?: "panel" | "inline";
  className?: string;
  /**
   * Called with the rewritten query when the user picks a variant from a chip's menu. Without it
   * the chips only explain themselves.
   */
  onQueryChange?: (query: string) => void;
};

const SET_FIELDS = new Set(["set", "s", "e", "edition"]);

const normalizeSetCode = (value?: string) => {
  if (!value) return "";
  return value.replace(/^"|"$/g, "").toLowerCase();
};

export const isSetToken = (token: TokenMetadata) =>
  token.type === "field" && Boolean(token.field) && SET_FIELDS.has(token.field!.toLowerCase());

/** Loads set names from /api/sets once a set filter appears; returns a token → name lookup. */
export function useSetNames(tokens: TokenMetadata[]) {
  const [setNames, setSetNames] = useState<Record<string, string>>({});
  const hasSetCodes = tokens.some((token) => isSetToken(token) && normalizeSetCode(token.value));

  useEffect(() => {
    if (!hasSetCodes) {
      return;
    }
    let cancelled = false;
    const controller = new AbortController();

    const loadSetNames = async () => {
      try {
        const response = await fetch("/api/sets", { signal: controller.signal });
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as { sets?: Record<string, string> };
        if (!cancelled && payload.sets) {
          setSetNames(payload.sets);
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.warn("[QueryTokenPreview] Failed to load set names:", error);
        }
      }
    };

    loadSetNames();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [hasSetCodes]);

  return (token: TokenMetadata) => setNames[normalizeSetCode(token.value)] || "Unknown set";
}

/* Token styling: light mode = light bg + dark text (WCAG 4.5:1), dark mode = dark bg + light text */
export const getTokenClassName = (token: TokenMetadata) => {
  const base =
    "border border-solid rounded";
  if (token.type === "group") {
    return `${base} bg-surface-muted border-border text-muted`;
  }
  /* Field + logical: accent theme, mode-aware contrast */
  return `${base} bg-accent-muted border-accent/40 text-accent dark:bg-accent-muted-dark dark:border-accent/50 dark:text-accent`;
};


// ---------------------------------------------------------------------------
// Catalog value picker (t:, kw:, set:, function:) — values come from the app's own cache routes.
// ---------------------------------------------------------------------------

type CatalogEntry = { value: string; label?: string };

/** The subtype and type catalogs a t: chip draws from, with the label shown next to each value. */
const TYPE_CATALOGS: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: "card-types", label: "card type" },
  { slug: "supertypes", label: "supertype" },
  { slug: "creature-types", label: "creature type" },
  { slug: "artifact-types", label: "artifact type" },
  { slug: "enchantment-types", label: "enchantment type" },
  { slug: "land-types", label: "land type" },
  { slug: "planeswalker-types", label: "planeswalker type" },
  { slug: "spell-types", label: "spell type" },
  { slug: "battle-types", label: "battle type" },
];

const CATALOG_TITLES: Record<CatalogKind, string> = {
  types: "Types from the catalog",
  keywords: "Keywords from the catalog",
  sets: "Sets from the catalog",
  functions: "Function tags from Tagger",
};

/** One fetch per kind per page view, shared by every chip. */
const catalogEntryCache: Partial<Record<CatalogKind, CatalogEntry[]>> = {};
const catalogEntryPromise: Partial<Record<CatalogKind, Promise<CatalogEntry[]>>> = {};

async function fetchCatalogEntries(kind: CatalogKind): Promise<CatalogEntry[]> {
  if (kind === "sets") {
    const response = await fetch("/api/sets");
    if (!response.ok) throw new Error(`/api/sets ${response.status}`);
    const payload = (await response.json()) as { sets?: Record<string, string> };
    return Object.entries(payload.sets ?? {}).map(([code, name]) => ({ value: code, label: name }));
  }
  if (kind === "functions") {
    const response = await fetch("/api/function-tags");
    if (!response.ok) throw new Error(`/api/function-tags ${response.status}`);
    const payload = (await response.json()) as { tags?: string[] };
    return (payload.tags ?? []).map((value) => ({ value }));
  }
  const slugs = kind === "types" ? TYPE_CATALOGS.map((c) => c.slug) : ["keyword-abilities"];
  const response = await fetch(`/api/catalogs?only=${slugs.join(",")}`);
  if (!response.ok) throw new Error(`/api/catalogs ${response.status}`);
  const payload = (await response.json()) as { catalogs?: Record<string, string[]> };
  if (kind === "keywords") {
    return (payload.catalogs?.["keyword-abilities"] ?? []).map((value) => ({ value }));
  }
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const { slug, label } of TYPE_CATALOGS) {
    for (const value of payload.catalogs?.[slug] ?? []) {
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ value, label });
    }
  }
  return entries;
}

/** Entries for `kind`, loaded once on first use; null while loading, [] after a failed load. */
function useCatalogEntries(kind: CatalogKind): CatalogEntry[] | null {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(catalogEntryCache[kind] ?? null);

  useEffect(() => {
    if (catalogEntryCache[kind]) return;
    let cancelled = false;
    const promise = (catalogEntryPromise[kind] ??= fetchCatalogEntries(kind).then((loaded) => {
      catalogEntryCache[kind] = loaded;
      return loaded;
    }));
    promise
      .then((loaded) => {
        if (!cancelled) setEntries(loaded);
      })
      .catch((error) => {
        delete catalogEntryPromise[kind];
        console.warn(`[CatalogValuePicker] Failed to load ${kind}:`, error);
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  return entries;
}

const MAX_PICKER_ROWS = 50;

/**
 * Searchable multi-select over the cached catalog behind a t:, kw:, set: or function: chip. Picking one value
 * swaps it in place; picking several replaces the chip with a parenthesized OR group.
 */
export function CatalogValuePicker({
  token,
  query,
  onPick,
}: {
  token: QueryToken;
  query: string;
  onPick: (query: string) => void;
}) {
  const kind = catalogKindOf(token)!;
  const entries = useCatalogEntries(kind);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);

  const current = catalogCurrentValue(token);
  // Until the user touches a checkbox, the chip's own value (as the catalog spells it) is selected.
  const selected =
    picked ?? (entries ?? []).filter((e) => e.value.toLowerCase() === current).map((e) => e.value);

  const needle = filter.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!entries) return [];
    if (!needle) return entries;
    const starts: CatalogEntry[] = [];
    const contains: CatalogEntry[] = [];
    for (const entry of entries) {
      const value = entry.value.toLowerCase();
      const label = entry.label?.toLowerCase() ?? "";
      if (value.startsWith(needle)) starts.push(entry);
      else if (value.includes(needle) || label.includes(needle)) contains.push(entry);
    }
    return [...starts, ...contains];
  }, [entries, needle]);

  const shown = matches.slice(0, MAX_PICKER_ROWS);
  const hiddenSelected = selected.filter((v) => !shown.some((e) => e.value === v));

  const toggle = (value: string) => {
    setPicked(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  const result = selected.length > 0 ? applyCatalogSelection(token, query, selected) : "";
  const canApply = Boolean(result) && result !== query;

  return (
    <div className="font-sans">
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (canApply) onPick(result);
          }
        }}
        placeholder={entries === null ? "Loading…" : `Search ${matches.length} values…`}
        aria-label={`Search ${kind}`}
        className="w-full rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-xs text-foreground placeholder:text-muted-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      />
      <div className="mt-1 max-h-48 overflow-y-auto overscroll-contain pr-1">
        {entries === null ? (
          <div className="px-2 py-1.5 text-xs text-muted">Loading the catalog…</div>
        ) : entries.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted">The catalog could not be loaded.</div>
        ) : shown.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted">No value matches “{filter.trim()}”.</div>
        ) : (
          <ul>
            {shown.map((entry) => (
              <li key={entry.value}>
                <label className="flex cursor-pointer items-baseline gap-2 rounded-lg px-2 py-1 text-xs hover:bg-accent-muted/40">
                  <input
                    type="checkbox"
                    checked={selected.includes(entry.value)}
                    onChange={() => toggle(entry.value)}
                    className="relative top-0.5 h-3 w-3 shrink-0 accent-accent"
                  />
                  <span className="break-all font-mono text-foreground">{entry.value}</span>
                  {entry.label && <span className="text-muted-soft">{entry.label}</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
        {matches.length > MAX_PICKER_ROWS && (
          <div className="px-2 py-1 text-[0.65rem] text-muted-soft">
            Showing {MAX_PICKER_ROWS} of {matches.length} — type to narrow the list.
          </div>
        )}
      </div>
      {hiddenSelected.length > 0 && (
        <div className="mt-1 px-2 text-[0.65rem] text-muted-soft">Also selected: {hiddenSelected.join(", ")}</div>
      )}
      <button
        type="button"
        disabled={!canApply}
        onClick={() => onPick(result)}
        className="mt-2 w-full rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-accent/50 hover:bg-accent-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {selected.length > 1
          ? `Apply ${selected.length} values as an OR group`
          : selected.length === 1
            ? `Apply ${selected[0]}`
            : "Pick at least one value"}
      </button>
    </div>
  );
}

/** The variant options of one chip, grouped, each showing its syntax and what it changes. */
export function QueryVariantMenu({
  groups,
  onPick,
  className = "",
}: {
  groups: QueryVariantGroup[];
  onPick: (query: string) => void;
  className?: string;
}) {
  return (
    <div className={`font-sans ${className}`}>
      {groups.map((group) => (
        <div key={group.title} className="mt-3 first:mt-0">
          <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-soft">{group.title}</div>
          <ul className="mt-1 space-y-0.5">
            {group.variants.map((option) => (
              <li key={option.clause + option.label}>
                <button
                  type="button"
                  disabled={option.current}
                  aria-current={option.current ? "true" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onPick(option.query);
                  }}
                  className={`block w-full rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                    option.current
                      ? "cursor-default bg-accent-muted/60"
                      : "hover:bg-accent-muted/40 focus-visible:bg-accent-muted/40"
                  }`}
                >
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <code className="font-mono text-xs text-accent">{option.clause}</code>
                    <span className="text-xs font-semibold text-foreground">{option.label}</span>
                    {option.current && <span className="text-[0.65rem] uppercase text-muted-soft">current</span>}
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted">{option.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default function QueryTokenPreview({
  scryfallQuery,
  sourceQuery,
  variant = "panel",
  className = "",
  onQueryChange,
}: QueryTokenPreviewProps) {
  // Remembered with its query: a new query means new chips, so an open menu closes by itself.
  const [open, setOpen] = useState<{ query: string; index: number } | null>(null);
  const activeTooltip = open?.query === scryfallQuery ? open.index : null;
  const setActiveTooltip = (index: number | null) =>
    setOpen(index === null ? null : { query: scryfallQuery, index });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeTooltip === null) return;

    const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(null);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("touchstart", handleOutsideClick);
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("touchstart", handleOutsideClick);
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [activeTooltip]);
  const tokenMetadata = useMemo(
    () =>
      scryfallQuery
        ? tokenizeQuery(scryfallQuery).map((token) => getTokenMetadata(token, sourceQuery))
        : [],
    [scryfallQuery, sourceQuery]
  );
  const variantGroups = useMemo(
    () => (onQueryChange ? tokenMetadata.map((token) => getTokenVariants(token, scryfallQuery)) : []),
    [tokenMetadata, scryfallQuery, onQueryChange]
  );

  const setNameOf = useSetNames(tokenMetadata);

  const isEmpty = tokenMetadata.length === 0;

  const handleTokenTap = (index: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveTooltip(activeTooltip === index ? null : index);
  };

  const handlePick = (query: string) => {
    setActiveTooltip(null);
    onQueryChange?.(query);
  };

  const tokens = (
    <div ref={containerRef} className={`isolate flex flex-wrap gap-1.5 font-mono text-xs sm:gap-2 sm:text-sm ${className}`}>
      {isEmpty ? (
        <span className="rounded border border-border bg-surface-muted px-2 py-1 text-xs text-muted">
          No query tokens yet.
        </span>
      ) : (
        tokenMetadata.map((token, index) => {
          const groups = variantGroups[index] ?? [];
          const catalogKind = onQueryChange ? catalogKindOf(token) : undefined;
          const hasMenu = groups.length > 0 || catalogKind !== undefined;
          const isActive = activeTooltip === index;
          return (
            <span
              key={`${token.raw}-${index}`}
              className="group relative z-0 inline-flex max-w-full hover:z-30 focus-within:z-30"
            >
              <button
                type="button"
                onClick={(e) => handleTokenTap(index, e)}
                aria-expanded={isActive}
                aria-haspopup={hasMenu ? "dialog" : undefined}
                className={`inline-flex max-w-full items-center break-all px-1.5 py-1 text-left leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:px-2 ${
                  hasMenu ? "cursor-pointer" : "cursor-help"
                } ${getTokenClassName(token)}`}
              >
                {token.raw}
                {hasMenu && (
                  <span aria-hidden="true" className="ml-1 text-[0.6rem] opacity-60">
                    ▾
                  </span>
                )}
              </button>
              <div
                role={isActive ? "dialog" : undefined}
                aria-label={isActive ? `${token.raw}: ${token.title}` : undefined}
                className={`absolute left-1/2 top-full z-40 mt-2 w-[min(18rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-border bg-surface px-3 py-2.5 text-left text-xs text-foreground shadow-xl transition duration-200 sm:w-96 sm:px-4 sm:py-3 ${
                  isActive
                    ? "opacity-100"
                    : "pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                }`}
              >
                <div className="text-sm font-semibold text-foreground">{token.title}</div>
                <div className="mt-2 text-muted">{token.description}</div>
                {isSetToken(token) && (
                  <div className="mt-3 text-muted-soft">
                    <span className="font-semibold text-foreground">Set name</span>
                    <div className="mt-1">{setNameOf(token)}</div>
                  </div>
                )}
                {token.tip && (
                  <div className="mt-3 text-muted-soft">
                    <span className="font-semibold text-foreground">Tip</span>
                    <div className="mt-1">{token.tip}</div>
                  </div>
                )}
                {hasMenu && !isActive && (
                  <div className="mt-3 text-[0.65rem] uppercase tracking-wide text-muted-soft">
                    Click to change this term
                  </div>
                )}
                {isActive && groups.length > 0 && (
                  <div className="mt-3 border-t border-border pt-3">
                    <div className="text-sm font-semibold text-foreground">Change this term</div>
                    <QueryVariantMenu
                      groups={groups}
                      onPick={handlePick}
                      className="mt-2 max-h-72 overflow-y-auto overscroll-contain pr-1"
                    />
                  </div>
                )}
                {isActive && catalogKind && (
                  <div className="mt-3 border-t border-border pt-3">
                    <div className="text-sm font-semibold text-foreground">{CATALOG_TITLES[catalogKind]}</div>
                    <div className="mt-2">
                      <CatalogValuePicker token={token} query={scryfallQuery} onPick={handlePick} />
                    </div>
                  </div>
                )}
              </div>
            </span>
          );
        })
      )}
    </div>
  );

  if (variant === "inline") {
    return tokens;
  }

  return (
    <div className="mt-4 rounded-xl border border-border bg-surface-muted px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted">Query tokens</div>
      <div className="mt-2">{tokens}</div>
    </div>
  );
}
