import { NextRequest, NextResponse } from "next/server";
import {
  ensureScryfallCatalogCache,
  getAllCatalogs,
} from "@/lib/scryfall/catalogs";

export async function GET(request: NextRequest) {
  try {
    await ensureScryfallCatalogCache();
    const catalogs = await getAllCatalogs();
    // ?only=card-types,creature-types trims the payload: some catalogs (card names,
    // word bank) are tens of thousands of entries a client rarely wants all at once.
    const only = request.nextUrl.searchParams.get("only");
    if (only !== null) {
      const wanted = new Set(only.split(",").map((name) => name.trim()).filter(Boolean));
      const filtered = Object.fromEntries(Object.entries(catalogs).filter(([name]) => wanted.has(name)));
      return NextResponse.json({ catalogs: filtered });
    }
    return NextResponse.json({ catalogs });
  } catch (error) {
    console.warn("[Catalogs API] Failed to build catalog list:", error);
    return NextResponse.json({ catalogs: {} });
  }
}
