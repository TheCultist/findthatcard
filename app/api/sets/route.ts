import { NextResponse } from "next/server";
import { getSetCodeMap } from "@/lib/scryfall/sets";

export async function GET() {
  try {
    const payload = await getSetCodeMap();
    return NextResponse.json(payload);
  } catch (error) {
    console.warn("[Sets API] Failed to build set map:", error);
    return NextResponse.json({ updatedAt: undefined, sets: {} });
  }
}
