import Image from "next/image";
import Link from "next/link";

export default function AboutPage() {
  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 text-center">
          <Link
            href="/"
            className="text-blue-400 hover:underline text-sm mb-4 inline-block"
          >
            ← Back to search
          </Link>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">About</h1>
          <p className="mt-2 text-sm text-gray-400">
            Meet the creator behind Find That Card.
          </p>
        </div>

        <div className="relative overflow-hidden rounded-3xl border border-gray-800/80 bg-gray-900/40 p-8 text-center shadow-[0_20px_60px_-40px_rgba(59,130,246,0.6)] sm:p-10">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-blue-500/10 via-transparent to-transparent" />
          <div className="relative prose prose-invert max-w-none space-y-6 text-gray-300">
            <div className="mx-auto mb-8 flex justify-center">
              <div className="rounded-full border border-gray-700/80 bg-gray-900/60 p-2 shadow-lg shadow-blue-500/10">
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
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-blue-300/80">
                MTG Content Creator
              </p>
              <h2 className="mt-3 text-2xl font-semibold text-gray-100 sm:text-3xl">
                Cardboard Cultist
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-gray-300 sm:text-lg">
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
                  className="inline-flex items-center justify-center rounded-full border border-gray-700 bg-gray-900 px-5 py-2 text-sm font-medium text-gray-200 transition-colors hover:border-blue-400/60 hover:bg-blue-500/10"
                >
                  Instagram
                </a>
                <a
                  href="https://www.tiktok.com/@cardboardcultist"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center rounded-full border border-gray-700 bg-gray-900 px-5 py-2 text-sm font-medium text-gray-200 transition-colors hover:border-blue-400/60 hover:bg-blue-500/10"
                >
                  TikTok
                </a>
                <a
                  href="https://www.youtube.com/@card_cultist"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center rounded-full border border-gray-700 bg-gray-900 px-5 py-2 text-sm font-medium text-gray-200 transition-colors hover:border-blue-400/60 hover:bg-blue-500/10"
                >
                  YouTube
                </a>
              </div>
            </section>
          </div>
        </div>

        <footer className="mt-16 border-t border-gray-800 pt-8 text-center text-xs text-gray-500">
          <p>
            Unofficial fan content. Card data and images from{" "}
            <a
              href="https://scryfall.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
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
