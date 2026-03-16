import type { Metadata } from "next";
import SearchPage from "../../components/SearchPage";

type SearchSlugPageProps = {
  params: Promise<{ slug: string }> | { slug: string };
};

const defaultDescription =
  "Find MTG cards by describing them in plain English. Commander, Modern, Pauper. Art tags, function tags, natural language. Free — powered by Scryfall.";

const buildMetadata = (query: string, slug: string): Metadata => {
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
  params,
}: SearchSlugPageProps): Promise<Metadata> {
  const resolvedParams = await params;
  const slug = resolvedParams?.slug ?? "";
  const query = slug.replace(/-/g, " ");
  return buildMetadata(query, slug);
}

export default function SearchSlugPage() {
  return <SearchPage />;
}
