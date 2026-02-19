import { promises as fs } from "fs";
import path from "path";
import { getCacheDir } from "@/lib/cache-paths";

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

const SCRYFALL_USER_AGENT =
  process.env.SCRYFALL_USER_AGENT || "find-that-card/1.0 (+https://findthat.card)";

const KEYWORDS_FILE_PATH = path.join(getCacheDir(), "mtg-keywords.json");

let keywordCache: MtgKeywordEntry[] | null = null;
let keywordCacheUpdatedAt: string | null = null;
let keywordCachePromise: Promise<void> | null = null;
let keywordIndex: MtgKeywordIndex | null = null;

function formatTodayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function compareDateStamp(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function shouldSkipUpdate(fileStamp: string | null, todayStamp: string): boolean {
  if (!fileStamp) {
    return false;
  }
  return compareDateStamp(fileStamp, todayStamp) >= 0;
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
      const normalized: MtgKeywordEntry = {
        name: entry.name,
        slug,
      };
      bySlug.set(slug, normalized);
      list.push(normalized);
    }
  }

  list.sort((a, b) => a.name.localeCompare(b.name));

  return { bySlug, list };
}

async function readKeywordFile(): Promise<MtgKeywordCacheFile | null> {
  try {
    const raw = await fs.readFile(KEYWORDS_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      const keywords = parsed
        .filter(
          (entry): entry is MtgKeywordEntry =>
            entry && typeof entry.name === "string",
        )
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
          .filter(
            (entry: MtgKeywordEntry): entry is MtgKeywordEntry =>
              entry && typeof entry.name === "string",
          )
          .map((entry: MtgKeywordEntry) => ({
            name: entry.name,
            slug: normalizeKeywordName(entry.slug || entry.name),
          }))
      : [];

    return { updatedAt, keywords };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as any).code === "ENOENT") {
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
      merged.push({ name: entry.name, slug });
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
  const response = await fetch(SCRYFALL_KEYWORDS_URL, {
    headers: {
      "User-Agent": SCRYFALL_USER_AGENT,
      Accept: "application/json",
    },
  });

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

async function initializeKeywordCache(): Promise<void> {
  if (keywordCache !== null) {
    return;
  }

  const existing = await readKeywordFile();
  if (existing) {
    keywordCache = existing.keywords;
    keywordCacheUpdatedAt = existing.updatedAt || null;
    keywordIndex = buildKeywordIndex(existing.keywords);
  }

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
    console.error("[MTG Keywords] Failed to refresh cache:", error);
    if (!keywordCache) {
      keywordCache = [];
      keywordIndex = buildKeywordIndex([]);
    }
  }
}

export async function ensureMtgKeywordCache(): Promise<void> {
  if (keywordCache !== null) {
    return;
  }

  if (keywordCachePromise === null) {
    keywordCachePromise = initializeKeywordCache().catch((error) => {
      keywordCachePromise = null;
      throw error;
    });
  }

  await keywordCachePromise;
}

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

export async function getMtgKeywordSlugMap(): Promise<Record<string, string>> {
  const { bySlug } = await getKeywordIndex();
  const map: Record<string, string> = {};
  for (const [slug, entry] of bySlug.entries()) {
    map[slug] = entry.name;
  }
  return map;
}

function hasKeywordGrantIntent(naturalQuery: string): boolean {
  return /\b(give|gives|giving|grant|grants|granting)\b/i.test(naturalQuery);
}

function hasKeywordExcludeIntent(naturalQuery: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\b(without|no|excluding|exclude|not)\\b.*${escaped}|${escaped}.*\\b(without|no|excluding|exclude|not)\\b`,
    "i"
  );
  return pattern.test(naturalQuery);
}

function hasKeywordPositiveIntent(naturalQuery: string, keyword: string): boolean {
  const lower = naturalQuery.toLowerCase();
  const kwLower = keyword.toLowerCase();
  // Explicit "cards with/have X" patterns
  if (
    /\b(with|has|have|featuring|that have|that has)\b/i.test(naturalQuery) &&
    lower.includes(kwLower)
  ) {
    return true;
  }
  // "X creatures", "X cards", "creatures with X", "cards with X"
  if (
    new RegExp(`\\b${kwEscaped(kwLower)}s?\\s+(creatures?|cards?)\\b`, "i").test(lower)
  ) {
    return true;
  }
  if (
    new RegExp(
      `\\b(creatures?|cards?)\\s+with\\s+${kwEscaped(kwLower)}s?\\b`,
      "i"
    ).test(lower)
  ) {
    return true;
  }
  // Bare keyword or "X" at start (e.g. "flying", "trample", "cascades")
  if (new RegExp(`^\\s*${kwEscaped(kwLower)}s?\\b`, "i").test(lower)) {
    return true;
  }
  // "cards with X" or "X ability"
  if (
    new RegExp(`\\b(with|having)\\s+${kwEscaped(kwLower)}s?\\b`, "i").test(lower)
  ) {
    return true;
  }
  // "cards that X" or "that X" (e.g. "cards that cascade", "cards that cascades")
  if (
    new RegExp(`\\b(creatures?|cards?)\\s+that\\s+${kwEscaped(kwLower)}s?\\b`, "i").test(lower)
  ) {
    return true;
  }
  if (new RegExp(`\\bthat\\s+${kwEscaped(kwLower)}s?\\b`, "i").test(lower)) {
    return true;
  }
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function kwEscaped(kw: string): string {
  return escapeRegex(kw).replace(/\s+/g, "\\s+");
}

function getExistingKwInQuery(scryfallQuery: string): Set<string> {
  const existing = new Set<string>();
  const kwPattern = /(?:^|\s)-?kw:(?:"([^"]+)"|([^\s()]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = kwPattern.exec(scryfallQuery)) !== null) {
    const value = (match[1] ?? match[2] ?? "").trim().toLowerCase();
    if (value) existing.add(value);
  }
  return existing;
}

function toKwToken(name: string): string {
  if (/\s/.test(name) || /[^a-zA-Z0-9-]/.test(name)) {
    return `kw:"${name}"`;
  }
  return `kw:${name.toLowerCase()}`;
}

export async function resolveKeywordFilters(naturalQuery: string): Promise<string[]> {
  if (hasKeywordGrantIntent(naturalQuery)) {
    return [];
  }

  const { list } = await getKeywordIndex();
  if (list.length === 0) return [];

  // Match longest first so "first strike" matches before "first"
  const byLength = [...list].sort(
    (a, b) => b.name.length - a.name.length
  );

  const matched: string[] = [];
  const lowerQuery = naturalQuery.toLowerCase();

  for (const entry of byLength) {
    const name = entry.name;
    const kwLower = name.toLowerCase();
    // Match keyword or common variant (e.g. "cascades" for "cascade")
    const base = escapeRegex(kwLower);
    const pattern = entry.name.includes(" ")
      ? new RegExp(`\\b${base.replace(/\s+/g, "\\s+")}(s)?\\b`, "i")
      : new RegExp(`\\b${base}s?\\b`, "i");

    if (!pattern.test(lowerQuery)) continue;
    if (hasKeywordExcludeIntent(naturalQuery, name)) continue;
    if (!hasKeywordPositiveIntent(naturalQuery, name)) continue;

    // Avoid duplicates (e.g. "first strike" and "strike")
    const alreadyMatched = matched.some(
      (m) => m.toLowerCase().includes(kwLower) || kwLower.includes(m.toLowerCase())
    );
    if (alreadyMatched) continue;

    matched.push(name);
  }

  return matched;
}

export async function applyKeywordFiltersFromNaturalQuery(
  naturalQuery: string,
  scryfallQuery: string
): Promise<string> {
  const keywords = await resolveKeywordFilters(naturalQuery);
  if (keywords.length === 0) return scryfallQuery;

  const existingKw = getExistingKwInQuery(scryfallQuery);
  const toAdd = keywords.filter((name) => {
    const normalized = name.toLowerCase();
    return !existingKw.has(normalized) && !existingKw.has(normalized.replace(/\s+/g, "-"));
  });

  if (toAdd.length === 0) return scryfallQuery;

  const tokens = toAdd.map(toKwToken);
  const hasOrChain = /\s+or\s+/i.test(scryfallQuery);
  const joiner = hasOrChain ? " or " : " ";
  return `${scryfallQuery}${joiner}${tokens.join(joiner)}`.trim().replace(/\s{2,}/g, " ");
}

ensureMtgKeywordCache().catch((error) => {
  console.warn("[MTG Keywords] Warm-up failed:", error);
});

