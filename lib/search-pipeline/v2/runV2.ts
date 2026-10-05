/**
 * Search Pipeline V2 — orchestrator.
 *
 * Flow: pre-pass (direct-scryfall passthrough) → one AI extraction → catalog
 * validation into an IR → intent resolver → Phase 3 finalizer. Compound "or"
 * queries process each branch independently and OR-combine, mirroring the legacy
 * compound pipeline. Results are LRU-cached by normalized query (except degraded
 * resolver fallbacks); identical in-flight queries share one run.
 *
 * Failures throw; the search route logs them and answers with a generic error.
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
const inFlight = new Map<string, Promise<SearchPipelineResult>>();

const GAME_FILTER_RE = /\s*\bgame:\w+\b/gi;
const PREFER_BEST_RE = /^prefer:best\s+/i;

const NAMED_CARD_INTENTS = new Set(["similar-cards", "art-like-cards", "synergy-with-card"]);

const MAX_COMPOUND_BRANCHES = 4;
const COMPOUND_WRAPPER_LENGTH = "() game:paper".length;

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

  // Identical queries arriving together (double submit, a shared link) share one AI call.
  let pending = inFlight.get(cacheKey);
  if (!pending) {
    pending = runUncached(naturalQuery).finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, pending);
  }
  const result = await pending;
  if (!result.degraded) extractionCache.set(cacheKey, result);
  return result;
}

async function runUncached(naturalQuery: string): Promise<SearchPipelineResult> {
  // Direct Scryfall syntax passes through untouched — never sent to the AI.
  if (isScryfallQuery(naturalQuery)) {
    const ir = buildDirectIR(naturalQuery);
    const phase3 = await finalizeQuery(ir);
    return {
      queryForScryfall: phase3.queryForScryfall,
      queryForLogs: phase3.queryForLogs,
      debug: emptyDebug(),
    };
  }

  const branches = splitCompoundQuery(naturalQuery);
  // Each branch is its own AI call; past the cap the whole query goes to one extraction.
  return branches.length > 1 && branches.length <= MAX_COMPOUND_BRANCHES
    ? (await runCompound(naturalQuery, branches)) ?? (await runSingle(naturalQuery))
    : runSingle(naturalQuery);
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
    degraded: ir.debug.degraded,
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

  // Truncate the OR body, not the whole string, so the wrapper and game filter always survive.
  const orBody = strippedBranches.map((b) => `(${b})`).join(" or ");
  const compound = `(${truncateScryfallQuery(orBody, EFFECTIVE_MAX_QUERY_LENGTH - COMPOUND_WRAPPER_LENGTH)}) game:paper`;
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
