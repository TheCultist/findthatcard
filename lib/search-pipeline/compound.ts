/**
 * Compound OR-query detection.
 *
 * Splits a (Phase 0-normalised) query into independent search branches on
 * top-level "or" connectors, while leaving embedded ORs ("3 or more"), colour
 * lists ("red, white, or blue"), type lists ("artifacts or enchantments") and
 * trigger descriptions ("whenever X enters or leaves") intact.
 *
 * Shared by the legacy pipeline (`runSearchPipeline`) and V2 (`runSearchPipelineV2`).
 */

const COMPOUND_STOPWORDS = new Set([
  "a", "an", "the", "for", "to", "from", "with", "without", "of", "in", "on",
  "that", "which", "cards", "card", "best", "good", "great", "strong", "want",
  "need", "find", "show", "me", "please", "are", "can", "could", "would",
  "should", "have", "has", "had", "been", "being", "about", "it", "its",
  "is", "do", "does", "than", "then", "also", "other", "others", "both",
  "any", "some", "all", "most", "every", "i", "my", "your", "not",
]);

/** Embedded OR patterns that must NOT be treated as top-level split points. */
const EMBEDDED_OR_PATTERN =
  /\bor\s+(?:more|less|fewer|greater|higher|better|worse|above|below)\b/gi;

/**
 * MTG color names (mono + named multi-color pairs/shards/wedges).
 * Used to detect "red, white, or blue" style color-list ORs that should NOT
 * be treated as compound query split points.
 */
const COLOR_NAMES_RE =
  /\b(?:white|blue|black|red|green|colorless|azorius|dimir|rakdos|gruul|selesnya|orzhov|izzet|golgari|boros|simic|esper|grixis|jund|naya|bant|abzan|jeskai|sultai|mardu|temur|four.?color|five.?color|wubrg|mono.?(?:white|blue|black|red|green))\b/i;

/** Card-type words on both sides of "or" → type list, not compound split (e.g. "artifacts or enchantments"). */
const CARD_TYPE_LIST_WORDS = new Set([
  "artifact", "artifacts", "enchantment", "enchantments", "creature",
  "creatures", "land", "lands", "instant", "instants", "sorcery", "sorceries",
  "planeswalker", "planeswalkers", "battle", "battles", "equipment", "token",
  "tokens", "vehicle", "vehicles", "permanent", "permanents",
]);

/**
 * Queries containing trigger / conditional keywords describe a triggered ability
 * (e.g. "whenever a creature enters or leaves the battlefield").  The ORs inside
 * such sentences connect parts of a single trigger description, not independent
 * search intents.  Compound splitting would produce nonsensical branches.
 */
const TRIGGER_CONDITION_RE =
  /\b(?:whenever|when\s+(?:a|an|it|you|they|the)\b|on\s+(?:etb|ltb|death)\b|when\s+(?:this|a\s+creature|an?\s+\w+)\s+(?:enters|leaves|dies|attacks|blocks))\b/i;

function countMeaningfulWords(text: string): number {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !COMPOUND_STOPWORDS.has(w))
    .length;
}

/**
 * Detect top-level OR split points in a query and return the individual branch
 * strings.  Returns `[query]` (single element) when no valid compound structure
 * is found.
 */
export function splitCompoundQuery(query: string): string[] {
  if (TRIGGER_CONDITION_RE.test(query)) return [query];

  const lower = query.toLowerCase();

  const embeddedRanges: Array<[number, number]> = [];
  let em: RegExpExecArray | null;
  const embeddedRe = new RegExp(EMBEDDED_OR_PATTERN.source, "gi");
  while ((em = embeddedRe.exec(lower)) !== null) {
    embeddedRanges.push([em.index, em.index + em[0].length]);
  }

  const colorOrRe = /[,;]?\s*\bor\b\s*/gi;
  let co: RegExpExecArray | null;
  while ((co = colorOrRe.exec(lower)) !== null) {
    const before = lower.slice(0, co.index).trimEnd();
    const after = lower.slice(co.index + co[0].length).trimStart();
    const wordBefore = (before.match(/\b\w[\w-]*$/) ?? [""])[0];
    const wordAfter = (after.match(/^\b\w[\w-]*/) ?? [""])[0];
    const wb = wordBefore.toLowerCase();
    const wa = wordAfter.toLowerCase();
    if (COLOR_NAMES_RE.test(wordBefore) && COLOR_NAMES_RE.test(wordAfter)) {
      embeddedRanges.push([co.index, co.index + co[0].length]);
    } else if (CARD_TYPE_LIST_WORDS.has(wb) && CARD_TYPE_LIST_WORDS.has(wa)) {
      embeddedRanges.push([co.index, co.index + co[0].length]);
    }
  }

  const isEmbedded = (pos: number) =>
    embeddedRanges.some(([s, e]) => pos >= s && pos < e);

  const splitRe = /[,;]?\s*\bor\b\s*/gi;
  const splitPoints: Array<{ start: number; end: number }> = [];
  let sp: RegExpExecArray | null;
  while ((sp = splitRe.exec(lower)) !== null) {
    const orIdx = lower.indexOf("or", sp.index);
    if (orIdx < 0 || isEmbedded(orIdx)) continue;
    splitPoints.push({ start: sp.index, end: sp.index + sp[0].length });
  }

  if (splitPoints.length === 0) return [query];

  const branches: string[] = [];
  let lastEnd = 0;
  for (const pt of splitPoints) {
    branches.push(query.substring(lastEnd, pt.start).trim());
    lastEnd = pt.end;
  }
  branches.push(query.substring(lastEnd).trim());

  if (branches.some((b) => !b || countMeaningfulWords(b) < 2)) {
    return [query];
  }

  return branches;
}
