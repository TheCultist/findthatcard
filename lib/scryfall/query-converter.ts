import OpenAI from "openai";
import {
  getUserPrompt,
} from "@/lib/prompts";
import { buildSystemPrompt, selectPacks } from "@/lib/prompts/promptModules";
import { TaggerTagContext } from "@/lib/tagger/context";
import {
  expandStrategyTags,
  resolveStrategyName,
  STRATEGY_ORACLETAGS,
} from "@/lib/strategies/oracletagStrategies";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClient) {
    return openaiClient;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "The OPENAI_API_KEY environment variable is missing or empty."
    );
  }
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_SCRYFALL_QUERY_LENGTH = 400;
export const PREFER_BEST_PREFIX = "prefer:best "; // 12 characters
export const EFFECTIVE_MAX_QUERY_LENGTH =
  MAX_SCRYFALL_QUERY_LENGTH - PREFER_BEST_PREFIX.length; // 388 characters
const FORMAT_NAMES = [
  "legacy",
  "modern",
  "standard",
  "pioneer",
  "vintage",
  "pauper",
  "commander",
  "brawl",
] as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeFormatFunctionTags(query: string): string {
  return FORMAT_NAMES.reduce((acc, format) => {
    const pattern = new RegExp(`(^|\\s|\\()(-)?function:${format}\\b`, "gi");
    return acc.replace(pattern, (_match, prefix, negation) => {
      const negated = negation ? "-" : "";
      return `${prefix}${negated}f:${format}`;
    });
  }, query);
}

function pickLandTutorTag(
  naturalQuery: string,
  tagContext?: TaggerTagContext
): string | null {
  if (!tagContext?.function || tagContext.function.length === 0) {
    return null;
  }

  const query = naturalQuery.toLowerCase();
  if (!/\btutor\b/.test(query) || !/\blands?\b/.test(query)) {
    return null;
  }

  const candidates = tagContext.function.filter((tag) => {
    const lower = tag.toLowerCase();
    return lower.includes("tutor") && lower.includes("land");
  });

  if (candidates.length === 0) {
    return null;
  }

  const landTypes = ["forest", "island", "mountain", "plains", "swamp", "gate", "desert", "cave"];
  const keywords = [
    { word: "basic", weight: 2 },
    { word: "any", weight: 1 },
    { word: "snow", weight: 1 },
  ];

  let bestLand = candidates[0];
  let bestScore = -1;

  for (const tag of candidates) {
    const lower = tag.toLowerCase();
    let score = 0;

    for (const entry of keywords) {
      if (query.includes(entry.word) && lower.includes(entry.word)) {
        score += entry.weight;
      }
    }

    for (const landType of landTypes) {
      if (query.includes(landType) && lower.includes(landType)) {
        score += 2;
      }
    }

    if (score > bestScore || (score === bestScore && tag.length < bestLand.length)) {
      bestLand = tag;
      bestScore = score;
    }
  }

  return bestLand;
}

function buildStrategyCandidates(): string[] {
  const candidates: string[] = [];
  for (const entry of STRATEGY_ORACLETAGS) {
    candidates.push(entry.strategy);
    for (const alias of entry.aliases || []) {
      candidates.push(alias);
    }
  }
  return candidates;
}

function detectStrategies(naturalQuery: string): string[] {
  const query = naturalQuery.toLowerCase();
  const found = new Set<string>();
  for (const candidate of buildStrategyCandidates()) {
    const normalized = candidate.toLowerCase();
    const isWordy = /^[a-z0-9 ]+$/.test(normalized);
    if (isWordy) {
      const pattern = new RegExp(`\\b${escapeRegex(normalized).replace(/ +/g, "\\s+")}\\b`, "i");
      if (pattern.test(naturalQuery)) {
        found.add(candidate);
      }
    } else if (query.includes(normalized)) {
      found.add(candidate);
    }
  }
  const resolved = new Set<string>();
  for (const entry of found) {
    const canonical = resolveStrategyName(entry) || entry;
    resolved.add(canonical);
  }
  return Array.from(resolved);
}

function appendStrategyTags(query: string, naturalQuery: string): string {
  const detected = detectStrategies(naturalQuery);
  if (detected.length === 0) {
    return query;
  }

  const queryLower = query.toLowerCase();
  const missing = detected.filter(
    (strategy) => !queryLower.includes(`strategy:${strategy.toLowerCase()}`)
  );

  if (missing.length === 0) {
    return query;
  }

  const strategyTokens = missing.map((strategy) => {
    return /[^\w]/.test(strategy)
      ? `strategy:"${strategy}"`
      : `strategy:${strategy}`;
  });

  return `${query} ${strategyTokens.join(" ")}`.trim();
}

export function finalizeScryfallQuery(args: {
  naturalQuery: string;
  rawQuery: string;
  tagContext?: TaggerTagContext;
  maxLength?: number;
}): string {
  const {
    naturalQuery,
    rawQuery,
    tagContext,
    maxLength = EFFECTIVE_MAX_QUERY_LENGTH,
  } = args;

  // Clean up any markdown code blocks if the model adds them
  const cleanedQuery = rawQuery
    .replace(/^```[\w]*\n?/g, "")
    .replace(/```$/g, "")
    .trim();
  const queryWithStrategies = appendStrategyTags(cleanedQuery, naturalQuery);
  const expandedQuery = expandStrategyTags(queryWithStrategies);
  let normalizedQuery = normalizeFormatFunctionTags(expandedQuery);

  const landTutorTag = pickLandTutorTag(naturalQuery, tagContext);
  if (landTutorTag) {
    if (/\bfunction:tutor\b(?!-)/i.test(normalizedQuery)) {
      normalizedQuery = normalizedQuery.replace(
        /\bfunction:tutor\b(?!-)/gi,
        `function:${landTutorTag}`
      );
    }

    const toHandTag =
      tagContext?.function.find((tag) => tag === "tutor-to-hand") ||
      tagContext?.function.find((tag) => tag === "tutor-hand");
    const toBattlefieldTag = tagContext?.function.find(
      (tag) => tag === "tutor-to-battlefield"
    );

    const wantsHand = /\bhand\b/i.test(naturalQuery);
    const wantsBattlefield = /\b(battlefield|into play|onto the battlefield)\b/i.test(
      naturalQuery
    );
    const hasOr = /\bor\b/i.test(normalizedQuery);

    if (wantsHand && toHandTag) {
      const hasLandTag = new RegExp(`\\bfunction:${landTutorTag}\\b`, "i").test(
        normalizedQuery
      );
      const hasToHandTag = new RegExp(`\\bfunction:${toHandTag}\\b`, "i").test(
        normalizedQuery
      );
      if (hasOr || !hasLandTag || !hasToHandTag) {
        const additions: string[] = [];
        if (!hasLandTag) {
          additions.push(`function:${landTutorTag}`);
        }
        if (!hasToHandTag) {
          additions.push(`function:${toHandTag}`);
        }
        if (additions.length > 0) {
          normalizedQuery = `${normalizedQuery} ${additions.join(" ")}`.trim();
        }
      }
    } else if (wantsBattlefield && toBattlefieldTag) {
      const hasLandTag = new RegExp(`\\bfunction:${landTutorTag}\\b`, "i").test(
        normalizedQuery
      );
      const hasToBattlefieldTag = new RegExp(
        `\\bfunction:${toBattlefieldTag}\\b`,
        "i"
      ).test(normalizedQuery);
      if (hasOr || !hasLandTag || !hasToBattlefieldTag) {
        const additions: string[] = [];
        if (!hasLandTag) {
          additions.push(`function:${landTutorTag}`);
        }
        if (!hasToBattlefieldTag) {
          additions.push(`function:${toBattlefieldTag}`);
        }
        if (additions.length > 0) {
          normalizedQuery = `${normalizedQuery} ${additions.join(" ")}`.trim();
        }
      }
    }
  }

  if (!normalizedQuery) {
    throw new Error("Failed to generate Scryfall query (empty response)");
  }

  // Validate parentheses are balanced
  const openParens = (normalizedQuery.match(/\(/g) || []).length;
  const closeParens = (normalizedQuery.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    console.warn(
      `[OpenAI] Generated query has unbalanced parentheses (${openParens} open, ${closeParens} close): "${normalizedQuery}"`
    );
    // Try to fix by adding missing closing parentheses
    const fixedQuery = normalizedQuery + ")".repeat(openParens - closeParens);
    console.warn(
      `[OpenAI] Attempting to fix by adding closing parentheses: "${fixedQuery}"`
    );
    // Only use fixed query if it's still under the limit (accounting for prefer:best prefix)
    if (fixedQuery.length <= maxLength) {
      return fixedQuery;
    }
    // If fixed query is too long, throw error to trigger regeneration
    throw new Error(
      "Generated query has unbalanced parentheses and cannot be automatically fixed"
    );
  }

  // Validate length - truncate if necessary (accounting for prefer:best prefix)
  if (normalizedQuery.length > maxLength) {
    console.warn(
      `[OpenAI] Generated query exceeds ${maxLength} characters (${normalizedQuery.length}), truncating...`
    );
    return truncateScryfallQuery(normalizedQuery, maxLength);
  }

  return normalizedQuery;
}

/**
 * Truncates a Scryfall query to the maximum allowed length, trying to preserve word boundaries
 */
export function truncateScryfallQuery(
  query: string,
  maxLength: number = MAX_SCRYFALL_QUERY_LENGTH
): string {
  if (query.length <= maxLength) {
    return query;
  }

  let truncated = query.substring(0, maxLength).trim();
  // Try to truncate at a word boundary if possible (within 90% of max length)
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.9) {
    truncated = truncated.substring(0, lastSpace).trim();
  }

  return truncated;
}

/**
 * Checks if a query looks like a Scryfall query (contains operators like :, t:, c:, art:, etc.)
 * Only matches actual Scryfall operators, not just any word followed by a colon
 */
export function isScryfallQuery(query: string): boolean {
  const trimmed = query.trim();

  // List of known Scryfall operators (common ones)
  // These must be complete words immediately followed by a colon
  // This ensures "function tag:" doesn't match, but "function:" does
  const scryfallOperators = [
    "t:",
    "type:",
    "c:",
    "color:",
    "cmc:",
    "mana:",
    "m:",
    "power:",
    "p:",
    "toughness:",
    "loyalty:",
    "oracle:",
    "o:",
    "kw:",
    "keyword:",
    "art:",
    "atag:",
    "arttag:",
    "function:",
    "otag:",
    "oracletag:",
    "set:",
    "s:",
    "rarity:",
    "r:",
    "is:",
    "in:",
    "not:",
    "format:",
    "game:",
    "border:",
    "frame:",
    "lang:",
    "foil:",
    "promo:",
    "date:",
    "year:",
    "artist:",
    "watermark:",
    "banned:",
    "legal:",
    "id:",
    "id=",
    "name:",
    "number:",
    "block:",
    "set-type:",
  ];

  // Check if the query contains any Scryfall operator
  // Pattern: word boundary + operator word + colon (colon must immediately follow the word)
  // This ensures "function tag:" doesn't match because there's a space before "tag:"
  for (const operator of scryfallOperators) {
    // Escape special regex characters in the operator
    const escapedOperator = operator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match: word boundary + operator (colon must immediately follow, no space)
    const pattern = new RegExp(`\\b${escapedOperator}`, "i");
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

/**
 * Converts natural language query to Scryfall query string using OpenAI
 */
export async function convertToScryfallQuery(
  naturalQuery: string,
  regenerationPrompt?: string,
  tagContext?: TaggerTagContext,
  isRetry: boolean = false
): Promise<string> {
  // If it's already a Scryfall query, validate length and return it
  // Account for "prefer:best " prefix (12 characters)
  if (isScryfallQuery(naturalQuery)) {
    const trimmed = naturalQuery.trim();
    if (trimmed.length > EFFECTIVE_MAX_QUERY_LENGTH) {
      throw new Error(
        `Scryfall query exceeds maximum length of ${EFFECTIVE_MAX_QUERY_LENGTH} characters (${MAX_SCRYFALL_QUERY_LENGTH} total including "prefer:best " prefix). Please shorten your query.`
      );
    }
    return trimmed;
  }

  const userPrompt = regenerationPrompt || getUserPrompt(naturalQuery, tagContext);
  const systemPrompt = buildSystemPrompt(naturalQuery);

  // Log selected packs and prompt length in dev
  if (process.env.NODE_ENV === "development") {
    const selectedPacks = selectPacks(naturalQuery);
    console.log(`[OpenAI] Selected packs: ${selectedPacks.join(", ")}`);
    console.log(`[OpenAI] System prompt length: ${systemPrompt.length} chars`);
  }

  let query = "";
  try {
    const isGpt5 = OPENAI_MODEL.startsWith("gpt-5");

    if (isGpt5) {
      // Use Responses API for reasoning models (gpt-5-mini, gpt-5, etc.)
      // Use "low" effort for economical token usage - this is a relatively simple conversion task
      const completion = await getOpenAIClient().responses.create({
        model: OPENAI_MODEL,
        reasoning: {
          effort: "low", // Low effort balances speed and cost efficiency for query conversion
        },
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_output_tokens: 3000, // Reasonable limit: 388 char query + reasoning overhead
      });

      // Log response structure in dev for debugging
      if (process.env.NODE_ENV === "development") {
        console.log(`[OpenAI] Response structure (Responses API):`, {
          status: completion.status,
          outputLength: completion.output?.length,
          outputText: completion.output_text,
          usage: completion.usage,
          reasoningTokens: completion.usage?.output_tokens_details?.reasoning_tokens,
        });
      }

      // Handle incomplete responses
      if (completion.status === "incomplete") {
        const reason = completion.incomplete_details?.reason;
        if (reason === "max_output_tokens") {
          if (completion.output_text && completion.output_text.length > 0) {
            // Partial output available, use it
            query = completion.output_text.trim();
            console.warn(
              `[OpenAI] Response incomplete due to max_output_tokens, using partial output`
            );
          } else {
            // Ran out of tokens during reasoning, no output
            throw new Error(
              `Failed to generate Scryfall query: ran out of tokens during reasoning. Consider increasing max_output_tokens or simplifying the query.`
            );
          }
        } else {
          throw new Error(
            `Failed to generate Scryfall query: incomplete response (reason: ${reason})`
          );
        }
      } else {
        query = completion.output_text?.trim() || "";
      }
    } else {
      // Use Chat Completions API for non-reasoning models
      const completion = await getOpenAIClient().chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        stream: false,
        max_tokens: 1500,
      });

      // Log response structure in dev for debugging
      if (process.env.NODE_ENV === "development") {
        console.log(`[OpenAI] Response structure (Chat Completions):`, {
          choicesLength: completion.choices?.length,
          firstChoice: completion.choices?.[0],
          finishReason: completion.choices?.[0]?.finish_reason,
        });
      }

      query = completion.choices[0]?.message?.content?.trim() || "";
    }

    return finalizeScryfallQuery({
      naturalQuery,
      rawQuery: query,
      tagContext,
      maxLength: EFFECTIVE_MAX_QUERY_LENGTH,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("empty response")) {
      console.error(`[OpenAI] ${error.message}`, {
        model: OPENAI_MODEL,
        isGpt5: OPENAI_MODEL.startsWith("gpt-5"),
        rawQuery: query,
      });
    }
    // Log detailed error information
    if (process.env.NODE_ENV === "development") {
      console.error("[OpenAI] API call error details:", {
        model: OPENAI_MODEL,
        isGpt5: OPENAI_MODEL.startsWith("gpt-5"),
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : error,
      });
    }

    // If it's a validation error (unbalanced parentheses) and we haven't retried yet, try regenerating once
    if (!isRetry && error instanceof Error && error.message.includes("unbalanced parentheses")) {
      console.warn("[OpenAI] Query had unbalanced parentheses, attempting regeneration...");
      try {
        const retryPrompt = regenerationPrompt || getUserPrompt(naturalQuery, tagContext);
        const retryPromptWithFix = `${retryPrompt}\n\nIMPORTANT: The previous attempt had unbalanced parentheses. Please ensure all parentheses are properly closed and use the simplest possible query.`;
        return await convertToScryfallQuery(
          naturalQuery,
          retryPromptWithFix,
          tagContext,
          true
        );
      } catch (retryError) {
        console.error("[OpenAI] Retry also failed:", retryError);
        throw error; // Throw original error
      }
    }

    // Re-throw API errors with more context
    if (error instanceof Error) {
      console.error("OpenAI API error:", error.message);
      throw error;
    }

    console.error("OpenAI API error:", error);
    throw new Error("Failed to convert query. Please try again.");
  }
}
