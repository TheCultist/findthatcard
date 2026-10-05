import type { Metadata } from "next";
import Link from "next/link";
import ThemeToggle from "@/app/components/ThemeToggle";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Find That Card privacy policy. No ads or tracking cookies, cookieless analytics you can opt out of, and how searches are processed by Scryfall and our AI provider.",
  openGraph: {
    title: "Privacy Policy | Find That Card",
    description:
      "How Find That Card handles your searches, analytics, and third-party services. No ads or tracking cookies.",
    url: "https://www.findthatcard.net/privacy",
  },
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex justify-end">
          <ThemeToggle />
        </div>
        {/* Header */}
        <div className="mb-8">
          <Link
            href="/"
            className="text-accent hover:underline text-sm mb-4 inline-block"
          >
            ← Back to search
          </Link>
          <h1 className="font-display text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            Privacy Policy
          </h1>
          <p className="mt-2 text-sm text-muted">Last updated: October 5, 2026</p>
        </div>

        {/* Content */}
        <div className="prose max-w-none space-y-6 text-muted">
          <section>
            <h2 className="font-display text-2xl font-semibold text-foreground mb-3">Summary</h2>
            <p className="text-sm leading-relaxed">
              Find That Card is a search tool for Magic: The Gathering cards. There are no user accounts, no
              advertising networks and no advertising or tracking cookies. The site itself sets no cookies at all.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-semibold text-foreground mb-3">Your Searches</h2>
            <p className="text-sm leading-relaxed">
              When you search, the text you type is sent to our server and processed as follows:
            </p>
            <ul className="list-disc list-inside mt-3 space-y-2 text-sm">
              <li>
                Plain-language searches are sent to our AI provider (OpenAI or Anthropic, depending on our
                configuration) to be converted into Scryfall syntax. Only the search text is sent, not your IP
                address or any identifier.
              </li>
              <li>Searches already written in Scryfall syntax skip the AI step entirely.</li>
              <li>
                The resulting query is sent from our server to Scryfall, and community tags may be looked up on
                Scryfall Tagger.
              </li>
              <li>
                Your search appears in the page address (for example <code>/search?q=...</code>) so results can be
                bookmarked and shared.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-2xl font-semibold text-foreground mb-3">Stored in Your Browser</h2>
            <p className="text-sm leading-relaxed">
              We use your browser&apos;s local storage (not cookies) for two settings, which never leave your device:
            </p>
            <ul className="list-disc list-inside mt-3 space-y-2 text-sm">
              <li>Your light/dark theme preference</li>
              <li>Your choice in the analytics banner (accept or reject)</li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-2xl font-semibold text-foreground mb-3">Analytics</h2>
            <p className="text-sm leading-relaxed">
              We use Vercel Web Analytics, which is privacy-friendly and does not use cookies. It records aggregate
              page views and a few anonymous events, such as opening a card or clicking a buy link (including the
              card name and store). It is not used to identify or follow you across sites.
            </p>
            <p className="text-sm leading-relaxed mt-3">
              If you choose &quot;Reject&quot; in the banner, no analytics data is sent from your browser. To change
              your choice, clear this site&apos;s data in your browser and the banner will appear again.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-semibold text-foreground mb-3">Affiliate Links</h2>
            <p className="text-sm leading-relaxed">
              Buy links to CardTrader and TCGPlayer, and the CavernHold banner, are affiliate links: we may earn a
              commission if you buy something, at no extra cost to you. We don&apos;t share any data with these
              stores. Once you click through, those sites (and their affiliate partners) may set their own cookies
              under their own privacy policies.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-semibold text-foreground mb-3">Bug Reports</h2>
            <p className="text-sm leading-relaxed">
              If you use the bug report button, your description, your search, the generated Scryfall query and the
              screenshot you choose to attach (if any) are emailed to us through Resend. We use them only to fix
              search problems. Please don&apos;t include personal information in screenshots.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-semibold text-foreground mb-3">Third-Party Services</h2>
            <ul className="list-disc list-inside mt-3 space-y-2 text-sm">
              <li>
                <strong>Scryfall</strong>: card data and community tags are fetched by our server. Card images and
                mana symbols load directly from Scryfall in your browser, so Scryfall receives the standard request
                information (such as your IP address) for those files.
              </li>
              <li>
                <strong>OpenAI or Anthropic</strong>: converts plain-language search text into Scryfall syntax.
              </li>
              <li>
                <strong>Vercel</strong>: hosts the site. Like any web host, it processes IP addresses and request
                details, and our server logs (which include search text) are kept for a limited time.
              </li>
              <li>
                <strong>Resend</strong>: delivers bug reports to us by email.
              </li>
            </ul>
            <p className="text-sm leading-relaxed mt-3">
              We do not sell your data or share it with third parties beyond what is needed for the service to work.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-semibold text-foreground mb-3">Data Storage</h2>
            <p className="text-sm leading-relaxed">
              We have no database of users or searches. To keep the service fast and fair, our server briefly holds
              in memory recent query conversions and per-IP request counts for rate limiting; these are discarded
              automatically. Apart from hosting logs and any bug reports you send, we do not keep your searches.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl font-semibold text-foreground mb-3">Your Rights</h2>
            <p className="text-sm leading-relaxed">
              Under GDPR and other privacy regulations, you have the right to:
            </p>
            <ul className="list-disc list-inside mt-3 space-y-2 text-sm">
              <li>Ask what data we hold about you (normally none beyond any bug report you sent)</li>
              <li>Ask us to delete a bug report you sent</li>
              <li>Opt out of analytics with the banner&apos;s &quot;Reject&quot; button</li>
              <li>Remove the settings stored on your device by clearing this site&apos;s data in your browser</li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-2xl font-semibold text-foreground mb-3">Contact</h2>
            <p className="text-sm leading-relaxed">
              If you have questions about this privacy policy, please contact us at findthatcard@thecultist.it.
            </p>
          </section>
        </div>

        {/* Footer */}
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
