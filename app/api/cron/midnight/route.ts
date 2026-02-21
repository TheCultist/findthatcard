import { NextRequest, NextResponse } from "next/server";

/**
 * Cron endpoint invoked at midnight (UTC) by Vercel Cron Jobs.
 * Use it to refresh caches, revalidate data, or simply "wake" the app.
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
    // Optional: trigger cache refresh so next requests get fresh data
    // e.g. await ensureMtgKeywordCache(); await ensureScryfallCatalogCache();
    return NextResponse.json({
      ok: true,
      cron: "midnight",
      at: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("[Cron midnight]", error);
    return NextResponse.json(
      { ok: false, error: String(error) },
      { status: 500 }
    );
  }
}
