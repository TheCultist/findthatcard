import { assembleQueryFromIR } from "@/lib/search-pipeline/assembleQuery";
import { normalizeQuery } from "@/lib/search-pipeline/phase0/normalizeQuery";
import { parseNaturalQuery } from "@/lib/search-pipeline/phase1/parseNaturalQuery";
import { runPhase1_5, shouldRunPhase1_5 } from "@/lib/search-pipeline/phase1_5/structuredExtraction";
import { resolveUnresolvedFragments } from "@/lib/search-pipeline/phase2/resolveUnresolvedFragments";
import { finalizeQuery } from "@/lib/search-pipeline/phase3/finalizeQuery";
import { resolveIntentClauses } from "@/lib/search-pipeline/resolveIntentClauses";
import {
  EFFECTIVE_MAX_QUERY_LENGTH,
  PREFER_BEST_PREFIX,
  truncateScryfallQuery,
} from "@/lib/scryfall/query-converter";

function isPipelineDebugEnabled(): boolean {
  const v = process.env.LOG_SEARCH_PIPELINE_DEBUG?.toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function logPipelineSummary(args: {
  original: string;
  afterPhase0?: string;
  afterPhase1?: string;
  afterPhase1_5?: string;
  afterPhase2?: string;
  afterPhase3?: string;
}): void {
  if (!isPipelineDebugEnabled()) return;
  const lines: string[] = ["[Search Pipeline Debug] Summary:"];
  lines.push(`  original: "${args.original}"`);
  if (args.afterPhase0 !== undefined) {
    lines.push(`  after Phase 0: "${args.afterPhase0}"`);
  }
  if (args.afterPhase1 !== undefined) {
    lines.push(`  after Phase 1: "${args.afterPhase1}"`);
  }
  if (args.afterPhase1_5 !== undefined) {
    lines.push(`  after Phase 1.5: "${args.afterPhase1_5}"`);
  }
  if (args.afterPhase2 !== undefined) {
    lines.push(`  after Phase 2: "${args.afterPhase2}"`);
  }
  if (args.afterPhase3 !== undefined) {
    lines.push(`  after Phase 3: "${args.afterPhase3}"`);
  }
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Compound OR query detection
// ---------------------------------------------------------------------------

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
  "artifact",
  "artifacts",
  "enchantment",
  "enchantments",
  "creature",
  "creatures",
  "land",
  "lands",
  "instant",
  "instants",
  "sorcery",
  "sorceries",
  "planeswalker",
  "planeswalkers",
  "battle",
  "battles",
  "equipment",
  "token",
  "tokens",
  "vehicle",
  "vehicles",
  "permanent",
  "permanents",
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
 * Detect top-level OR split points in a (Phase 0-normalised) query and return
 * the individual branch strings.  Returns `[query]` (single element) when no
 * valid compound structure is found.
 *
 * Heuristic:
 * 1. Mark positions of embedded ORs ("or more", "or less", …) that must not
 *    be split on.
 * 2. Find remaining `or` tokens (with optional preceding comma/semicolon).
 * 3. Accept a candidate only when **both** sides have ≥ 2 meaningful words.
 */
export function splitCompoundQuery(query: string): string[] {
  // Queries that describe triggered abilities ("whenever X enters or leaves…") use
  // OR to connect parts of a single trigger description, not to separate independent
  // search intents.  Splitting them produces nonsensical branches.
  if (TRIGGER_CONDITION_RE.test(query)) return [query];

  const lower = query.toLowerCase();

  // 1. Collect character ranges of embedded ORs
  const embeddedRanges: Array<[number, number]> = [];
  let em: RegExpExecArray | null;
  const embeddedRe = new RegExp(EMBEDDED_OR_PATTERN.source, "gi");
  while ((em = embeddedRe.exec(lower)) !== null) {
    embeddedRanges.push([em.index, em.index + em[0].length]);
  }

  // 1b. Also embed color-name "or" connectors: "red, white, or blue" is a color list,
  //     not two independent search intents.  Mark any "or" where both the word
  //     immediately before AND immediately after it are color names.
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

  // 2. Find candidate split points: optional ",;" then "or"
  const splitRe = /[,;]?\s*\bor\b\s*/gi;
  const splitPoints: Array<{ start: number; end: number }> = [];
  let sp: RegExpExecArray | null;
  while ((sp = splitRe.exec(lower)) !== null) {
    const orIdx = lower.indexOf("or", sp.index);
    if (orIdx < 0 || isEmbedded(orIdx)) continue;
    splitPoints.push({ start: sp.index, end: sp.index + sp[0].length });
  }

  if (splitPoints.length === 0) return [query];

  // 3. Slice the original query on those split points
  const branches: string[] = [];
  let lastEnd = 0;
  for (const pt of splitPoints) {
    branches.push(query.substring(lastEnd, pt.start).trim());
    lastEnd = pt.end;
  }
  branches.push(query.substring(lastEnd).trim());

  // 4. Validate: every branch must have ≥ 2 meaningful words
  if (branches.some((b) => !b || countMeaningfulWords(b) < 2)) {
    return [query];
  }

  return branches;
}

export type SearchPipelineResult = {
  queryForScryfall: string;
  queryForLogs: string;
  normalizedQuery?: string;
  debug: {
    /** Count of Phase 1 fragment buckets (same as `ir.unresolvedFragments.length`; assembly order keys, not “still unresolved”). */
    unresolvedFragments: number;
    /** How many fragments Phase 2 attached tags/archetypes to (successful resolutions). */
    resolvedFragments: number;
    aiBatchCalls: number;
    aiSequentialCalls: number;
    invalidTagsRemoved: number;
    phase0Normalized: boolean;
  };
};

export async function runSearchPipeline(naturalQuery: string): Promise<SearchPipelineResult> {
  const phase0 = await normalizeQuery(naturalQuery);

  // Check for compound OR query (e.g. "jund creatures 10mv+ or artifact creatures 10mv+")
  const branches = splitCompoundQuery(phase0.normalized);
  if (branches.length > 1) {
    const compoundResult = await runCompoundPipeline(naturalQuery, phase0, branches);
    if (compoundResult) return compoundResult;
    // Falls through to single pipeline if compound was aborted (named-card intent in a branch).
  }

  const phase1 = await parseNaturalQuery(phase0.normalized);

  // Propagate Phase 0 status into the IR so downstream logging can see it.
  phase1.debug.phase0Normalized = phase0.didNormalize;

  // Intent resolver — fetches card-specific Tagger/LLM data and injects it as
  // a mustClause so the remaining phases (1.5, 2, 3) can apply any extra
  // user constraints on top.  No-ops for search/commander intents.
  await resolveIntentClauses(phase1);

  // Phase 1.5 — Structured AI extraction for unresolved numeric/rarity/year fragments.
  // Runs only when Phase 1 left fragments that carry concrete game-mechanic intent.
  if (shouldRunPhase1_5(phase1)) {
    await runPhase1_5(phase1);
    phase1.debug.aiBatchCalls += 1;
  }

  const phase2 = await resolveUnresolvedFragments(phase1);
  const phase3 = await finalizeQuery(phase2.ir);

  logPipelineSummary({
    original: naturalQuery,
    afterPhase0: phase0.normalized,
    afterPhase1: assembleQueryFromIR(phase1),
    afterPhase2: assembleQueryFromIR(phase2.ir),
    afterPhase3: phase3.queryForScryfall,
  });
  // Note: Phase 1.5 snapshot is not logged separately because it mutates phase1 in-place;
  // the afterPhase2 line already reflects any clauses it added.

  return {
    queryForScryfall: phase3.queryForScryfall,
    queryForLogs: phase3.queryForLogs,
    normalizedQuery: phase0.didNormalize ? phase0.normalized : undefined,
    debug: {
      unresolvedFragments: phase2.ir.unresolvedFragments.length,
      resolvedFragments: phase2.ir.resolvedFragments.length,
      aiBatchCalls: phase1.debug.aiBatchCalls + phase2.batchCalls,
      aiSequentialCalls: phase2.sequentialCalls,
      invalidTagsRemoved: phase3.removedInvalidTags.length,
      phase0Normalized: phase0.didNormalize,
    },
  };
}

// ---------------------------------------------------------------------------
// Compound OR pipeline — processes each branch through Phases 1-3 independently
// ---------------------------------------------------------------------------

const GAME_FILTER_RE = /\s*\bgame:\w+\b/gi;
const PREFER_BEST_RE = /^prefer:best\s+/i;

async function runCompoundPipeline(
  originalQuery: string,
  phase0: { normalized: string; didNormalize: boolean },
  branches: string[]
): Promise<SearchPipelineResult | null> {
  // Phase 1 for all branches (parallel)
  const phase1Results = await Promise.all(branches.map((b) => parseNaturalQuery(b)));

  // If any branch carries a named-card intent (similar/art-like/synergy), abort
  // compound mode — an intent resolver produces a self-contained query that
  // cannot be OR-combined with other branches.
  const hasNamedCardIntent = phase1Results.some(
    (p) => p.intent !== "search" && p.intent !== "commander-deck" && p.intent !== "commander-creature"
  );
  if (hasNamedCardIntent) return null;

  // Phase 1.5 for all branches (parallel) — structured AI extraction
  await Promise.all(
    phase1Results.map(async (p1) => {
      if (shouldRunPhase1_5(p1)) {
        await runPhase1_5(p1);
        p1.debug.aiBatchCalls += 1;
      }
    })
  );

  // Phase 2 for all branches (parallel)
  const phase2Results = await Promise.all(
    phase1Results.map((p1) => resolveUnresolvedFragments(p1))
  );

  // Phase 3 for all branches (parallel)
  const phase3Results = await Promise.all(
    phase2Results.map((p2) => finalizeQuery(p2.ir))
  );

  // Strip per-branch global decorations (prefer:best prefix, game:… filter)
  const strippedBranches = phase3Results.map((p3) => {
    let q = p3.queryForScryfall;
    q = q.replace(PREFER_BEST_RE, "");
    q = q.replace(GAME_FILTER_RE, "");
    return q.replace(/\s{2,}/g, " ").trim();
  });

  // Build compound query with explicit grouping so global filters apply to all branches.
  // Scryfall precedence: AND (space) binds tighter than OR, so we need parens.
  const orBody = strippedBranches.map((b) => `(${b})`).join(" or ");
  let compound = `(${orBody}) game:paper`;

  if (compound.length > EFFECTIVE_MAX_QUERY_LENGTH) {
    compound = truncateScryfallQuery(compound, EFFECTIVE_MAX_QUERY_LENGTH);
  }

  const queryForScryfall = `${PREFER_BEST_PREFIX}${compound}`.trim();

  // Aggregate debug stats across branches
  const totalBatch = phase1Results.reduce((s, p) => s + p.debug.aiBatchCalls, 0)
    + phase2Results.reduce((s, p) => s + p.batchCalls, 0);
  const totalSeq = phase2Results.reduce((s, p) => s + p.sequentialCalls, 0);
  const totalUnresolved = phase2Results.reduce(
    (s, p) => s + p.ir.unresolvedFragments.length, 0
  );
  const totalResolved = phase2Results.reduce(
    (s, p) => s + p.ir.resolvedFragments.length, 0
  );
  const totalInvalid = phase3Results.reduce(
    (s, p) => s + p.removedInvalidTags.length, 0
  );

  logPipelineSummary({
    original: originalQuery,
    afterPhase0: phase0.normalized,
    afterPhase1: `[compound: ${branches.length} branches] ${phase1Results.map((p) => assembleQueryFromIR(p)).join(" | ")}`,
    afterPhase3: queryForScryfall,
  });

  return {
    queryForScryfall,
    queryForLogs: compound,
    normalizedQuery: phase0.didNormalize ? phase0.normalized : undefined,
    debug: {
      unresolvedFragments: totalUnresolved,
      resolvedFragments: totalResolved,
      aiBatchCalls: totalBatch,
      aiSequentialCalls: totalSeq,
      invalidTagsRemoved: totalInvalid,
      phase0Normalized: phase0.didNormalize,
    },
  };
}

