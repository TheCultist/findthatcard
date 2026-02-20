import OpenAI from "openai";
import { getTaggerTagContext } from "@/lib/tagger/context";
import { buildResolverPrompt } from "@/lib/search-pipeline/phase2/buildResolverPrompt";
import { Phase2Result, ResolvedFragment, ResolverCategory, SearchPipelineIR } from "../types";

type ResolverResponse = {
  results?: Array<{
    fragment?: string;
    tags?: string[];
    confidence?: number;
  }>;
};

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MIN_CONFIDENCE = 0.35;

let openaiClient: OpenAI | null = null;

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
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  } | null
): void {
  if (!shouldLogAiAgentPrompt()) {
    return;
  }
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const total = usage?.total_tokens ?? input + output;
  console.log(
    `[Phase2][AI Usage] category=${category} fragments=${fragmentsCount} input_tokens=${input} output_tokens=${output} total_tokens=${total}`
  );
}

function getOpenAIClient(): OpenAI {
  if (openaiClient) return openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
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
  availableArtTags: string[];
  availableFunctionTags: string[];
}): Promise<ResolvedFragment[]> {
  const prompt = buildResolverPrompt(args);
  if (shouldLogAiAgentPrompt()) {
    console.log(
      `[Phase2][AI Prompt] category=${args.category} fragments=${args.fragments.length}\n${prompt}`
    );
  }
  const response = await getOpenAIClient().responses.create({
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    input: [{ role: "user", content: prompt }],
    max_output_tokens: 800,
  });
  logAiTokenUsage(args.category, args.fragments.length, response.usage);

  const text = response.output_text?.trim() || '{"results":[]}';
  const parsed = parseResolverOutput(text);
  const results: ResolvedFragment[] = [];
  for (const item of parsed.results || []) {
    const fragment = (item.fragment || "").trim();
    if (!fragment) continue;
    const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? 0)));
    results.push({
      fragment,
      category: args.category,
      tags: sanitizeTags(item.tags || []),
      confidence,
    });
  }
  return results;
}

async function runSequentialFallback(args: {
  unresolved: Array<{ text: string; category: ResolverCategory }>;
  availableArtTags: string[];
  availableFunctionTags: string[];
}): Promise<ResolvedFragment[]> {
  const resolved: ResolvedFragment[] = [];
  for (const fragment of args.unresolved) {
    const batch = await runCategoryBatch({
      category: fragment.category,
      fragments: [fragment.text],
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

export async function resolveUnresolvedFragments(ir: SearchPipelineIR): Promise<Phase2Result> {
  if (ir.intent === "direct-scryfall" || ir.unresolvedFragments.length === 0) {
    return { ir, batchCalls: 0, sequentialCalls: 0 };
  }

  const tagContext = await getTaggerTagContext(ir.naturalQuery);
  const grouped = groupByCategory(ir.unresolvedFragments);

  let batchCalls = 0;
  let sequentialCalls = 0;
  const firstPass: ResolvedFragment[] = [];

  for (const [category, fragments] of grouped.entries()) {
    batchCalls += 1;
    try {
      const resolved = await runCategoryBatch({
        category,
        fragments,
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
    return !result || result.tags.length === 0 || result.confidence < MIN_CONFIDENCE;
  });

  let fallbackResults: ResolvedFragment[] = [];
  if (leftovers.length > 0) {
    sequentialCalls = leftovers.length;
    try {
      fallbackResults = await runSequentialFallback({
        unresolved: leftovers,
        availableArtTags: tagContext.art,
        availableFunctionTags: tagContext.function,
      });
    } catch (error) {
      console.warn("[Phase2] Sequential fallback failed", error);
    }
  }

  const merged = [...firstPass, ...fallbackResults]
    .filter((entry) => entry.tags.length > 0 && entry.confidence >= MIN_CONFIDENCE)
    .reduce<ResolvedFragment[]>((acc, current) => {
      const existing = acc.find((entry) => entry.fragment.toLowerCase() === current.fragment.toLowerCase());
      if (!existing) {
        acc.push(current);
        return acc;
      }
      if (current.confidence > existing.confidence) {
        existing.tags = current.tags;
        existing.confidence = current.confidence;
      }
      return acc;
    }, []);

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

