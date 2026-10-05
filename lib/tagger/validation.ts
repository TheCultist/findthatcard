import { ensureTaggerTagCache, getTaggerTagCache } from "@/lib/tagger/cache";

/**
 * Extracts Tagger tags from a Scryfall query
 * Returns an array of { type: 'art' | 'function', tag: string, fullMatch: string }
 */
export function extractTaggerTags(
  query: string
): Array<{ type: "art" | "function"; tag: string; fullMatch: string }> {
  const tags: Array<{ type: "art" | "function"; tag: string; fullMatch: string }> =
    [];

  // A tag can be preceded by start-of-string, whitespace, or an open paren —
  // assembled queries routinely emit `((function:tag …`, and requiring
  // whitespace made every parenthesized tag invisible to validation.
  // Patterns for art tags: art:, atag:, arttag:
  const artPattern = /(?:^|[\s(])(?:art|atag|arttag):([^\s"()]+|"[^"]+")/gi;
  // Patterns for function tags: function:, otag:, oracletag:
  const functionPattern = /(?:^|[\s(])(?:function|otag|oracletag):([^\s"()]+|"[^"]+")/gi;

  // Also handle negated tags (-art:, -function:, etc.)
  const negatedArtPattern = /(?:^|[\s(])-(?:art|atag|arttag):([^\s"()]+|"[^"]+")/gi;
  const negatedFunctionPattern =
    /(?:^|[\s(])-(?:function|otag|oracletag):([^\s"()]+|"[^"]+")/gi;

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

// Tagger display names use spaces ("pure draw"); the catalog and Scryfall queries use hyphens.
const toSlug = (tag: string) => tag.toLowerCase().trim().replace(/\s+/g, "-");

// Slug sets per catalog Set, rebuilt automatically when the tagger cache swaps in a new Set.
const slugSets = new WeakMap<Set<string>, Set<string>>();

/**
 * Validates a Tagger tag against the same catalog the prompt context is built from
 * (lib/tagger/cache.ts — /tmp on serverless). Fails CLOSED: with no catalog loaded we
 * can't tell real tags from invented ones, and an invented tag zeroes the results,
 * while dropping a real one only broadens them.
 */
export async function validateTaggerTag(
  type: "art" | "function",
  tag: string
): Promise<boolean> {
  await ensureTaggerTagCache().catch((error) =>
    console.warn("[Tagger Validation] Tag catalog load failed:", error)
  );
  const tagSet = getTaggerTagCache()?.get(type);
  if (!tagSet?.size) {
    console.warn(`[Tagger Validation] No ${type} tag catalog loaded; rejecting "${tag}"`);
    return false;
  }

  let slugs = slugSets.get(tagSet);
  if (!slugs) {
    slugs = new Set([...tagSet].map(toSlug));
    slugSets.set(tagSet, slugs);
  }
  if (slugs.has(toSlug(tag))) return true;

  console.log(
    `[Tagger Validation] Tag "${tag}" (slug: "${toSlug(tag)}") not found in ${type} tags catalog. Catalog size: ${tagSet.size}`
  );
  return false;
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
