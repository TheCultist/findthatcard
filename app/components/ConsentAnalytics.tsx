"use client";

import { Analytics } from "@vercel/analytics/next";
import { readConsent } from "@/app/components/CookieBanner";

/** beforeSend sees page views and custom track() events alike, so a rejection drops both. */
export default function ConsentAnalytics() {
  return <Analytics beforeSend={(event) => (readConsent() === "rejected" ? null : event)} />;
}
