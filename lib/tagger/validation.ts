import { promises as fs } from "fs";
import path from "path";

/**
 * Extracts Tagger tags from a Scryfall query
 * Returns an array of { type: 'art' | 'function', tag: string, fullMatch: string }
 */
export function extractTaggerTags(
  query: string
): Array<{ type: "art" | "function"; tag: string; fullMatch: string }> {
  const tags: Array<{ type: "art" | "function"; tag: string; fullMatch: string }> =
    [];

  // Patterns for art tags: art:, atag:, arttag:
  const artPattern = /(?:^|\s)(?:art|atag|arttag):([^\s"()]+|"[^"]+")/gi;
  // Patterns for function tags: function:, otag:, oracletag:
  const functionPattern = /(?:^|\s)(?:function|otag|oracletag):([^\s"()]+|"[^"]+")/gi;

  // Also handle negated tags (-art:, -function:, etc.)
  const negatedArtPattern = /(?:^|\s)-(?:art|atag|arttag):([^\s"()]+|"[^"]+")/gi;
  const negatedFunctionPattern =
    /(?:^|\s)-(?:function|otag|oracletag):([^\s"()]+|"[^"]+")/gi;

  // Extract art tags
  let match;
  while ((match = artPattern.exec(query)) !== null) {
    const tag = match[1].replace(/^"|"$/g, ""); // Remove quotes
    tags.push({ type: "art", tag, fullMatch: match[0].trim() });
  }

  // Extract function tags
  while ((match = functionPattern.exec(query)) !== null) {
    const tag = match[1].replace(/^"|"$/g, ""); // Remove quotes
    tags.push({ type: "function", tag, fullMatch: match[0].trim() });
  }

  // Extract negated art tags (we still want to validate them)
  while ((match = negatedArtPattern.exec(query)) !== null) {
    const tag = match[1].replace(/^"|"$/g, "");
    tags.push({ type: "art", tag, fullMatch: match[0].trim() });
  }

  // Extract negated function tags
  while ((match = negatedFunctionPattern.exec(query)) !== null) {
    const tag = match[1].replace(/^"|"$/g, "");
    tags.push({ type: "function", tag, fullMatch: match[0].trim() });
  }

  return tags;
}

/**
 * Validates if a Tagger tag exists by checking the cached tag list
 * Returns true if the tag exists, false if the tag doesn't exist
 */
let localTaggerCatalogPromise: Promise<Map<"art" | "function", Set<string>>> | null = null;

async function getLocalTaggerCatalog(): Promise<Map<"art" | "function", Set<string>>> {
  if (!localTaggerCatalogPromise) {
    localTaggerCatalogPromise = (async () => {
      const filePath = path.join(process.cwd(), "data", "tagger-tags.json");
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as {
        art?: unknown;
        function?: unknown;
      };
      const art = Array.isArray(parsed.art)
        ? parsed.art.filter((v): v is string => typeof v === "string")
        : [];
      const func = Array.isArray(parsed.function)
        ? parsed.function.filter((v): v is string => typeof v === "string")
        : [];
      return new Map<"art" | "function", Set<string>>([
        ["art", new Set(art)],
        ["function", new Set(func)],
      ]);
    })();
  }
  return localTaggerCatalogPromise;
}

export async function validateTaggerTag(
  type: "art" | "function",
  tag: string
): Promise<boolean> {
  try {
    const localCatalog = await getLocalTaggerCatalog();
    const tagSet = localCatalog.get(type);
    if (!tagSet) {
      console.warn(`[Tagger Validation] No tags found for type: ${type}`);
      return true; // Assume exists to avoid false positives
    }

    // Normalize to slug form (lowercase, spaces → hyphens) for comparison.
    // Tagger display names use spaces ("pure draw") but the catalog and Scryfall
    // queries both use hyphens ("pure-draw").
    const normalizedTag = tag.toLowerCase().trim().replace(/\s+/g, "-");
    for (const cachedTag of tagSet) {
      if (cachedTag.toLowerCase().replace(/\s+/g, "-") === normalizedTag) {
        return true;
      }
    }

    // Debug: log when a tag is not found (helps diagnose cache issues)
    console.log(
      `[Tagger Validation] Tag "${tag}" (slug: "${normalizedTag}") not found in ${type} tags catalog. Catalog size: ${tagSet.size}`
    );

    return false;
  } catch (error) {
    // On file read errors, assume tag exists to avoid false positives
    // We only want to regenerate if we're confident the tag doesn't exist
    console.error(`Error validating tag ${type}:${tag}:`, error);
    return true;
  }
}

/**
 * Validates all Tagger tags in a query and returns invalid ones
 */
export async function validateTaggerTags(
  query: string
): Promise<Array<{ type: "art" | "function"; tag: string }>> {
  const tags = extractTaggerTags(query);
  if (tags.length === 0) {
    return [];
  }

  const invalidTags: Array<{ type: "art" | "function"; tag: string }> = [];

  // Validate tags using cache (no delays needed since we're not making API calls)
  for (const { type, tag } of tags) {
    const isValid = await validateTaggerTag(type, tag);
    if (!isValid) {
      invalidTags.push({ type, tag });
    }
  }

  return invalidTags;
}
