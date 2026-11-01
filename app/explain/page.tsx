import type { Metadata } from "next";
import Link from "next/link";
import QueryExplainer from "@/app/components/QueryExplainer";
import ThemeToggle from "@/app/components/ThemeToggle";

const MAX_QUERY_LENGTH = 2_000;

export const metadata: Metadata = {
  title: "Explain a Scryfall Query",
  description:
    "Paste a Scryfall query to see what each part does, read it in plain English, and catch broken syntax before you search.",
  alternates: { canonical: "https://www.findthatcard.net/explain" },
  openGraph: {
    title: "Explain a Scryfall Query | Find That Card",
    description: "See what each part of a Scryfall query does, in plain English.",
    url: "https://www.findthatcard.net/explain",
  },
};

type ExplainPageProps = {
  searchParams?: Promise<{ q?: string | string[] }>;
};

export default async function ExplainPage({ searchParams }: ExplainPageProps) {
  const rawQuery = (await searchParams)?.q;
  const query = (Array.isArray(rawQuery) ? rawQuery[0] ?? "" : rawQuery ?? "").slice(0, MAX_QUERY_LENGTH);

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex justify-end">
          <ThemeToggle />
        </div>
        <div className="mb-8 text-center">
          <Link href="/" className="text-accent hover:underline text-sm mb-4 inline-block">
            ← Back to search
          </Link>
          <h1 className="font-display text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            Explain a query
          </h1>
          <p className="mt-2 text-sm text-muted">
            Paste a Scryfall query to see what each part does and learn the syntax as you go.
          </p>
        </div>
        <QueryExplainer initialQuery={query} maxLength={MAX_QUERY_LENGTH} />
      </div>
    </main>
  );
}
