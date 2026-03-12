"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getTokenMetadata, tokenizeQuery, TokenMetadata } from "@/lib/query-tokens";

type QueryTokenPreviewProps = {
  scryfallQuery: string;
  sourceQuery: string;
  variant?: "panel" | "inline";
  className?: string;
  /** Called with the rewritten query when the user clicks the id:/id= toggle. */
  onApplyQueryAction?: (newQuery: string) => void;
};

const SET_FIELDS = new Set(["set", "s", "e", "edition"]);

const normalizeSetCode = (value?: string) => {
  if (!value) return "";
  return value.replace(/^"|"$/g, "").toLowerCase();
};

const getTokenClassName = (token: TokenMetadata) => {
  if (token.type === "group") {
    return "border-gray-700/70 text-gray-400";
  }
  if (token.type === "logical") {
    return "border-purple-500/40 text-purple-300";
  }
  return "border-blue-500/40 text-blue-300";
};

export default function QueryTokenPreview({
  scryfallQuery,
  sourceQuery,
  variant = "panel",
  className = "",
  onApplyQueryAction,
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
    <div ref={containerRef} className={`isolate flex flex-wrap gap-1.5 font-mono text-xs text-blue-200 sm:gap-2 sm:text-sm ${className}`}>
      {isEmpty ? (
        <span className="rounded border border-gray-800/70 bg-gray-900/60 px-2 py-1 text-xs text-gray-500">
          No query tokens yet.
        </span>
      ) : (
        tokenMetadata.map((token, index) => (
          <span
            key={`${token.raw}-${index}`}
            onClick={(e) => handleTokenTap(index, e)}
            className={`group relative z-0 inline-flex items-center cursor-help rounded border bg-gray-900/70 px-1.5 py-1 leading-none hover:z-30 sm:px-2 ${getTokenClassName(
              token
            )}`}
          >
            {token.raw}
            <span className={`pointer-events-none absolute left-1/2 top-full z-40 mt-2 w-[min(16rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-gray-700/70 bg-gray-950/95 px-3 py-2.5 text-xs text-gray-200 shadow-xl transition duration-200 sm:w-80 sm:px-4 sm:py-3 ${
              activeTooltip === index ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}>
              <div className="text-sm font-semibold text-white">{token.title}</div>
              <div className="mt-2 text-gray-300">{token.description}</div>
              {token.type === "field" &&
                token.field &&
                SET_FIELDS.has(token.field.toLowerCase()) && (
                  <div className="mt-3 text-gray-400">
                    <span className="font-semibold text-gray-200">Set name</span>
                    <div className="mt-1">
                      {setNames[normalizeSetCode(token.value)] || "Unknown set"}
                    </div>
                  </div>
                )}
              {token.tip && (
                <div className="mt-3 text-gray-400">
                  <span className="font-semibold text-gray-200">Tip</span>
                  <div className="mt-1">{token.tip}</div>
                </div>
              )}
            </span>
          </span>
        ))
      )}
    </div>
  );

  if (variant === "inline") {
    return tokens;
  }

  return (
    <div className="mt-4 rounded-xl border border-gray-800/70 bg-gray-950/60 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">Query tokens</div>
      <div className="mt-2">{tokens}</div>
    </div>
  );
}
