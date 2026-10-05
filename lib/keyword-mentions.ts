/**
 * Keyword chips for the detail panel: Scryfall's `keywords` only lists
 * abilities a card HAS. Cards that grant or reference keywords ("creatures you
 * control gain flying and protection from all colors") get nothing, so we also
 * scan oracle text for catalog keyword names that have a reminder definition.
 */

import { escapeRegex } from "@/lib/utils/text";

/** Same slug rule as KeywordWithTooltip / mtg-keywords. */
export function keywordSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Returns `own` plus every catalog keyword mentioned in `text`, deduped by slug,
 * own keywords first. Reminder text in parentheses is ignored; only candidates
 * with a definition are added (filters out bare verbs and flavor words).
 * Longest names first so "Hexproof from" / "Double strike" win over their prefixes.
 */
export function mergeKeywordMentions(
  own: string[],
  text: string,
  candidates: string[],
  definitions: Record<string, string>,
): string[] {
  const seen = new Set(own.map(keywordSlug));
  const result = [...own];
  let haystack = text.replace(/\([^)]*\)/g, " ");
  const byLength = [...candidates].sort((a, b) => b.length - a.length);
  for (const name of byLength) {
    const slug = keywordSlug(name);
    if (!slug || !definitions[slug]) continue;
    const re = new RegExp(`(?<![\\w-])${escapeRegex(name).replace(/\\?\s+/g, "\\s+")}s?(?![\\w-])`, "gi");
    if (!re.test(haystack)) continue;
    // Consume the match so shorter names ("Strike", "Hexproof") don't re-match inside it.
    haystack = haystack.replace(re, " ");
    if (seen.has(slug)) continue;
    seen.add(slug);
    result.push(name);
  }
  return result;
}
