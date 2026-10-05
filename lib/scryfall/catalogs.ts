import { promises as fs } from "fs";
import path from "path";
import { getCacheDir } from "@/lib/cache-paths";
import { createCacheLoader, readCacheJson, formatTodayStamp, shouldSkipUpdate, stampedToday } from "@/lib/utils/cache";
import { scryfallFetch } from "@/lib/scryfall/http";

const CATALOG_SLUGS = [
  "artist-names",
  "word-bank",
  "supertypes",
  "card-types",
  "artifact-types",
  "battle-types",
  "creature-types",
  "enchantment-types",
  "land-types",
  "planeswalker-types",
  "spell-types",
  "powers",
  "toughnesses",
  "loyalties",
  "keyword-abilities",
  "keyword-actions",
  "ability-words",
  "flavor-words",
  "watermarks",
  "card-names",
] as const;

export type CatalogName = (typeof CATALOG_SLUGS)[number];

type CatalogCacheFile = {
  updatedAt: string;
  catalogs: Record<string, string[]>;
};


const CATALOGS_FILE_PATH = path.join(getCacheDir(), "scryfall-catalogs.json");

const FETCH_DELAY_MS = 100;

let catalogCache: Record<string, string[]> | null = null;
let catalogUpdatedAt: string | null = null;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function readCatalogFile(): Promise<CatalogCacheFile | null> {
  try {
    const parsed = await readCacheJson(CATALOGS_FILE_PATH, () => import("@/data/seed/scryfall-catalogs.json"));
    if (!parsed || typeof parsed !== "object") return null;

    const updatedAt =
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    const catalogs: Record<string, string[]> = {};

    if (parsed.catalogs && typeof parsed.catalogs === "object") {
      for (const [key, value] of Object.entries(parsed.catalogs)) {
        if (Array.isArray(value)) {
          catalogs[key] = (value as unknown[]).filter(
            (v): v is string => typeof v === "string"
          );
        }
      }
    }

    return { updatedAt, catalogs };
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    console.warn("[Scryfall Catalogs] Failed to read cache file:", error);
    return null;
  }
}

async function writeCatalogFile(payload: CatalogCacheFile): Promise<void> {
  await fs.mkdir(path.dirname(CATALOGS_FILE_PATH), { recursive: true });
  await fs.writeFile(
    CATALOGS_FILE_PATH,
    JSON.stringify(payload, null, 2),
    "utf-8"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ScryfallCatalogResponse = {
  object: string;
  total_values?: number;
  data: string[];
};

async function fetchCatalog(slug: string): Promise<string[]> {
  const url = `https://api.scryfall.com/catalog/${slug}`;
  const response = await scryfallFetch(url);

  if (!response.ok) {
    throw new Error(
      `[Scryfall Catalogs] Failed to fetch ${slug} (${response.status} ${response.statusText})`
    );
  }

  const payload = (await response.json()) as ScryfallCatalogResponse;
  if (!payload?.data || !Array.isArray(payload.data)) {
    throw new Error(
      `[Scryfall Catalogs] Unexpected response format for ${slug}`
    );
  }

  return payload.data.filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
}

async function fetchAllCatalogs(
  existing: Record<string, string[]> | null
): Promise<{ catalogs: Record<string, string[]>; complete: boolean }> {
  const result: Record<string, string[]> = {};
  let fetched = 0;
  let failed = 0;

  for (const slug of CATALOG_SLUGS) {
    try {
      if (fetched > 0) await sleep(FETCH_DELAY_MS);
      const data = await fetchCatalog(slug);
      result[slug] = data;
      fetched++;

      const prev = existing?.[slug]?.length ?? 0;
      if (prev > 0 && data.length !== prev) {
        console.log(
          `[Scryfall Catalogs]   ${slug}: ${prev} -> ${data.length} entries`
        );
      }
    } catch (error) {
      failed++;
      console.warn(`[Scryfall Catalogs]   ${slug}: fetch failed`, error);
      if (existing?.[slug]) {
        result[slug] = existing[slug];
      }
    }
  }

  console.log(
    `[Scryfall Catalogs] Fetched ${fetched}/${CATALOG_SLUGS.length} catalogs` +
      (failed > 0 ? ` (${failed} failed, kept previous data)` : "")
  );
  if (fetched === 0) {
    throw new Error("[Scryfall Catalogs] Every catalog fetch failed");
  }

  return { catalogs: result, complete: failed === 0 };
}

async function initializeCatalogCache(): Promise<void> {
  const firstLoad = catalogCache === null;
  const existing = await readCatalogFile();
  if (existing) {
    catalogCache = existing.catalogs;
    catalogUpdatedAt = existing.updatedAt;
  }

  // Serve file/seed data at once; a stale stamp makes the loader refresh it in the background.
  if (firstLoad && existing) return;

  const todayStamp = formatTodayStamp();
  if (existing && shouldSkipUpdate(existing.updatedAt, todayStamp)) {
    const totalEntries = Object.values(existing.catalogs).reduce(
      (sum, arr) => sum + arr.length,
      0
    );
    console.log(
      `[Scryfall Catalogs] Cache already refreshed (${existing.updatedAt}), ` +
        `${Object.keys(existing.catalogs).length} catalogs, ${totalEntries} total entries`
    );
    return;
  }

  try {
    console.log(
      `[Scryfall Catalogs] Performing cache update (file date: ${
        existing?.updatedAt || "none"
      }, today: ${todayStamp})`
    );

    const { catalogs: fetched, complete } = await fetchAllCatalogs(existing?.catalogs || null);

    catalogCache = fetched;
    // In memory a partial refresh still counts as today's (no 20-fetch retry every minute);
    // the file keeps the old stamp so the next cold start retries the gaps.
    catalogUpdatedAt = todayStamp;
    await writeCatalogFile({
      updatedAt: complete ? todayStamp : existing?.updatedAt ?? "",
      catalogs: fetched,
    });

    const totalEntries = Object.values(fetched).reduce(
      (sum, arr) => sum + arr.length,
      0
    );
    console.log(
      `[Scryfall Catalogs] Cache updated (${todayStamp}): ` +
        `${Object.keys(fetched).length} catalogs, ${totalEntries} total entries`
    );
  } catch (error) {
    // Stale file data (if any) stays; with none the cache stays null and is retried.
    console.error("[Scryfall Catalogs] Failed to refresh cache:", error);
  }
}

export const ensureScryfallCatalogCache = createCacheLoader(
  () => catalogCache !== null,
  initializeCatalogCache,
  { isFresh: stampedToday(() => catalogUpdatedAt) }
);

/** Identifies the loaded catalog data — changes whenever a refresh replaces it. */
export function getCatalogStamp(): string | null {
  return catalogUpdatedAt;
}

export async function getCatalog(name: CatalogName): Promise<string[]> {
  await ensureScryfallCatalogCache();
  return catalogCache?.[name] ?? [];
}

export async function getAllCatalogs(): Promise<Record<string, string[]>> {
  await ensureScryfallCatalogCache();
  return { ...(catalogCache ?? {}) };
}

ensureScryfallCatalogCache().catch((error) => {
  console.warn("[Scryfall Catalogs] Warm-up failed:", error);
});
