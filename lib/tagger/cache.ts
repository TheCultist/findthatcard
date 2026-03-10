import { promises as fs } from "fs";
import path from "path";
import { getCacheDir } from "@/lib/cache-paths";
import { formatTodayStamp, shouldSkipUpdate } from "@/lib/utils/cache";

const TAGGER_USER_AGENT = "find-that-card/1.0 (+https://findthat.card)";
const TAGGER_CACHE_PATH = path.join(getCacheDir(), "tagger-tags.json");

type TaggerCacheFile = {
  updatedAt: string;
  art: string[];
  function: string[];
};

/**
 * In-memory cache for Scryfall Tagger tags
 * Structure: Map<'art' | 'function', Set<string>>
 */
let taggerTagCache: Map<'art' | 'function', Set<string>> | null = null;
let cacheInitializationPromise: Promise<void> | null = null;

let cacheUpdatedAt: string | null = null;

async function readTaggerCacheFile(): Promise<TaggerCacheFile | null> {
  try {
    const raw = await fs.readFile(TAGGER_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    const art = Array.isArray(parsed.art)
      ? parsed.art.filter((tag: string) => typeof tag === "string")
      : [];
    const func = Array.isArray(parsed.function)
      ? parsed.function.filter((tag: string) => typeof tag === "string")
      : [];
    return { updatedAt, art, function: func };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    console.warn("[Tagger Cache] Failed to read cache file:", error);
    return null;
  }
}

async function writeTaggerCacheFile(payload: TaggerCacheFile): Promise<void> {
  await fs.mkdir(path.dirname(TAGGER_CACHE_PATH), { recursive: true });
  await fs.writeFile(TAGGER_CACHE_PATH, JSON.stringify(payload, null, 2), "utf-8");
}

/**
 * Fetches and parses the Scryfall Tagger Tags documentation page
 * Extracts all valid art: and function: tags
 */
async function initializeTaggerTagCache(): Promise<void> {
  if (taggerTagCache !== null) {
    return; // Cache already initialized
  }

  const existing = await readTaggerCacheFile();
  if (existing) {
    taggerTagCache = new Map([
      ["art", new Set(existing.art)],
      ["function", new Set(existing.function)],
    ]);
    cacheUpdatedAt = existing.updatedAt || null;
  }

  const todayStamp = formatTodayStamp();
  if (existing && shouldSkipUpdate(existing.updatedAt, todayStamp)) {
    console.log(
      `[Tagger Cache] Cache already refreshed (${existing.updatedAt}), skipping update`
    );
    return;
  }

  const artTags = new Set<string>(existing?.art ?? []);
  const functionTags = new Set<string>(existing?.function ?? []);
  const artOperators = new Set<string>(["art", "atag", "arttag"]);
  const functionOperators = new Set<string>(["function", "otag", "oracletag"]);

  try {
    console.log(
      `[Tagger Cache] Performing cache update (file date: ${existing?.updatedAt || "none"}, today: ${todayStamp})`
    );
    const response = await fetch("https://scryfall.com/docs/tagger-tags", {
      headers: {
        "User-Agent": TAGGER_USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch tagger tags: ${response.status} ${response.statusText}`
      );
    }

    const html = await response.text();

    /**
     * Decodes HTML entities iteratively to handle double-encoding (e.g., &amp;amp; -> &amp; -> &)
     * Continues until no more changes occur
     */
    function decodeHtmlEntities(text: string): string {
      let previous = text;
      let current = text;

      // Keep decoding until no more changes occur
      do {
        previous = current;
        current = previous
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
      } while (current !== previous);

      return current;
    }

    function decodeTagName(rawTag: string): string {
      try {
        return decodeURIComponent(rawTag.trim());
      } catch {
        return rawTag.trim();
      }
    }

    function extractTagFromQuery(
      queryParam: string,
      hasArtMarker: boolean
    ): { type: "art" | "function"; tagName: string } | null {
      const decodedQuery = decodeHtmlEntities(queryParam).trim();
      const operatorMatch = decodedQuery.match(/^([a-z]+):(.+)$/i);

      if (!operatorMatch) {
        return null;
      }

      const operator = operatorMatch[1].toLowerCase();
      const rawTag = operatorMatch[2];

      let tagType: "art" | "function";
      if (hasArtMarker || artOperators.has(operator)) {
        tagType = "art";
        artOperators.add(operator);
      } else {
        tagType = "function";
        functionOperators.add(operator);
      }

      const tagName = decodeTagName(rawTag);
      if (!tagName) {
        return null;
      }

      return { type: tagType, tagName };
    }

    // Parse content to extract tags from any search links
    const hrefPattern = /href=["']([^"']+)["']/gi;

    let match;

    while ((match = hrefPattern.exec(html)) !== null) {
      const decodedHref = decodeHtmlEntities(match[1]);
      if (!decodedHref.includes("/search")) {
        continue;
      }

      let url: URL;
      try {
        url = new URL(decodedHref, "https://scryfall.com");
      } catch {
        continue;
      }

      if (!url.pathname.includes("/search")) {
        continue;
      }

      const q = url.searchParams.get("q");
      if (!q) {
        continue;
      }

      const hasArtMarker = url.searchParams.get("unique") === "art";
      const extractedTag = extractTagFromQuery(q, hasArtMarker);

      if (!extractedTag) {
        continue;
      }

      if (extractedTag.type === "art") {
        artTags.add(extractedTag.tagName);
      } else {
        functionTags.add(extractedTag.tagName);
      }
    }

    const fetchedArt = new Set(artTags);
    const fetchedFunction = new Set(functionTags);

    const addedArt: string[] = [];
    const removedArt: string[] = [];
    const addedFunction: string[] = [];
    const removedFunction: string[] = [];

    for (const tag of fetchedArt) {
      if (!existing?.art?.includes(tag)) {
        addedArt.push(tag);
      }
    }
    for (const tag of existing?.art ?? []) {
      if (!fetchedArt.has(tag)) {
        removedArt.push(tag);
      }
    }
    for (const tag of fetchedFunction) {
      if (!existing?.function?.includes(tag)) {
        addedFunction.push(tag);
      }
    }
    for (const tag of existing?.function ?? []) {
      if (!fetchedFunction.has(tag)) {
        removedFunction.push(tag);
      }
    }

    taggerTagCache = new Map([
      ["art", fetchedArt],
      ["function", fetchedFunction],
    ]);
    cacheUpdatedAt = todayStamp;
    await writeTaggerCacheFile({
      updatedAt: cacheUpdatedAt,
      art: Array.from(fetchedArt),
      function: Array.from(fetchedFunction),
    });

    console.log(
      `[Tagger Cache] Cache updated (${cacheUpdatedAt}): ${fetchedArt.size} art tags and ${fetchedFunction.size} function tags`
    );
    if (addedArt.length || removedArt.length || addedFunction.length || removedFunction.length) {
      if (addedArt.length) {
        console.log(`[Tagger Cache] Added art tags: ${addedArt.join(", ")}`);
      }
      if (removedArt.length) {
        console.log(`[Tagger Cache] Removed art tags: ${removedArt.join(", ")}`);
      }
      if (addedFunction.length) {
        console.log(`[Tagger Cache] Added function tags: ${addedFunction.join(", ")}`);
      }
      if (removedFunction.length) {
        console.log(`[Tagger Cache] Removed function tags: ${removedFunction.join(", ")}`);
      }
    } else {
      console.log("[Tagger Cache] No tag content changes detected");
    }
  } catch (error) {
    console.error("[Tagger Cache] Failed to initialize cache:", error);
    // Initialize with empty sets to prevent repeated failed attempts
    // This allows the app to continue functioning, but all tags will be assumed valid
    taggerTagCache = new Map([
      ["art", new Set()],
      ["function", new Set()],
    ]);
    // Don't throw - allow the app to continue with empty cache (tags will be assumed valid)
  }
}

/**
 * Ensures the tagger tag cache is initialized
 * Uses a promise to prevent concurrent initialization attempts
 */
export async function ensureTaggerTagCache(): Promise<void> {
  if (taggerTagCache !== null) {
    return;
  }

  if (cacheInitializationPromise === null) {
    cacheInitializationPromise = initializeTaggerTagCache().catch((error) => {
      // Reset promise on error so we can retry
      cacheInitializationPromise = null;
      throw error;
    });
  }

  await cacheInitializationPromise;
}

export function getTaggerTagCache(): Map<"art" | "function", Set<string>> | null {
  return taggerTagCache;
}

ensureTaggerTagCache().catch((error) => {
  console.warn("[Tagger Cache] Warm-up failed:", error);
});
