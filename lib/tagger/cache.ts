const TAGGER_USER_AGENT = "find-that-card/1.0 (+https://findthat.card)";

/**
 * In-memory cache for Scryfall Tagger tags
 * Structure: Map<'art' | 'function', Set<string>>
 */
let taggerTagCache: Map<'art' | 'function', Set<string>> | null = null;
let cacheInitializationPromise: Promise<void> | null = null;

/**
 * Fetches and parses the Scryfall Tagger Tags documentation page
 * Extracts all valid art: and function: tags
 */
async function initializeTaggerTagCache(): Promise<void> {
  if (taggerTagCache !== null) {
    return; // Cache already initialized
  }

  const artTags = new Set<string>();
  const functionTags = new Set<string>();
  const artOperators = new Set<string>(["art", "atag", "arttag"]);
  const functionOperators = new Set<string>(["function", "otag", "oracletag"]);

  try {
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

    taggerTagCache = new Map([
      ["art", artTags],
      ["function", functionTags],
    ]);

    console.log(
      `[Tagger Cache] Initialized with ${artTags.size} art tags and ${functionTags.size} function tags`
    );
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
