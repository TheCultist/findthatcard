/**
 * System prompt for OpenAI to convert natural language queries to Scryfall query syntax
 */
export const SCRYFALL_QUERY_CONVERTER_SYSTEM_PROMPT = `You convert natural language Magic: The Gathering requests into a single Scryfall search query string.

Output rules (strict):
- Output ONLY the final query string.
- No markdown, no surrounding quotes, no explanations.
- Use spaces between tokens; quote multi-word phrases/tags.
- Use OR inside parentheses for alternatives.

Tag usage:
- Prefer Tagger tags for function/art intent: art:/atag:/arttag: and function:/otag:/oracletag:.
- Art intent (“art with X”) -> art:; multi-word art tags must be quoted.
- Function intent (“cards that do X”) -> function/otag/oracletag.
- If request has exact wording or quantities (e.g., "draw two cards", "deal 3 damage"), use oracle text: o:"...".
- Magic keywords (flying, trample, vigilance, lifelink, haste, deathtouch, etc.) -> o:<keyword>.
- “X synergies / X package” -> small OR list of related Tagger tags.

Heuristics:
- Commander/EDH: include f:commander and use id: color identity (Dimir=ub, Boros=rw, mono red=id:r).
- Formats: f:<format>.
- Alchemy: use is:alchemy; exclude -> -is:alchemy (not a type).
- Types: t:<type>; tribes like zombie/angel -> t:<tribe> (unless art intent).
- Game changers: is:gamechanger; exclude -> -is:gamechanger.
- Art tags must be concrete; avoid vague art categories. For vague art, use small OR list of concrete subjects.
- Artist intent -> artist: (not art:).

Negation:
- “no/not/without/exclude/avoid” -> leading dash on the correct field (e.g., -t:human, -function:board-wipe, -art:angel).

Quality bar:
- Avoid overly broad queries; choose most likely interpretation; use safe fallback (o: or art:) if vague.

Examples:
- Dimir removal spells for Commander -> f:commander id:ub function:removal
- Cards with vigilance and lifelink -> o:vigilance o:lifelink
- Cards that draw two cards -> o:"draw two cards"
- Boros cards with fantasy creatures in the art -> id:rw t:creature (art:dragon or art:angel or art:demon or art:elf or art:griffin)
- Rakdos sacrifice synergies for Commander -> f:commander id:br (oracletag:"sacrifice outlet" or oracletag:"free sac outlet" or oracletag:"sacrifice payoff" or oracletag:"sacrifice fodder")
`;

/**
 * Template for user prompt - includes the natural language query
 */
type TaggerTagContext = {
  art: string[];
  function: string[];
};

function formatTagContext(tagContext?: TaggerTagContext): string {
  if (!tagContext || (tagContext.art.length === 0 && tagContext.function.length === 0)) {
    return '';
  }

  const artList = tagContext.art.length > 0 ? tagContext.art.join(', ') : 'none';
  const functionList = tagContext.function.length > 0 ? tagContext.function.join(', ') : 'none';

  return `\n\nAvailable Tagger tags for this query (use ONLY these for art:/function:/otag:/oracletag:):\nArt tags: ${artList}\nFunction tags: ${functionList}`;
}

export function getUserPrompt(naturalQuery: string, tagContext?: TaggerTagContext): string {
  return `Convert this natural language query to a Scryfall query string:\n\n"${naturalQuery}"${formatTagContext(tagContext)}`;
}

/**
 * Creates a prompt for regenerating a query with invalid tags removed
 */
export function getRegenerationPrompt(
  naturalQuery: string,
  invalidTags: Array<{ type: 'art' | 'function'; tag: string }>,
  tagContext?: TaggerTagContext
): string {
  const tagList = invalidTags
    .map(({ type, tag }) => `${type}:${tag.includes(' ') ? `"${tag}"` : tag}`)
    .join(', ');
  
  const tagTypeDescription = invalidTags.every(t => t.type === 'art')
    ? 'art tags'
    : invalidTags.every(t => t.type === 'function')
    ? 'function tags'
    : 'tags';
  
  return `The previous Scryfall query included ${tagTypeDescription} that do not exist in the Scryfall Tagger catalogue: ${tagList}

Please regenerate the query WITHOUT using these invalid ${tagTypeDescription}. Use alternative approaches:
- For invalid art tags: Use oracle text (o:) or remove the art filter entirely
- For invalid function tags: Use oracle text (o:) to describe the function instead

Original query: "${naturalQuery}"

Convert to a Scryfall query string that avoids the invalid ${tagTypeDescription} listed above:${formatTagContext(tagContext)}`;
}
