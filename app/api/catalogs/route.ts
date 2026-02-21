import { NextResponse } from "next/server";
import {
  ensureScryfallCatalogCache,
  getAllCatalogs,
} from "@/lib/scryfall/catalogs";

export async function GET() {
  try {
    await ensureScryfallCatalogCache();
    const catalogs = await getAllCatalogs();
    return NextResponse.json({ catalogs });
  } catch (error) {
    console.warn("[Catalogs API] Failed to build catalog list:", error);
    return NextResponse.json({ catalogs: {} });
  }
}
