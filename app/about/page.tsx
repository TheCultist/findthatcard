import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import ThemeToggle from "@/app/components/ThemeToggle";

export const metadata: Metadata = {
  title: "Cardboard Cultist — MTG Creator",
  description:
    "Meet Cardboard Cultist, creator of Find That Card — the free MTG card search that turns natural language into Scryfall queries. Commander, art tags, and more.",
  openGraph: {
    title: "About | Find That Card - MTG Card Search",
    description:
      "Meet Cardboard Cultist, creator of Find That Card — the free MTG card search that turns natural language into Scryfall queries.",
    url: "https://www.findthatcard.net/about",
  },
};

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex justify-end">
          <ThemeToggle />
        </div>
        <div className="mb-8 text-center">
          <Link
            href="/"
            className="text-accent hover:underline text-sm mb-4 inline-block"
          >
            ← Back to search
          </Link>
          <h1 className="font-display text-4xl font-bold tracking-tight text-foreground sm:text-5xl">About</h1>
          <p className="mt-2 text-sm text-muted">
            Meet the creator behind Find That Card.
          </p>
        </div>

        <div className="relative overflow-hidden rounded-3xl border border-border bg-surface-muted p-8 text-center shadow-[0_1px_0_0_hsl(var(--border)),0_20px_50px_-25px_rgba(0,0,0,0.1)] sm:p-10">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent" />
          <div className="relative prose max-w-none space-y-6 text-muted">
            <div className="mx-auto mb-8 flex justify-center">
              <div className="rounded-full border border-border bg-surface p-2 shadow-lg shadow-accent/5">
                <Image
                  src="/brand/Cardboard Cultist Profile Pic.png"
                  alt="Cardboard Cultist logo"
                  width={180}
                  height={180}
                  className="h-32 w-32 rounded-full object-cover sm:h-40 sm:w-40"
                  priority
                />
              </div>
            </div>
            <section>
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">
                MTG Content Creator
              </p>
              <h2 className="font-display mt-3 text-2xl font-semibold text-foreground sm:text-3xl">
                Cardboard Cultist
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
                Find That Card is a personal project by Cardboard Cultist, an MTG content creator
                focused on Commander, card discovery, and MTG memes. The goal is to make it fast and
                fun to find the perfect card by describing what you remember or want to build.
              </p>
            </section>

            <section>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <a
                  href="https://www.instagram.com/card_cultist/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center rounded-full border border-border bg-surface-muted px-5 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent/50 hover:bg-accent-muted"
                >
                  Instagram
                </a>
                <a
                  href="https://www.tiktok.com/@cardboardcultist"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center rounded-full border border-border bg-surface-muted px-5 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent/50 hover:bg-accent-muted"
                >
                  TikTok
                </a>
                <a
                  href="https://www.youtube.com/@card_cultist"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center rounded-full border border-border bg-surface-muted px-5 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent/50 hover:bg-accent-muted"
                >
                  YouTube
                </a>
              </div>
            </section>
          </div>
        </div>

        <footer className="mt-16 border-t border-border pt-8 text-center text-xs text-muted">
          <p>
            Unofficial fan content. Card data and images from{" "}
            <a
              href="https://scryfall.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              Scryfall
            </a>
            . Not endorsed by Wizards of the Coast or Scryfall.
          </p>
        </footer>
      </div>
    </main>
  );
}
