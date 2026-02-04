"use client";

import { getTokenMetadata, tokenizeQuery, TokenMetadata } from "@/lib/query-tokens";

type QueryTokenPreviewProps = {
  scryfallQuery: string;
  sourceQuery: string;
  variant?: "panel" | "inline";
  className?: string;
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
}: QueryTokenPreviewProps) {
  const tokenMetadata = scryfallQuery
    ? tokenizeQuery(scryfallQuery).map((token) => getTokenMetadata(token, sourceQuery))
    : [];

  if (tokenMetadata.length === 0) {
    return null;
  }

  const tokens = (
    <div className={`flex flex-wrap gap-2 font-mono text-sm text-blue-200 ${className}`}>
      {tokenMetadata.map((token, index) => (
        <span
          key={`${token.raw}-${index}`}
          className={`group relative cursor-help rounded border px-2 py-1 bg-gray-900/70 ${getTokenClassName(
            token
          )}`}
        >
          {token.raw}
          <span className="absolute left-1/2 top-full z-20 mt-2 w-80 -translate-x-1/2 rounded-xl border border-gray-700/70 bg-gray-950/95 px-4 py-3 text-xs text-gray-200 opacity-0 shadow-xl transition duration-200 group-hover:opacity-100">
            <div className="text-sm font-semibold text-white">{token.title}</div>
            <div className="mt-2 text-gray-300">{token.description}</div>
            {token.tip && (
              <div className="mt-3 text-gray-400">
                <span className="font-semibold text-gray-200">Tip</span>
                <div className="mt-1">{token.tip}</div>
              </div>
            )}
          </span>
        </span>
      ))}
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
