import { assembleQueryFromIR } from "@/lib/search-pipeline/assembleQuery";
import { normalizeQuery } from "@/lib/search-pipeline/phase0/normalizeQuery";
import { parseNaturalQuery } from "@/lib/search-pipeline/phase1/parseNaturalQuery";
import { resolveUnresolvedFragments } from "@/lib/search-pipeline/phase2/resolveUnresolvedFragments";
import { finalizeQuery } from "@/lib/search-pipeline/phase3/finalizeQuery";
import { resolveArtLikeCardsQuery, resolveSimilarCardsQuery } from "@/lib/search-pipeline/similar-cards";
import { resolveSynergyQuery } from "@/lib/search-pipeline/synergy-cards";

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
      phase1.mustClauses.unshift({ value: `(${synergyResult.query})`, source: "phase1:direct" });
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

