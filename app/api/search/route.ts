import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import {
  validateNaturalQuery,
  transformScryfallResponse,
  formatErrorMessage,
  validateTaggerTags,
  getTaggerTagContext,
  TaggerTagContext
} from "@/lib/utils";
import { SearchRequest, SearchResponse, ErrorResponse, ScryfallSearchResponse, ScryfallError } from "@/types/scryfall";
import { SCRYFALL_QUERY_CONVERTER_SYSTEM_PROMPT, getUserPrompt, getRegenerationPrompt } from "@/lib/prompts";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SCRYFALL_BASE_URL = "https://api.scryfall.com";
const SCRYFALL_USER_AGENT = process.env.SCRYFALL_USER_AGENT || "find-that-card/1.0 (+https://findthat.card)";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_SCRYFALL_QUERY_LENGTH = 400;
const PREFER_BEST_PREFIX = "prefer:best "; // 12 characters
const EFFECTIVE_MAX_QUERY_LENGTH = MAX_SCRYFALL_QUERY_LENGTH - PREFER_BEST_PREFIX.length; // 388 characters

/**
 * Truncates a Scryfall query to the maximum allowed length, trying to preserve word boundaries
 */
function truncateScryfallQuery(query: string, maxLength: number = MAX_SCRYFALL_QUERY_LENGTH): string {
  if (query.length <= maxLength) {
    return query;
  }
  
  let truncated = query.substring(0, maxLength).trim();
  // Try to truncate at a word boundary if possible (within 90% of max length)
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.9) {
    truncated = truncated.substring(0, lastSpace).trim();
  }
  
  return truncated;
}

/**
 * Checks if a query looks like a Scryfall query (contains operators like :, t:, c:, art:, etc.)
 * Only matches actual Scryfall operators, not just any word followed by a colon
 */
function isScryfallQuery(query: string): boolean {
  const trimmed = query.trim();
  
  // List of known Scryfall operators (common ones)
  // These must be complete words immediately followed by a colon
  // This ensures "function tag:" doesn't match, but "function:" does
  const scryfallOperators = [
    't:', 'type:', 'c:', 'color:', 'cmc:', 'mana:', 'm:',
    'power:', 'p:', 'toughness:', 'loyalty:', 'oracle:', 'o:',
    'art:', 'atag:', 'arttag:', 'function:', 'otag:', 'oracletag:',
    'set:', 's:', 'rarity:', 'r:', 'is:', 'in:', 'not:', 'format:',
    'game:', 'border:', 'frame:', 'lang:', 'foil:', 'promo:',
    'date:', 'year:', 'artist:', 'watermark:', 'banned:', 'legal:',
    'id:', 'name:', 'number:', 'block:', 'set-type:'
  ];
  
  // Check if the query contains any Scryfall operator
  // Pattern: word boundary + operator word + colon (colon must immediately follow the word)
  // This ensures "function tag:" doesn't match because there's a space before "tag:"
  for (const operator of scryfallOperators) {
    // Escape special regex characters in the operator
    const escapedOperator = operator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match: word boundary + operator (colon must immediately follow, no space)
    const pattern = new RegExp(`\\b${escapedOperator}`, 'i');
    if (pattern.test(trimmed)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Converts natural language query to Scryfall query string using OpenAI
 */
async function convertToScryfallQuery(
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
      throw new Error(`Scryfall query exceeds maximum length of ${EFFECTIVE_MAX_QUERY_LENGTH} characters (${MAX_SCRYFALL_QUERY_LENGTH} total including "prefer:best " prefix). Please shorten your query.`);
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
    const cleanedQuery = query
      .replace(/^```[\w]*\n?/g, "")
      .replace(/```$/g, "")
      .trim();

    if (!cleanedQuery) {
      throw new Error("Failed to generate Scryfall query");
    }

    // Validate parentheses are balanced
    const openParens = (cleanedQuery.match(/\(/g) || []).length;
    const closeParens = (cleanedQuery.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
      console.warn(`[OpenAI] Generated query has unbalanced parentheses (${openParens} open, ${closeParens} close): "${cleanedQuery}"`);
      // Try to fix by adding missing closing parentheses
      const fixedQuery = cleanedQuery + ')'.repeat(openParens - closeParens);
      console.warn(`[OpenAI] Attempting to fix by adding closing parentheses: "${fixedQuery}"`);
      // Only use fixed query if it's still under the limit (accounting for prefer:best prefix)
      if (fixedQuery.length <= EFFECTIVE_MAX_QUERY_LENGTH) {
        return fixedQuery;
      }
      // If fixed query is too long, throw error to trigger regeneration
      throw new Error("Generated query has unbalanced parentheses and cannot be automatically fixed");
    }

      // Validate length - truncate if necessary (accounting for prefer:best prefix)
      if (cleanedQuery.length > EFFECTIVE_MAX_QUERY_LENGTH) {
        console.warn(`[OpenAI] Generated query exceeds ${EFFECTIVE_MAX_QUERY_LENGTH} characters (${cleanedQuery.length}), truncating...`);
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
          return await convertToScryfallQuery(naturalQuery, retryPromptWithFix, tagContext, true);
        } catch (retryError) {
          console.error("[OpenAI] Retry also failed:", retryError);
          throw error; // Throw original error
        }
      }
      
      console.error("OpenAI API error:", error);
      throw new Error("Failed to convert query. Please try again.");
    }
}

const CARDS_PER_PAGE = 60;

/**
 * Calculates which Scryfall page to fetch and the offset within that page
 * Since Scryfall returns ~175 cards per page and we want 60 per page:
 * - Our page 1 = Scryfall page 1, offset 0
 * - Our page 2 = Scryfall page 1, offset 60
 * - Our page 3 = Scryfall page 2, offset 0 (approximately)
 */
function calculateScryfallPage(ourPage: number): { scryfallPage: number; offset: number } {
  // Scryfall returns approximately 175 cards per page
  const SCRYFALL_CARDS_PER_PAGE = 175;
  const totalOffset = (ourPage - 1) * CARDS_PER_PAGE;
  const scryfallPage = Math.floor(totalOffset / SCRYFALL_CARDS_PER_PAGE) + 1;
  const offset = totalOffset % SCRYFALL_CARDS_PER_PAGE;
  return { scryfallPage, offset };
}

/**
 * Executes Scryfall search
 * May fetch multiple Scryfall pages if needed to get 60 cards
 */
async function searchScryfall(query: string, page: number = 1): Promise<{ response: ScryfallSearchResponse; offset: number }> {
  const { scryfallPage, offset } = calculateScryfallPage(page);
  
  // Add prefer:best to the query (12 characters: "prefer:best ")
  const queryWithPrefer = `prefer:best ${query}`;
  
  const url = new URL(`${SCRYFALL_BASE_URL}/cards/search`);
  url.searchParams.set("q", queryWithPrefer);
  url.searchParams.set("unique", "cards");
  url.searchParams.set("page", scryfallPage.toString());

  console.log(`[Scryfall] Executing search with query: "${queryWithPrefer}" (our page ${page} -> Scryfall page ${scryfallPage}, offset ${offset})`);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent": SCRYFALL_USER_AGENT,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorData: ScryfallError = await response.json().catch(() => ({
        object: "error",
        code: "unknown",
        status: response.status,
        details: response.statusText,
      }));

      throw new Error(
        errorData.details || `Scryfall API error: ${response.statusText}`
      );
    }

    const data: ScryfallSearchResponse = await response.json();
    
    // Check if we need to fetch more cards from the next Scryfall page
    const cardsAvailable = data.data.length - offset;
    if (cardsAvailable < CARDS_PER_PAGE && data.has_more) {
      // Fetch the next Scryfall page to get remaining cards
      const nextPageUrl = new URL(`${SCRYFALL_BASE_URL}/cards/search`);
      nextPageUrl.searchParams.set("q", queryWithPrefer);
      nextPageUrl.searchParams.set("unique", "cards");
      nextPageUrl.searchParams.set("page", (scryfallPage + 1).toString());
      
      const nextResponse = await fetch(nextPageUrl.toString(), {
        headers: {
          "User-Agent": SCRYFALL_USER_AGENT,
          Accept: "application/json",
        },
      });
      
      if (nextResponse.ok) {
        const nextData: ScryfallSearchResponse = await nextResponse.json();
        // Combine cards from both pages
        const combinedData: ScryfallSearchResponse = {
          ...data,
          data: [...data.data, ...nextData.data],
        };
        return { response: combinedData, offset };
      }
    }
    
    return { response: data, offset };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to search Scryfall");
  }
}

/**
 * POST /api/search
 */
export async function POST(request: NextRequest) {
  try {
    // Validate API key
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json<ErrorResponse>(
        { error: "OpenAI API key is not configured" },
        { status: 500 }
      );
    }

    // Parse and validate request body
    let body: SearchRequest;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json<ErrorResponse>(
        { error: "Invalid JSON in request body" },
        { status: 400 }
      );
    }

    const validation = validateNaturalQuery(body.naturalQuery);
    if (!validation.valid) {
      return NextResponse.json<ErrorResponse>(
        { error: validation.error || "Invalid query" },
        { status: 400 }
      );
    }

    // Get page number (default to 1)
    const page = Math.max(1, body.page || 1);

    // Convert natural language to Scryfall query
    let scryfallQuery: string | undefined;
    let tagValidationError: string | undefined;
    let tagContext: TaggerTagContext | undefined;
    
    // Check if the user entered a direct Scryfall query
    const isDirectScryfallQuery = isScryfallQuery(body.naturalQuery);
    
    try {
      tagContext = isDirectScryfallQuery ? undefined : await getTaggerTagContext(body.naturalQuery);
      scryfallQuery = await convertToScryfallQuery(body.naturalQuery, undefined, tagContext);
      
      // Validate and truncate Scryfall query length (accounting for prefer:best prefix)
      if (scryfallQuery.length > EFFECTIVE_MAX_QUERY_LENGTH) {
        console.warn(`[Search] Scryfall query exceeds ${EFFECTIVE_MAX_QUERY_LENGTH} characters (${scryfallQuery.length}), truncating...`);
        scryfallQuery = truncateScryfallQuery(scryfallQuery, EFFECTIVE_MAX_QUERY_LENGTH);
      }
      
      console.log(`[Search] Natural query: "${body.naturalQuery}" -> Scryfall query: "${scryfallQuery}" (page ${page})`);
      
      // Only validate Tagger tags for AI-generated queries, not direct Scryfall queries
      // If user entered a Scryfall query directly (like "oracletag:reanimate"), trust their syntax
      const invalidTags = isDirectScryfallQuery ? [] : await validateTaggerTags(scryfallQuery);
      
      if (invalidTags.length > 0) {
        console.log(`[Search] Found ${invalidTags.length} invalid tag(s), regenerating query...`);
        
        // Regenerate query without invalid tags
        const regenerationPrompt = getRegenerationPrompt(body.naturalQuery, invalidTags, tagContext);
        scryfallQuery = await convertToScryfallQuery(body.naturalQuery, regenerationPrompt, tagContext);
        
        // Validate and truncate regenerated query length (accounting for prefer:best prefix)
        if (scryfallQuery.length > EFFECTIVE_MAX_QUERY_LENGTH) {
          console.warn(`[Search] Regenerated Scryfall query exceeds ${EFFECTIVE_MAX_QUERY_LENGTH} characters (${scryfallQuery.length}), truncating...`);
          scryfallQuery = truncateScryfallQuery(scryfallQuery, EFFECTIVE_MAX_QUERY_LENGTH);
        }
        
        console.log(`[Search] Regenerated query: "${scryfallQuery}"`);
        
        // Validate again (only once to avoid infinite loops)
        const stillInvalidTags = await validateTaggerTags(scryfallQuery);
        
        if (stillInvalidTags.length > 0) {
          const invalidTagList = stillInvalidTags
            .map(({ type, tag }) => `${type}:${tag}`)
            .join(', ');
          tagValidationError = `The generated query still includes invalid Tagger tags: ${invalidTagList}. Continuing with best-effort search.`;
        }
      }
    } catch (conversionError) {
      // If conversion fails, we can't include the query
      console.error("Query conversion error:", conversionError);
      throw conversionError;
    }
    
    if (tagValidationError) {
      console.warn(`[Search] ${tagValidationError}`);
    }

    // Execute Scryfall search
    try {
      const { response: scryfallResponse, offset } = await searchScryfall(scryfallQuery, page);

      // Transform response
      const response: SearchResponse = await transformScryfallResponse(
        scryfallQuery,
        page,
        offset,
        scryfallResponse
      );

      return NextResponse.json<SearchResponse>(response);
    } catch (scryfallError) {
      // If Scryfall search fails, attempt a best-effort response
      console.error("Scryfall search error:", scryfallError);
      const errorMessage = formatErrorMessage(scryfallError);

      if (errorMessage.includes("didn’t match any cards") && scryfallQuery) {
        const emptyResponse: SearchResponse = {
          scryfallQuery,
          total: 0,
          has_more: false,
          page,
          per_page: CARDS_PER_PAGE,
          cards: [],
        };
        return NextResponse.json<SearchResponse>(emptyResponse);
      }

      const status = errorMessage.includes("Scryfall") ? 502 : 500;
      return NextResponse.json<ErrorResponse>(
        { error: errorMessage, scryfallQuery },
        { status }
      );
    }
  } catch (error) {
    console.error("Search API error:", error);
    
    const errorMessage = formatErrorMessage(error);
    
    // Check if it's a Scryfall error (502) or other error (500)
    const status = errorMessage.includes("Scryfall") ? 502 : 500;
    
    return NextResponse.json<ErrorResponse>(
      { error: errorMessage },
      { status }
    );
  }
}
