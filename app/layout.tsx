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
      <body className="min-h-screen bg-gray-950 text-gray-100 antialiased">
        {children}
      </body>
    </html>
  );
}
