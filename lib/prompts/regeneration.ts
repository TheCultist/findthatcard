import type { TaggerTagContext } from "@/lib/tagger/context";
import { formatTagContext } from "@/lib/prompts/user";

/**
 * Creates a prompt for regenerating a query with invalid tags removed
 */
export function getRegenerationPrompt(
  naturalQuery: string,
  invalidTags: Array<{ type: "art" | "function"; tag: string }>,
  tagContext?: TaggerTagContext
): string {
  const tagList = invalidTags
    .map(({ type, tag }) => `${type}:${tag.includes(" ") ? `"${tag}"` : tag}`)
    .join(", ");

  const tagTypeDescription = invalidTags.every((t) => t.type === "art")
    ? "art tags"
    : invalidTags.every((t) => t.type === "function")
    ? "function tags"
    : "tags";

  return `The previous Scryfall query included ${tagTypeDescription} that do not exist in the Scryfall Tagger catalogue: ${tagList}

Please regenerate the query WITHOUT using these invalid ${tagTypeDescription}. Use alternative approaches:
- For invalid art tags: Use oracle text (o:) or remove the art filter entirely
- For invalid function tags: Use oracle text (o:) to describe the function instead

Original query: "${naturalQuery}"

Convert to a Scryfall query string that avoids the invalid ${tagTypeDescription} listed above:${formatTagContext(
    tagContext
  )}`;
}
