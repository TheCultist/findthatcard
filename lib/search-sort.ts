/**
 * Result ordering. Scryfall sorts the whole result set (`order` + `dir` on /cards/search), so page N
 * is page N of the ordered list; the app never re-sorts a page itself.
 *
 * `null` means Scryfall's default (name, ascending). "Name ascending" is normalised to `null` too, so
 * the default never shows up in a URL or an upstream request.
 */

export const SORT_KEYS = ["name", "cmc", "usd", "released"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export interface SearchSort {
  by: SortKey;
  dir: SortDir;
}

export const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  cmc: "Mana value",
  usd: "Price (USD)",
  released: "Release date",
};

const isSortKey = (value: unknown): value is SortKey =>
  typeof value === "string" && (SORT_KEYS as readonly string[]).includes(value);

/** The default order collapses to null; everything else passes through. */
export function normalizeSort(sort: SearchSort | null): SearchSort | null {
  return !sort || (sort.by === "name" && sort.dir === "asc") ? null : sort;
}

/**
 * Lenient parse of untrusted input (request body, hand-edited URL). Anything unusable — unknown key,
 * a `dir` without a key, wrong types — means "no sort" rather than an error. A key without `dir`
 * sorts ascending.
 */
export function parseSortInput(by: unknown, dir: unknown): SearchSort | null {
  if (!isSortKey(by)) return null;
  return normalizeSort({ by, dir: dir === "desc" ? "desc" : "asc" });
}

/** `?sort=cmc&dir=desc` → sort. */
export function sortFromParams(params: { get(name: string): string | null }): SearchSort | null {
  return parseSortInput(params.get("sort"), params.get("dir"));
}

/** Stable string form, for comparing two sorts. */
export function sortKeyOf(sort: SearchSort | null): string {
  return sort ? `${sort.by}:${sort.dir}` : "";
}
