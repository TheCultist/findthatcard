import type { Metadata } from "next";
import { Suspense } from "react";
import SearchPage from "@/app/components/SearchPage";

type SearchPageProps = {
  searchParams?: {
    q?: string | string[];
  };
};

const buildMetadata = (query: string): Metadata => {
  const cleaned = query.trim();
  if (!cleaned) {
    return {
      title: "Search | Find That Card",
      description:
        "Search Magic: The Gathering cards using natural language. Supports art and function tags from Scryfall Tagger.",
    };
  }

  return {
    title: `${cleaned} | Find That Card`,
    description: `Search results for "${cleaned}" on Find That Card.`,
  };
};

export function generateMetadata({ searchParams }: SearchPageProps): Metadata {
  const rawQuery = searchParams?.q;
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
