import { promises as fs } from "fs";
import path from "path";
import { getCacheDir } from "@/lib/cache-paths";
import { ensureScryfallCatalogCache, getCatalog } from "@/lib/scryfall/catalogs";
import { createCacheLoader, readCacheJson, formatTodayStamp, shouldSkipUpdate, stampedToday } from "@/lib/utils/cache";
import { fetchWikiReminder } from "@/lib/keyword-wiki";
import { scryfallFetch } from "@/lib/scryfall/http";

type MtgKeywordEntry = {
  name: string;
  slug: string;
};

type MtgKeywordCacheFile = {
  updatedAt: string;
  keywords: MtgKeywordEntry[];
};

type MtgKeywordIndex = {
  bySlug: Map<string, MtgKeywordEntry>;
  list: MtgKeywordEntry[];
};

const SCRYFALL_KEYWORDS_URL =
  "https://api.scryfall.com/catalog/keyword-abilities";

const KEYWORD_REMINDERS_FILE_PATH = path.join(
  process.cwd(),
  "data",
  "mtg-keyword-reminders.json",
);

/** Same basename in the cache dir: locally that resolves to the tracked data/ file itself. */
const LEARNED_REMINDERS_FILE_PATH = path.join(getCacheDir(), "mtg-keyword-reminders.json");


const KEYWORDS_FILE_PATH = path.join(getCacheDir(), "mtg-keywords.json");

let keywordCache: MtgKeywordEntry[] | null = null;
let keywordCacheUpdatedAt: string | null = null;
let keywordIndex: MtgKeywordIndex | null = null;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function normalizeKeywordName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildKeywordIndex(entries: MtgKeywordEntry[]): MtgKeywordIndex {
  const bySlug = new Map<string, MtgKeywordEntry>();
  const list: MtgKeywordEntry[] = [];

  for (const entry of entries) {
    const slug = normalizeKeywordName(entry.slug || entry.name);
    if (!slug) continue;
    if (!bySlug.has(slug)) {
      const normalized: MtgKeywordEntry = { name: entry.name, slug };
      bySlug.set(slug, normalized);
      list.push(normalized);
    }
  }

  list.sort((a, b) => a.name.localeCompare(b.name));

  return { bySlug, list };
}

async function readKeywordFile(): Promise<MtgKeywordCacheFile | null> {
  try {
    const parsed = await readCacheJson(KEYWORDS_FILE_PATH, () => import("@/data/seed/mtg-keywords.json"));

    if (Array.isArray(parsed)) {
      const keywords = parsed
        .filter((entry): entry is { name: string; slug?: string } => entry && typeof entry.name === "string")
        .map((entry) => ({
          name: entry.name,
          slug: normalizeKeywordName(entry.slug || entry.name),
        }));
      return { updatedAt: "", keywords };
    }

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const updatedAt =
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords
          .filter((entry: { name?: unknown; slug?: unknown }): entry is { name: string; slug?: string } =>
            entry && typeof entry.name === "string",
          )
          .map((entry: { name: string; slug?: string }) => ({
            name: entry.name,
            slug: normalizeKeywordName(entry.slug || entry.name),
          }))
      : [];

    return { updatedAt, keywords };
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    console.warn("[MTG Keywords] Failed to read cached keywords file:", error);
    return null;
  }
}

async function writeKeywordFile(payload: MtgKeywordCacheFile): Promise<void> {
  await fs.mkdir(path.dirname(KEYWORDS_FILE_PATH), { recursive: true });
  await fs.writeFile(
    KEYWORDS_FILE_PATH,
    JSON.stringify(payload, null, 2),
    "utf-8",
  );
}

function mergeKeywords(
  existing: MtgKeywordEntry[] | null,
  fetched: MtgKeywordEntry[],
): {
  merged: MtgKeywordEntry[];
  addedSlugs: string[];
  renamed: Array<{ slug: string; from: string; to: string }>;
} {
  if (!existing || existing.length === 0) {
    return {
      merged: fetched,
      addedSlugs: fetched.map((entry) => entry.slug),
      renamed: [],
    };
  }

  const merged = existing.map((entry) => ({
    name: entry.name,
    slug: normalizeKeywordName(entry.slug || entry.name),
  }));

  const existingMap = new Map(
    existing.map((entry) => [
      normalizeKeywordName(entry.slug || entry.name),
      entry.name,
    ]),
  );

  const mergedMap = new Map(
    merged.map((entry) => [normalizeKeywordName(entry.slug || entry.name), entry.name]),
  );

  const addedSlugs: string[] = [];
  const renamed: Array<{ slug: string; from: string; to: string }> = [];

  for (const entry of fetched) {
    const slug = normalizeKeywordName(entry.slug || entry.name);
    if (!slug) continue;

    const existingName = existingMap.get(slug);
    if (!existingName) {
      merged.push({ name: entry.name, slug } as MtgKeywordEntry);
      mergedMap.set(slug, entry.name);
      addedSlugs.push(slug);
      continue;
    }

    if (existingName !== entry.name) {
      mergedMap.set(slug, entry.name);
      renamed.push({ slug, from: existingName, to: entry.name });
    }
  }

  if (renamed.length > 0) {
    for (const entry of merged) {
      const slug = normalizeKeywordName(entry.slug || entry.name);
      const updatedName = mergedMap.get(slug);
      if (updatedName && updatedName !== entry.name) {
        entry.name = updatedName;
      }
    }
  }

  merged.sort((a, b) => a.name.localeCompare(b.name));

  return { merged, addedSlugs, renamed };
}

type ScryfallKeywordResponse = {
  object: string;
  data: string[];
};


async function fetchKeywordsFromScryfall(): Promise<MtgKeywordEntry[]> {
  const response = await scryfallFetch(SCRYFALL_KEYWORDS_URL);

  if (!response.ok) {
    throw new Error(
      `[MTG Keywords] Failed to fetch keywords (${response.status} ${response.statusText})`,
    );
  }

  const payload = (await response.json()) as ScryfallKeywordResponse;
  if (!payload?.data || !Array.isArray(payload.data)) {
    throw new Error("[MTG Keywords] Unexpected Scryfall response format");
  }

  const entries = payload.data
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .map((name) => ({
      name,
      slug: normalizeKeywordName(name),
    }))
    .filter((entry) => entry.slug);

  entries.sort((a, b) => a.name.localeCompare(b.name));

  return entries;
}

const BLOCKED_KEYWORD_ACTIONS = new Set([
  "activate", "attach", "cast", "counter", "create", "destroy", "discard",
  "double", "exchange", "exile", "fight", "play", "regenerate", "reveal",
  "sacrifice", "search", "shuffle", "tap", "untap", "vote", "fateseal",
]);

/**
 * Synonym phrases that should be expanded to MTG keywords.
 * Used both for query matching and for stripping the original phrase from
 * unresolved fragments after the keyword has been resolved.
 */
export const KEYWORD_SYNONYM_STRIPS: Array<{ pattern: RegExp; keyword: string }> = [
  { pattern: /\bflyers?\b/gi, keyword: "flying" },
  { pattern: /\btramplers?\b/gi, keyword: "trample" },
  { pattern: /\bground\s*pound(?:ers?)?\b/gi, keyword: "trample" },
];

async function fetchCatalogKeywordExtras(): Promise<MtgKeywordEntry[]> {
  try {
    await ensureScryfallCatalogCache();
    const [actions, abilityWords] = await Promise.all([
      getCatalog("keyword-actions"),
      getCatalog("ability-words"),
    ]);

    const entries: MtgKeywordEntry[] = [];
    for (const name of actions) {
      const slug = normalizeKeywordName(name);
      if (!slug || BLOCKED_KEYWORD_ACTIONS.has(slug)) continue;
      entries.push({ name, slug });
    }
    for (const name of abilityWords) {
      const slug = normalizeKeywordName(name);
      if (!slug) continue;
      entries.push({ name, slug });
    }
    return entries;
  } catch (error) {
    console.warn("[MTG Keywords] Failed to fetch catalog keyword extras:", error);
    return [];
  }
}

async function initializeKeywordCache(): Promise<void> {
  const firstLoad = keywordCache === null;
  const existing = await readKeywordFile();
  if (existing) {
    keywordCache = existing.keywords;
    keywordCacheUpdatedAt = existing.updatedAt || null;
    keywordIndex = buildKeywordIndex(keywordCache);
  }

  // Serve file/seed data at once; a stale stamp makes the loader refresh it in the background.
  if (firstLoad && existing) return;

  const todayStamp = formatTodayStamp();
  if (existing && shouldSkipUpdate(existing.updatedAt, todayStamp)) {
    console.log(
      `[MTG Keywords] Cache already refreshed (${existing.updatedAt}), skipping update`,
    );
    return;
  }

  try {
    console.log(
      `[MTG Keywords] Performing cache update (file date: ${
        existing?.updatedAt || "none"
      }, today: ${todayStamp})`,
    );

    const fetched = await fetchKeywordsFromScryfall();

    const catalogExtras = await fetchCatalogKeywordExtras();
    if (catalogExtras.length > 0) {
      const existingSlugs = new Set(fetched.map((e) => e.slug));
      let added = 0;
      for (const extra of catalogExtras) {
        if (!existingSlugs.has(extra.slug)) {
          fetched.push(extra);
          existingSlugs.add(extra.slug);
          added++;
        }
      }
      if (added > 0) {
        console.log(`[MTG Keywords] Merged ${added} extra keywords from catalogs (keyword-actions, ability-words)`);
      }
    }

    const { merged, addedSlugs, renamed } = mergeKeywords(
      existing?.keywords || null,
      fetched,
    );

    keywordCache = merged;
    keywordCacheUpdatedAt = todayStamp;
    keywordIndex = buildKeywordIndex(merged);

    await writeKeywordFile({
      updatedAt: keywordCacheUpdatedAt,
      keywords: merged,
    });

    console.log(
      `[MTG Keywords] Cache updated (${keywordCacheUpdatedAt}): ${merged.length} keywords`,
    );

    // Background: up to 25 sequential wiki fetches must not hold up the request that loaded keywords.
    void learnMissingReminders(merged).catch((error) =>
      console.warn("[MTG Keywords] Reminder learning failed:", error),
    );

    if (addedSlugs.length > 0 || renamed.length > 0) {
      if (addedSlugs.length > 0) {
        console.log(
          `[MTG Keywords] Added keywords: ${addedSlugs
            .map((slug) => `"${slug}"`)
            .join(", ")}`,
        );
      }
      if (renamed.length > 0) {
        console.log(
          `[MTG Keywords] Renamed keywords: ${renamed
            .map((entry) => `${entry.slug} "${entry.from}" -> "${entry.to}"`)
            .join("; ")}`,
        );
      }
    } else {
      console.log("[MTG Keywords] No keyword content changes detected");
    }
  } catch (error) {
    // Stale file data (if any) stays; with none the cache stays null and is retried.
    console.error("[MTG Keywords] Failed to refresh cache:", error);
  }
}

export const ensureMtgKeywordCache = createCacheLoader(
  () => keywordCache !== null,
  initializeKeywordCache,
  { isFresh: stampedToday(() => keywordCacheUpdatedAt) }
);

async function getKeywordIndex(): Promise<MtgKeywordIndex> {
  await ensureMtgKeywordCache();
  if (!keywordIndex) {
    keywordIndex = buildKeywordIndex(keywordCache || []);
  }
  return keywordIndex;
}

export async function getMtgKeywordList(): Promise<string[]> {
  const { list } = await getKeywordIndex();
  return list.map((entry) => entry.name);
}

/**
 * Returns a map of keyword slug -> reminder text for tooltips.
 * Reads from data/mtg-keyword-reminders.json, a manually maintained static catalog.
 */
async function readReminderFile(filePath: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch (error) {
    if (!(isErrnoException(error) && error.code === "ENOENT")) {
      console.warn(`[MTG Keywords] Failed to read reminders file ${filePath}:`, error);
    }
  }
  return {};
}

let definitionsMap: Record<string, string> | null = null;
export async function getKeywordDefinitionsMap(): Promise<Record<string, string>> {
  if (definitionsMap) return definitionsMap;
  const base = await readReminderFile(KEYWORD_REMINDERS_FILE_PATH);
  const learned =
    LEARNED_REMINDERS_FILE_PATH === KEYWORD_REMINDERS_FILE_PATH
      ? {}
      : await readReminderFile(LEARNED_REMINDERS_FILE_PATH);
  definitionsMap = { ...base, ...learned };
  return definitionsMap;
}

/** ponytail: sequential wiki fetches, capped per refresh; a backlog drains over a few nightly runs. */
const MAX_REMINDER_LOOKUPS_PER_RUN = 25;

/**
 * Fills in reminder text for catalog keywords that have no definition yet, from
 * the MTG Wiki. Misses are stored as "" so they aren't re-fetched every night
 * (the tooltip treats "" as "no definition"). Locally the cache dir IS data/, so
 * learned entries land in the tracked reminders file; on serverless they go to a
 * /tmp overlay merged on read.
 */
async function learnMissingReminders(entries: MtgKeywordEntry[]): Promise<void> {
  const defs = await getKeywordDefinitionsMap();
  const missing = entries.filter((e) => !(e.slug in defs)).slice(0, MAX_REMINDER_LOOKUPS_PER_RUN);
  if (missing.length === 0) return;

  const learned: Record<string, string> = {};
  for (const entry of missing) {
    learned[entry.slug] = (await fetchWikiReminder(entry.name)) ?? "";
    await new Promise((r) => setTimeout(r, 250));
  }

  definitionsMap = { ...defs, ...learned };
  const existing = await readReminderFile(LEARNED_REMINDERS_FILE_PATH);
  const payload = Object.fromEntries(
    Object.entries({ ...existing, ...learned }).sort(([a], [b]) => a.localeCompare(b)),
  );
  await fs.mkdir(path.dirname(LEARNED_REMINDERS_FILE_PATH), { recursive: true });
  await fs.writeFile(LEARNED_REMINDERS_FILE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf-8");

  const found = Object.entries(learned).filter(([, v]) => v);
  console.log(
    `[MTG Keywords] Learned ${found.length}/${missing.length} reminder texts from MTG Wiki` +
      (found.length ? `: ${found.map(([k]) => `"${k}"`).join(", ")}` : ""),
  );
}

ensureMtgKeywordCache().catch((error) => {
  console.warn("[MTG Keywords] Warm-up failed:", error);
});

