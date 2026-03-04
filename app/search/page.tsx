import type { Metadata } from "next";
import { Suspense } from "react";
import SearchPage from "../components/SearchPage";

type SearchPageProps = {
  searchParams?: Promise<{
    q?: string | string[];
  }>;
};

const defaultDescription =
  "Search Magic: The Gathering cards using natural language. Supports art and function tags from Scryfall Tagger.";

const buildMetadata = (query: string): Metadata => {
  const cleaned = query.trim();
  if (!cleaned) {
    return {
      title: "Search",
      description: defaultDescription,
      openGraph: {
        title: "Find That Card - Search",
        description: defaultDescription,
      },
    };
  }

  const description = `Search results for "${cleaned}" on Find That Card.`;
  const slug = cleaned.toLowerCase().replace(/\s+/g, "-");

  return {
    title: `${cleaned} - Search`,
    description,
    alternates: { canonical: `/search/${encodeURIComponent(slug)}` },
    openGraph: {
      title: `${cleaned} - Find That Card`,
      description,
    },
    twitter: {
      card: "summary",
      title: `${cleaned} - Find That Card`,
      description,
    },
  };
};

export async function generateMetadata({
  searchParams,
}: SearchPageProps): Promise<Metadata> {
  const resolvedParams = await searchParams;
  const rawQuery = resolvedParams?.q;
  const query = Array.isArray(rawQuery) ? rawQuery[0] ?? "" : rawQuery ?? "";
  return buildMetadata(query);
}

export default function SearchIndexPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <SearchPage />
    </Suspense>
  );
}
