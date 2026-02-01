"use client";

import { useEffect, useRef } from "react";

type Props = {
  slot: string;
  className?: string;
};

export default function AdBanner({ slot, className }: Props) {
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    try {
      // @ts-ignore
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) {
      console.warn("AdSense error", e);
    }
  }, []);

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
