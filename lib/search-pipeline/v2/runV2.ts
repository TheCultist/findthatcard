/**
 * Search Pipeline V2 — orchestrator.
 *
 * Flow: pre-pass (direct-scryfall passthrough) → one AI extraction → catalog
 * validation into an IR → intent resolver → Phase 3 finalizer. Compound "or"
 * queries process each branch independently and OR-combine, mirroring the legacy
 * compound pipeline. Results are LRU-cached by normalized query.
 *
 * This module never falls back to the legacy pipeline itself — it throws on
 * failure and `runSearchPipeline` catches and degrades. Keeping fallback in one
 * place avoids an import cycle and keeps the failure policy explicit.
 */

import { ensureCatalogIndex } from "@/lib/scryfall/catalog-index";
import {
  EFFECTIVE_MAX_QUERY_LENGTH,
  isScryfallQuery,
  PREFER_BEST_PREFIX,
  truncateScryfallQuery,
} from "@/lib/scryfall/query-converter";
import { assembleQueryFromIR } from "@/lib/search-pipeline/assembleQuery";
import { splitCompoundQuery } from "@/lib/search-pipeline/compound";
import { isPipelineDebugEnabled } from "@/lib/search-pipeline/debug";
import { finalizeQuery } from "@/lib/search-pipeline/phase3/finalizeQuery";
import { resolveIntentClauses } from "@/lib/search-pipeline/resolveIntentClauses";
import type { SearchPipelineIR } from "@/lib/search-pipeline/types";
import { buildIRFromExtraction } from "@/lib/search-pipeline/v2/buildIR";
import { LruCache, normalizeCacheKey } from "@/lib/search-pipeline/v2/cache";
import { extractQuery } from "@/lib/search-pipeline/v2/extractIR";
import type { SearchPipelineResult } from "@/lib/search-pipeline/runSearchPipeline";

const extractionCache = new LruCache<SearchPipelineResult>();

const GAME_FILTER_RE = /\s*\bgame:\w+\b/gi;
const PREFER_BEST_RE = /^prefer:best\s+/i;

const NAMED_CARD_INTENTS = new Set(["similar-cards", "art-like-cards", "synergy-with-card"]);

export function buildDirectIR(query: string): SearchPipelineIR {
  return {
    naturalQuery: query,
    intent: "direct-scryfall",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [{ value: query.trim(), source: "phase1:direct" }],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [],
    debug: {
      strippedTerms: [],
      aiBatchCalls: 0,
      aiSequentialCalls: 0,
      invalidTagsRemoved: 0,
      phase0Normalized: false,
    },
  };
}

function logSummary(original: string, stages: Record<string, string>): void {
  if (!isPipelineDebugEnabled()) return;
  const lines = ["[Search Pipeline V2 Debug] Summary:", `  original: ${JSON.stringify(original)}`];
  for (const [k, v] of Object.entries(stages)) lines.push(`  ${k}: ${JSON.stringify(v)}`);
  console.log(lines.join("\n"));
}

export async function runSearchPipelineV2(naturalQuery: string): Promise<SearchPipelineResult> {
  await ensureCatalogIndex();

  const cacheKey = normalizeCacheKey(naturalQuery);
  const cached = extractionCache.get(cacheKey);
  if (cached) return cached;

  // Direct Scryfall syntax passes through untouched — never sent to the AI.
  if (isScryfallQuery(naturalQuery)) {
    const ir = buildDirectIR(naturalQuery);
    const phase3 = await finalizeQuery(ir);
    const result: SearchPipelineResult = {
      queryForScryfall: phase3.queryForScryfall,
      queryForLogs: phase3.queryForLogs,
      debug: emptyDebug(),
    };
    extractionCache.set(cacheKey, result);
    return result;
  }

  const branches = splitCompoundQuery(naturalQuery);
  const result =
    branches.length > 1
      ? (await runCompound(naturalQuery, branches)) ?? (await runSingle(naturalQuery))
      : await runSingle(naturalQuery);

  extractionCache.set(cacheKey, result);
  return result;
}

function emptyDebug(): SearchPipelineResult["debug"] {
  return {
    unresolvedFragments: 0,
    resolvedFragments: 0,
    aiBatchCalls: 0,
    aiSequentialCalls: 0,
    invalidTagsRemoved: 0,
    phase0Normalized: false,
  };
}

async function runSingle(query: string): Promise<SearchPipelineResult> {
  const { extraction } = await extractQuery(query);
  const ir = await buildIRFromExtraction(extraction, query);
  await resolveIntentClauses(ir);
  const phase3 = await finalizeQuery(ir);

  logSummary(query, {
    "after extraction": JSON.stringify(extraction),
    "after assembly": assembleQueryFromIR(ir),
    "after Phase 3": phase3.queryForScryfall,
  });

  return {
    queryForScryfall: phase3.queryForScryfall,
    queryForLogs: phase3.queryForLogs,
    debug: {
      ...emptyDebug(),
      unresolvedFragments: ir.unresolvedFragments.length,
      resolvedFragments: ir.resolvedFragments.length,
      aiBatchCalls: 1,
    },
  };
}

/**
 * Processes each compound branch through V2 and OR-combines them. Returns null
 * (so the caller falls back to single-query mode) when any branch resolves to a
 * named-card intent, which cannot be meaningfully OR-combined.
 */
async function runCompound(
  originalQuery: string,
  branches: string[]
): Promise<SearchPipelineResult | null> {
  const extractions = await Promise.all(branches.map((b) => extractQuery(b)));
  const irs = await Promise.all(
    extractions.map((e, i) => buildIRFromExtraction(e.extraction, branches[i]))
  );

  if (irs.some((ir) => NAMED_CARD_INTENTS.has(ir.intent))) return null;

  const phase3Results = await Promise.all(irs.map((ir) => finalizeQuery(ir)));

  const strippedBranches = phase3Results.map((p3) =>
    p3.queryForScryfall
      .replace(PREFER_BEST_RE, "")
      .replace(GAME_FILTER_RE, "")
      .replace(/\s{2,}/g, " ")
      .trim()
  );

  const orBody = strippedBranches.map((b) => `(${b})`).join(" or ");
  let compound = `(${orBody}) game:paper`;
  if (compound.length > EFFECTIVE_MAX_QUERY_LENGTH) {
    compound = truncateScryfallQuery(compound, EFFECTIVE_MAX_QUERY_LENGTH);
  }
  const queryForScryfall = `${PREFER_BEST_PREFIX}${compound}`.trim();

  logSummary(originalQuery, {
    "compound branches": branches.join(" | "),
    "after Phase 3": queryForScryfall,
  });

  return {
    queryForScryfall,
    queryForLogs: compound,
    debug: { ...emptyDebug(), aiBatchCalls: branches.length },
  };
}
