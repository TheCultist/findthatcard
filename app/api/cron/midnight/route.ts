import { NextRequest, NextResponse } from "next/server";
import { ensureScryfallCatalogCache } from "@/lib/scryfall/catalogs";
import { ensureScryfallSetCache } from "@/lib/scryfall/sets";
import { ensureMtgKeywordCache } from "@/lib/mtg-keywords";
import { ensureTaggerTagCache } from "@/lib/tagger/cache";

/**
 * Cron endpoint invoked at midnight (UTC) by Vercel Cron Jobs.
 * Refreshes all daily JSON caches so the first real user request of the day
 * is served from warm, up-to-date data rather than triggering a cold fetch.
 * Configure the schedule in vercel.json; set CRON_SECRET in Vercel project settings.
 * @see https://vercel.com/docs/cron-jobs
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;

  if (secret && authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const results = await Promise.allSettled([
      ensureScryfallCatalogCache(),
      ensureScryfallSetCache(),
      ensureMtgKeywordCache(),
      ensureTaggerTagCache(),
    ]);

    const summary = {
      catalogs: results[0].status,
      sets: results[1].status,
      keywords: results[2].status,
      taggerTags: results[3].status,
    };

    const anyFailed = results.some((r) => r.status === "rejected");
    if (anyFailed) {
      const errors = results
        .map((r, i) =>
          r.status === "rejected"
            ? `${["catalogs", "sets", "keywords", "taggerTags"][i]}: ${String(r.reason)}`
            : null
        )
        .filter(Boolean);
      console.error("[Cron midnight] Some caches failed to refresh:", errors);
    }

    return NextResponse.json({
      ok: !anyFailed,
      cron: "midnight",
      at: new Date().toISOString(),
      caches: summary,
    });
  } catch (error) {
    console.warn("[Cron midnight]", error);
    return NextResponse.json(
      { ok: false, error: String(error) },
      { status: 500 }
    );
  }
}
