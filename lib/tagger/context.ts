import { ensureTaggerTagCache, getTaggerTagCache } from "./cache";

export type TaggerTagContext = {
  art: string[];
  function: string[];
};

/**
 * Function tags that should be blacklisted (e.g., tags used by very few cards)
 */
const BLACKLISTED_FUNCTION_TAGS = new Set([
  "create-multiple-tokens", // Only used by one card
]);

function extractTaggerKeywords(naturalQuery: string): string[] {
  const stopwords = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "with",
    "without",
    "for",
    "to",
    "in",
    "on",
    "of",
    "from",
    "by",
    "about",
    "that",
    "those",
    "these",
    "this",
    "cards",
    "card",
    "synergy",
    "synergies",
    "package",
    "packages",
    "commander",
    "edh",
    "format",
    "spells",
    "spell",
    "creature",
    "creatures",
    "deck",
    "decks",
  ]);

  const words = naturalQuery.toLowerCase().match(/[a-z0-9-]+/g) || [];
  const keywords = new Set<string>();

  const normalized = naturalQuery.toLowerCase();
  if (/\+1\s*\/\s*\+1/.test(normalized)) {
    // Tagger uses "pp" for +1/+1 counter tags.
    keywords.add("pp");
  }
  if (/-1\s*\/\s*-1/.test(normalized)) {
    // Tagger uses "mm" for -1/-1 counter tags.
    keywords.add("mm");
  }

  for (const word of words) {
    if (word.length < 3 || stopwords.has(word)) {
      continue;
    }
    keywords.add(word);
  }

  return Array.from(keywords);
}

function scoreTagMatch(tag: string, keywords: string[]): number {
  if (keywords.length === 0) {
    return 0;
  }

  const tokens = tag.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let score = 0;

  for (const keyword of keywords) {
    if (keyword.length < 3) {
      continue;
    }

    let matched = false;
    for (const token of tokens) {
      if (token.length < 3) {
        continue;
      }

      if (token === keyword) {
        score += 2;
        matched = true;
        break;
      }

      if (token.includes(keyword) || keyword.includes(token)) {
        score += 1;
        matched = true;
        break;
      }
    }

    if (matched) {
      continue;
    }

    if (tag.toLowerCase().includes(keyword)) {
      score += 1;
    }
  }

  return score;
}

/**
 * Returns a narrowed list of Tagger tags relevant to the query.
 * Used to guide the model toward valid tags without sending the full catalog.
 */
export async function getTaggerTagContext(
  naturalQuery: string,
  maxPerType: number = 40
): Promise<TaggerTagContext> {
  await ensureTaggerTagCache();

  const taggerTagCache = getTaggerTagCache();
  if (taggerTagCache === null) {
    return { art: [], function: [] };
  }

  const keywords = extractTaggerKeywords(naturalQuery);
  if (keywords.length === 0) {
    return { art: [], function: [] };
  }

  const buildList = (type: "art" | "function"): string[] => {
    const tagSet = taggerTagCache.get(type);
    if (!tagSet) {
      return [];
    }

    const scored = Array.from(tagSet)
      .filter((tag) => {
        // Filter out blacklisted function tags
        if (type === "function" && BLACKLISTED_FUNCTION_TAGS.has(tag.toLowerCase())) {
          return false;
        }
        return true;
      })
      .map((tag) => ({ tag, score: scoreTagMatch(tag, keywords) }))
      .filter((entry) => entry.score > 0);

    if (scored.length === 0) {
      return [];
    }

    const maxScore = scored.reduce((max, entry) => Math.max(max, entry.score), 0);
    const minScore = maxScore >= 3 ? maxScore - 1 : 1;

    return scored
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag))
      .slice(0, maxPerType)
      .map((entry) => entry.tag);
  };

  return {
    art: buildList("art"),
    function: buildList("function"),
  };
}
