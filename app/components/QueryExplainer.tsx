"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import QueryTokenPreview from "@/app/components/QueryTokenPreview";
import { explainQuery } from "@/lib/query-explain";

const EXAMPLES = [
  't:creature (o:"draw a card" or kw:flying) -c:r',
  "o:/(?<!this )creature[^.]*die[^.]*gain[^.]*life/ t:creature",
  `name:'Henzie "Toolbox" Torre' t:creature`,
  "f:modern mv<=2",
  "t:creature (kw:flying or",
];

const linkClass =
  "rounded-lg border border-border bg-surface-muted px-4 py-2 text-sm text-foreground transition-colors duration-200 hover:border-accent/50 hover:bg-accent-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

type QueryExplainerProps = {
  initialQuery: string;
  maxLength: number;
};

export default function QueryExplainer({ initialQuery, maxLength }: QueryExplainerProps) {
  const [query, setQuery] = useState(initialQuery);
  const { summary, warnings } = useMemo(() => explainQuery(query), [query]);
  const trimmed = query.trim();

  return (
    <div className="space-y-6">
      <div>
        <label htmlFor="explain-query" className="text-sm font-medium text-foreground">
          Scryfall query
        </label>
        <textarea
          id="explain-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={maxLength}
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder='t:creature o:"draw a card"'
          className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 font-mono text-sm text-foreground placeholder:text-muted-soft focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <div className="mt-3">
          <div className="text-xs uppercase tracking-wide text-muted">Try an example</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setQuery(example)}
                className="max-w-full truncate rounded border border-border bg-surface-muted px-2 py-1 font-mono text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      </div>

      {trimmed && (
        <>
          <section aria-label="Query parts" className="rounded-xl border border-border bg-surface-muted px-4 py-3">
            <h2 className="text-xs uppercase tracking-wide text-muted">What each part does</h2>
            <p className="mt-1 text-xs text-muted-soft">Hover or tap a part to read about it.</p>
            <div className="mt-3">
              <QueryTokenPreview scryfallQuery={query} sourceQuery={query} variant="inline" />
            </div>
          </section>

          {summary && (
            <section aria-label="Summary" className="rounded-xl border border-border bg-surface-muted px-4 py-3">
              <h2 className="text-xs uppercase tracking-wide text-muted">In plain English</h2>
              <p className="mt-2 text-foreground">{summary}</p>
            </section>
          )}

          {warnings.length > 0 && (
            <section aria-label="Syntax problems" aria-live="polite" className="rounded-xl border border-border bg-surface-muted px-4 py-3">
              <h2 className="text-xs uppercase tracking-wide text-muted">Syntax problems</h2>
              <ul className="mt-2 space-y-2 text-sm text-foreground">
                {warnings.map((warning, index) => (
                  <li key={`${warning.message}-${index}`}>
                    <span className="font-semibold">{warning.severity === "error" ? "Error: " : "Warning: "}</span>
                    {warning.message}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap gap-2">
            <Link href={`/search?q=${encodeURIComponent(trimmed)}`} className={linkClass}>
              Search this query
            </Link>
            <a
              href={`https://scryfall.com/search?q=${encodeURIComponent(trimmed)}`}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              View on Scryfall
            </a>
          </div>
        </>
      )}
    </div>
  );
}
