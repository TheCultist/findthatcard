import type { Metadata } from "next";
import SearchPage from "../../components/SearchPage";
import { buildSearchMetadata } from "../share-metadata";
import { getQueryFromSlug } from "@/lib/search-slug";
import { getSeoPageResult } from "@/lib/seo-pages";

type SearchSlugPageProps = {
  params: Promise<{ slug: string }> | { slug: string };
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({
  params,
}: SearchSlugPageProps): Promise<Metadata> {
  const resolvedParams = await params;
  const slug = resolvedParams?.slug ?? "";
  return buildSearchMetadata(getQueryFromSlug(slug), slug);
}

export default async function SearchSlugPage({ params, searchParams }: SearchSlugPageProps) {
  const { slug } = await params;
  const query = (await searchParams) ?? {};
  // Pre-built SEO pages arrive with their first page of cards in the HTML; others search client-side.
  // The cached HTML is page 1 in the default order, so a link with a sort or a page searches
  // client-side instead of flashing the wrong cards first. The canonical stays the bare slug.
  const wantsDefaultView = query.sort === undefined && query.page === undefined;
  const initial = wantsDefaultView ? (await getSeoPageResult(slug)) ?? undefined : undefined;
  return <SearchPage initial={initial} />;
}
