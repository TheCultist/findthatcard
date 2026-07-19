import { lookupCardName } from "@/lib/scryfall/catalog-index";
import { isScryfallQuery } from "@/lib/scryfall/query-converter";

/**
 * Deterministic work that must happen before (or instead of) the AI extraction:
 *
 *  1. `direct` — raw Scryfall syntax passes through untouched (never sent to AI).
 *  2. `recognizedCardNames` — multi-word spans that exactly match a catalog card
 *     name. These are passed to the prompt as protected entities so the model
 *     does not shred names like "Destroy Evil" or "White Knight" into filters.
 */
export type PrePassResult = {
  direct: boolean;
  recognizedCardNames: string[];
};

/** Longest n-gram we will test as a card-name span. */
const MAX_NAME_WORDS = 6;
/** Only surface multi-word matches — single common words (Shock, Forest, Counterspell) are too noisy as hints. */
const MIN_NAME_WORDS = 2;

/**
 * Finds non-overlapping, longest-first spans of the query that exactly match a
 * catalog card name. Punctuation is tolerated by `lookupCardName`'s simplified
 * index, so "sheoldred the apocalypse" still resolves.
 */
export function recognizeCardNames(query: string): string[] {
  const words = query.split(/\s+/).filter(Boolean);
  const found: string[] = [];
  const seen = new Set<string>();
  let i = 0;

  while (i < words.length) {
    let matched = false;
    const maxLen = Math.min(MAX_NAME_WORDS, words.length - i);
    for (let len = maxLen; len >= MIN_NAME_WORDS; len--) {
      const span = words.slice(i, i + len).join(" ");
      const canonical = lookupCardName(span.replace(/[?.!,;:]+$/g, ""));
      if (canonical) {
        const key = canonical.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          found.push(canonical);
        }
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) i += 1;
  }

  return found;
}

export function runPrePass(query: string): PrePassResult {
  if (isScryfallQuery(query)) {
    return { direct: true, recognizedCardNames: [] };
  }
  return { direct: false, recognizedCardNames: recognizeCardNames(query) };
}
