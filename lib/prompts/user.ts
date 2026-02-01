import type { TaggerTagContext } from "@/lib/tagger/context";

export function formatTagContext(tagContext?: TaggerTagContext): string {
  if (!tagContext || (tagContext.art.length === 0 && tagContext.function.length === 0)) {
    return "";
  }

  const artList =
    tagContext.art.length > 0
      ? tagContext.art.map((tag) => `art:${tag}`).join(", ")
      : "none";
  const functionList =
    tagContext.function.length > 0
      ? tagContext.function.map((tag) => `function:${tag}`).join(", ")
      : "none";

  return `\n\nAvailable Tagger tags for this query (use ONLY these for art:/function:/otag:/oracletag:):\nArt tags: ${artList}\nFunction tags: ${functionList}\n\nIMPORTANT: 
- If the query asks for a keyword ability (e.g., "Cards with ward/flying"), use kw:/keyword: instead of function tags.
- If a function tag exists that matches the user's intent (e.g., "ramp", "mana producer", "card draw"), you MUST use function:/otag:/oracletag: instead of oracle text (o:). Only use o: when no matching function tag exists or when exact wording is required.
- When using function tags, include the full prefix exactly as shown (e.g., function:discount-self).
- If multiple function tags relate to the same theme of the original query, link them using OR clauses (e.g., "(function:token-generator OR function:token-doubler)").
- SIMPLICITY: If a single, direct tag matches the user's intent (e.g., "zombie" for "cards with zombie art"), use that single tag (art:zombie). Do NOT create long OR lists unless the user explicitly asks for multiple specific things.
- Always ensure parentheses are properly closed if using OR lists.`;
}

export function getUserPrompt(naturalQuery: string, tagContext?: TaggerTagContext): string {
  return `Convert this natural language query to a Scryfall query string:\n\n"${naturalQuery}"${formatTagContext(
    tagContext
  )}`;
}
