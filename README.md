# Find That Card

A Magic: The Gathering card search tool that converts natural language queries into Scryfall search queries using a single schema-constrained AI extraction wrapped in deterministic guardrails, and displays results in a clean, responsive interface.

**Live at:** [findthatcard.net](https://findthatcard.net)

## Features

- **Natural Language Search**: Describe what you're looking for in plain English
- **AI Extraction Pipeline**: One schema-constrained AI call extracts colors, formats, types, keywords, stats, tags, and strategies, then deterministic guardrails validate the result against live Scryfall/Tagger catalogs
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

- **Next.js 16** (App Router, Turbopack in dev)
- **TypeScript**
- **Tailwind CSS**
- **OpenAI / Anthropic API** — one structured extraction call per query (provider-selectable via `AI_PROVIDER`)
- **Scryfall API** — card data, catalogs, sets, and symbology
- **Scryfall Tagger** — art and function tag data (scraped/cached)
- **Resend** — bug report emails

## How It Works

### Search Pipeline

A query becomes a Scryfall query through one AI extraction wrapped in deterministic steps:

1. **Pre-pass** *(no LLM)*: Raw Scryfall syntax (e.g. `t:creature c:r`, `name:"X" game:paper`) is detected by `isScryfallQuery` and passed straight through — the AI is never involved. Compound "or" queries are split into branches. Multi-word card names are recognized against a catalog n-gram index so the extractor can protect them.

2. **Structured AI extraction** *(one LLM call)*: A single schema-constrained call (`v2/extractIR.ts` + `v2/extractPrompt.ts` + `v2/schema.ts`) turns the query into a `V2Extraction` object — intent, card name, colors, types/subtypes/supertypes, stats, rarity, year, keywords, format, set, artist, art subjects, function tags, archetypes, and oracle phrases. The prompt is fed a narrowed slice of relevant Tagger tags and the archetype menu.

3. **IR build + validation** *(no LLM)*: `v2/buildIR.ts` is the trust boundary. Because some models treat the schema as a hint, it validates every field against live catalogs (types, subtypes, keywords, card names, Tagger tags) and coerces shape mismatches, dropping anything invalid, before assembling a `SearchPipelineIR`.

4. **Intent resolver**: For a named-card intent ("find cards similar to X", "art like X", "synergy with X"), `resolveIntentClauses.ts` fetches card-specific data (Tagger relationship graph, illustration tags, or an LLM synergy query) and injects it as a `mustClause`. The query still continues to finalization, so appended constraints ("…that aren't instants", "…in Modern") are applied.

5. **Finalization**: `phase3/finalizeQuery.ts` injects archetype tags, suppresses redundant type filters, adds the `game:` filter, sanitizes, and truncates to Scryfall's length limit.

Results are cached in-memory (LRU, keyed by normalized query) so repeat searches skip the AI call.

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

The deterministic self-check (`lib/search-pipeline/v2/v2.test.ts`) asserts extraction-to-IR-to-query behavior on fixed fixtures without any live AI calls. `query-converter.test.ts`, `synergy-cards.test.ts`, and `synergyPartnerMask.test.ts` cover the finalization/assembly helpers. For end-to-end quality spot-checks against real search results, use `npm run search:qa`.

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
│   │   ├── runSearchPipeline.ts    # Public entry point — delegates to V2
│   │   ├── resolveIntentClauses.ts # Intent resolver: similar/art-like/synergy named-card intents
│   │   ├── assembleQuery.ts        # IR → Scryfall query string
│   │   ├── compound.ts             # Splits top-level "or" queries into branches
│   │   ├── synergyPartnerMask.ts   # Masks "combos with X" partner mentions for finalize
│   │   ├── similar-cards.ts        # Similar-card and art-like resolvers
│   │   ├── v2/                     # The pipeline: one AI extraction + guardrails
│   │   │   ├── runV2.ts                # Orchestrator: passthrough, compound, cache, wiring
│   │   │   ├── prePass.ts              # Card-name recognition (n-gram catalog lookup)
│   │   │   ├── schema.ts               # V2Extraction type + JSON schema
│   │   │   ├── extractPrompt.ts        # Builds the extraction prompt
│   │   │   ├── extractIR.ts            # Runs the single structured AI call
│   │   │   ├── buildIR.ts              # Validates AI output → SearchPipelineIR (trust boundary)
│   │   │   ├── cache.ts                # LRU cache keyed by normalized query
│   │   │   └── v2.test.ts              # Deterministic self-check (no live AI)
│   │   └── phase3/finalizeQuery.ts # Archetype injection, sanitization, game filter, truncation
│   ├── scryfall/
│   │   ├── client.ts               # Pagination math, multi-page fetching
│   │   ├── query-converter.ts      # Scryfall query helpers: archetype registry, sanitizers, direct-query detection
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
