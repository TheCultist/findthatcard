# Find That Card

A Magic: The Gathering card search tool that converts natural language queries into Scryfall search queries using a multi-phase NLP pipeline, and displays results in a clean, responsive interface.

**Live at:** [findthatcard.net](https://findthatcard.net)

## Features

- **Natural Language Search**: Describe what you're looking for in plain English
- **Multi-Phase Search Pipeline**: Deterministic NLP parser handles colors, formats, types, keywords, and strategies before falling back to AI for unresolved fragments
- **Direct Scryfall Query Support**: Enter Scryfall queries directly (e.g., `t:creature c:r`) — the app detects and passes them through without conversion
- **Editable Query Field**: View and edit the generated Scryfall query as tokenized chips or raw text
- **Scryfall Tagger Support**: Native support for art and function tags from [Scryfall Tagger](https://tagger.scryfall.com)
  - Art tags: `art:`, `atag:`, `arttag:` (e.g., `art:dragon`, `art:"black cat"`)
  - Function tags: `function:`, `otag:`, `oracletag:` (e.g., `function:removal`, `function:card-advantage`)
- **Similar Card Search**: Find cards similar to a named card, including art-alike search via Tagger data
- **Pagination**: 60 cards per page with Previous/Next and jump-to-page controls
- **Card Detail Panel**: Tap any card to open a full detail sheet with legalities, keywords, and buy links
- **Buy Links**: CardTrader and TCGPlayer affiliate buttons per card, with 404-fallback handling
- **Example Query Chips**: 350+ example queries shown as random chips on each load
- **Pro Tips**: Rotating tips displayed during search loading
- **Responsive Design**: Works on desktop, tablet, and mobile with swipe-to-dismiss on mobile panels
- **Dark Mode**: System-aware with manual toggle, persisted to localStorage

## Tech Stack

- **Next.js 15** (App Router, Turbopack in dev)
- **TypeScript**
- **Tailwind CSS**
- **OpenAI API** — used only for unresolved query fragments and Phase 0 normalization
- **Scryfall API** — card data, catalogs, sets, and symbology
- **Scryfall Tagger** — art and function tag data (scraped/cached)
- **Resend** — bug report emails

## How It Works

### Search Pipeline

Queries go through a five-phase pipeline before hitting Scryfall:

1. **Phase 0 — Normalization** *(optional, LLM)*: Detects structurally ambiguous queries (e.g. missing connectors) and rewrites them. Most queries skip this phase entirely.

2. **Phase 1 — Deterministic NLP Parser** *(no LLM)*: A frozen, rule-based parser handles the majority of queries without any AI calls. It extracts:
   - Colors and color identities (including guild/shard/wedge/nephilim names)
   - Formats (Standard, Modern, Commander, Pauper, etc.)
   - Card types and subtypes (matched against live Scryfall catalog indexes)
   - MTG keyword abilities (Flying, Trample, etc.) with synonym expansion
   - Tagger function/art tags via strategy expansions
   - Artist names, set names, and CMC/stat filters
   - Named land cycles, IS-flags (MDFC, adventure, etc.), and explicit action verbs

   Phase 1 is **intentionally frozen** — new colloquial patterns are handled in Phase 1.5, not by expanding this parser.

3. **Phase 1.5 — Structured AI Extraction** *(LLM, optional)*: Runs only when concrete numeric, rarity, or year-phrase fragments remain after Phase 1. Unlike Phase 2, this phase asks the AI a **narrow, schema-constrained question** ("what are the exact stat/rarity/year values in this text?") and validates the output before injecting it as first-class IR clauses. This replaces the old approach of adding ever-more regex to Phase 1.

4. **Phase 2 — Fragment Resolver** *(LLM, optional)*: Any vibe/strategy/abstract fragments remaining after Phase 1.5 are sent to the AI with a focused resolver prompt. It answers "what Scryfall tags match this theme?" Results are merged back into the IR.

5. **Phase 3 — Finalization**: Post-processing injects archetype tags, suppresses redundant type filters, adds game filters, and validates the assembled query.

6. **Intent resolver**: When Phase 1 detects a named-card intent ("find cards similar to X", "art like X", "synergy with X"), `resolveIntentClauses.ts` fetches card-specific data (Tagger relationship graph, illustration tags, or an LLM synergy query) and injects the result as a `mustClause`. The query then continues through Phase 1.5, 2, and 3 — so any additional constraints the user appended (e.g. "…that aren't instants", "…in Modern") are still applied.

### Query Assembly

The pipeline produces an intermediate representation (IR) that is assembled into a Scryfall query string. The editable query field and token preview both show this final Scryfall query.

## Local Development

### Prerequisites

- Node.js 18+ and npm/yarn/pnpm
- OpenAI API key ([get one here](https://platform.openai.com/api-keys))

### Setup

1. **Clone the repository**

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Set up environment variables**:

   Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```

   Edit `.env.local`:
   ```env
   OPENAI_API_KEY=your_openai_api_key_here
   SCRYFALL_USER_AGENT=find-that-card/1.0 (+https://findthatcard.net)
   OPENAI_MODEL=gpt-4.1-mini
   ```

4. **(Optional) Configure affiliate links**:
   ```env
   NEXT_PUBLIC_CARDTRADER_SHARE_CODE=your_share_code
   TCG_PLAYER_PARTNER_LINK=https://partner.tcgplayer.com/XXXXXXXX
   ```

5. **Run the development server**:
   ```bash
   npm run dev
   ```

6. Open [http://localhost:3000](http://localhost:3000)

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key |
| `SCRYFALL_USER_AGENT` | No | `find-that-card/1.0` | User-Agent for Scryfall API requests |
| `OPENAI_MODEL` | No | `gpt-4.1-mini` | OpenAI model for query conversion |
| `NEXT_PUBLIC_CARDTRADER_SHARE_CODE` | No | `thecultist` | CardTrader share code for buy links |
| `TCG_PLAYER_PARTNER_LINK` | No | — | TCGPlayer partner link base URL |
| `CRON_SECRET` | No | — | Secret for Vercel cron job authentication |
| `RESEND_API_KEY` | No | — | Resend API key for bug report emails |
| `BUG_REPORT_TO_EMAIL` | No | — | Recipient address for bug reports |

## Testing

```bash
npm run test:queries
npm run lint
```

The test suite (`lib/search-pipeline/search-pipeline.test.ts`) contains 50+ assertion-based tests covering the full pipeline.

## Project Structure

```
findthatcard/
├── app/
│   ├── page.tsx                    # Home page (wraps SearchPage in Suspense)
│   ├── layout.tsx                  # Root layout: fonts, metadata, analytics
│   ├── globals.css                 # Tailwind base + custom utilities
│   ├── about/page.tsx
│   ├── privacy/page.tsx
│   ├── search/
│   │   ├── page.tsx                # /search?q=... with dynamic metadata
│   │   └── [slug]/page.tsx        # /search/query-slug SEO-friendly URL
│   ├── components/
│   │   ├── SearchPage.tsx          # Main client component: all search UI state
│   │   ├── CardCard.tsx            # Card thumbnail grid cell with flip, buy buttons
│   │   ├── CardDetailPanel.tsx     # Mobile-friendly modal sheet for card details
│   │   ├── ManaCost.tsx            # Renders {W}{U}{B}{R}{G} as SVG symbols
│   │   ├── OracleText.tsx          # Renders oracle text with inline mana symbols
│   │   ├── KeywordWithTooltip.tsx  # Keyword badge with hover tooltip
│   │   ├── QueryTokenPreview.tsx   # Tokenized Scryfall query display
│   │   ├── ThemeToggle.tsx         # Light/dark mode toggle
│   │   ├── ScrollToTop.tsx         # Floating back-to-top button
│   │   ├── CookieBanner.tsx        # GDPR cookie consent banner
│   │   ├── BugReportButton.tsx     # Floating bug report → email via Resend
│   │   └── AdBanner.tsx            # Google AdSense banner
│   ├── hooks/
│   │   └── useAdBlockDetection.ts
│   └── api/
│       ├── search/route.ts         # POST /api/search — main search endpoint
│       ├── card/[id]/route.ts      # GET /api/card/:id — full card from Scryfall
│       ├── sets/route.ts
│       ├── catalogs/route.ts
│       ├── keywords/route.ts
│       ├── keyword-definitions/route.ts
│       ├── check-link/route.ts     # HEAD-checks CardTrader links before navigation
│       ├── report-bug/route.ts     # Sends bug reports via Resend
│       └── cron/midnight/route.ts  # Vercel cron job (daily cache refresh)
├── lib/
│   ├── search-pipeline/
│   │   ├── types.ts                # IR types: SearchPipelineIR, QueryIntent, etc.
│   │   ├── runSearchPipeline.ts    # Orchestrates Phase 0–1.5–2–3 + intent resolver
│   │   ├── resolveIntentClauses.ts # Intent resolver: similar/art-like/synergy named-card intents
│   │   ├── assembleQuery.ts        # IR → Scryfall query string
│   │   ├── similar-cards.ts        # Similar-card and art-like resolvers
│   │   ├── phase0/normalizeQuery.ts
│   │   ├── phase1/                 # Deterministic NLP parser (FROZEN — do not expand)
│   │   │   ├── parseNaturalQuery.ts    # Main parser entry point
│   │   │   ├── constants.ts            # Shared token lists and maps
│   │   │   ├── resolveStats.ts         # Numeric stat filter resolution
│   │   │   ├── resolveRarity.ts        # Rarity filter resolution
│   │   │   ├── isFlags.ts              # Card face / layout IS-flag detection
│   │   │   ├── landCycles.ts           # Named land cycle detection
│   │   │   └── actionRules.ts          # Explicit MTG action verb detection
│   │   ├── phase1_5/
│   │   │   └── structuredExtraction.ts # AI structured extraction for stat/rarity/year
│   │   ├── phase2/
│   │   │   ├── buildResolverPrompt.ts
│   │   │   └── resolveUnresolvedFragments.ts
│   │   ├── phase3/finalizeQuery.ts
│   │   └── search-pipeline.test.ts
│   ├── scryfall/
│   │   ├── client.ts               # Pagination math, multi-page fetching
│   │   ├── query-converter.ts      # Legacy converter + archetype registry
│   │   ├── response-transformer.ts # Alchemy substitution, TCGPlayer links
│   │   ├── symbols.ts              # Mana symbol SVG cache
│   │   ├── lookup.ts               # Fuzzy card lookup via /cards/named
│   │   ├── catalogs.ts             # Daily-refreshed catalog cache
│   │   ├── sets.ts                 # Set cache + set filter resolution
│   │   ├── catalog-index.ts        # In-memory indexes for fuzzy subtype matching
│   │   └── tagger-graphql.ts       # Tagger GraphQL API (CSRF + session)
│   ├── prompts/
│   │   ├── system.ts               # Dynamic system prompt
│   │   ├── user.ts                 # User prompt + tag context formatting
│   │   ├── promptModules.ts        # Modular prompt packs with selectPacks()
│   │   └── regeneration.ts         # Regeneration prompt for invalid-tag fallback
│   ├── tagger/
│   │   ├── cache.ts                # Fetches/caches art: and function: tags
│   │   ├── context.ts              # Narrows relevant tags for the current query
│   │   └── validation.ts           # Tag extraction and validation
│   ├── strategies/
│   │   └── oracletagStrategies.ts  # Strategy → oracletag expansion map
│   ├── cardtrader/links.ts
│   ├── tcgplayer/links.ts
│   ├── mtg-keywords.ts             # Keyword cache + filter injection
│   ├── query-tokens.ts             # Scryfall query tokenizer for QueryTokenPreview
│   ├── example-queries.ts          # 350+ example query strings
│   ├── pro-tips.ts                 # Tips shown during loading
│   ├── cache-paths.ts              # /tmp on serverless, ./data locally
│   └── commander-context.ts        # "my commander" color identity resolution
├── types/
│   └── scryfall.ts                 # ScryfallCard, CardResult, SearchResponse, etc.
├── data/
│   ├── mtg-keywords.json
│   ├── mtg-keyword-reminders.json
│   └── scryfall-catalogs.json
└── vercel.json                     # Cron job: /api/cron/midnight at 0 0 * * *
```

## Deployment to Vercel

1. Push your code to GitHub
2. Import the repository at [vercel.com](https://vercel.com)
3. Add environment variables in Vercel project settings
4. Deploy — Next.js App Router is detected automatically

The `CRON_SECRET` env var is required for the midnight cron job. Set it in Vercel and it will be validated against the `Authorization` header sent by Vercel Cron.

## Usage Examples

### Natural Language Queries

- `"white creatures"`
- `"Dimir removal spells for Commander"`
- `"cards with a black cat in the art"`
- `"modern legal artifacts that draw cards"`
- `"aristocrats payoffs in black"`

### Tagger Tag Queries

- `art:dragon` — cards with dragon artwork
- `function:removal` — cards tagged as removal
- `id:ub function:removal t:instant` — Dimir instant removal

You can also combine Tagger tags with regular Scryfall syntax directly — the app passes them through without conversion.

## Legal & Attribution

Unofficial fan content. Card data and images from [Scryfall](https://scryfall.com) and community tags from [Scryfall Tagger](https://tagger.scryfall.com). Not endorsed by Wizards of the Coast or Scryfall.

## License

MIT
