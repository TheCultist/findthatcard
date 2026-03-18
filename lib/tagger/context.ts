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

const KEYWORD_ABILITIES = [
  "flying",
  "trample",
  "vigilance",
  "lifelink",
  "haste",
  "deathtouch",
  "hexproof",
  "indestructible",
  "reach",
  "first strike",
  "double strike",
  "menace",
  "prowess",
  "flash",
  "ward",
  "disturb",
  "storm",
  "suspend",
];

function getKeywordMatches(naturalQuery: string): string[] {
  const text = naturalQuery.toLowerCase();
  const matches: string[] = [];
  for (const keyword of KEYWORD_ABILITIES) {
    const pattern = keyword.includes(" ")
      ? new RegExp(`\\b${keyword.replace(/\s+/g, "\\s+")}\\b`, "i")
      : new RegExp(`\\b${keyword}\\b`, "i");
    if (pattern.test(text)) {
      matches.push(keyword);
    }
  }
  return matches;
}

function hasKeywordGrantIntent(naturalQuery: string): boolean {
  return /\b(give|gives|giving|grant|grants|granting)\b/i.test(naturalQuery);
}

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
  if (
    /\b(mv|cmc|mana value|mana-value|converted mana cost)\b/.test(normalized) &&
    /\b\d+\b/.test(normalized)
  ) {
    // Avoid suggesting mana-value-matters for numeric mv/cmc filters.
    stopwords.add("mana");
    stopwords.add("value");
    stopwords.add("mv");
    stopwords.add("cmc");
    stopwords.add("cost");
    stopwords.add("converted");
  }
  if (/\b(burn|direct damage|deal(s|t)? damage)\b/.test(normalized)) {
    // Surface burn-related function tags for direct damage intents.
    keywords.add("burn");
  }
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

export function extractArtKeywords(naturalQuery: string): string[] {
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
    "art",
    "artwork",
    "illustration",
    "illustrations",
    "depicts",
    "depicting",
    "featuring",
    "shows",
    "showing",
    "pictured",
    // MTG card types — these describe the kind of card, not what's depicted in the art.
    // Without this exclusion, "esper artifacts with clockwork art" would extract "artifact"
    // as an art keyword and cause the LLM to emit art:artifact instead of t:artifact.
    "artifact",
    "artifacts",
    "enchantment",
    "enchantments",
    "instant",
    "instants",
    "sorcery",
    "sorceries",
    "planeswalker",
    "planeswalkers",
    "land",
    "lands",
    "battle",
    "battles",
  ]);

  const text = naturalQuery.toLowerCase();
  const phrases: string[] = [];
  const patterns = [
    /([a-z0-9-]+(?:\s+[a-z0-9-]+){0,2})\s+art\b/g, // "zombie art"
    /\bart(?:\s+of)?\s+([a-z0-9-]+(?:\s+[a-z0-9-]+){0,2})/g, // "art of zombies"
    /\bdepicts?\s+([a-z0-9-]+(?:\s+[a-z0-9-]+){0,2})/g,
    /\bdepicting\s+([a-z0-9-]+(?:\s+[a-z0-9-]+){0,2})/g,
    /\bfeaturing\s+([a-z0-9-]+(?:\s+[a-z0-9-]+){0,2})/g,
    /\bshows?\s+([a-z0-9-]+(?:\s+[a-z0-9-]+){0,2})/g,
    /\bpictured\s+([a-z0-9-]+(?:\s+[a-z0-9-]+){0,2})/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      phrases.push(match[1]);
    }
  }

  const keywords = new Set<string>();
  for (const phrase of phrases) {
    const words = phrase.match(/[a-z0-9-]+/g) || [];
    for (const word of words) {
      if (word.length < 3 || stopwords.has(word)) {
        continue;
      }
      keywords.add(word);
    }
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

      const tokenLongEnough = token.length >= 4;
      const keywordLongEnough = keyword.length >= 4;
      if (tokenLongEnough && keywordLongEnough) {
        if (token.includes(keyword) || keyword.includes(token)) {
          score += 1;
          matched = true;
          break;
        }
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
 * Finds an art tag whose hyphen-separated segments contain ALL of the
 * provided segments (case-insensitive).  Returns the shortest match so e.g.
 * ["space"] resolves to "space" (if it exists) before "spaceship" or "space-godzilla".
 *
 * Returns null when the cache is not yet loaded or no tag matches.
 */
export function findArtTagBySegments(segments: string[]): string | null {
  const cache = getTaggerTagCache();
  if (!cache) return null;
  const artTags = cache.get("art");
  if (!artTags) return null;

  const lower = segments.map((s) => s.toLowerCase());
  const matches: string[] = [];
  for (const tag of artTags) {
    const tagSegs = tag.toLowerCase().split("-");
    if (lower.every((s) => tagSegs.includes(s))) {
      matches.push(tag);
    }
  }
  if (matches.length === 0) return null;
  return matches.sort((a, b) => a.split("-").length - b.split("-").length)[0];
}

/**
 * Finds a function tag whose hyphen-separated segments contain ALL of the
 * provided segments (case-insensitive).  Returns the shortest match (fewest
 * extra segments) so e.g. ["leaves","graveyard"] resolves to
 * "leaves-graveyard-trigger" rather than a longer, more specific variant.
 *
 * Returns null when the cache is not yet loaded or no tag matches.
 */
export function findFunctionTagBySegments(segments: string[]): string | null {
  const cache = getTaggerTagCache();
  if (!cache) return null;
  const functionTags = cache.get("function");
  if (!functionTags) return null;

  const lower = segments.map((s) => s.toLowerCase());
  const matches: string[] = [];
  for (const tag of functionTags) {
    const tagSegs = tag.toLowerCase().split("-");
    if (lower.every((s) => tagSegs.includes(s))) {
      matches.push(tag);
    }
  }
  if (matches.length === 0) return null;
  // Prefer the tag with the fewest segments (most concise / least specific)
  return matches.sort((a, b) => a.split("-").length - b.split("-").length)[0];
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

  const keywordMatches = getKeywordMatches(naturalQuery);
  const keywords = extractTaggerKeywords(naturalQuery);
  const artKeywords = extractArtKeywords(naturalQuery);
  if (keywords.length === 0 && artKeywords.length === 0) {
    return { art: [], function: [] };
  }

  const buildList = (type: "art" | "function"): string[] => {
    const tagSet = taggerTagCache.get(type);
    if (!tagSet) {
      return [];
    }

    if (type === "art" && artKeywords.length === 0) {
      return [];
    }

    const scopedKeywords = type === "art" ? artKeywords : keywords;
    if (scopedKeywords.length === 0) {
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
      .map((tag) => ({ tag, score: scoreTagMatch(tag, scopedKeywords) }))
      .filter((entry) => entry.score > 0);

    if (scored.length === 0) {
      return [];
    }

    let filtered = scored;
    if (type === "function") {
      const withoutCycles = filtered.filter(
        (entry) => !entry.tag.toLowerCase().startsWith("cycle-")
      );
      if (withoutCycles.length > 0) {
        filtered = withoutCycles;
      }

      if (keywordMatches.length > 0 && !hasKeywordGrantIntent(naturalQuery)) {
        const keywordTokens = keywordMatches.map((keyword) =>
          keyword.replace(/\s+/g, "-").toLowerCase()
        );
        filtered = filtered.filter((entry) => {
          const tag = entry.tag.toLowerCase();
          const isGrantTag = /^(gains|grant|grants|gives|giving)-/.test(tag);
          if (!isGrantTag) {
            return true;
          }
          return !keywordTokens.some((token) => tag.includes(token));
        });
      }

      // Keep more specific tags when their scores are higher; do not auto-filter by hyphen count.
    }

    const maxScore = filtered.reduce((max, entry) => Math.max(max, entry.score), 0);
    const minScore = maxScore >= 3 ? maxScore - 1 : 1;

    let ranked = filtered.filter((entry) => entry.score >= minScore);

    if (type === "function") {
      ranked = ranked.filter((entry) => {
        const token = entry.tag.toLowerCase();
        if (token.includes("-")) {
          return true;
        }
        return !ranked.some(
          (other) =>
            other.score > entry.score &&
            other.tag
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .includes(token)
        );
      });
    }

    return ranked
      .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag))
      .slice(0, maxPerType)
      .map((entry) => entry.tag);
  };

  return {
    art: buildList("art"),
    function: buildList("function"),
  };
}
