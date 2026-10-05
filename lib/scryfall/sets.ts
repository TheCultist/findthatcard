import { promises as fs } from "fs";
import path from "path";
import { getCacheDir } from "@/lib/cache-paths";
import { escapeRegex, levenshteinDistance } from "@/lib/utils/text";
import { formatTodayStamp, shouldSkipUpdate } from "@/lib/utils/cache";

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

const SCRYFALL_SETS_URL = "https://api.scryfall.com/sets";
const SCRYFALL_USER_AGENT =
  process.env.SCRYFALL_USER_AGENT || "find-that-card/1.0 (+https://findthatcard.net)";
const SETS_FILE_PATH = path.join(getCacheDir(), "scryfall-sets.json");

let setCache: ScryfallSetEntry[] | null = null;
let setCacheUpdatedAt: string | null = null;
let setCachePromise: Promise<void> | null = null;
let setIndex: SetIndex | null = null;

function normalizeSetText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedDistance(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) {
    return 0;
  }
  return levenshteinDistance(a, b) / maxLength;
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

// Above this many name matches a reference is a word, not a set ("commander", "core").
const MAX_SET_MATCHES = 12;

/**
 * Resolves one extracted set reference (name or code) to Scryfall set codes:
 * exact code → every set whose name holds all its words (the set plus its commander / token /
 * promo siblings: "final fantasy" → fin, fic, tfin…) → exact name when that is too many →
 * closest name within a small edit distance. Returns [] rather than guessing.
 */
export async function resolveSetCodes(raw: string): Promise<string[]> {
  const { byCode, byName } = await getSetIndex();
  const needle = normalizeSetText(raw);
  if (!needle) return [];
  if (byCode.has(needle)) return [needle];

  const words = needle.split(" ").filter((w) => w.length >= 3);
  if (words.length > 0) {
    const patterns = words.map((w) => new RegExp(`\\b${escapeRegex(w)}\\b`));
    const codes = [
      ...new Set(byName.filter((e) => patterns.every((p) => p.test(e.normalized))).map((e) => e.entry.code)),
    ];
    if (codes.length > 0 && codes.length <= MAX_SET_MATCHES) return codes;
    const exact = byName.filter((e) => e.normalized === needle).map((e) => e.entry.code);
    if (codes.length > 0) return [...new Set(exact)];
  }

  let best: string | null = null;
  let bestScore = 1;
  for (const e of byName) {
    const score = normalizedDistance(needle, e.normalized);
    if (score < bestScore) {
      bestScore = score;
      best = e.entry.code;
    }
  }
  return best && bestScore <= 0.25 ? [best] : [];
}

ensureScryfallSetCache().catch((error) => {
  console.warn("[Scryfall Sets] Warm-up failed:", error);
});
