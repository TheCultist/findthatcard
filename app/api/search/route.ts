import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { validateNaturalQuery, transformScryfallResponse, formatErrorMessage } from "@/lib/utils";
import { SearchRequest, SearchResponse, ErrorResponse, ScryfallSearchResponse, ScryfallError } from "@/types/scryfall";
import { SCRYFALL_QUERY_CONVERTER_SYSTEM_PROMPT, getUserPrompt } from "@/lib/prompts";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SCRYFALL_BASE_URL = "https://api.scryfall.com";
const SCRYFALL_USER_AGENT = process.env.SCRYFALL_USER_AGENT || "find-that-card/1.0 (+https://findthat.card)";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

/**
 * Checks if a query looks like a Scryfall query (contains operators like :, t:, c:, art:, etc.)
 */
function isScryfallQuery(query: string): boolean {
  // Scryfall queries typically contain operators with colons (t:, c:, art:, function:, etc.)
  const scryfallPattern = /[a-z]+:/i;
  return scryfallPattern.test(query.trim());
}

/**
 * Converts natural language query to Scryfall query string using OpenAI
 */
async function convertToScryfallQuery(naturalQuery: string): Promise<string> {
  // If it's already a Scryfall query, return it as-is
  if (isScryfallQuery(naturalQuery)) {
    return naturalQuery.trim();
  }

  const userPrompt = getUserPrompt(naturalQuery);

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

    return cleanedQuery;
  } catch (error) {
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
 */
async function searchScryfall(query: string, page: number = 1): Promise<{ response: ScryfallSearchResponse; offset: number }> {
  const { scryfallPage, offset } = calculateScryfallPage(page);
  
  const url = new URL(`${SCRYFALL_BASE_URL}/cards/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("unique", "cards");
  url.searchParams.set("page", scryfallPage.toString());

  console.log(`[Scryfall] Executing search with query: "${query}" (our page ${page} -> Scryfall page ${scryfallPage}, offset ${offset})`);

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
    const scryfallQuery = await convertToScryfallQuery(body.naturalQuery);
    console.log(`[Search] Natural query: "${body.naturalQuery}" -> Scryfall query: "${scryfallQuery}" (page ${page})`);

    // Execute Scryfall search
    const { response: scryfallResponse, offset } = await searchScryfall(scryfallQuery, page);

    // Transform response
    const response: SearchResponse = transformScryfallResponse(
      scryfallQuery,
      page,
      offset,
      scryfallResponse
    );

    return NextResponse.json<SearchResponse>(response);
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
