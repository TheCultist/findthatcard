import { NextResponse } from "next/server";
import { ensureTaggerTagCache, getTaggerTagCache } from "@/lib/tagger/cache";

/** The Tagger function tags (function:/otag: values), for the chip menu's catalog picker. */
export async function GET() {
  try {
    await ensureTaggerTagCache();
    const tags = [...(getTaggerTagCache()?.get("function") ?? [])].sort();
    return NextResponse.json({ tags });
  } catch (error) {
    console.warn("[Function tags API] Failed to load the Tagger cache:", error);
    return NextResponse.json({ tags: [] });
  }
}
