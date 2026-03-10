import { promises as fs } from "fs";
import path from "path";
import { getCacheDir } from "@/lib/cache-paths";
import { formatTodayStamp, shouldSkipUpdate } from "@/lib/utils/cache";

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

const SCRYFALL_USER_AGENT =
  process.env.SCRYFALL_USER_AGENT || "find-that-card/1.0 (+https://findthat.card)";

const CATALOGS_FILE_PATH = path.join(getCacheDir(), "scryfall-catalogs.json");

const FETCH_DELAY_MS = 100;

let catalogCache: Record<string, string[]> | null = null;
let catalogCacheUpdatedAt: string | null = null;
let catalogCachePromise: Promise<void> | null = null;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function readCatalogFile(): Promise<CatalogCacheFile | null> {
  try {
    const raw = await fs.readFile(CATALOGS_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
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
  const response = await fetch(url, {
    headers: {
      "User-Agent": SCRYFALL_USER_AGENT,
      Accept: "application/json",
    },
  });

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
): Promise<Record<string, string[]>> {
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

  return result;
}

async function initializeCatalogCache(): Promise<void> {
  if (catalogCache !== null) return;

  const existing = await readCatalogFile();
  if (existing) {
    catalogCache = existing.catalogs;
    catalogCacheUpdatedAt = existing.updatedAt || null;
  }

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

    const fetched = await fetchAllCatalogs(existing?.catalogs || null);

    catalogCache = fetched;
    catalogCacheUpdatedAt = todayStamp;

    await writeCatalogFile({
      updatedAt: todayStamp,
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
    console.error("[Scryfall Catalogs] Failed to refresh cache:", error);
    if (!catalogCache) {
      catalogCache = {};
    }
  }
}

export async function ensureScryfallCatalogCache(): Promise<void> {
  if (catalogCache !== null) return;

  if (catalogCachePromise === null) {
    catalogCachePromise = initializeCatalogCache().catch((error) => {
      catalogCachePromise = null;
      throw error;
    });
  }

  await catalogCachePromise;
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
