/**
 * Search Pipeline V2 — the single AI extraction call.
 *
 * One `callAIStructured` invocation replaces the legacy Phase 0 (normalize),
 * Phase 1 (regex detectors), Phase 1.5 (numeric/rarity extraction) and Phase 2
 * (fragment resolver). It returns a schema-conformant `V2Extraction` that
 * `buildIRFromExtraction` validates against the catalogs.
 */

import { callAIStructured } from "@/lib/ai-client";
import { getTaggerTagContext } from "@/lib/tagger/context";
import { isAiPromptLoggingEnabled } from "@/lib/search-pipeline/debug";
import { buildExtractPrompt, V2_SYSTEM_PROMPT } from "@/lib/search-pipeline/v2/extractPrompt";
import { recognizeCardNames } from "@/lib/search-pipeline/v2/prePass";
import { V2_EXTRACTION_SCHEMA, V2_SCHEMA_NAME, type V2Extraction } from "@/lib/search-pipeline/v2/schema";

export type ExtractionOutcome = {
  extraction: V2Extraction;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
};

/**
 * Runs the structured extraction for a single (non-compound) query branch.
 * Throws on AI/transport failure so the orchestrator can fall back to V1.
 */
export async function extractQuery(query: string): Promise<ExtractionOutcome> {
  const recognizedCardNames = recognizeCardNames(query);
  const tagContext = await getTaggerTagContext(query);

  const user = buildExtractPrompt({
    query,
    recognizedCardNames,
    availableFunctionTags: tagContext.function,
    availableArtTags: tagContext.art,
  });

  if (isAiPromptLoggingEnabled()) {
    console.log(`[V2][Extract Prompt]\n${user}`);
  }

  const { data, usage } = await callAIStructured<V2Extraction>({
    system: V2_SYSTEM_PROMPT,
    user,
    schema: V2_EXTRACTION_SCHEMA,
    schemaName: V2_SCHEMA_NAME,
    max_output_tokens: 800,
  });

  if (isAiPromptLoggingEnabled()) {
    console.log(
      `[V2][Extract Usage] input=${usage.input_tokens} output=${usage.output_tokens} total=${usage.total_tokens}`
    );
    console.log(`[V2][Extract Result] ${JSON.stringify(data)}`);
  }

  return { extraction: data, usage };
}
