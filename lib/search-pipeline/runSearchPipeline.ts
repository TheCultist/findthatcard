import { parseNaturalQuery } from "@/lib/search-pipeline/phase1/parseNaturalQuery";
import { resolveUnresolvedFragments } from "@/lib/search-pipeline/phase2/resolveUnresolvedFragments";
import { finalizeQuery } from "@/lib/search-pipeline/phase3/finalizeQuery";

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

