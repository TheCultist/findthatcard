import { NextRequest, NextResponse } from "next/server";

/**
 * API route to check if a URL returns a 404
 * Used to validate Cardmarket links before navigation
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const url = searchParams.get("url");

  if (!url) {
    return NextResponse.json(
      { error: "URL parameter is required" },
      { status: 400 }
    );
  }

  try {
    // Validate URL format
    const urlObj = new URL(url);
    if (!urlObj.protocol.startsWith("http")) {
      return NextResponse.json(
        { error: "Invalid URL protocol" },
        { status: 400 }
      );
    }

    // Fetch the URL with HEAD request to check status without downloading content
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      redirect: "follow",
    });

    const is404 = response.status === 404;

    return NextResponse.json({
      url,
      is404,
      status: response.status,
    });
  } catch (error) {
    // If fetch fails, assume it might be a 404 or network error
    console.error("[API] Error checking link:", error);
    return NextResponse.json(
      {
        url,
        is404: true,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 200 } // Return 200 so client can handle it
    );
  }
}
