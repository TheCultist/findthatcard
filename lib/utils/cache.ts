import { promises as fs } from "fs";
import path from "path";

/**
 * Reads a JSON cache file. When it doesn't exist yet (a fresh serverless instance's empty /tmp,
 * a fresh clone, CI) it falls back to the committed snapshot in data/seed/, so the instance starts
 * with data instead of ~20 blocking upstream fetches; the stale stamp then triggers a background
 * refresh. CACHE_SEED=off disables the fallback (used by `npm run seed` to fetch fresh data).
 * Untyped like JSON.parse: callers validate the shape.
 */
export async function readCacheJson(
  filePath: string,
  seed: () => Promise<{ default: unknown }>
): Promise<ReturnType<typeof JSON.parse>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || process.env.CACHE_SEED === "off") {
      throw error;
    }
    console.log(`[Cache] ${path.basename(filePath)} not found — starting from the seed snapshot`);
    return (await seed()).default;
  }
}

/** Returns today's date as an ISO date string (YYYY-MM-DD). */
export function formatTodayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns true when the cached file stamp is already up-to-date (same day or newer). */
export function shouldSkipUpdate(fileStamp: string | null, todayStamp: string): boolean {
  if (!fileStamp) return false;
  return fileStamp >= todayStamp;
}

/**
 * Single-flight loader for a module-level cache: concurrent callers share one load. A load that
 * leaves the cache unpopulated (upstream down on a cold start) is retried by a later call — at
 * most once per `retryMs` — instead of pinning the instance to empty data for its lifetime.
 * Callers inside the retry window resolve immediately and read whatever the cache holds.
 *
 * Stale-while-revalidate: once loaded, a cache that is no longer `isFresh` (e.g. yesterday's
 * stamp) is served as-is while one background reload runs, so a long-lived warm instance stays
 * current without a cron and no request waits on the refresh. CACHE_REFRESH=off skips these
 * refreshes (CI: tests run against the seed snapshots, offline and deterministic).
 */
export function createCacheLoader(
  isLoaded: () => boolean,
  load: () => Promise<void>,
  { retryMs = 60_000, isFresh = () => true }: { retryMs?: number; isFresh?: () => boolean } = {},
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let lastAttempt = -Infinity;
  const start = (): Promise<void> | null => {
    if (!inFlight && Date.now() - lastAttempt >= retryMs) {
      lastAttempt = Date.now();
      inFlight = load().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
  return () => {
    if (isLoaded()) {
      if (process.env.CACHE_REFRESH !== "off" && !isFresh()) {
        start()?.catch((error) => console.warn("[Cache] Background refresh failed:", error));
      }
      return Promise.resolve();
    }
    return start() ?? Promise.resolve();
  };
}

/** isFresh for caches stamped with formatTodayStamp(): stale once the UTC day rolls over. */
export function stampedToday(getStamp: () => string | null): () => boolean {
  return () => (getStamp() ?? "") >= formatTodayStamp();
}
