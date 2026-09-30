import { NextRequest, NextResponse } from "next/server";
import { CardDetailData } from "@/types/scryfall";
import { mergeKeywordMentions } from "@/lib/keyword-mentions";
import { getKeywordDefinitionsMap, getMtgKeywordList } from "@/lib/mtg-keywords";

const SCRYFALL_BASE_URL = "https://api.scryfall.com";
const SCRYFALL_USER_AGENT =
  process.env.SCRYFALL_USER_AGENT || "find-that-card/1.0 (+https://findthatcard.net)";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id || !/^[0-9a-f-]+$/i.test(id)) {
    return NextResponse.json({ error: "Invalid card ID" }, { status: 400 });
  }

  try {
    const response = await fetch(`${SCRYFALL_BASE_URL}/cards/${id}`, {
      headers: {
        "User-Agent": SCRYFALL_USER_AGENT,
        Accept: "application/json",
      },
      next: { revalidate: 3600 },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return NextResponse.json({ error: "Card not found" }, { status: 404 });
      }
      return NextResponse.json(
        { error: "Failed to fetch card from Scryfall" },
        { status: response.status }
      );
    }

    const data: CardDetailData = await response.json();
    try {
      const [names, definitions] = await Promise.all([getMtgKeywordList(), getKeywordDefinitionsMap()]);
      const oracle = [data.oracle_text, ...(data.card_faces ?? []).map((f) => f.oracle_text)]
        .filter(Boolean)
        .join("\n");
      data.keywords = mergeKeywordMentions(data.keywords ?? [], oracle, names, definitions);
    } catch (error) {
      console.warn("[Card API] Keyword mention scan failed:", error);
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
