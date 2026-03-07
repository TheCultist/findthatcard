import { NextRequest, NextResponse } from "next/server";
import {
  validateNaturalQuery,
  transformScryfallResponse,
  formatErrorMessage,
} from "@/lib/utils";
import { SearchRequest, SearchResponse, ErrorResponse } from "@/types/scryfall";
import { CARDS_PER_PAGE, searchScryfall } from "@/lib/scryfall/client";
import { runSearchPipeline } from "@/lib/search-pipeline/runSearchPipeline";

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

    let scryfallQuery: string | undefined;
    try {
      const pipelineResult = await runSearchPipeline(body.naturalQuery);
      scryfallQuery = pipelineResult.queryForScryfall;
      const phase0Note = pipelineResult.normalizedQuery
        ? ` ~> "${pipelineResult.normalizedQuery}"`
        : "";
      console.log(
        `[Search] Natural query "${body.naturalQuery}"${phase0Note} -> "${pipelineResult.queryForLogs}" (batch=${pipelineResult.debug.aiBatchCalls}, sequential=${pipelineResult.debug.aiSequentialCalls}, unresolved=${pipelineResult.debug.unresolvedFragments}, invalidRemoved=${pipelineResult.debug.invalidTagsRemoved}, normalized=${pipelineResult.debug.phase0Normalized})`
      );
    } catch (conversionError) {
      console.error("Query conversion error:", conversionError);
      throw conversionError;
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
