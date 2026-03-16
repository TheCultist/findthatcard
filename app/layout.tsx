import type { Metadata, Viewport } from "next";
import { Syne, DM_Sans } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import Script from "next/script";
import ScrollToTop from "./components/ScrollToTop";
import "./globals.css";

const syne = Syne({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const description =
  "Search Magic: The Gathering cards using natural language. Supports art and function tags from Scryfall Tagger.";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://www.findthatcard.net"),
  title: {
    default: "Find That Card",
    template: "%s | Find That Card",
  },
  description,
  openGraph: {
    type: "website",
    siteName: "Find That Card",
    title: "Find That Card",
    description,
    url: "https://www.findthatcard.net",
    images: [{ url: "/brand/og-image.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Find That Card",
    description,
    images: ["/brand/og-image.png"],
  },
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
    <html lang="en" suppressHydrationWarning className={`${syne.variable} ${dmSans.variable}`}>
      <head>
        <meta
          name="impact-site-verification"
          content="fe0d142c-1e97-427f-9abb-35dd9ed1c38f"
        />
      </head>
      <body suppressHydrationWarning className={`${dmSans.className} min-h-screen bg-[hsl(var(--background))] text-[hsl(var(--foreground))] subpixel-antialiased dark:antialiased`}>
        <Script
          id="schema-org"
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "Find That Card",
              url: "https://www.findthatcard.net",
              potentialAction: {
                "@type": "SearchAction",
                target:
                  "https://www.findthatcard.net/search?q={search_term_string}",
                "query-input": "required name=search_term_string",
              },
            }),
          }}
        />
        <Script
          id="theme-script"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                const theme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
                document.documentElement.classList.toggle('dark', theme === 'dark');
              })();
            `,
          }}
        />
        <Script
          id="adsense"
          async
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1161939859067558"
          crossOrigin="anonymous"
          strategy="afterInteractive"
        />
        {children}
        <ScrollToTop />
        <Analytics />
      </body>
    </html>
  );
}
