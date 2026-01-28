import OpenAI from "openai";
import {
  SCRYFALL_QUERY_CONVERTER_SYSTEM_PROMPT,
  getUserPrompt,
} from "@/lib/prompts";
import { TaggerTagContext } from "@/lib/tagger/context";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_SCRYFALL_QUERY_LENGTH = 400;
export const PREFER_BEST_PREFIX = "prefer:best "; // 12 characters
export const EFFECTIVE_MAX_QUERY_LENGTH =
  MAX_SCRYFALL_QUERY_LENGTH - PREFER_BEST_PREFIX.length; // 388 characters

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

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: SCRYFALL_QUERY_CONVERTER_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 200,
    });

    const query = completion.choices[0]?.message?.content?.trim() || "";

    // Clean up any markdown code blocks if the model adds them
    const cleanedQuery = query.replace(/^```[\w]*\n?/g, "").replace(/```$/g, "").trim();

    if (!cleanedQuery) {
      throw new Error("Failed to generate Scryfall query");
    }

    // Validate parentheses are balanced
    const openParens = (cleanedQuery.match(/\(/g) || []).length;
    const closeParens = (cleanedQuery.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
      console.warn(
        `[OpenAI] Generated query has unbalanced parentheses (${openParens} open, ${closeParens} close): "${cleanedQuery}"`
      );
      // Try to fix by adding missing closing parentheses
      const fixedQuery = cleanedQuery + ")".repeat(openParens - closeParens);
      console.warn(
        `[OpenAI] Attempting to fix by adding closing parentheses: "${fixedQuery}"`
      );
      // Only use fixed query if it's still under the limit (accounting for prefer:best prefix)
      if (fixedQuery.length <= EFFECTIVE_MAX_QUERY_LENGTH) {
        return fixedQuery;
      }
      // If fixed query is too long, throw error to trigger regeneration
      throw new Error(
        "Generated query has unbalanced parentheses and cannot be automatically fixed"
      );
    }

    // Validate length - truncate if necessary (accounting for prefer:best prefix)
    if (cleanedQuery.length > EFFECTIVE_MAX_QUERY_LENGTH) {
      console.warn(
        `[OpenAI] Generated query exceeds ${EFFECTIVE_MAX_QUERY_LENGTH} characters (${cleanedQuery.length}), truncating...`
      );
      return truncateScryfallQuery(cleanedQuery, EFFECTIVE_MAX_QUERY_LENGTH);
    }

    return cleanedQuery;
  } catch (error) {
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

    console.error("OpenAI API error:", error);
    throw new Error("Failed to convert query. Please try again.");
  }
}
