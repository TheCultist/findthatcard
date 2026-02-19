import { NextResponse } from "next/server";
import {
  ensureMtgKeywordCache,
  getMtgKeywordList,
} from "@/lib/mtg-keywords";

export async function GET() {
  try {
    await ensureMtgKeywordCache();
    const keywords = await getMtgKeywordList();
    return NextResponse.json({ keywords });
  } catch (error) {
    console.warn("[Keywords API] Failed to build keyword list:", error);
    return NextResponse.json({ keywords: [] });
  }
}
