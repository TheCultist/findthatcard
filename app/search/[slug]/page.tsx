import type { Metadata } from "next";
import SearchPage from "../../components/SearchPage";
import { buildSearchMetadata } from "../share-metadata";

type SearchSlugPageProps = {
  params: Promise<{ slug: string }> | { slug: string };
};

export async function generateMetadata({
  params,
}: SearchSlugPageProps): Promise<Metadata> {
  const resolvedParams = await params;
  const slug = resolvedParams?.slug ?? "";
  const query = slug.replace(/-/g, " ");
  return buildSearchMetadata(query, slug);
}

export default function SearchSlugPage() {
  return <SearchPage />;
}
