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

  return `\n\nAvailable Tagger tags for this query (use ONLY these for art:/function:/otag:/oracletag:):\nArt tags: ${artList}\nFunction tags: ${functionList}`;
}

export function getUserPrompt(naturalQuery: string, tagContext?: TaggerTagContext): string {
  return `Convert this natural language query to a Scryfall query string:\n\n"${naturalQuery}"${formatTagContext(
    tagContext
  )}`;
}
