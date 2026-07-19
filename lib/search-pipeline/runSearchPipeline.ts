import { runSearchPipelineV2 } from "@/lib/search-pipeline/v2/runV2";

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

/**
 * Public entry point for turning a natural-language query into a Scryfall query.
 *
 * Delegates to the V2 pipeline: a deterministic pre-pass (direct-scryfall
 * passthrough + compound "or" splitting) around a single schema-constrained AI
 * extraction, validated into an IR and finalized by Phase 3. There is no longer
 * a legacy multi-phase fallback.
 */
export function runSearchPipeline(naturalQuery: string): Promise<SearchPipelineResult> {
  return runSearchPipelineV2(naturalQuery);
}
