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

Results are cached in-memory (LRU, keyed by normalized query; degraded resolver fallbacks are not cached) so repeat searches skip the AI call, and identical in-flight queries share one run. `/api/search` is rate-limited per IP.

### Query Assembly

The pipeline produces an intermediate representation (IR) that is assembled into a Scryfall query string. The editable query field and token preview both show this final Scryfall query.

### Reference data caches

Scryfall catalogs, sets, keywords and Tagger tags are cached as JSON in `CACHE_DIR` (`./data` locally, `/tmp` on serverless). A fresh instance with no cache file starts from the committed snapshots in `data/seed/` (no blocking upstream fetches), and any cache whose date stamp is older than today is refreshed in the background on the next request (stale-while-revalidate) — no cron job needed. Refresh the snapshots with `npm run seed`.

### Pre-built search pages

`data/seo-queries.json` lists `/search/<slug>` pages whose query was resolved and verified once by `npm run seo:verify` (the example queries, plus `data/top-queries.txt` when present — one query or `/search/<slug>` path per line). Those pages render their first page of cards on the server by replaying the stored Scryfall query, so crawlers get real content and never trigger an AI call. They are listed in the sitemap.

## Local Development

### Prerequisites

- Node.js 20+ and npm
- An OpenAI or Anthropic API key

### Setup

1. **Clone the repository**

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Set up environment variables**: copy `.env.example` to `.env.local` and fill in the key for your provider.

4. **Run the development server**:
   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000)

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AI_PROVIDER` | No | `openai` | `openai` or `claude` |
| `OPENAI_API_KEY` | When provider is `openai` | — | OpenAI API key |
| `OPENAI_MODEL` | No | `gpt-4.1-mini` | OpenAI model for query extraction |
| `OPENAI_REASONING_EFFORT` | No | — | `low` / `medium` / `high` for reasoning models |
| `ANTHROPIC_API_KEY` | When provider is `claude` | — | Anthropic API key |
| `CLAUDE_MODEL` | No | `claude-haiku-4-5` | Claude model for query extraction |
| `SCRYFALL_USER_AGENT` | No | `find-that-card/1.0 (+https://findthatcard.net)` | User-Agent for Scryfall requests |
| `NEXT_PUBLIC_CARDTRADER_SHARE_CODE` | No | `thecultist` | CardTrader share code for buy links |
| `TCG_PLAYER_PARTNER_LINK` | No | — | TCGPlayer partner link base URL |
| `RESEND_API_KEY` | For bug reports | — | Resend API key (reports go to the address in `app/api/report-bug/route.ts`) |
| `CACHE_DIR` | No | `./data` / `/tmp` | Where reference-data caches are written |
| `CACHE_REFRESH` | No | — | `off` disables background cache refreshes (CI) |
| `LOG_SEARCH_PIPELINE_DEBUG` / `LOG_AI_AGENT_PROMPT` | No | — | Verbose pipeline / AI prompt logging |

## Testing

```bash
npm test          # deterministic self-checks (no live AI calls)
npm run lint
npm run build     # includes the typecheck
```

CI (`.github/workflows/ci.yml`) runs lint, tests and build on every push to `main` and every PR, against the seed snapshots (`CACHE_REFRESH=off`). For end-to-end checks against live AI + Scryfall, use `npm run search:qa` or `npm run seo:verify`.

## Project Structure

```
findthatcard/
├── app/
│   ├── page.tsx                    # Home page (wraps SearchPage in Suspense)
│   ├── layout.tsx                  # Root layout: fonts, metadata, analytics, cookie banner
│   ├── about/page.tsx, privacy/page.tsx
│   ├── sitemap.ts                  # Static pages + pre-built search pages
│   ├── search/
│   │   ├── page.tsx                # /search?q=... with dynamic metadata
│   │   └── [slug]/page.tsx         # /search/query-slug (server-rendered when pre-built)
│   ├── components/
│   │   ├── SearchPage.tsx          # Main client component: all search UI state
│   │   ├── CardCard.tsx            # Card grid cell with flip, buy buttons
│   │   ├── CardDetailPanel.tsx     # Card detail <dialog>
│   │   ├── QueryTokenPreview.tsx   # Tokenized Scryfall query display
│   │   ├── CookieBanner.tsx        # Consent banner (Reject opts out of analytics)
│   │   ├── ConsentAnalytics.tsx    # Vercel Analytics, respecting the consent choice
│   │   ├── BugReportButton.tsx     # Bug report <dialog> → email via Resend
│   │   └── …                       # ManaCost, OracleText, KeywordWithTooltip, ThemeToggle, ScrollToTop
│   ├── hooks/usePagerAnimation.ts
│   └── api/
│       ├── search/route.ts         # POST /api/search — rate-limited main search endpoint
│       ├── card/[id]/route.ts      # GET /api/card/:id — full card from Scryfall
│       ├── report-bug/route.ts     # Rate-limited bug reports via Resend
│       └── sets/, catalogs/, keywords/, keyword-definitions/
├── lib/
│   ├── ai-client.ts                # OpenAI / Anthropic calls (plain + structured)
│   ├── search-pipeline/
│   │   ├── types.ts                # IR types: SearchPipelineIR, QueryIntent, etc.
│   │   ├── runSearchPipeline.ts    # Public entry point — delegates to V2
│   │   ├── resolveIntentClauses.ts # Intent resolver: similar/art-like/synergy named-card intents
│   │   ├── similar-cards.ts        # Similar-card and art-like resolvers
│   │   ├── synergy-cards.ts        # Synergy resolver
│   │   ├── card-query-sanitize.ts  # Sanitizers for LLM-produced clauses
│   │   ├── assembleQuery.ts        # IR → Scryfall query string
│   │   ├── compound.ts             # Splits top-level "or" queries into branches
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
│   │   ├── http.ts                 # scryfallFetch: headers, timeout, 429 retry
│   │   ├── client.ts               # Search + pagination
│   │   ├── query-converter.ts      # Query helpers: archetypes, quoting/balancing/truncation, direct-query detection
│   │   ├── response-transformer.ts # Alchemy substitution, buy links
│   │   ├── catalogs.ts, sets.ts    # Reference-data caches
│   │   ├── catalog-index.ts        # In-memory indexes for subtype / card-name matching
│   │   ├── lookup.ts               # Fuzzy card lookup via /cards/named
│   │   ├── symbols.ts              # Mana symbol SVG cache (browser)
│   │   └── tagger-graphql.ts       # Tagger GraphQL API (CSRF session, reused)
│   ├── tagger/                     # Tagger tag cache, query context, validation
│   ├── utils/                      # Cache loader, rate limiter, validation, errors, text
│   ├── seo-pages.ts                # Pre-built search pages (server render)
│   ├── search-slug.ts              # /search/<slug> ↔ query
│   ├── mtg-keywords.ts             # Keyword cache + reminder text
│   ├── query-tokens.ts             # Scryfall query tokenizer for QueryTokenPreview
│   ├── example-queries.ts          # Example query strings
│   └── cache-paths.ts              # /tmp on serverless, ./data locally
├── scripts/
│   ├── seed-caches.ts              # npm run seed
│   ├── verify-seo-queries.ts       # npm run seo:verify
│   └── search-qabot.ts             # npm run search:qa
├── data/
│   ├── seed/                       # Committed cache snapshots (fresh-instance fallback)
│   ├── seo-queries.json            # Pre-built search pages
│   └── mtg-keyword-reminders.json
└── types/scryfall.ts
```

## Deployment to Vercel

1. Push your code to GitHub
2. Import the repository at [vercel.com](https://vercel.com)
3. Add environment variables in Vercel project settings
4. Deploy — Next.js App Router is detected automatically

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
