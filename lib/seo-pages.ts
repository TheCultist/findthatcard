import { unstable_cache } from "next/cache";
import seo from "@/data/seo-queries.json";
import { searchScryfall } from "@/lib/scryfall/client";
import { transformScryfallResponse } from "@/lib/scryfall/response-transformer";
import type { SearchResponse } from "@/types/scryfall";

/**
 * Pre-built /search/<slug> pages (data/seo-queries.json, from `npm run seo:verify`): each slug's
 * natural-language query was resolved and verified once, so serving the page replays the stored
 * Scryfall query — crawler traffic never costs an AI call.
 */
type SeoPage = { slug: string; query: string; scryfallQuery: string; total: number };

const pages = new Map((seo.pages as SeoPage[]).map((page) => [page.slug, page]));

export const SEO_PAGES: readonly SeoPage[] = [...pages.values()];

const cachedFirstPage = unstable_cache(
  async (scryfallQuery: string): Promise<SearchResponse> => {
    const { response, offset } = await searchScryfall(scryfallQuery, 1);
    return transformScryfallResponse(scryfallQuery, 1, offset, response);
  },
  ["seo-first-page"],
  { revalidate: 24 * 60 * 60 }
);

/** Page-1 results for a pre-built slug, or null (not an SEO page, or Scryfall failed — not cached). */
export async function getSeoPageResult(
  slug: string
): Promise<{ query: string; result: SearchResponse } | null> {
  const page = pages.get(slug);
  if (!page) return null;
  try {
    return { query: page.query, result: await cachedFirstPage(page.scryfallQuery) };
  } catch (error) {
    console.warn(`[SEO] Server render failed for /search/${slug}; client will search:`, error);
    return null;
  }
}
