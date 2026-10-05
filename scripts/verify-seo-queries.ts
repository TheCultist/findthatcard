/**
 * Runs every SEO candidate query through the real pipeline (AI + Scryfall) once and writes:
 *  - data/seo-queries.json — the /search/<slug> pages to pre-render: slug → resolved Scryfall query.
 *    Served pages replay the stored Scryfall query, so crawler hits never cost an AI call.
 *  - reports/seo-verify-<date>.md — every query with its result count; failures listed first.
 *
 * Candidates: EXAMPLE_QUERIES plus data/top-queries.txt (one per line; e.g. the top /search/*
 * pages from Vercel Analytics) when present. Run: npm run seo:verify  (uses .env.local AI keys)
 * `npm run seo:verify -- --missing-only` re-checks only queries without a page yet and merges.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { EXAMPLE_QUERIES } from "@/lib/example-queries";
import { runSearchPipeline } from "@/lib/search-pipeline/runSearchPipeline";
import { searchScryfall } from "@/lib/scryfall/client";
import { getQueryFromSlug, isSimpleQuery, slugifyQuery } from "@/lib/search-slug";

// Each query is ~2-4 Scryfall requests; scryfallFetch spaces them, two workers keep the AI side busy.
const CONCURRENCY = 2;
const SEO_FILE = "data/seo-queries.json";
const missingOnly = process.argv.includes("--missing-only");
const TOP_QUERIES_FILE = "data/top-queries.txt";

type Page = { slug: string; query: string; scryfallQuery: string; total: number };
type Row = { input: string; query: string; slug: string | null; scryfallQuery: string; total: number; error?: string };

function candidates(): string[] {
  const top = existsSync(TOP_QUERIES_FILE)
    ? readFileSync(TOP_QUERIES_FILE, "utf-8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : [];
  // A pasted /search/<slug> path is turned back into its query.
  const normalized = top.map((q) => (q.startsWith("/search/") ? getQueryFromSlug(q.slice(8)) : q));
  return [...new Set([...normalized, ...EXAMPLE_QUERIES])];
}

async function verify(input: string): Promise<Row> {
  // A slug page searches for the slug's words — verify exactly what that page will run.
  const slug = isSimpleQuery(input) ? slugifyQuery(input) : null;
  const query = slug ? getQueryFromSlug(slug) : input;
  try {
    const { queryForScryfall } = await runSearchPipeline(query);
    const { response } = await searchScryfall(queryForScryfall, 1);
    return { input, query, slug, scryfallQuery: queryForScryfall, total: response.total_cards ?? 0 };
  } catch (error) {
    return { input, query, slug, scryfallQuery: "", total: 0, error: String(error) };
  }
}

async function main() {
  const existing: Page[] = missingOnly && existsSync(SEO_FILE) ? JSON.parse(readFileSync(SEO_FILE, "utf-8")).pages : [];
  const have = new Set(existing.map((p) => p.slug));
  const queue = candidates().filter((q) => !(isSimpleQuery(q) && have.has(slugifyQuery(q))));
  const rows: Row[] = [];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let q = queue.shift(); q !== undefined; q = queue.shift()) {
        const row = await verify(q);
        rows.push(row);
        console.log(`${row.error ? "ERR " : row.total === 0 ? "ZERO" : "ok  "} ${String(row.total).padStart(5)}  ${q}`);
      }
    })
  );
  // Errors under concurrency are mostly upstream rate limits — retry those one at a time.
  for (const [i, row] of rows.entries()) {
    if (!row.error) continue;
    rows[i] = await verify(row.input);
    console.log(`retry ${rows[i].error ? "ERR " : "ok  "} ${row.input}${rows[i].error ? ` — ${rows[i].error}` : ""}`);
  }

  const verified: Page[] = rows
    .filter((r) => r.slug && r.total > 0)
    .map(({ slug, query, scryfallQuery, total }) => ({ slug: slug!, query, scryfallQuery, total }));
  const pages = [...existing, ...verified].sort((a, b) => a.slug.localeCompare(b.slug));
  writeFileSync(SEO_FILE, JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), pages }, null, 2) + "\n");

  const failed = rows.filter((r) => r.error || r.total === 0);
  const line = (r: Row) => `| ${r.input} | ${r.error ? `ERROR: ${r.error.slice(0, 120)}` : r.total} | \`${r.scryfallQuery}\` |`;
  mkdirSync("reports", { recursive: true });
  const report = `reports/seo-verify-${new Date().toISOString().slice(0, 10)}${missingOnly ? "-missing" : ""}.md`;
  writeFileSync(
    report,
    [
      `# SEO query verification — ${rows.length} queries, ${failed.length} failing, ${pages.length} pages`,
      "",
      "| Query | Results | Scryfall query |",
      "|---|---|---|",
      ...failed.map(line),
      ...rows.filter((r) => !failed.includes(r)).sort((a, b) => a.total - b.total).map(line),
    ].join("\n") + "\n"
  );
  console.log(`\n${rows.length} queries, ${failed.length} failing → ${report}; ${pages.length} pages → data/seo-queries.json`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
