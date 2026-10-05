"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getTokenMetadata, tokenizeQuery, TokenMetadata } from "@/lib/query-tokens";

type QueryTokenPreviewProps = {
  scryfallQuery: string;
  sourceQuery: string;
  variant?: "panel" | "inline";
  className?: string;
};

const SET_FIELDS = new Set(["set", "s", "e", "edition"]);

const normalizeSetCode = (value?: string) => {
  if (!value) return "";
  return value.replace(/^"|"$/g, "").toLowerCase();
};

/* Token styling: light mode = light bg + dark text (WCAG 4.5:1), dark mode = dark bg + light text */
const getTokenClassName = (token: TokenMetadata) => {
  const base =
    "border border-solid rounded";
  if (token.type === "group") {
    return `${base} bg-surface-muted border-border text-muted`;
  }
  /* Field + logical: accent theme, mode-aware contrast */
  return `${base} bg-accent-muted border-accent/40 text-accent dark:bg-accent-muted-dark dark:border-accent/50 dark:text-accent`;
};

export default function QueryTokenPreview({
  scryfallQuery,
  sourceQuery,
  variant = "panel",
  className = "",
}: QueryTokenPreviewProps) {
  const [setNames, setSetNames] = useState<Record<string, string>>({});
  const [activeTooltip, setActiveTooltip] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeTooltip === null) return;

    const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setActiveTooltip(null);
      }
    };
    document.addEventListener("touchstart", handleOutsideClick);
    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("touchstart", handleOutsideClick);
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [activeTooltip]);
  const tokenMetadata = useMemo(
    () =>
      scryfallQuery
        ? tokenizeQuery(scryfallQuery).map((token) => getTokenMetadata(token, sourceQuery))
        : [],
    [scryfallQuery, sourceQuery]
  );

  const setCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const token of tokenMetadata) {
      if (token.type !== "field") {
        continue;
      }
      const field = token.field?.toLowerCase();
      if (!field || !SET_FIELDS.has(field)) {
        continue;
      }
      const code = normalizeSetCode(token.value);
      if (code) {
        codes.add(code);
      }
    }
    return Array.from(codes);
  }, [tokenMetadata]);
  const hasSetCodes = setCodes.length > 0;

  useEffect(() => {
    if (!hasSetCodes) {
      return;
    }
    let cancelled = false;
    const controller = new AbortController();

    const loadSetNames = async () => {
      try {
        const response = await fetch("/api/sets", { signal: controller.signal });
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as { sets?: Record<string, string> };
        if (!cancelled && payload.sets) {
          setSetNames(payload.sets);
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.warn("[QueryTokenPreview] Failed to load set names:", error);
        }
      }
    };

    loadSetNames();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [hasSetCodes]);

  const isEmpty = tokenMetadata.length === 0;

  const handleTokenTap = (index: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveTooltip(activeTooltip === index ? null : index);
  };

  const tokens = (
    <div ref={containerRef} className={`isolate flex flex-wrap gap-1.5 font-mono text-xs sm:gap-2 sm:text-sm ${className}`}>
      {isEmpty ? (
        <span className="rounded border border-border bg-surface-muted px-2 py-1 text-xs text-muted">
          No query tokens yet.
        </span>
      ) : (
        tokenMetadata.map((token, index) => (
          <button
            type="button"
            key={`${token.raw}-${index}`}
            onClick={(e) => handleTokenTap(index, e)}
            aria-expanded={activeTooltip === index}
            className={`group relative z-0 inline-flex items-center cursor-help px-1.5 py-1 leading-none hover:z-30 focus-visible:z-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:px-2 ${getTokenClassName(
              token
            )}`}
          >
            {token.raw}
            <span className={`pointer-events-none absolute left-1/2 top-full z-40 mt-2 w-[min(16rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl text-left border border-border bg-surface px-3 py-2.5 text-xs text-foreground shadow-xl transition duration-200 sm:w-80 sm:px-4 sm:py-3 ${
              activeTooltip === index ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
            }`}>
              <div className="text-sm font-semibold text-foreground">{token.title}</div>
              <div className="mt-2 text-muted">{token.description}</div>
              {token.type === "field" &&
                token.field &&
                SET_FIELDS.has(token.field.toLowerCase()) && (
                  <div className="mt-3 text-muted-soft">
                    <span className="font-semibold text-foreground">Set name</span>
                    <div className="mt-1">
                      {setNames[normalizeSetCode(token.value)] || "Unknown set"}
                    </div>
                  </div>
                )}
              {token.tip && (
                <div className="mt-3 text-muted-soft">
                  <span className="font-semibold text-foreground">Tip</span>
                  <div className="mt-1">{token.tip}</div>
                </div>
              )}
            </span>
          </button>
        ))
      )}
    </div>
  );

  if (variant === "inline") {
    return tokens;
  }

  return (
    <div className="mt-4 rounded-xl border border-border bg-surface-muted px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted">Query tokens</div>
      <div className="mt-2">{tokens}</div>
    </div>
  );
}
