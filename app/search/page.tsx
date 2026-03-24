import type { Metadata } from "next";
import { Suspense } from "react";
import SearchPage from "../components/SearchPage";
import { searchShareMetadata } from "./share-metadata";

type SearchPageProps = {
  searchParams?: Promise<{
    q?: string | string[];
  }>;
};

const defaultDescription =
  "Find MTG cards by describing them in plain English. Commander, Modern, Pauper. Art tags, function tags, natural language. Free — powered by Scryfall.";

const buildMetadata = (query: string): Metadata => {
  const cleaned = query.trim();
  const share = searchShareMetadata("/");

  if (!cleaned) {
    return {
      title: "MTG Card Search",
      description: defaultDescription,
      alternates: { canonical: "/" },
      openGraph: {
        ...share.openGraph,
        title: "MTG Card Search — Find That Card",
        description: defaultDescription,
      },
      twitter: {
        ...share.twitter,
        title: "MTG Card Search — Find That Card",
        description: defaultDescription,
      },
    };
  }

  const description = `Search results for "${cleaned}" on Find That Card.`;
  const slug = cleaned.toLowerCase().replace(/\s+/g, "-");
  const canonicalPath = `/search/${encodeURIComponent(slug)}`;
  const shareWithCanonical = searchShareMetadata(canonicalPath);

  return {
    title: `${cleaned} - Search`,
    description,
    alternates: { canonical: canonicalPath },
    openGraph: {
      ...shareWithCanonical.openGraph,
      title: `${cleaned} - Find That Card`,
      description,
    },
    twitter: {
      ...shareWithCanonical.twitter,
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
