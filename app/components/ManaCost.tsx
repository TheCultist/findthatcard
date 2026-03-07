"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import {
  getSymbolSvg,
  isSymbolDataLoaded,
  registerSymbolLoadCallback,
  unregisterSymbolLoadCallback,
} from "@/lib/scryfall/symbols";

/**
 * Renders mana cost symbols from a mana cost string (e.g., "{1}{R}{G}" or "{1}{R} / {2}{G}" for split cards)
 */
export default function ManaCost({ manaCost }: { manaCost: string }) {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (!isSymbolDataLoaded()) {
      const callback = () => forceUpdate((prev) => prev + 1);
      registerSymbolLoadCallback(callback);
      return () => {
        unregisterSymbolLoadCallback(callback);
      };
    }
  }, []);

  const isSplitCost = manaCost.includes(" / ");

  if (isSplitCost) {
    const costs = manaCost.split(" / ");

    return (
      <div className="flex items-center gap-1 flex-shrink-0">
        {costs.map((cost, costIndex) => {
          const symbols = cost.match(/\{[^}]+\}/g) || [];

          return (
            <div key={costIndex} className="flex items-center gap-0.5">
              {symbols.length > 0 ? (
                symbols.map((symbol, symbolIndex) => {
                  const svgUri = getSymbolSvg(symbol);

                  if (!svgUri) {
                    return (
                      <span
                        key={`${symbol}-${symbolIndex}`}
                        className="text-xs text-gray-400 whitespace-nowrap"
                      >
                        {symbol}
                      </span>
                    );
                  }

                  return (
                    <Image
                      key={`${symbol}-${symbolIndex}`}
                      src={svgUri}
                      alt={symbol}
                      width={16}
                      height={16}
                      unoptimized
                      className="inline-block flex-shrink-0"
                      onError={(e) => {
                        const target = e.currentTarget as HTMLImageElement;
                        target.style.display = "none";
                        const textSpan = document.createElement("span");
                        textSpan.textContent = symbol;
                        textSpan.className = "text-xs text-gray-400 whitespace-nowrap";
                        target.parentElement?.appendChild(textSpan);
                      }}
                    />
                  );
                })
              ) : (
                <span className="text-xs text-gray-400 whitespace-nowrap">
                  {cost}
                </span>
              )}
              {costIndex < costs.length - 1 && (
                <span className="text-xs text-gray-500 mx-0.5">/</span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Regular single mana cost
  const symbols = manaCost.match(/\{[^}]+\}/g) || [];

  if (symbols.length === 0) {
    return <span className="text-xs text-gray-400 whitespace-nowrap">{manaCost}</span>;
  }

  return (
    <div className="flex items-center gap-0.5 flex-shrink-0">
      {symbols.map((symbol, index) => {
        const svgUri = getSymbolSvg(symbol);

        if (!svgUri) {
          return (
            <span
              key={`${symbol}-${index}`}
              className="text-xs text-gray-400 whitespace-nowrap"
            >
              {symbol}
            </span>
          );
        }

        return (
          <Image
            key={`${symbol}-${index}`}
            src={svgUri}
            alt={symbol}
            width={16}
            height={16}
            unoptimized
            className="inline-block flex-shrink-0"
            onError={(e) => {
              const target = e.currentTarget as HTMLImageElement;
              target.style.display = "none";
              const textSpan = document.createElement("span");
              textSpan.textContent = symbol;
              textSpan.className = "text-xs text-gray-400 whitespace-nowrap";
              target.parentElement?.appendChild(textSpan);
            }}
          />
        );
      })}
    </div>
  );
}
