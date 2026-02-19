"use client";

import { useEffect, useRef } from "react";

type Props = {
  slot: string;
  className?: string;
};

const SHOW_ADS = process.env.NEXT_PUBLIC_SHOW_ADS === "true";

export default function AdBanner({ slot, className }: Props) {
  const loaded = useRef(false);

  useEffect(() => {
    if (!SHOW_ADS) return;
    if (loaded.current) return;
    loaded.current = true;

    try {
      // @ts-expect-error adsbygoogle is injected by AdSense
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) {
      console.warn("AdSense error", e);
    }
  }, []);

  if (!SHOW_ADS) return null;

  return (
    <div className={className}>
      <div className="text-[10px] text-gray-400 mb-1">Advertisement</div>
      <ins
        className="adsbygoogle"
        style={{ display: "block", minHeight: 90 }}
        data-ad-client="ca-pub-1161939859067558"
        data-ad-slot={slot}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
}
