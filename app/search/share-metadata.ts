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
