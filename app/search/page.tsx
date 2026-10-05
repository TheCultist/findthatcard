import type { Metadata } from "next";
import { Suspense } from "react";
import SearchPage from "../components/SearchPage";
import { buildSearchMetadata } from "./share-metadata";

type SearchPageProps = {
  searchParams?: Promise<{
    q?: string | string[];
  }>;
};

export async function generateMetadata({
  searchParams,
}: SearchPageProps): Promise<Metadata> {
  const resolvedParams = await searchParams;
  const rawQuery = resolvedParams?.q;
  const query = Array.isArray(rawQuery) ? rawQuery[0] ?? "" : rawQuery ?? "";
  return buildSearchMetadata(query);
}

export default function SearchIndexPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <SearchPage />
    </Suspense>
  );
}
