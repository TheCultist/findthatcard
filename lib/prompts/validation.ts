/**
 * Validation prompt for query correction
 * Used to validate and correct generated Scryfall queries against user intent
 */

/**
 * Builds the validation prompt for query correction
 * @param naturalQuery - The original user query
 * @param generatedQuery - The generated Scryfall query to validate
 * @param invalidTags - Array of invalid tags found in the query (optional)
 */
export function buildValidationPrompt(
  naturalQuery: string,
  generatedQuery: string,
  invalidTags?: Array<{ type: "art" | "function"; tag: string }>
): string {
  let invalidTagsSection = "";
  if (invalidTags && invalidTags.length > 0) {
    const invalidTagsList = invalidTags
      .map(({ type, tag }) => `${type}:${tag}`)
      .join(", ");
    invalidTagsSection = `\n\nCRITICAL: The following tags DO NOT EXIST and MUST be removed or replaced:\n${invalidTagsList}\n\nIf a function tag doesn't exist, use oracle text (o:) instead. If an art tag doesn't exist, remove it or use a valid alternative.`;
  }

  return `User request: "${naturalQuery}"
Generated query: "${generatedQuery}"${invalidTagsSection}

CRITICAL RULES:
- "f:" is FORMAT (f:commander, f:modern, f:legacy), NOT function tags. Function tags use "function:", "otag:", or "oracletag:".
- NEVER use non-existent tags. If a tag doesn't exist, use oracle text (o:) instead.
- Keyword abilities MUST use kw:/keyword: (e.g., kw:surveil, kw:flying). Do NOT replace kw: with o:.
- Check: Missing requirements? Extra filters? Overly broad function tags? Incorrect colors/types? Syntax errors?
- Function tags must exist in the Tagger system. If uncertain, use oracle text (o:) as fallback.
- Preserve valid function tags; do NOT replace them with o: unless they are invalid or clearly wrong.
- Keep it minimal: use ONE function tag unless the user explicitly requests multiple distinct functions. Remove unrelated or redundant function tags.
- When using o:, avoid inventing long phrases. Use short, canonical terms from the user request (e.g., "cost", "less", "reduce") instead of made-up sentences like "cost reduction for elementals".
- Type vs targeting: Use t: only when the user wants the cards themselves to be that type. If the request targets a creature type (e.g., "discount elementals", "destroy dragons"), use o:"elemental"/o:"dragon" and do NOT add t: unless explicitly requested.
- No bare words: every token must be a valid fielded filter (t:, o:, function:, etc.). Only use bare words for explicit card names; otherwise convert or remove.
- For cost reduction, prefer function:discount-* if available; otherwise use a mana-cost wildcard in oracle text, e.g. o:/cost \\{[0-9X]+\\} less/ (not o:"cost reduction").
- Quote multiword values for any field (a:, o:, name:, etc.).

Examples:
- "put lands into play" -> function:play-additional-land, function:conjure-land, or function:create-land-tokens (NOT function:cheat-into-play - too broad)
- "cards that deal damage" -> o:damage (NOT f:damage - f: is format!)
- "cards that deal damage to any target" -> o:"damage" o:"any target" (if no function tag exists)
- "cards with surveil" -> kw:surveil (NOT o:surveil)
- "Selesnya cards that create +1/+1 counters for Commander" -> f:commander id:gw function:gives-pp-counters

Output ONLY the Scryfall query string (max 388 chars). If correct, output it as-is. If wrong, output corrected version. No explanations:`;
}
