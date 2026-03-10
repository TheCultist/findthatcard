import { promises as fs } from "fs";
import path from "path";
import { getCacheDir } from "@/lib/cache-paths";

type ScryfallSetEntry = {
  name: string;
  code: string;
};

type ScryfallSetResponse = {
  data: Array<{
    name: string;
    code: string;
  }>;
};

type SetCacheFile = {
  updatedAt: string;
  sets: ScryfallSetEntry[];
};

type SetIndex = {
  byCode: Map<string, ScryfallSetEntry>;
  byName: Array<{ normalized: string; entry: ScryfallSetEntry }>;
};

export type SetFilter = {
  code: string;
  name: string;
  negated: boolean;
  source: "name" | "code";
};

const SCRYFALL_SETS_URL = "https://api.scryfall.com/sets";
const SCRYFALL_USER_AGENT =
  process.env.SCRYFALL_USER_AGENT || "find-that-card/1.0 (+https://findthat.card)";
const SETS_FILE_PATH = path.join(getCacheDir(), "scryfall-sets.json");

let setCache: ScryfallSetEntry[] | null = null;
let setCacheUpdatedAt: string | null = null;
let setCachePromise: Promise<void> | null = null;
let setIndex: SetIndex | null = null;
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

function normalizeSetText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const aLength = a.length;
  const bLength = b.length;
  if (aLength === 0) {
    return bLength;
  }
  if (bLength === 0) {
    return aLength;
  }

  const row = new Array(bLength + 1);
  for (let index = 0; index <= bLength; index += 1) {
    row[index] = index;
  }

  for (let i = 1; i <= aLength; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= bLength; j += 1) {
      const temp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + cost
      );
      prev = temp;
    }
  }

  return row[bLength];
}

function normalizedDistance(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) {
    return 0;
  }
  return levenshteinDistance(a, b) / maxLength;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldSkipUpdate(fileStamp: string | null, todayStamp: string): boolean {
  if (!fileStamp) {
    return false;
  }
  return compareDateStamp(fileStamp, todayStamp) >= 0;
}

function buildSetIndex(entries: ScryfallSetEntry[]): SetIndex {
  const byCode = new Map<string, ScryfallSetEntry>();
  const byName: Array<{ normalized: string; entry: ScryfallSetEntry }> = [];

  for (const entry of entries) {
    const code = entry.code.toLowerCase();
    if (!code) {
      continue;
    }
    if (!byCode.has(code)) {
      byCode.set(code, { ...entry, code });
    }
    const normalizedName = normalizeSetText(entry.name);
    if (normalizedName.length > 0) {
      byName.push({ normalized: normalizedName, entry: { ...entry, code } });
    }
  }

  byName.sort((a, b) => b.normalized.length - a.normalized.length);

  return { byCode, byName };
}

async function readSetFile(): Promise<SetCacheFile | null> {
  try {
    const raw = await fs.readFile(SETS_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const sets = parsed.filter(
        (entry): entry is ScryfallSetEntry =>
          entry && typeof entry.name === "string" && typeof entry.code === "string"
      );
      return { updatedAt: "", sets };
    }
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const updatedAt =
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    const sets = Array.isArray(parsed.sets)
      ? parsed.sets.filter(
          (entry: ScryfallSetEntry): entry is ScryfallSetEntry =>
            entry &&
            typeof entry.name === "string" &&
            typeof entry.code === "string"
        )
      : [];
    return { updatedAt, sets };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    console.warn("[Scryfall Sets] Failed to read cached sets file:", error);
    return null;
  }
}

async function writeSetFile(payload: SetCacheFile): Promise<void> {
  await fs.mkdir(path.dirname(SETS_FILE_PATH), { recursive: true });
  await fs.writeFile(SETS_FILE_PATH, JSON.stringify(payload, null, 2), "utf-8");
}

function mergeSets(
  existing: ScryfallSetEntry[] | null,
  fetched: ScryfallSetEntry[]
): {
  merged: ScryfallSetEntry[];
  addedCodes: string[];
  renamed: Array<{ code: string; from: string; to: string }>;
} {
  if (!existing || existing.length === 0) {
    return { merged: fetched, addedCodes: fetched.map((entry) => entry.code), renamed: [] };
  }

  const merged = existing.map((entry) => ({
    name: entry.name,
    code: entry.code.toLowerCase(),
  }));
  const existingMap = new Map(
    existing.map((entry) => [entry.code.toLowerCase(), entry.name])
  );
  const mergedMap = new Map(
    merged.map((entry) => [entry.code.toLowerCase(), entry.name])
  );
  const addedCodes: string[] = [];
  const renamed: Array<{ code: string; from: string; to: string }> = [];

  for (const entry of fetched) {
    const code = entry.code.toLowerCase();
    const existingName = existingMap.get(code);
    if (!existingName) {
      merged.push({ name: entry.name, code });
      mergedMap.set(code, entry.name);
      addedCodes.push(code);
      continue;
    }
    if (existingName !== entry.name) {
      mergedMap.set(code, entry.name);
      renamed.push({ code, from: existingName, to: entry.name });
    }
  }

  if (renamed.length > 0) {
    for (const entry of merged) {
      const updatedName = mergedMap.get(entry.code);
      if (updatedName && updatedName !== entry.name) {
        entry.name = updatedName;
      }
    }
  }

  return { merged, addedCodes, renamed };
}

async function fetchSetsFromScryfall(): Promise<ScryfallSetEntry[]> {
  const response = await fetch(SCRYFALL_SETS_URL, {
    headers: {
      "User-Agent": SCRYFALL_USER_AGENT,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `[Scryfall Sets] Failed to fetch sets (${response.status} ${response.statusText})`
    );
  }

  const payload = (await response.json()) as ScryfallSetResponse;
  if (!payload?.data || !Array.isArray(payload.data)) {
    throw new Error("[Scryfall Sets] Unexpected response format");
  }

  return payload.data
    .map((set) => ({
      name: set.name,
      code: set.code.toLowerCase(),
    }))
    .filter((entry) => entry.name && entry.code);
}

async function initializeSetCache(): Promise<void> {
  if (setCache !== null) {
    return;
  }

  const existing = await readSetFile();
  if (existing) {
    setCache = existing.sets;
    setCacheUpdatedAt = existing.updatedAt || null;
    setIndex = buildSetIndex(existing.sets);
  }

  const todayStamp = formatTodayStamp();
  if (existing && shouldSkipUpdate(existing.updatedAt, todayStamp)) {
    console.log(
      `[Scryfall Sets] Cache already refreshed (${existing.updatedAt}), skipping update`
    );
    return;
  }

  try {
    console.log(
      `[Scryfall Sets] Performing cache update (file date: ${existing?.updatedAt || "none"}, today: ${todayStamp})`
    );
    const fetched = await fetchSetsFromScryfall();
    const { merged, addedCodes, renamed } = mergeSets(existing?.sets || null, fetched);
    setCache = merged;
    setCacheUpdatedAt = todayStamp;
    setIndex = buildSetIndex(merged);

    await writeSetFile({ updatedAt: setCacheUpdatedAt, sets: merged });
    console.log(
      `[Scryfall Sets] Cache updated (${setCacheUpdatedAt}): ${merged.length} sets`
    );
    if (addedCodes.length > 0 || renamed.length > 0) {
      if (addedCodes.length > 0) {
        console.log(`[Scryfall Sets] Added sets: ${addedCodes.join(", ")}`);
      }
      if (renamed.length > 0) {
        console.log(
          `[Scryfall Sets] Renamed sets: ${renamed
            .map((entry) => `${entry.code} "${entry.from}" -> "${entry.to}"`)
            .join("; ")}`
        );
      }
    } else {
      console.log("[Scryfall Sets] No set content changes detected");
    }
  } catch (error) {
    console.error("[Scryfall Sets] Failed to refresh cache:", error);
    if (!setCache) {
      setCache = [];
      setIndex = buildSetIndex([]);
    }
  }
}

export async function ensureScryfallSetCache(): Promise<void> {
  if (setCache !== null) {
    return;
  }

  if (setCachePromise === null) {
    setCachePromise = initializeSetCache().catch((error) => {
      setCachePromise = null;
      throw error;
    });
  }

  await setCachePromise;
}

export async function getSetCodeMap(): Promise<{
  updatedAt?: string;
  sets: Record<string, string>;
}> {
  await ensureScryfallSetCache();
  const map: Record<string, string> = {};
  if (setCache) {
    for (const entry of setCache) {
      if (!entry || !entry.code || !entry.name) {
        continue;
      }
      map[entry.code.toLowerCase()] = entry.name;
    }
  }
  return {
    updatedAt: setCacheUpdatedAt || undefined,
    sets: map,
  };
}

async function getSetIndex(): Promise<SetIndex> {
  await ensureScryfallSetCache();
  if (!setIndex) {
    setIndex = buildSetIndex(setCache || []);
  }
  return setIndex;
}

function detectNegation(normalizedQuery: string, normalizedToken: string): boolean {
  const escapedToken = escapeRegex(normalizedToken).replace(/ +/g, "\\s+");
  const pattern = new RegExp(
    `\\b(not\\s+in|not\\s+from|without|excluding|exclude|no)\\b\\s+(?:the\\s+)?${escapedToken}\\b`,
    "i"
  );
  return pattern.test(normalizedQuery);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s{2,}/g, " ").trim();
}

function normalizeOrphanedOr(query: string): string {
  let updated = query;
  updated = updated.replace(/\(\s*OR\s+([^)]+)\)/gi, "($1)");
  updated = updated.replace(/\(\s*([^)]+)\s+OR\s*\)/gi, "($1)");
  // Remove parenthesized branches that contain only OR tokens.
  updated = updated.replace(/\(\s*(?:OR\s*)+\)/gi, "");
  updated = updated.replace(/\(\s*OR\s+/gi, "(");
  updated = updated.replace(/\s+OR\s*\)/gi, ")");
  updated = updated.replace(/\bOR\b\s+\bOR\b/gi, "OR");
  updated = updated.replace(/\(\s*\)/g, "");
  return normalizeWhitespace(updated);
}

function removeSetFilters(query: string): string {
  let updated = query;
  // \b prevents matching `e:` inside `name:`, `type:`, etc.
  updated = updated.replace(/-?\b(?:set|s|e|edition):[^\s)]+/gi, "");
  updated = updated.replace(/\s{2,}/g, " ").trim();
  return normalizeOrphanedOr(updated);
}

function buildSetFilterTokens(filters: SetFilter[]): string {
  const positives: string[] = [];
  const negatives: string[] = [];

  for (const filter of filters) {
    if (filter.negated) {
      negatives.push(`-set:${filter.code}`);
    } else {
      positives.push(`set:${filter.code}`);
    }
  }

  const tokens: string[] = [];
  if (positives.length === 1) {
    tokens.push(positives[0]);
  } else if (positives.length > 1) {
    tokens.push(`(${positives.join(" OR ")})`);
  }

  if (negatives.length > 0) {
    tokens.push(negatives.join(" "));
  }

  return tokens.join(" ").trim();
}

function addFranchiseSetFilters(
  naturalQuery: string,
  normalizedQuery: string,
  byName: Array<{ normalized: string; entry: ScryfallSetEntry }>,
  filters: Map<string, SetFilter>
): void {
  const hasSetContext =
    /\b(set|sets|edition|editions|printing|printings)\b/i.test(naturalQuery);
  if (!hasSetContext) {
    return;
  }

  const phrasePattern =
    /\b([a-z0-9]{3,}(?:\s+[a-z0-9]{3,}){0,3})\s+(set|sets|edition|editions|printing|printings)\b/gi;
  const ignored = new Set([
    "commander",
    "commanders",
    "from",
    "for",
    "in",
    "of",
    "the",
    "my",
  ]);

  const phrases = new Set<string>();
  let phraseMatch: RegExpExecArray | null;
  while ((phraseMatch = phrasePattern.exec(normalizedQuery)) !== null) {
    const raw = (phraseMatch[1] || "").trim();
    if (!raw) continue;
    const cleanedTokens = raw
      .split(" ")
      .filter(Boolean)
      .filter((token) => !ignored.has(token));
    if (cleanedTokens.length === 0) continue;
    phrases.add(cleanedTokens.join(" "));
  }

  const franchiseHints: Array<{ match: RegExp; phrases: string[] }> = [
    { match: /\b(avatar|airbender)\b/i, phrases: ["avatar", "airbender", "last airbender"] },
    { match: /\b(fallout)\b/i, phrases: ["fallout"] },
    { match: /\b(doctor\s*who)\b/i, phrases: ["doctor who"] },
    { match: /\b(final\s*fantasy)\b/i, phrases: ["final fantasy"] },
    {
      match: /\b(lotr|lord\s*of\s*the\s*rings|middle\s*earth)\b/i,
      phrases: ["lord of the rings", "middle earth", "lotr"],
    },
    { match: /\b(marvel)\b/i, phrases: ["marvel"] },
  ];

  for (const hint of franchiseHints) {
    if (hint.match.test(naturalQuery)) {
      for (const phrase of hint.phrases) {
        phrases.add(phrase);
      }
    }
  }

  for (const phrase of phrases) {
    const phraseTokens = phrase
      .split(" ")
      .filter((token) => token.length >= 3);
    if (phraseTokens.length === 0) continue;

    for (const entry of byName) {
      const isMatch = phraseTokens.every((token) =>
        new RegExp(`\\b${escapeRegex(token)}\\b`, "i").test(entry.normalized)
      );
      if (!isMatch) continue;
      const code = entry.entry.code.toLowerCase();
      if (filters.has(code)) continue;
      const negated = detectNegation(normalizedQuery, phrase);
      filters.set(code, {
        code,
        name: entry.entry.name,
        negated,
        source: "name",
      });
    }
  }
}

export async function resolveSetFilters(naturalQuery: string): Promise<SetFilter[]> {
  const { byCode, byName } = await getSetIndex();
  if (byCode.size === 0 || byName.length === 0) {
    return [];
  }

  const normalizedQuery = normalizeSetText(naturalQuery);
  if (!normalizedQuery) {
    return [];
  }

  const wantsCommanderFormat =
    /\b(commander[-\s]?legal|legal\s+in\s+commander|for\s+commander|commander\s+format|in\s+commander|edh[-\s]?legal|legal\s+in\s+edh|for\s+edh|edh\s+format|in\s+edh)\b/i.test(
      naturalQuery
    ) ||
    /\bmy\s+commander\b|\bcommander\s+is\b|\b(?:have|run|play|use)\s+(?:a\s+)?[^.]+?\s+commander\b/i.test(
      naturalQuery
    );
  const hasSetContext =
    /\b(set|sets|edition|editions|printing|printings)\b/i.test(naturalQuery);
  const hasCommanderFromSetHint =
    /\bcommander\s+from\b|\bcommanders?\s+(?:from|in)\b/i.test(naturalQuery);
  const hasFranchiseSetHint =
    /\b(avatar|airbender|fallout|lotr|lord\s*of\s*the\s*rings|doctor\s*who|final\s*fantasy)\b/i.test(
      naturalQuery
    );
  const allowSetFuzzyWithoutAnchorContext =
    hasSetContext || hasCommanderFromSetHint || hasFranchiseSetHint;
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const queryTokenSet = new Set(queryTokens);

  const shouldSkipCommanderSetMatch = (entry: { normalized: string }) => {
    if (!wantsCommanderFormat || hasSetContext) {
      return false;
    }
    const tokens = entry.normalized
      .split(" ")
      .filter(Boolean)
      .filter((token) => token !== "commander");
    if (tokens.length === 0) {
      return true;
    }
    return !tokens.some((token) => queryTokenSet.has(token));
  };

  const filters = new Map<string, SetFilter>();
  const anySetPattern =
    /\bany\s+([a-z0-9 ]{2,})\s+(set|sets|edition|editions|printing|printings)\b/gi;
  let anyMatch: RegExpExecArray | null;

  while ((anyMatch = anySetPattern.exec(normalizedQuery)) !== null) {
    const rawPhrase = anyMatch[1] || "";
    const normalizedPhrase = normalizeSetText(rawPhrase);
    const phraseTokens = normalizedPhrase.split(" ").filter((token) => token.length >= 3);
    if (phraseTokens.length === 0) {
      continue;
    }

    for (const entry of byName) {
      if (shouldSkipCommanderSetMatch(entry)) {
        continue;
      }
      const isMatch = phraseTokens.every((token) =>
        new RegExp(`\\b${escapeRegex(token)}\\b`, "i").test(entry.normalized)
      );
      if (!isMatch) {
        continue;
      }
      const code = entry.entry.code.toLowerCase();
      if (!filters.has(code)) {
        const negated = detectNegation(normalizedQuery, normalizedPhrase);
        filters.set(code, {
          code,
          name: entry.entry.name,
          negated,
          source: "name",
        });
      }
    }
  }

  for (const entry of byName) {
    if (shouldSkipCommanderSetMatch(entry)) {
      continue;
    }
    const pattern = new RegExp(
      `\\b${escapeRegex(entry.normalized).replace(/ +/g, "\\s+")}\\b`,
      "i"
    );
    if (!pattern.test(normalizedQuery)) {
      continue;
    }
    const negated = detectNegation(normalizedQuery, entry.normalized);
    const code = entry.entry.code.toLowerCase();
    if (!filters.has(code)) {
      filters.set(code, {
        code,
        name: entry.entry.name,
        negated,
        source: "name",
      });
    }
  }

  if (queryTokens.length > 0) {
    for (const entry of byName) {
      if (shouldSkipCommanderSetMatch(entry)) {
        continue;
      }
      const nameTokens = entry.normalized.split(" ").filter(Boolean);
      if (nameTokens.length === 0) {
        continue;
      }

      const hasAnchorToken = nameTokens.some(
        (token) => token.length >= 4 && queryTokenSet.has(token)
      );

      const windowSizes = new Set<number>([nameTokens.length]);
      if (nameTokens.length >= 2) {
        windowSizes.add(nameTokens.length - 1);
      }
      if (nameTokens.length >= 3) {
        windowSizes.add(nameTokens.length + 1);
      }

      let bestScore = 1;
      for (const size of windowSizes) {
        if (size <= 0 || size > queryTokens.length) {
          continue;
        }
        for (let i = 0; i <= queryTokens.length - size; i += 1) {
          const windowTokens = queryTokens.slice(i, i + size);
          const windowText = windowTokens.join(" ");
          const score = normalizedDistance(entry.normalized, windowText);
          if (score < bestScore) {
            bestScore = score;
          }
        }
      }

      const maxAllowed = entry.normalized.length <= 8 ? 0.32 : 0.38;
      const allowWithoutAnchor =
        !hasAnchorToken &&
        queryTokens.length <= 4 &&
        entry.normalized.length >= 5 &&
        bestScore <= 0.28;

      if (
        allowSetFuzzyWithoutAnchorContext &&
        bestScore <= maxAllowed &&
        (hasAnchorToken || allowWithoutAnchor)
      ) {
        const code = entry.entry.code.toLowerCase();
        if (!filters.has(code)) {
          const negated = detectNegation(normalizedQuery, entry.normalized);
          filters.set(code, {
            code,
            name: entry.entry.name,
            negated,
            source: "name",
          });
        }
      }
    }
  }

  addFranchiseSetFilters(naturalQuery, normalizedQuery, byName, filters);

  const codeContextPattern = /\b(set|edition|printing)\b/i.test(naturalQuery);
  const directCodePattern = /\b(?:set|edition)\s*[:#]?\s*([a-z0-9]{1,6})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = directCodePattern.exec(naturalQuery)) !== null) {
    const candidate = match[1]?.toLowerCase();
    if (!candidate || !byCode.has(candidate)) {
      continue;
    }
    const negated = detectNegation(normalizedQuery, candidate);
    filters.set(candidate, {
      code: candidate,
      name: byCode.get(candidate)?.name || candidate,
      negated,
      source: "code",
    });
  }

  if (codeContextPattern) {
    const tokens = naturalQuery.toLowerCase().match(/\b[a-z0-9]{1,6}\b/g) || [];
    for (const token of tokens) {
      if (!byCode.has(token)) {
        continue;
      }
      if (filters.has(token)) {
        continue;
      }
      const negated = detectNegation(normalizedQuery, token);
      filters.set(token, {
        code: token,
        name: byCode.get(token)?.name || token,
        negated,
        source: "code",
      });
    }
  }

  // When user asks for "commander from [franchise] sets" (e.g. Avatar, Fallout), drop Commander
  // precon sets—they want commanders FROM that franchise, not from Commander products
  const COMMANDER_PRECON_CODES = new Set([
    "c13", "c14", "c15", "c16", "c17", "c18", "c19", "c20", "c21",
    "cmd", "cm1", "cm2", "cmr", "clb", "m21", "dbl", "mic",
  ]);
  const hasCommanderPrecons = [...filters.keys()].some((code) =>
    COMMANDER_PRECON_CODES.has(code)
  );
  const hasThemeFranchiseSets = [...filters.keys()].some(
    (code) => !COMMANDER_PRECON_CODES.has(code)
  );
  const hasCommanderFromSetIntent =
    /\bcommanders?\s+from\b/i.test(naturalQuery);
  const mentionsFranchise =
    /\b(avatar|airbender|fallout|lotr|lord\s*of\s*the\s*rings|doctor\s*who|final\s*fantasy)\b/i.test(
      naturalQuery
    );
  // If a franchise set is requested, never keep Commander precon/product sets
  // that might be fuzzy-matched from "commanders".
  if (mentionsFranchise) {
    for (const code of COMMANDER_PRECON_CODES) {
      filters.delete(code);
    }
  }
  if (
    hasCommanderPrecons &&
    hasThemeFranchiseSets &&
    mentionsFranchise
  ) {
    for (const code of COMMANDER_PRECON_CODES) {
      filters.delete(code);
    }
  }

  // "commanders from <set>" usually asks for commander-eligible cards printed in those sets,
  // not Commander product sets accidentally matched by "commanders".
  if (hasCommanderPrecons && hasThemeFranchiseSets && hasCommanderFromSetIntent) {
    for (const code of COMMANDER_PRECON_CODES) {
      filters.delete(code);
    }
  }

  return Array.from(filters.values());
}

export async function applySetFiltersFromNaturalQuery(
  naturalQuery: string,
  scryfallQuery: string
): Promise<string> {
  const { hasCommanderDeckContext } = await import("@/lib/commander-context");
  if (hasCommanderDeckContext(naturalQuery)) {
    return scryfallQuery;
  }

  const filters = await resolveSetFilters(naturalQuery);
  if (filters.length === 0) {
    return scryfallQuery;
  }

  const cleanedQuery = removeSetFilters(scryfallQuery);
  const setTokens = buildSetFilterTokens(filters);
  if (!setTokens) {
    return cleanedQuery;
  }

  return normalizeWhitespace(`${cleanedQuery} ${setTokens}`);
}

ensureScryfallSetCache().catch((error) => {
  console.warn("[Scryfall Sets] Warm-up failed:", error);
});
