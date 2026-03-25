"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import {
  getSymbolSvg,
  isSymbolDataLoaded,
  registerSymbolLoadCallback,
  unregisterSymbolLoadCallback,
} from "@/lib/scryfall/symbols";

function OracleSegment({ text }: { text: string }) {
  const parts = text.split(/(\{[^}]+\})/g);

  return (
    <>
      {parts.map((part, i) => {
        if (/^\{[^}]+\}$/.test(part)) {
          const svgUri = getSymbolSvg(part);
          if (svgUri) {
            return (
              <Image
                key={i}
                src={svgUri}
                alt={part}
                width={16}
                height={16}
                unoptimized
                className="inline-block align-middle mx-0.5 w-4 h-4 flex-shrink-0"
              />
            );
          }
          return (
            <span key={i} className="text-muted font-mono text-xs">
              {part}
            </span>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

interface OracleTextProps {
  text: string;
  className?: string;
  italic?: boolean;
}

export default function OracleText({ text, className = "", italic = false }: OracleTextProps) {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (!isSymbolDataLoaded()) {
      const callback = () => forceUpdate((prev) => prev + 1);
      registerSymbolLoadCallback(callback);
      return () => unregisterSymbolLoadCallback(callback);
    }
  }, []);

  const paragraphs = text.split("\n");

  return (
    <div className={`space-y-1.5 ${className}`}>
      {paragraphs.map((para, i) => (
        <p
          key={i}
          className={`text-sm leading-relaxed text-foreground ${italic ? "italic text-muted" : ""}`}
        >
          <OracleSegment text={para} />
        </p>
      ))}
    </div>
  );
}
