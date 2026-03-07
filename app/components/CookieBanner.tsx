"use client";

import { useState, useEffect } from "react";

const COOKIE_CONSENT_KEY = "cookie-consent";

export default function CookieBanner() {
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    const consent = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (!consent) {
      // Small delay to avoid flash of banner on page load
      const timer = setTimeout(() => {
        setShowBanner(true);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleAccept = () => {
    localStorage.setItem(COOKIE_CONSENT_KEY, "accepted");
    setShowBanner(false);
  };

  const handleReject = () => {
    localStorage.setItem(COOKIE_CONSENT_KEY, "rejected");
    setShowBanner(false);
  };

  if (!showBanner) {
    return null;
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-gray-900 border-t border-gray-800 shadow-lg" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1">
            <p className="text-sm text-gray-300">
              <span className="font-semibold">We use cookies</span> to improve your experience and analyze site usage. 
              This site uses essential cookies for functionality and may use analytics cookies to understand how visitors interact with the site.
            </p>
            <p className="mt-1 text-xs text-gray-500">
              By clicking &quot;Accept&quot;, you consent to our use of cookies. You can also{" "}
              <button
                onClick={handleReject}
                className="underline hover:text-gray-400"
              >
                reject non-essential cookies
              </button>
              .{" "}
              <a
                href="/privacy"
                className="underline hover:text-gray-400"
              >
                Privacy Policy
              </a>
            </p>
          </div>
          <div className="flex gap-3 sm:flex-shrink-0">
            <button
              onClick={handleReject}
              className="rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:border-gray-600 hover:bg-gray-700"
            >
              Reject
            </button>
            <button
              onClick={handleAccept}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              Accept
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
