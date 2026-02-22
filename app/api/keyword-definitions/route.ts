import { NextResponse } from "next/server";
import {
  ensureMtgKeywordCache,
  getKeywordDefinitionsMap,
} from "@/lib/mtg-keywords";

export async function GET() {
  try {
    await ensureMtgKeywordCache();
    const definitions = await getKeywordDefinitionsMap();
    return NextResponse.json(definitions);
  } catch (error) {
    console.warn("[Keyword definitions API] Failed to get definitions:", error);
    return NextResponse.json({});
  }
}
