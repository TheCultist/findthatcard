import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="mb-8">
          <Link
            href="/"
            className="text-blue-400 hover:underline text-sm mb-4 inline-block"
          >
            ← Back to search
          </Link>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Privacy Policy
          </h1>
          <p className="mt-2 text-sm text-gray-400">
            Last updated: {new Date().toLocaleDateString()}
          </p>
        </div>

        {/* Content */}
        <div className="prose prose-invert max-w-none space-y-6 text-gray-300">
          <section>
            <h2 className="text-2xl font-semibold text-gray-100 mb-3">Data Collection</h2>
            <p className="text-sm leading-relaxed">
              Find That Card is a search tool for Magic: The Gathering cards. We collect minimal data necessary for the service to function:
            </p>
            <ul className="list-disc list-inside mt-3 space-y-2 text-sm">
              <li>Search queries are processed to generate Scryfall API queries</li>
              <li>Cookie consent preferences are stored locally in your browser</li>
              <li>No personal information is collected or stored</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-100 mb-3">Cookies</h2>
            <p className="text-sm leading-relaxed">
              We use cookies to:
            </p>
            <ul className="list-disc list-inside mt-3 space-y-2 text-sm">
              <li>Remember your cookie consent preference</li>
              <li>Store cached data for improved performance (mana symbol images)</li>
            </ul>
            <p className="text-sm leading-relaxed mt-3">
              You can accept or reject non-essential cookies using the cookie banner. Essential cookies are required for the site to function.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-100 mb-3">Third-Party Services</h2>
            <p className="text-sm leading-relaxed">
              This site uses the following third-party services:
            </p>
            <ul className="list-disc list-inside mt-3 space-y-2 text-sm">
              <li>
                <strong>Scryfall API</strong> - Card data and images are fetched from Scryfall&apos;s public API
              </li>
              <li>
                <strong>OpenAI API</strong> - Natural language queries are converted to Scryfall syntax using OpenAI
              </li>
            </ul>
            <p className="text-sm leading-relaxed mt-3">
              We do not share your data with third parties beyond what is necessary for the service to function.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-100 mb-3">Data Storage</h2>
            <p className="text-sm leading-relaxed">
              All data processing happens in real-time. We do not store:
            </p>
            <ul className="list-disc list-inside mt-3 space-y-2 text-sm">
              <li>Search queries</li>
              <li>Search results</li>
              <li>User accounts or personal information</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-100 mb-3">Your Rights</h2>
            <p className="text-sm leading-relaxed">
              Under GDPR and other privacy regulations, you have the right to:
            </p>
            <ul className="list-disc list-inside mt-3 space-y-2 text-sm">
              <li>Access any data we hold about you (we don&apos;t store personal data)</li>
              <li>Request deletion of your data (clear your browser&apos;s localStorage)</li>
              <li>Withdraw consent for cookies at any time</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-100 mb-3">Contact</h2>
            <p className="text-sm leading-relaxed">
              If you have questions about this privacy policy, please contact us at findthatcard@thecultist.it.
            </p>
          </section>
        </div>

        {/* Footer */}
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
