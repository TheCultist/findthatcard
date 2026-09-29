/**
 * Search Pipeline V2 — the single AI extraction call.
 *
 * One `callAIStructured` invocation replaces the legacy Phase 0 (normalize),
 * Phase 1 (regex detectors), Phase 1.5 (numeric/rarity extraction) and Phase 2
 * (fragment resolver). It returns a (possibly partial) `V2Extraction` that
 * `buildIRFromExtraction` normalizes and validates against the catalogs.
 */

import { callAIStructured, getActiveProvider } from "@/lib/ai-client";
import { getTaggerTagContext } from "@/lib/tagger/context";
import { isAiPromptLoggingEnabled } from "@/lib/search-pipeline/debug";
import { buildExtractPrompt, buildExtractSystemPrompt } from "@/lib/search-pipeline/v2/extractPrompt";
import { recognizeCardNames } from "@/lib/search-pipeline/v2/prePass";
import {
  V2_EXTRACTION_SCHEMA,
  V2_EXTRACTION_SCHEMA_STRICT,
  V2_SCHEMA_NAME,
  type V2Extraction,
} from "@/lib/search-pipeline/v2/schema";

export type ExtractionOutcome = {
  extraction: Partial<V2Extraction>;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
};

// The static prompt (rules + examples + archetype menu) never changes between
// queries; build it once per process.
let systemPrompt: string | null = null;

/**
 * Runs the structured extraction for a single (non-compound) query branch.
 * Throws on AI/transport failure.
 */
export async function extractQuery(query: string): Promise<ExtractionOutcome> {
  const recognizedCardNames = recognizeCardNames(query);
  const tagContext = await getTaggerTagContext(query);

  systemPrompt ??= buildExtractSystemPrompt();
  const user = buildExtractPrompt({
    query,
    recognizedCardNames,
    availableFunctionTags: tagContext.function,
    availableArtTags: tagContext.art,
  });

  if (isAiPromptLoggingEnabled()) {
    console.log(`[V2][Extract Prompt]\n${user}`);
  }

  const { data, usage } = await callAIStructured<Partial<V2Extraction>>({
    system: systemPrompt,
    user,
    // OpenAI strict mode needs every property required; Claude tool use does not,
    // and the relaxed schema saves ~300 output tokens of empty scaffolding per call.
    schema: getActiveProvider() === "openai" ? V2_EXTRACTION_SCHEMA_STRICT : V2_EXTRACTION_SCHEMA,
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
