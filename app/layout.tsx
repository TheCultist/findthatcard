import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Find That Card",
  description: "Search Magic: The Gathering cards using natural language. Supports art and function tags from Scryfall Tagger.",
  icons: {
    icon: "/brand/cardicon.svg",
    shortcut: "/brand/cardicon.svg",
    apple: "/brand/cardicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <script
          async
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1161939859067558"
          crossOrigin="anonymous"
        />
        <meta
          name="impact-site-verification"
          content="fe0d142c-1e97-427f-9abb-35dd9ed1c38f"
        />
      </head>
      <body suppressHydrationWarning className="min-h-screen bg-gray-950 text-gray-100 antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
