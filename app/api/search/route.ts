import { NextRequest, NextResponse } from "next/server";
import {
  validateNaturalQuery,
  transformScryfallResponse,
  formatErrorMessage,
  validateTaggerTags,
  getTaggerTagContext,
  TaggerTagContext
} from "@/lib/utils";
import { SearchRequest, SearchResponse, ErrorResponse } from "@/types/scryfall";
import { getRegenerationPrompt } from "@/lib/prompts";
import {
  convertToScryfallQuery,
  EFFECTIVE_MAX_QUERY_LENGTH,
  isScryfallQuery,
  truncateScryfallQuery,
} from "@/lib/scryfall/query-converter";
import { CARDS_PER_PAGE, searchScryfall } from "@/lib/scryfall/client";

const DEFAULT_GAME_FILTER = "game:paper";

function applyDefaultGameFilter(query: string): string {
  const lower = query.toLowerCase();
  const hasGameFilter = /\b(game|in):(paper|arena|mtgo)\b/.test(lower);
  const hasDigitalFilter = /\b-?is:(digital|alchemy|rebalanced)\b/.test(lower);

  if (hasGameFilter || hasDigitalFilter) {
    return query;
  }

  return `${query} ${DEFAULT_GAME_FILTER}`.trim();
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
      scryfallQuery = applyDefaultGameFilter(scryfallQuery);
      
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
        scryfallQuery = applyDefaultGameFilter(scryfallQuery);
        
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
