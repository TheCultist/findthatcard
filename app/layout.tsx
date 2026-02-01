import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Find That Card",
  description: "Search Magic: The Gathering cards using natural language. Supports art and function tags from Scryfall Tagger.",
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
      </head>
      <body className="min-h-screen bg-gray-950 text-gray-100 antialiased">
        {children}
      </body>
    </html>
  );
}
