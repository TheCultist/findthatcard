"use client";

import { useState, useEffect } from "react";

export const COOKIE_CONSENT_KEY = "cookie-consent";

/** localStorage throws when storage is blocked; treat that as "no choice saved". */
export function readConsent(): string | null {
  try {
    return localStorage.getItem(COOKIE_CONSENT_KEY);
  } catch {
    return null;
  }
}

function saveConsent(value: "accepted" | "rejected") {
  try {
    localStorage.setItem(COOKIE_CONSENT_KEY, value);
  } catch {
    // Storage blocked: the choice still applies for this page view only.
  }
}

export default function CookieBanner() {
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    if (!readConsent()) {
      // Small delay to avoid flash of banner on page load
      const timer = setTimeout(() => {
        setShowBanner(true);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleAccept = () => {
    saveConsent("accepted");
    setShowBanner(false);
  };

  const handleReject = () => {
    saveConsent("rejected");
    setShowBanner(false);
  };

  if (!showBanner) {
    return null;
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-surface border-t border-border shadow-lg" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1">
            <p className="text-sm text-muted">
              <span className="font-semibold text-foreground">No advertising or tracking cookies.</span>{" "}
              We use privacy-friendly, cookieless analytics (Vercel Analytics) to count page views and
              anonymous events such as card opens and buy-link clicks.
            </p>
            <p className="mt-1 text-xs text-muted-soft">
              Choose &quot;Reject&quot; to opt out of analytics entirely.{" "}
              <a
                href="/privacy"
                className="underline hover:text-muted"
              >
                Privacy Policy
              </a>
            </p>
          </div>
          <div className="flex gap-3 sm:flex-shrink-0">
            <button
              onClick={handleReject}
              className="rounded-lg border border-border bg-surface-muted px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent/50 hover:bg-accent-muted"
            >
              Reject
            </button>
            <button
              onClick={handleAccept}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              Accept
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
