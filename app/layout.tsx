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
    <html lang="en" suppressHydrationWarning>
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
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                const theme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
                document.documentElement.classList.toggle('dark', theme === 'dark');
              })();
            `,
          }}
        />
      </head>
      <body suppressHydrationWarning className="min-h-screen bg-white text-gray-900 antialiased dark:bg-gray-950 dark:text-gray-100">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
