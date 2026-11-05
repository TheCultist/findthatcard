/**
 * Recent searches, kept only in the browser's localStorage. Pure logic plus a storage layer that never
 * throws: blocked storage, corrupt JSON or hand-edited values all read as a clean list.
 */

export const RECENT_SEARCHES_KEY = "recent-searches";
export const MAX_RECENT_SEARCHES = 8;

/** The subset of `Storage` this module needs, so tests can pass a fake. */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Duplicate key: case and extra whitespace don't make a different search. */
export function normalizeSearch(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

const isSame = (a: string, b: string) => normalizeSearch(a) === normalizeSearch(b);

/** Newest first. A repeat moves to the top with the spelling just used. Empty queries are ignored. */
export function addRecentSearch(list: readonly string[], query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [...list];
  return [trimmed, ...list.filter((entry) => !isSame(entry, trimmed))].slice(0, MAX_RECENT_SEARCHES);
}

export function removeRecentSearch(list: readonly string[], query: string): string[] {
  return list.filter((entry) => !isSame(entry, query));
}

/** Keeps only non-empty strings, without duplicates, at most the cap. */
function sanitize(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  let list: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    if (list.some((kept) => isSame(kept, entry))) continue;
    list = [...list, entry.trim()];
    if (list.length === MAX_RECENT_SEARCHES) break;
  }
  return list;
}

export function loadRecentSearches(storage: StorageLike | null): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_SEARCHES_KEY);
    return raw ? sanitize(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Returns whether the write succeeded (it fails in some private modes); callers keep the list in memory either way. */
export function saveRecentSearches(storage: StorageLike | null, list: readonly string[]): boolean {
  if (!storage) return false;
  try {
    storage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** `window.localStorage`, or null where it doesn't exist or the accessor itself throws. */
export function getBrowserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
