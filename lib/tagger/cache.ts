import { promises as fs } from "fs";
import path from "path";
import { getCacheDir } from "@/lib/cache-paths";
import { createCacheLoader, readCacheJson, formatTodayStamp, shouldSkipUpdate, stampedToday } from "@/lib/utils/cache";
import { scryfallFetch } from "@/lib/scryfall/http";

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

let cacheUpdatedAt: string | null = null;

async function readTaggerCacheFile(): Promise<TaggerCacheFile | null> {
  try {
    const parsed = await readCacheJson(TAGGER_CACHE_PATH, () => import("@/data/seed/tagger-tags.json"));
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
  const firstLoad = taggerTagCache === null;
  const existing = await readTaggerCacheFile();
  if (existing) {
    taggerTagCache = new Map([
      ["art", new Set(existing.art)],
      ["function", new Set(existing.function)],
    ]);
    cacheUpdatedAt = existing.updatedAt || null;
  }

  // Serve file/seed data at once; a stale stamp makes the loader refresh it in the background.
  if (firstLoad && existing) return;

  const todayStamp = formatTodayStamp();
  if (existing && shouldSkipUpdate(existing.updatedAt, todayStamp)) {
    console.log(
      `[Tagger Cache] Cache already refreshed (${existing.updatedAt}), skipping update`
    );
    return;
  }

  // Only what the docs page lists now: unioning with the old file kept tags Scryfall deleted
  // "valid" forever, and each one zeroes the results of any query that uses it.
  const artTags = new Set<string>();
  const functionTags = new Set<string>();
  const artOperators = new Set<string>(["art", "atag", "arttag"]);
  const functionOperators = new Set<string>(["function", "otag", "oracletag"]);

  try {
    console.log(
      `[Tagger Cache] Performing cache update (file date: ${existing?.updatedAt || "none"}, today: ${todayStamp})`
    );
    const response = await scryfallFetch("https://scryfall.com/docs/tagger-tags", {
      headers: { Accept: "text/html" },
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
    // A markup change that breaks the parse yields a fraction of the tags — keep the old list.
    if (
      fetchedFunction.size < (existing?.function.length ?? 0) / 2 ||
      fetchedArt.size < (existing?.art.length ?? 0) / 2
    ) {
      throw new Error(
        `Parsed only ${fetchedArt.size} art / ${fetchedFunction.size} function tags (had ${existing?.art.length} / ${existing?.function.length})`
      );
    }

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
    // Keep whatever the cache file gave us; with no file the cache stays null and
    // ensureTaggerTagCache retries on a later call.
    console.error("[Tagger Cache] Failed to initialize cache:", error);
  }
}

/** Ensures the tagger tag cache is initialized (single-flight; retried while unpopulated). */
export const ensureTaggerTagCache = createCacheLoader(
  () => taggerTagCache !== null,
  initializeTaggerTagCache,
  { isFresh: stampedToday(() => cacheUpdatedAt) }
);

export function getTaggerTagCache(): Map<"art" | "function", Set<string>> | null {
  return taggerTagCache;
}

ensureTaggerTagCache().catch((error) => {
  console.warn("[Tagger Cache] Warm-up failed:", error);
});
