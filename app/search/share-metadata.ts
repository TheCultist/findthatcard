import type { Metadata } from "next";

const OG_IMAGE = {
  url: "/brand/og-image.png",
  width: 1200,
  height: 630,
  alt: "Find That Card — MTG natural language search",
} as const;

/**
 * Rich link previews (Discord, Telegram, etc.) need explicit og:image and og:url.
 * Relying on root layout merge alone often drops the image for route-level openGraph.
 */
export function searchShareMetadata(canonicalPath: string): Pick<
  Metadata,
  "openGraph" | "twitter"
> {
  return {
    openGraph: {
      url: canonicalPath,
      siteName: "Find That Card",
      type: "website",
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      images: [OG_IMAGE.url],
    },
  };
}

const DEFAULT_DESCRIPTION =
  "Find MTG cards by describing them in plain English. Commander, Modern, Pauper. Art tags, function tags, natural language. Free — powered by Scryfall.";

/**
 * Builds Next.js Metadata for search routes.
 *
 * @param query  - The decoded natural-language query string (may be empty).
 * @param slug   - The URL slug used to derive the canonical path (optional;
 *                 when omitted the canonical falls back to "/search" or "/").
 */
export function buildSearchMetadata(query: string, slug?: string): Metadata {
  const cleaned = query.trim();

  if (!cleaned) {
    const canonicalPath = slug ? "/search" : "/";
    const share = searchShareMetadata(canonicalPath);
    return {
      title: "MTG Card Search",
      description: DEFAULT_DESCRIPTION,
      alternates: { canonical: canonicalPath },
      openGraph: {
        ...share.openGraph,
        title: "MTG Card Search — Find That Card",
        description: DEFAULT_DESCRIPTION,
      },
      twitter: {
        ...share.twitter,
        title: "MTG Card Search — Find That Card",
        description: DEFAULT_DESCRIPTION,
      },
    };
  }

  const resolvedSlug =
    slug ?? cleaned.toLowerCase().replace(/\s+/g, "-");
  const canonicalPath = `/search/${encodeURIComponent(resolvedSlug)}`;
  const share = searchShareMetadata(canonicalPath);
  const description = `Search results for "${cleaned}" on Find That Card.`;

  return {
    title: `${cleaned} - Search`,
    description,
    alternates: { canonical: canonicalPath },
    openGraph: {
      ...share.openGraph,
      title: `${cleaned} - Find That Card`,
      description,
    },
    twitter: {
      ...share.twitter,
      title: `${cleaned} - Find That Card`,
      description,
    },
  };
}
