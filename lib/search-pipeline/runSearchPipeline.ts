import { parseNaturalQuery } from "@/lib/search-pipeline/phase1/parseNaturalQuery";
import { resolveUnresolvedFragments } from "@/lib/search-pipeline/phase2/resolveUnresolvedFragments";
import { finalizeQuery } from "@/lib/search-pipeline/phase3/finalizeQuery";
import { resolveSimilarCardsQuery } from "@/lib/search-pipeline/similar-cards";
import { PREFER_BEST_PREFIX } from "@/lib/scryfall/query-converter";

export type SearchPipelineResult = {
  queryForScryfall: string;
  queryForLogs: string;
  debug: {
    unresolvedFragments: number;
    aiBatchCalls: number;
    aiSequentialCalls: number;
    invalidTagsRemoved: number;
  };
};

export async function runSearchPipeline(naturalQuery: string): Promise<SearchPipelineResult> {
  const phase1 = await parseNaturalQuery(naturalQuery);

  // "cards similar to X" / "cards like X" — bypass the normal pipeline and
  // build a query directly from Scryfall card data + AI oracle-tag inference.
  if (phase1.intent === "similar-cards" && phase1.similarToCardName) {
    const similarQuery = await resolveSimilarCardsQuery(phase1.similarToCardName);

    if (similarQuery) {
      return {
        queryForScryfall: `${PREFER_BEST_PREFIX}${similarQuery}`,
        queryForLogs: similarQuery,
        debug: {
          unresolvedFragments: 0,
          aiBatchCalls: 0,
          aiSequentialCalls: 0,
          invalidTagsRemoved: 0,
        },
      };
    }

    // Resolution failed (card not in Scryfall or no usable signals) — fall
    // back to a direct name search so the user at least sees the card itself.
    const fallbackQuery = `name:"${phase1.similarToCardName}"`;
    return {
      queryForScryfall: `${PREFER_BEST_PREFIX}${fallbackQuery}`,
      queryForLogs: fallbackQuery,
      debug: {
        unresolvedFragments: 0,
        aiBatchCalls: 0,
        aiSequentialCalls: 0,
        invalidTagsRemoved: 0,
      },
    };
  }

  const phase2 = await resolveUnresolvedFragments(phase1);
  const phase3 = await finalizeQuery(phase2.ir);

  return {
    queryForScryfall: phase3.queryForScryfall,
    queryForLogs: phase3.queryForLogs,
    debug: {
      unresolvedFragments: phase2.ir.unresolvedFragments.length,
      aiBatchCalls: phase2.batchCalls,
      aiSequentialCalls: phase2.sequentialCalls,
      invalidTagsRemoved: phase3.removedInvalidTags.length,
    },
  };
}

