"use client";

import { useEffect, useState } from "react";
import { ArrowUpIcon } from "@heroicons/react/24/outline";

export default function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 300);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Back to top"
      title="Back to top"
      className={`fixed bottom-6 right-6 z-50 rounded-lg border border-border bg-surface-muted/80 p-2 text-muted shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-accent/40 hover:bg-surface hover:shadow ${
        visible ? "opacity-100 translate-y-0" : "pointer-events-none opacity-0 translate-y-2"
      }`}
    >
      <ArrowUpIcon className="h-6 w-6" />
    </button>
  );
}
