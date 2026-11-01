import { parseQuery, walkQuery, type QueryTerm } from "@/lib/scryfall/query-ast";
import { ensureTaggerTagCache, getTaggerTagCache } from "@/lib/tagger/cache";

const ART_TAG_FIELDS = new Set(["art", "atag", "arttag"]);
const FUNCTION_TAG_FIELDS = new Set(["function", "otag", "oracletag"]);

export type TaggerTagRef = { type: "art" | "function"; tag: string };

/**
 * The Tagger tag a parsed term refers to (`function:storm`, `-atag:"night sky"`), or null when
 * the term is not a tag clause. Regex values are not tags.
 */
export function taggerTagOf(term: QueryTerm): TaggerTagRef | null {
  if (term.field === undefined || term.valueKind === "regex" || term.unterminated) return null;
  const field = term.field.toLowerCase();
  const type = ART_TAG_FIELDS.has(field) ? "art" : FUNCTION_TAG_FIELDS.has(field) ? "function" : null;
  if (!type || !term.value) return null;
  return { type, tag: term.value };
}

/**
 * Extracts Tagger tags from a Scryfall query, negated ones included, wherever they sit (inside
 * groups too). Text inside quoted or regex values is never a tag. `fullMatch` is the clause as
 * written. Uses the shared parser in lib/scryfall/query-ast.
 */
export function extractTaggerTags(
  query: string
): Array<{ type: "art" | "function"; tag: string; fullMatch: string }> {
  const tags: Array<{ type: "art" | "function"; tag: string; fullMatch: string }> = [];
  for (const node of walkQuery(parseQuery(query).root)) {
    if (node.type !== "term") continue;
    const ref = taggerTagOf(node.term);
    if (ref) tags.push({ ...ref, fullMatch: node.term.raw });
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
