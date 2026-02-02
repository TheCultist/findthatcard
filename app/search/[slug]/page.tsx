import type { Metadata } from "next";
import SearchPage from "@/app/components/SearchPage";

type SearchSlugPageProps = {
  params: {
    slug: string;
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

export function generateMetadata({ params }: SearchSlugPageProps): Metadata {
  const query = params.slug.replace(/-/g, " ");
  return buildMetadata(query);
}

export default function SearchSlugPage() {
  return <SearchPage />;
}
