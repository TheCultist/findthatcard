import { NextRequest, NextResponse } from "next/server";
import { validateNaturalQuery, formatErrorMessage } from "@/lib/utils";
import { SearchRequest, SearchResponse, ErrorResponse } from "@/types/scryfall";
import { CARDS_PER_PAGE, ScryfallResponseError } from "@/lib/scryfall/client";
import { isScryfallQuery } from "@/lib/scryfall/query-converter";
import { searchResultsPage } from "@/lib/scryfall/response-transformer";
import { runSearchPipeline } from "@/lib/search-pipeline/runSearchPipeline";
import { getActiveProvider } from "@/lib/ai-client";
import { clientIp, createRateLimiter } from "@/lib/utils/rate-limit";
import { parseSortInput } from "@/lib/search-sort";

// AI extraction (≤20s, one retry) + Scryfall (10s timeout) fit; a hung call can't run forever.
export const maxDuration = 60;

// Every uncached search costs an AI call. 30/min covers a person searching and paging fast.
const searchRateLimit = createRateLimiter(30, 60_000);

// ~30k unique cards at 60 per page is ~500 pages; anything far past that is garbage input.
const MAX_PAGE = 1_000;

/**
 * POST /api/search
 */
export async function POST(request: NextRequest) {
  const retryAfter = searchRateLimit(clientIp(request.headers));
  if (retryAfter > 0) {
    return NextResponse.json<ErrorResponse>(
      { error: "Too many searches — please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  try {
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

    const page = body.page ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
      return NextResponse.json<ErrorResponse>({ error: "Invalid page" }, { status: 400 });
    }

    // Lenient on purpose: a bad sort (hand-edited link, old client) searches unsorted instead of failing.
    const rawSort = body.sort && typeof body.sort === "object" ? body.sort : {};
    const sort = parseSortInput(rawSort.by, rawSort.dir);

    // Raw Scryfall syntax never reaches the AI, so it works without a key.
    const provider = getActiveProvider();
    const apiKeyMissing =
      provider === "claude"
        ? !process.env.ANTHROPIC_API_KEY
        : !process.env.OPENAI_API_KEY;
    if (apiKeyMissing && !isScryfallQuery(body.naturalQuery)) {
      console.error(`[Search] ${provider} API key is not configured`);
      return NextResponse.json<ErrorResponse>(
        { error: "Search is temporarily unavailable." },
        { status: 503 }
      );
    }

    let scryfallQuery: string | undefined;
    try {
      const pipelineResult = await runSearchPipeline(body.naturalQuery);
      scryfallQuery = pipelineResult.queryForScryfall;
      const phase0Note = pipelineResult.normalizedQuery
        ? ` ~> "${pipelineResult.normalizedQuery}"`
        : "";
      console.log(
        `[Search] Natural query "${body.naturalQuery}"${phase0Note} -> "${pipelineResult.queryForLogs}" (batch=${pipelineResult.debug.aiBatchCalls}, sequential=${pipelineResult.debug.aiSequentialCalls}, phase1Fragments=${pipelineResult.debug.unresolvedFragments}, phase2Resolved=${pipelineResult.debug.resolvedFragments}, invalidRemoved=${pipelineResult.debug.invalidTagsRemoved}, normalized=${pipelineResult.debug.phase0Normalized})`
      );
    } catch (conversionError) {
      console.error("Query conversion error:", conversionError);
      throw conversionError;
    }

    try {
      return NextResponse.json<SearchResponse>(await searchResultsPage(scryfallQuery, page, sort));
    } catch (scryfallError) {
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
          excluded: 0,
          incomplete: false,
        };
        return NextResponse.json<SearchResponse>(emptyResponse);
      }

      // Scryfall's own 4xx explanation is about the query (and the user can edit it);
      // rate limits, timeouts, network failures and 5xx get a generic message.
      const queryProblem =
        scryfallError instanceof ScryfallResponseError &&
        scryfallError.status < 500 &&
        scryfallError.status !== 429;
      return NextResponse.json<ErrorResponse>(
        {
          error: queryProblem ? errorMessage : "Scryfall is unavailable right now — please try again.",
          scryfallQuery,
        },
        { status: queryProblem ? 400 : 502 }
      );
    }
  } catch (error) {
    // Pipeline/AI failures: log the detail, never send provider messages or internals to the client.
    console.error("Search API error:", error);
    return NextResponse.json<ErrorResponse>(
      { error: "Search failed — please try again or rephrase your query." },
      { status: 500 }
    );
  }
}
