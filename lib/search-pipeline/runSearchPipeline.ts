import { assembleQueryFromIR } from "@/lib/search-pipeline/assembleQuery";
import { normalizeQuery } from "@/lib/search-pipeline/phase0/normalizeQuery";
import { parseNaturalQuery } from "@/lib/search-pipeline/phase1/parseNaturalQuery";
import { resolveUnresolvedFragments } from "@/lib/search-pipeline/phase2/resolveUnresolvedFragments";
import { finalizeQuery } from "@/lib/search-pipeline/phase3/finalizeQuery";
import { resolveArtLikeCardsQuery, resolveSimilarCardsQuery } from "@/lib/search-pipeline/similar-cards";
import { PREFER_BEST_PREFIX } from "@/lib/scryfall/query-converter";

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

  // "cards similar to X" / "cards like X" — bypass the normal pipeline and
  // build a query directly from Scryfall card data + AI oracle-tag inference.
  if (phase1.intent === "similar-cards" && phase1.similarToCardName) {
    const similarQuery = await resolveSimilarCardsQuery(phase1.similarToCardName);

    if (similarQuery) {
      const queryForScryfall = `${PREFER_BEST_PREFIX}${similarQuery}`;
      logPipelineSummary({
        original: naturalQuery,
        afterPhase0: phase0.normalized,
        afterPhase3: queryForScryfall,
      });
      return {
        queryForScryfall,
        queryForLogs: similarQuery,
        normalizedQuery: phase0.didNormalize ? phase0.normalized : undefined,
        debug: {
          unresolvedFragments: 0,
          aiBatchCalls: 0,
          aiSequentialCalls: 0,
          invalidTagsRemoved: 0,
          phase0Normalized: phase0.didNormalize,
        },
      };
    }

    // Resolution failed (card not in Scryfall or no usable signals) — fall
    // back to a direct name search so the user at least sees the card itself.
    const fallbackQuery = `name:"${phase1.similarToCardName}"`;
    const fallbackForScryfall = `${PREFER_BEST_PREFIX}${fallbackQuery}`;
    logPipelineSummary({
      original: naturalQuery,
      afterPhase0: phase0.normalized,
      afterPhase3: fallbackForScryfall,
    });
    return {
      queryForScryfall: fallbackForScryfall,
      queryForLogs: fallbackQuery,
      normalizedQuery: phase0.didNormalize ? phase0.normalized : undefined,
      debug: {
        unresolvedFragments: 0,
        aiBatchCalls: 0,
        aiSequentialCalls: 0,
        invalidTagsRemoved: 0,
        phase0Normalized: phase0.didNormalize,
      },
    };
  }

  // "art like X" — bypass the normal pipeline and build a query from the
  // named card's illustration tags (art:) from the Scryfall Tagger.
  if (phase1.intent === "art-like-cards" && phase1.artLikeCardName) {
    const artQuery = await resolveArtLikeCardsQuery(phase1.artLikeCardName);

    if (artQuery) {
      const queryForScryfall = `${PREFER_BEST_PREFIX}${artQuery}`;
      logPipelineSummary({
        original: naturalQuery,
        afterPhase0: phase0.normalized,
        afterPhase3: queryForScryfall,
      });
      return {
        queryForScryfall,
        queryForLogs: artQuery,
        normalizedQuery: phase0.didNormalize ? phase0.normalized : undefined,
        debug: {
          unresolvedFragments: 0,
          aiBatchCalls: 0,
          aiSequentialCalls: 0,
          invalidTagsRemoved: 0,
          phase0Normalized: phase0.didNormalize,
        },
      };
    }

    // Fallback: no art tags found — return a plain name search.
    const fallbackQuery = `name:"${phase1.artLikeCardName}"`;
    const fallbackForScryfall = `${PREFER_BEST_PREFIX}${fallbackQuery}`;
    logPipelineSummary({
      original: naturalQuery,
      afterPhase0: phase0.normalized,
      afterPhase3: fallbackForScryfall,
    });
    return {
      queryForScryfall: fallbackForScryfall,
      queryForLogs: fallbackQuery,
      normalizedQuery: phase0.didNormalize ? phase0.normalized : undefined,
      debug: {
        unresolvedFragments: 0,
        aiBatchCalls: 0,
        aiSequentialCalls: 0,
        invalidTagsRemoved: 0,
        phase0Normalized: phase0.didNormalize,
      },
    };
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
      aiBatchCalls: phase2.batchCalls,
      aiSequentialCalls: phase2.sequentialCalls,
      invalidTagsRemoved: phase3.removedInvalidTags.length,
      phase0Normalized: phase0.didNormalize,
    },
  };
}

