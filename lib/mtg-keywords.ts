import { promises as fs } from "fs";
import path from "path";
import { getCacheDir } from "@/lib/cache-paths";
import { ensureScryfallCatalogCache, getCatalog } from "@/lib/scryfall/catalogs";
import { formatTodayStamp, shouldSkipUpdate } from "@/lib/utils/cache";
import { escapeRegex } from "@/lib/utils/text";

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

const SCRYFALL_USER_AGENT =
  process.env.SCRYFALL_USER_AGENT || "find-that-card/1.0 (+https://findthatcard.net)";

const KEYWORDS_FILE_PATH = path.join(getCacheDir(), "mtg-keywords.json");

let keywordCache: MtgKeywordEntry[] | null = null;
let keywordCacheUpdatedAt: string | null = null;
let keywordCachePromise: Promise<void> | null = null;
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
    const raw = await fs.readFile(KEYWORDS_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);

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
  if (keywordCache !== null) {
    return;
  }

  const existing = await readKeywordFile();
  if (existing) {
    keywordCache = existing.keywords;
    keywordCacheUpdatedAt = existing.updatedAt || null;
    keywordIndex = buildKeywordIndex(keywordCache);
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

/**
 * Returns a map of keyword slug -> reminder text for tooltips.
 * Reads from data/mtg-keyword-reminders.json, a manually maintained static catalog.
 */
export async function getKeywordDefinitionsMap(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(KEYWORD_REMINDERS_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch (error) {
    console.warn("[MTG Keywords] Failed to read keyword reminders file:", error);
  }
  return {};
}

function hasKeywordGrantIntent(naturalQuery: string): boolean {
  return /\b(give|gives|giving|grant|grants|granting)\b/i.test(naturalQuery);
}

function hasKeywordSynergyIntent(naturalQuery: string): boolean {
  // "synergize with X", "synergy with X", "work well with X" (incl. typos)
  if (
    /\b(synergiz(?:e|es)|synergyz(?:e|es)|synergis(?:e|es)|synergy)\s+with\b/i.test(
      naturalQuery
    )
  )
    return true;
  if (/\bwork(?:\s+well)?\s+with\b/i.test(naturalQuery)) return true;
  if (/\bworks?\s+well\s+with\b/i.test(naturalQuery)) return true;
  // "my commander synergizes with X" = deck context, same as synergy with X
  if (/\bmy\s+commander\s+(?:synergiz(?:e|es)|synergyz(?:e|es)|synergis(?:e|es)|synergy|works?)\s+(?:well\s+)?with\b/i.test(
    naturalQuery
  ))
    return true;
  // "cards for a X deck", "best cards for X deck" = typal deck, synergy
  if (/\bfor\s+(?:a\s+)?\w+(\s+\w+)?\s+deck\b/i.test(naturalQuery)) return true;
  return false;
}

function hasKeywordExcludeIntent(naturalQuery: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\b(without|no|excluding|exclude|not)\\b.*${escaped}|${escaped}.*\\b(without|no|excluding|exclude|not)\\b`,
    "i"
  );
  return pattern.test(naturalQuery);
}

function hasKeywordPositiveIntent(
  naturalQuery: string,
  keyword: string,
  expandedQuery?: string
): boolean {
  const lower = (expandedQuery ?? naturalQuery).toLowerCase();
  const kwLower = keyword.toLowerCase();
  // Explicit "cards with/have X" patterns (use expanded query for keyword presence)
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
  // "for a X deck", "X deck" = typal deck building
  if (
    new RegExp(
      `\\bfor\\s+(?:a\\s+)?${kwEscaped(kwLower)}s?\\s+deck\\b`,
      "i"
    ).test(lower)
  )
    return true;
  if (new RegExp(`\\b${kwEscaped(kwLower)}s?\\s+deck\\b`, "i").test(lower))
    return true;
  // Mill used as a verb by a player — "[opponent/player/they/you] mills [cards?]"
  // e.g. "opponent mills", "whenever you draw, opponent mills", "they mill three cards"
  // "mills X" alone (without a preceding subject) also counts as positive mill intent.
  if (kwLower === "mill") {
    if (
      /\b(?:opponents?|players?|they|enemy|enemies|each\s+(?:player|opponent)|you|we)\s+mills?\b/i.test(lower) ||
      /\bmills?\s+(?:\d+\s+)?(?:card[sd]?\b|their\s+library\b)/i.test(lower)
    ) {
      return true;
    }
  }
  // Synergy intent: "work well with X", "synergize with X" - add kw: to OR chain with function tags
  if (
    new RegExp(
      `\\b(?:work(?:\\s+well)?|synergiz(?:e|es)|synergyz(?:e|es)|synergis(?:e|es)|synergy)\\s+with\\s+${kwEscaped(kwLower)}s?\\b`,
      "i"
    ).test(lower)
  ) {
    return true;
  }
  // Synonym was expanded: if keyword now appears in the expanded query but wasn't in the
  // original, treat that as bare positive intent (e.g. "max speed" → "haste")
  if (
    expandedQuery !== undefined &&
    expandedQuery.toLowerCase() !== naturalQuery.toLowerCase() &&
    new RegExp(`\\b${kwEscaped(kwLower)}s?\\b`, "i").test(lower) &&
    !new RegExp(`\\b${kwEscaped(kwLower)}s?\\b`, "i").test(naturalQuery.toLowerCase())
  ) {
    return true;
  }
  return false;
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

function getExistingFunctionTagsForSlug(scryfallQuery: string, slug: string): Set<string> {
  const existing = new Set<string>();
  const fnPattern = new RegExp(
    `(?:^|\\s)function:(gains|gives|synergy)-${escapeRegex(slug)}\\b`,
    "gi"
  );
  let match: RegExpExecArray | null;
  while ((match = fnPattern.exec(scryfallQuery)) !== null) {
    const type = (match[1] ?? "").toLowerCase();
    if (type) existing.add(type);
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
  // Expand common synonyms (e.g. "flyers" = creatures with flying)
  const queryForMatch = lowerQuery
    .replace(/\bflyers?\b/gi, "flying")
    .replace(/\btramplers?\b/gi, "trample")
    .replace(/\bno\s*flying\b/gi, "flying")
    .replace(/\bground\s*pound(?:ers?)?\b/gi, "trample");

  for (const entry of byLength) {
    const name = entry.name;
    const kwLower = name.toLowerCase();
    // Match keyword or common variant (e.g. "cascades" for "cascade")
    const base = escapeRegex(kwLower);
    const pattern = entry.name.includes(" ")
      ? new RegExp(`\\b${base.replace(/\s+/g, "\\s+")}(s)?\\b`, "i")
      : new RegExp(`\\b${base}s?\\b`, "i");

    if (!pattern.test(queryForMatch)) continue;
    if (hasKeywordExcludeIntent(naturalQuery, name)) continue;
    if (!hasKeywordPositiveIntent(naturalQuery, name, queryForMatch)) continue;

    // Avoid duplicates (e.g. "first strike" and "strike")
    const alreadyMatched = matched.some(
      (m) => m.toLowerCase().includes(kwLower) || kwLower.includes(m.toLowerCase())
    );
    if (alreadyMatched) continue;

    matched.push(name);
  }

  return matched;
}

function removeGrantFunctionTags(
  scryfallQuery: string,
  keywordNames: string[],
  isSynergyIntent: boolean
): string {
  if (isSynergyIntent) {
    // Synergy intent: keep all function tags (gains, gives, synergy), just add kw: to OR chain
    return scryfallQuery;
  }
  let result = scryfallQuery;
  for (const name of keywordNames) {
    const slug = normalizeKeywordName(name);
    if (!slug) continue;
    // "cards with X" = have keyword → remove gains/gives/synergy (cards that GIVE X)
    const grantPattern = new RegExp(
      `\\s*(?:or\\s+)?function:(?:gains|gives|synergy)-${escapeRegex(slug)}\\b`,
      "gi"
    );
    result = result.replace(grantPattern, " ");
  }
  return result
    .replace(/\s*\(\s*\)\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+or\s+or\s+/gi, " or ")
    .replace(/^\s*or\s+/i, "")
    .replace(/\s+or\s*$/i, "")
    .trim();
}


function removeEmptyBrackets(q: string): string {
  return q.replace(/\s*\(\s*\)\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Converts AND'd related function tags to OR chain for synergy/typal deck queries.
 * e.g. "function:synergy-changeling function:changeling" -> "(function:synergy-changeling or function:changeling)"
 */
function convertSynergyFunctionTagsToOrChain(
  query: string,
  slugs: string[]
): string {
  let result = query;
  for (const slug of slugs) {
    if (!slug) continue;
    const escaped = escapeRegex(slug);
    const oneTag =
      `function:(?:synergy|gains|gives)-${escaped}|function:${escaped}\\b`;
    const pattern = new RegExp(
      `(${oneTag})(\\s+(?:${oneTag}))+`,
      "gi"
    );
    result = result.replace(pattern, (match) => {
      const tokens = match.trim().split(/\s+/);
      return `(${tokens.join(" or ")})`;
    });
  }
  return removeEmptyBrackets(result);
}

export async function applyKeywordFiltersFromNaturalQuery(
  naturalQuery: string,
  scryfallQuery: string
): Promise<string> {
  const keywords = await resolveKeywordFilters(naturalQuery);
  if (keywords.length === 0) return removeEmptyBrackets(scryfallQuery);

  const existingKw = getExistingKwInQuery(scryfallQuery);
  const toAdd = keywords.filter((name) => {
    const normalized = name.toLowerCase();
    return !existingKw.has(normalized) && !existingKw.has(normalized.replace(/\s+/g, "-"));
  });

  if (toAdd.length === 0) return removeEmptyBrackets(scryfallQuery);

  const isSynergyIntent = hasKeywordSynergyIntent(naturalQuery);
  let query = removeEmptyBrackets(removeGrantFunctionTags(scryfallQuery, toAdd, isSynergyIntent));

  if (isSynergyIntent) {
    const slugs = toAdd
      .map((name) => normalizeKeywordName(name))
      .filter((s): s is string => !!s);
    query = convertSynergyFunctionTagsToOrChain(query, slugs);
  }

  let tokens: string[];
  if (isSynergyIntent) {
    // Inject full set: function:gains-X, function:gives-X, function:synergy-X, kw:X (only missing ones)
    const allTokens: string[] = [];
    for (const name of toAdd) {
      const slug = normalizeKeywordName(name);
      if (!slug) continue;
      const existingFn = getExistingFunctionTagsForSlug(query, slug);
      const existingKw = getExistingKwInQuery(query);
      const kwNorm = name.toLowerCase();
      const kwExists =
        existingKw.has(kwNorm) || existingKw.has(kwNorm.replace(/\s+/g, "-"));

      if (!existingFn.has("gains")) allTokens.push(`function:gains-${slug}`);
      if (!existingFn.has("gives")) allTokens.push(`function:gives-${slug}`);
      if (!existingFn.has("synergy")) allTokens.push(`function:synergy-${slug}`);
      if (!kwExists) allTokens.push(toKwToken(name));
    }
    tokens = allTokens;
  } else {
    tokens = toAdd.map(toKwToken);
  }

  const hasOrChain = /\s+or\s+/i.test(query);
  const joiner = hasOrChain || isSynergyIntent ? " or " : " ";
  let result = `${query}${joiner}${tokens.join(joiner)}`.trim().replace(/\s{2,}/g, " ");
  result = result.replace(/^\s*or\s+/i, "").trim();
  return removeEmptyBrackets(result);
}

ensureMtgKeywordCache().catch((error) => {
  console.warn("[MTG Keywords] Warm-up failed:", error);
});

