import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

type SetCacheFile = {
  updatedAt?: string;
  sets?: Array<{ name: string; code: string }>;
};

const SETS_FILE_PATH = path.join(process.cwd(), "data", "scryfall-sets.json");

export async function GET() {
  try {
    const raw = await fs.readFile(SETS_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as SetCacheFile | Array<{ name: string; code: string }>;
    const sets = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.sets)
      ? parsed.sets
      : [];

    const map: Record<string, string> = {};
    for (const entry of sets) {
      if (!entry || typeof entry.code !== "string" || typeof entry.name !== "string") {
        continue;
      }
      map[entry.code.toLowerCase()] = entry.name;
    }

    return NextResponse.json({
      updatedAt: Array.isArray(parsed) ? undefined : parsed.updatedAt,
      sets: map,
    });
  } catch (error) {
    console.warn("[Sets API] Failed to read cached sets file:", error);
    return NextResponse.json({ updatedAt: undefined, sets: {} });
  }
}
