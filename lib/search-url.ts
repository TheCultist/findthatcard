/**
 * Search URLs: `/search/<slug>` for simple queries, `/search?q=…` otherwise, plus `page` (>1),
 * `sort`/`dir` and `prefer` (each only when not the default) as query parameters. The URL is the
 * source of truth for the search page, so reload, Back/Forward and shared links reproduce what
 * was on screen.
 */

import { getQueryFromSlug, isSimpleQuery, slugifyQuery } from "@/lib/search-slug";
import { normalizeSort, sortFromParams, type SearchSort } from "@/lib/search-sort";
import { DEFAULT_PREFER, preferFromParams } from "@/lib/search-prefer";

/** `?page=N`; anything missing or invalid means page 1. */
export function parsePage(value: string | null): number {
  const page = Number.parseInt(value ?? "", 10);
  return page > 1 ? page : 1;
}

export function buildSearchUrl(
  searchQuery: string,
  page = 1,
  sort: SearchSort | null = null,
  prefer: string = DEFAULT_PREFER
): string {
  const trimmed = searchQuery.trim();
  if (!trimmed) {
    return "/search";
  }

  const slug = isSimpleQuery(trimmed) ? slugifyQuery(trimmed) : "";
  const parts = slug ? [] : [`q=${encodeURIComponent(trimmed)}`];
  if (page > 1) parts.push(`page=${page}`);
  const effectiveSort = normalizeSort(sort);
  if (effectiveSort) parts.push(`sort=${effectiveSort.by}`, `dir=${effectiveSort.dir}`);
  if (prefer !== DEFAULT_PREFER) parts.push(`prefer=${encodeURIComponent(prefer)}`);
  const path = slug ? `/search/${slug}` : "/search";
  return parts.length ? `${path}?${parts.join("&")}` : path;
}

/** What the search page reads back from a URL produced by buildSearchUrl. */
export function searchFromUrl(url: string): { query: string; page: number; sort: SearchSort | null; prefer: string } {
  const { pathname, searchParams } = new URL(url, "https://findthatcard.invalid");
  const query = pathname.startsWith("/search/")
    ? getQueryFromSlug(pathname.slice("/search/".length))
    : searchParams.get("q") ?? "";
  return {
    query: query.trim(),
    page: parsePage(searchParams.get("page")),
    sort: sortFromParams(searchParams),
    prefer: preferFromParams(searchParams),
  };
}
