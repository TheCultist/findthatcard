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

const defaultDescription =
  "Search MTG cards in plain English. Natural language MTG search with Scryfall Tagger art & function tags. Find Commander, Modern & Pauper cards fast.";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://www.findthatcard.net"),
  title: {
    default: "MTG Card Search — Natural Language | Find That Card",
    template: "%s | Find That Card",
  },
  description: defaultDescription,
  keywords: [
    "MTG card search",
    "Magic card search",
    "natural language MTG search",
    "Scryfall alternative",
    "MTG card finder",
    "Commander card search",
    "Scryfall Tagger",
  ],
  openGraph: {
    type: "website",
    siteName: "Find That Card",
    title: "MTG Card Search — Natural Language | Find That Card",
    description: defaultDescription,
    url: "https://www.findthatcard.net",
    images: [{ url: "/brand/og-image.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "MTG Card Search — Natural Language | Find That Card",
    description: defaultDescription,
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
              "@graph": [
                {
                  "@type": "WebSite",
                  "@id": "https://www.findthatcard.net/#website",
                  name: "Find That Card",
                  url: "https://www.findthatcard.net",
                  description: defaultDescription,
                  publisher: {
                    "@id": "https://www.findthatcard.net/#organization",
                  },
                  potentialAction: {
                    "@type": "SearchAction",
                    target: {
                      "@type": "EntryPoint",
                      urlTemplate:
                        "https://www.findthatcard.net/search?q={search_term_string}",
                    },
                    "query-input": "required name=search_term_string",
                  },
                },
                {
                  "@type": "Organization",
                  "@id": "https://www.findthatcard.net/#organization",
                  name: "Find That Card",
                  url: "https://www.findthatcard.net",
                  logo: "https://www.findthatcard.net/brand/cardicon.svg",
                  sameAs: [
                    "https://www.instagram.com/card_cultist/",
                    "https://www.tiktok.com/@cardboardcultist",
                    "https://www.youtube.com/@card_cultist",
                  ],
                },
                {
                  "@type": "Person",
                  "@id": "https://www.findthatcard.net/about#person",
                  name: "Cardboard Cultist",
                  url: "https://www.findthatcard.net/about",
                  jobTitle: "MTG Content Creator",
                  sameAs: [
                    "https://www.instagram.com/card_cultist/",
                    "https://www.tiktok.com/@cardboardcultist",
                    "https://www.youtube.com/@card_cultist",
                  ],
                },
                {
                  "@type": "FAQPage",
                  "@id": "https://www.findthatcard.net/#faq",
                  mainEntity: [
                    {
                      "@type": "Question",
                      name: "How do I search MTG cards with natural language?",
                      acceptedAnswer: {
                        "@type": "Answer",
                        text: "Type what you remember or want in plain English — e.g. 'white creatures', 'removal spells', 'cards with dragon art'. Find That Card converts your query to Scryfall syntax and shows results instantly.",
                      },
                    },
                    {
                      "@type": "Question",
                      name: "Does Find That Card support Scryfall Tagger tags?",
                      acceptedAnswer: {
                        "@type": "Answer",
                        text: "Yes. Use art: (e.g. art:dragon) and function: (e.g. function:removal) tags from Scryfall Tagger. You can also describe art or roles in natural language.",
                      },
                    },
                    {
                      "@type": "Question",
                      name: "What formats does Find That Card support?",
                      acceptedAnswer: {
                        "@type": "Answer",
                        text: "Commander, Modern, Pauper, Standard, and more. Use format names in your query, e.g. 'Commander legal ramp' or 'Modern removal spells'.",
                      },
                    },
                  ],
                },
              ],
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
