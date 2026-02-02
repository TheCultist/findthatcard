import type { Metadata } from "next";
import SearchPage from "@/app/components/SearchPage";

type SearchSlugPageProps = {
  params: Promise<{ slug: string }> | { slug: string };
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

export async function generateMetadata({
  params,
}: SearchSlugPageProps): Promise<Metadata> {
  const resolvedParams = await params;
  const slug = resolvedParams?.slug ?? "";
  const query = slug.replace(/-/g, " ");
  return buildMetadata(query);
}

export default function SearchSlugPage() {
  return <SearchPage />;
}
