"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { getTokenClassName, isSetToken, useSetNames } from "@/app/components/QueryTokenPreview";
import { explainQuery, type ExplainWarning } from "@/lib/query-explain";

const EXAMPLES = [
  't:creature (o:"draw a card" or kw:flying) -c:r',
  "o:/(?<!this )creature[^.]*die[^.]*gain[^.]*life/ t:creature",
  `name:'Henzie "Toolbox" Torre' t:creature`,
  "f:modern mv<=2",
  "t:creature (kw:flying or",
];

const linkClass =
  "rounded-lg border border-border bg-surface-muted px-4 py-2 text-sm text-foreground transition-colors duration-200 hover:border-accent/50 hover:bg-accent-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

const WARNING_STYLES: Record<ExplainWarning["severity"], { label: string; className: string }> = {
  error: { label: "Error", className: "text-red-600 dark:text-red-400" },
  warning: { label: "Warning", className: "text-amber-700 dark:text-amber-400" },
};

/** Deep groups stop indenting so a phone keeps room for the text. */
const MAX_INDENT = 4;

const countOf = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

type QueryExplainerProps = {
  initialQuery: string;
  maxLength: number;
};

export default function QueryExplainer({ initialQuery, maxLength }: QueryExplainerProps) {
  const [query, setQuery] = useState(initialQuery);
  const { summary, parts, warnings } = useMemo(() => explainQuery(query), [query]);
  const setNameOf = useSetNames(parts);
  const trimmed = query.trim();
  const errors = warnings.filter((warning) => warning.severity === "error").length;
  const problemCount = [
    errors > 0 && countOf(errors, "error"),
    warnings.length > errors && countOf(warnings.length - errors, "warning"),
  ].filter(Boolean);

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
          {(summary || warnings.length > 0) && (
            <section aria-label="Summary" className="rounded-xl border border-border bg-surface-muted px-4 py-3">
              <h2 className="text-xs uppercase tracking-wide text-muted">In plain English</h2>
              {summary && <p className="mt-2 text-foreground">{summary}</p>}
              <p aria-live="polite" className="mt-2 text-sm text-muted">
                {problemCount.length > 0 && `${problemCount.join(" and ")} marked below.`}
              </p>
            </section>
          )}

          <section aria-label="Part by part">
            <h2 className="text-xs uppercase tracking-wide text-muted">Part by part</h2>
            <ol className="mt-1 divide-y divide-border">
              {parts.map((part, index) => (
                <li
                  key={`${part.start}-${index}`}
                  style={{ paddingLeft: `${Math.min(part.depth, MAX_INDENT) * 0.75}rem` }}
                  className="py-3 sm:grid sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-4"
                >
                  <div>
                    <code
                      className={`inline-block max-w-full break-all px-1.5 py-1 font-mono text-xs leading-tight sm:px-2 sm:text-sm ${getTokenClassName(part)}`}
                    >
                      {part.raw}
                    </code>
                  </div>
                  <div className="mt-2 text-sm sm:mt-0">
                    <div className="font-semibold text-foreground">{part.title}</div>
                    {part.firstMention && <p className="mt-1 text-muted">{part.description}</p>}
                    {isSetToken(part) && <p className="mt-1 text-muted">Set name: {setNameOf(part)}</p>}
                    {part.firstMention && part.tip && <p className="mt-1 text-muted-soft">Tip: {part.tip}</p>}
                    {part.warnings.map((warning) => (
                      <p key={warning.message} className={`mt-1 ${WARNING_STYLES[warning.severity].className}`}>
                        <span className="font-semibold">{WARNING_STYLES[warning.severity].label}: </span>
                        {warning.message}
                      </p>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          </section>

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
