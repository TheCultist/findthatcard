import type { Metadata } from "next";
import SearchPage from "../../components/SearchPage";
import { buildSearchMetadata } from "../share-metadata";
import { getQueryFromSlug } from "@/lib/search-slug";
import { getSeoPageResult } from "@/lib/seo-pages";

type SearchSlugPageProps = {
  params: Promise<{ slug: string }> | { slug: string };
};

export async function generateMetadata({
  params,
}: SearchSlugPageProps): Promise<Metadata> {
  const resolvedParams = await params;
  const slug = resolvedParams?.slug ?? "";
  return buildSearchMetadata(getQueryFromSlug(slug), slug);
}

export default async function SearchSlugPage({ params }: SearchSlugPageProps) {
  const { slug } = await params;
  // Pre-built SEO pages arrive with their first page of cards in the HTML; others search client-side.
  const initial = (await getSeoPageResult(slug)) ?? undefined;
  return <SearchPage initial={initial} />;
}
