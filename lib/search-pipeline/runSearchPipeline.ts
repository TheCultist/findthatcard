import { assembleQueryFromIR } from "@/lib/search-pipeline/assembleQuery";
import { normalizeQuery } from "@/lib/search-pipeline/phase0/normalizeQuery";
import { parseNaturalQuery } from "@/lib/search-pipeline/phase1/parseNaturalQuery";
import { resolveUnresolvedFragments } from "@/lib/search-pipeline/phase2/resolveUnresolvedFragments";
import { finalizeQuery } from "@/lib/search-pipeline/phase3/finalizeQuery";
import { resolveArtLikeCardsQuery, resolveSimilarCardsQuery } from "@/lib/search-pipeline/similar-cards";
import { resolveSynergyQuery } from "@/lib/search-pipeline/synergy-cards";
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
  if (args.afterPhase2 !== undefined) {
    lines.push(`  after Phase 2: "${args.afterPhase2}"`);
  }
  if (args.afterPhase3 !== undefined) {
    lines.push(`  after Phase 3: "${args.afterPhase3}"`);
  }
  console.log(lines.join("\n"));
}

function dropContradictoryNameClauses(phase1: Awaited<ReturnType<typeof parseNaturalQuery>>, query: string): void {
  const excluded = new Set<string>();
  let match: RegExpExecArray | null;
  const excludedNamePattern = /-name:"([^"]+)"/gi;
  while ((match = excludedNamePattern.exec(query)) !== null) {
    const name = (match[1] || "").trim().toLowerCase();
    if (name) excluded.add(name);
  }
  if (excluded.size === 0) return;

  phase1.mustClauses = phase1.mustClauses.filter((clause) => {
    const m = /^\s*name:"([^"]+)"\s*$/i.exec(clause.value);
    if (!m) return true;
    return !excluded.has((m[1] || "").trim().toLowerCase());
  });
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
  const lower = query.toLowerCase();

  // 1. Collect character ranges of embedded ORs
  const embeddedRanges: Array<[number, number]> = [];
  let em: RegExpExecArray | null;
  const embeddedRe = new RegExp(EMBEDDED_OR_PATTERN.source, "gi");
  while ((em = embeddedRe.exec(lower)) !== null) {
    embeddedRanges.push([em.index, em.index + em[0].length]);
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
    unresolvedFragments: number;
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
    // Falls through to single pipeline if compound was aborted (bypass intent in a branch).
  }

  const phase1 = await parseNaturalQuery(phase0.normalized);

  // Propagate Phase 0 status into the IR so downstream logging can see it.
  phase1.debug.phase0Normalized = phase0.didNormalize;

  // Resolve bypass intents: inject their output as a must-clause wrapped in
  // parens so any extra user constraints (e.g. -t:instant) apply globally.
  // The flow then continues to Phase 2/3 for fragment resolution + finalization.
  if (phase1.intent === "similar-cards" && phase1.similarToCardName) {
    const similarQuery = await resolveSimilarCardsQuery(phase1.similarToCardName);
    if (similarQuery) {
      dropContradictoryNameClauses(phase1, similarQuery);
      phase1.mustClauses.unshift({ value: `(${similarQuery})`, source: "phase1:direct" });
    } else {
      phase1.mustClauses.unshift({ value: `name:"${phase1.similarToCardName}"`, source: "phase1:cardname" });
    }
  }

  if (phase1.intent === "art-like-cards" && phase1.artLikeCardName) {
    const artQuery = await resolveArtLikeCardsQuery(phase1.artLikeCardName);
    if (artQuery) {
      dropContradictoryNameClauses(phase1, artQuery);
      phase1.mustClauses.unshift({ value: `(${artQuery})`, source: "phase1:direct" });
    } else {
      phase1.mustClauses.unshift({ value: `name:"${phase1.artLikeCardName}"`, source: "phase1:cardname" });
    }
  }

  if (phase1.intent === "synergy-with-card" && phase1.synergyWithCardName) {
    const synergyResult = await resolveSynergyQuery(phase1.synergyWithCardName);
    if (synergyResult) {
      dropContradictoryNameClauses(phase1, synergyResult.query);
      // Inject the synergy query without extra wrapping parens — it is already sanitized.
      phase1.mustClauses.unshift({ value: synergyResult.query, source: "phase1:direct" });
      // Inject color identity as a top-level constraint so it applies to the whole query.
      if (synergyResult.colorIdentity) {
        phase1.mustClauses.push({ value: `id<=${synergyResult.colorIdentity}`, source: "phase1:direct" });
      }
      phase1.debug.aiBatchCalls += 1;
    } else {
      phase1.mustClauses.unshift({ value: `name:"${phase1.synergyWithCardName}"`, source: "phase1:cardname" });
    }
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

  return {
    queryForScryfall: phase3.queryForScryfall,
    queryForLogs: phase3.queryForLogs,
    normalizedQuery: phase0.didNormalize ? phase0.normalized : undefined,
    debug: {
      unresolvedFragments: phase2.ir.unresolvedFragments.length,
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

const GAME_FILTER_RE = /\s+game:\w+\s*$/i;
const PREFER_BEST_RE = /^prefer:best\s+/i;

async function runCompoundPipeline(
  originalQuery: string,
  phase0: { normalized: string; didNormalize: boolean },
  branches: string[]
): Promise<SearchPipelineResult | null> {
  // Phase 1 for all branches (parallel)
  const phase1Results = await Promise.all(branches.map((b) => parseNaturalQuery(b)));

  // If any branch detected a bypass intent, abort compound mode.
  const hasBypass = phase1Results.some(
    (p) => p.intent !== "search" && p.intent !== "commander-deck" && p.intent !== "commander-creature"
  );
  if (hasBypass) return null;

  // Phase 2 for all branches (parallel)
  const phase2Results = await Promise.all(
    phase1Results.map((p1) => resolveUnresolvedFragments(p1))
  );

  // Phase 3 for all branches (parallel)
  const phase3Results = await Promise.all(
    phase2Results.map((p2) => finalizeQuery(p2.ir))
  );

  // Strip per-branch global decorations (prefer:best prefix, trailing game:…)
  const strippedBranches = phase3Results.map((p3) => {
    let q = p3.queryForScryfall;
    q = q.replace(PREFER_BEST_RE, "").trim();
    q = q.replace(GAME_FILTER_RE, "").trim();
    return q;
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
      aiBatchCalls: totalBatch,
      aiSequentialCalls: totalSeq,
      invalidTagsRemoved: totalInvalid,
      phase0Normalized: phase0.didNormalize,
    },
  };
}

