import { callAI } from "@/lib/ai-client";
import { getTaggerTagContext } from "@/lib/tagger/context";
import { buildResolverPrompt } from "@/lib/search-pipeline/phase2/buildResolverPrompt";
import { Phase2Result, ResolvedFragment, ResolverCategory, SearchPipelineIR } from "../types";

type ResolverResponseItem = {
  fragment?: string;
  tags?: string[];
  confidence?: number;
  archetype?: string | null;
  qualifier?: string | null;
};

type ResolverResponse = {
  results?: ResolverResponseItem[];
};

const MIN_CONFIDENCE = 0.35;

function shouldLogAiAgentPrompt(): boolean {
  const configured = process.env.LOG_AI_AGENT_PROMPT?.toLowerCase();
  if (configured === "true" || configured === "1") {
    return true;
  }
  if (configured === "false" || configured === "0") {
    return false;
  }
  return process.env.NODE_ENV !== "production";
}

function logAiTokenUsage(
  category: ResolverCategory,
  fragmentsCount: number,
  usage: { input_tokens: number; output_tokens: number; total_tokens: number }
): void {
  if (!shouldLogAiAgentPrompt()) return;
  console.log(
    `[Phase2][AI Usage] category=${category} fragments=${fragmentsCount} input_tokens=${usage.input_tokens} output_tokens=${usage.output_tokens} total_tokens=${usage.total_tokens}`
  );
}

const KNOWN_TAG_PREFIXES = /^(?:function|oracletag|otag|art|atag|arttag|artist|kw|o|t|type|c|id|f|set|is|mv|cmc|pow|tou|loy|year|r|rarity|banned|restricted|legal|format|game|prefer|order|direction|unique|new|not|-):/i;

function autoPrefix(tag: string): string | null {
  if (KNOWN_TAG_PREFIXES.test(tag)) return tag;
  if (/^"[^"]+"$/.test(tag)) return tag;
  const slug = tag.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!slug || slug.length < 3) return null;
  return `function:${slug}`;
}

function sanitizeTags(tags: string[]): string[] {
  const compact = tags
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .filter((tag) => !/[{}[\]]/.test(tag))
    .map((tag) => autoPrefix(tag))
    .filter((tag): tag is string => tag !== null);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const tag of compact) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(tag);
  }
  return deduped.slice(0, 4);
}

function parseResolverOutput(raw: string): ResolverResponse {
  const trimmed = raw.trim();
  const parsed = JSON.parse(trimmed) as ResolverResponse;
  return parsed;
}

async function runCategoryBatch(args: {
  category: ResolverCategory;
  fragments: string[];
  naturalQuery: string;
  availableArtTags: string[];
  availableFunctionTags: string[];
}): Promise<ResolvedFragment[]> {
  const prompt = buildResolverPrompt(args);
  if (shouldLogAiAgentPrompt()) {
    console.log(
      `[Phase2][AI Prompt] category=${args.category} fragments=${args.fragments.length}\n${prompt}`
    );
  }
  const response = await callAI({
    user: prompt,
    max_output_tokens: 800,
  });
  logAiTokenUsage(args.category, args.fragments.length, response.usage);

  const text = response.text || '{"results":[]}';
  const parsed = parseResolverOutput(text);
  const results: ResolvedFragment[] = [];
  for (const item of parsed.results || []) {
    const fragment = (item.fragment || "").trim();
    if (!fragment) continue;
    const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? 0)));

    const archetype = typeof item.archetype === "string" && item.archetype.trim()
      ? item.archetype.trim().toLowerCase()
      : undefined;
    const qualifier = typeof item.qualifier === "string" && item.qualifier.trim()
      ? item.qualifier.trim().toLowerCase()
      : undefined;

    results.push({
      fragment,
      category: args.category,
      tags: sanitizeTags(item.tags || []),
      confidence,
      archetype,
      qualifier,
    });
  }
  return results;
}

async function runSequentialFallback(args: {
  unresolved: Array<{ text: string; category: ResolverCategory }>;
  naturalQuery: string;
  availableArtTags: string[];
  availableFunctionTags: string[];
}): Promise<ResolvedFragment[]> {
  const resolved: ResolvedFragment[] = [];
  for (const fragment of args.unresolved) {
    const batch = await runCategoryBatch({
      category: fragment.category,
      fragments: [fragment.text],
      naturalQuery: args.naturalQuery,
      availableArtTags: args.availableArtTags,
      availableFunctionTags: args.availableFunctionTags,
    });
    resolved.push(...batch);
  }
  return resolved;
}

function groupByCategory(
  unresolved: Array<{ text: string; category: ResolverCategory }>
): Map<ResolverCategory, string[]> {
  const grouped = new Map<ResolverCategory, string[]>();
  for (const item of unresolved) {
    const existing = grouped.get(item.category) || [];
    existing.push(item.text);
    grouped.set(item.category, existing);
  }
  return grouped;
}

function isResolvedByArchetypeOrTags(entry: ResolvedFragment): boolean {
  return (entry.archetype != null && entry.archetype.length > 0) || entry.tags.length > 0;
}

function maskStrippedTerms(query: string, strippedTerms: string[]): string {
  let masked = query;
  for (const term of strippedTerms) {
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    masked = masked.replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ");
  }
  return masked.replace(/\s{2,}/g, " ").trim();
}

export async function resolveUnresolvedFragments(ir: SearchPipelineIR): Promise<Phase2Result> {
  if (ir.intent === "direct-scryfall" || ir.unresolvedFragments.length === 0) {
    return { ir, batchCalls: 0, sequentialCalls: 0 };
  }

  const tagContext = await getTaggerTagContext(ir.naturalQuery);
  const grouped = groupByCategory(ir.unresolvedFragments);
  const maskedQuery = maskStrippedTerms(ir.naturalQuery, ir.debug.strippedTerms);

  let batchCalls = 0;
  let sequentialCalls = 0;
  const firstPass: ResolvedFragment[] = [];

  for (const [category, fragments] of grouped.entries()) {
    batchCalls += 1;
    try {
      const resolved = await runCategoryBatch({
        category,
        fragments,
        naturalQuery: maskedQuery,
        availableArtTags: tagContext.art,
        availableFunctionTags: tagContext.function,
      });
      firstPass.push(...resolved);
    } catch (error) {
      console.warn(`[Phase2] Batch resolver failed for category ${category}`, error);
    }
  }

  const covered = new Set(firstPass.map((entry) => entry.fragment.toLowerCase()));
  const leftovers = ir.unresolvedFragments.filter((fragment) => {
    if (!covered.has(fragment.text.toLowerCase())) return true;
    const result = firstPass.find((entry) => entry.fragment.toLowerCase() === fragment.text.toLowerCase());
    return !result || (!isResolvedByArchetypeOrTags(result)) || result.confidence < MIN_CONFIDENCE;
  });

  let fallbackResults: ResolvedFragment[] = [];
  if (leftovers.length > 0) {
    sequentialCalls = leftovers.length;
    try {
      fallbackResults = await runSequentialFallback({
        unresolved: leftovers,
        naturalQuery: maskedQuery,
        availableArtTags: tagContext.art,
        availableFunctionTags: tagContext.function,
      });
    } catch (error) {
      console.warn("[Phase2] Sequential fallback failed", error);
    }
  }

  const merged = [...firstPass, ...fallbackResults]
    .filter((entry) => isResolvedByArchetypeOrTags(entry) && entry.confidence >= MIN_CONFIDENCE)
    .reduce<ResolvedFragment[]>((acc, current) => {
      const existing = acc.find((entry) => entry.fragment.toLowerCase() === current.fragment.toLowerCase());
      if (!existing) {
        acc.push(current);
        return acc;
      }
      if (current.confidence > existing.confidence) {
        existing.tags = current.tags;
        existing.confidence = current.confidence;
        existing.archetype = current.archetype;
        existing.qualifier = current.qualifier;
      }
      return acc;
    }, []);

  // Propagate the orConnected flag from unresolvedFragments so the assembly
  // phase knows which resolved fragments were joined by "or" in the original query.
  for (const resolved of merged) {
    const source = ir.unresolvedFragments.find(
      (f) => f.text.toLowerCase() === resolved.fragment.toLowerCase()
    );
    if (source?.orConnected) resolved.orConnected = true;
  }

  const nextIR: SearchPipelineIR = {
    ...ir,
    resolvedFragments: merged,
    debug: {
      ...ir.debug,
      aiBatchCalls: ir.debug.aiBatchCalls + batchCalls,
      aiSequentialCalls: ir.debug.aiSequentialCalls + sequentialCalls,
    },
  };

  return {
    ir: nextIR,
    batchCalls,
    sequentialCalls,
  };
}
