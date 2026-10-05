import type { MetadataRoute } from "next";
import { SEO_PAGES } from "@/lib/seo-pages";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  return [
    {
      url: "https://www.findthatcard.net",
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: "https://www.findthatcard.net/search",
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: "https://www.findthatcard.net/about",
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: "https://www.findthatcard.net/privacy",
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    // Pre-built query pages: their first page of results is server-rendered (lib/seo-pages.ts).
    ...SEO_PAGES.map((page) => ({
      url: `https://www.findthatcard.net/search/${page.slug}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];
}
