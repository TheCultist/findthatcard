"use client";

import { useState, useRef, useEffect } from "react";

/** Matches slug format used in keyword-definitions.json and mtg-keywords cache */
function keywordToSlug(keyword: string): string {
  return keyword
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

let definitionsCache: Record<string, string> | null = null;
let definitionsPromise: Promise<Record<string, string>> | null = null;

function fetchDefinitions(): Promise<Record<string, string>> {
  if (definitionsCache) return Promise.resolve(definitionsCache);
  if (!definitionsPromise) {
    definitionsPromise = fetch("/api/keyword-definitions")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        definitionsCache = data ?? {};
        return definitionsCache!;
      });
  }
  return definitionsPromise;
}

interface KeywordWithTooltipProps {
  keyword: string;
  className?: string;
}

export default function KeywordWithTooltip({ keyword, className = "" }: KeywordWithTooltipProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<"above" | "below">("above");
  const [definitions, setDefinitions] = useState<Record<string, string> | null>(definitionsCache);
  const triggerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (definitions !== null) return;
    fetchDefinitions().then(setDefinitions);
  }, [definitions]);

  const slug = keywordToSlug(keyword);
  const definition = definitions?.[slug];

  useEffect(() => {
    if (!showTooltip || !triggerRef.current || !definition) return;
    const el = triggerRef.current;
    const rect = el.getBoundingClientRect();
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    setTooltipPosition(spaceBelow >= 120 || spaceAbove < spaceBelow ? "below" : "above");
  }, [showTooltip, definition]);

  if (!definition) {
    return (
      <span className={className}>
        {keyword}
      </span>
    );
  }

  return (
    <span
      ref={triggerRef}
      className={`relative inline-block ${className}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {keyword}
      {showTooltip && (
        <span
          role="tooltip"
          className={`absolute left-1/2 z-[100] w-64 -translate-x-1/2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs font-normal leading-relaxed text-gray-200 shadow-xl whitespace-normal ${
            tooltipPosition === "above"
              ? "bottom-full mb-2"
              : "top-full mt-2"
          }`}
        >
          {definition}
        </span>
      )}
    </span>
  );
}
