# Find That Card

A single-page web application that converts natural language queries into Scryfall search queries using OpenAI, and displays Magic: The Gathering card results in a clean, responsive interface.

**Live at:** [findthat.card](https://findthat.card)

## Features

- **Natural Language Search**: Describe what you're looking for in plain English
- **Direct Scryfall Query Support**: Enter Scryfall queries directly (e.g., `t:creature c:r`) - the app detects and uses them without conversion
- **Editable Query Field**: View and edit the generated Scryfall query to refine your search or learn the syntax
- **Pagination**: Navigate through search results with Previous/Next buttons (60 cards per page)
- **Example Query Chips**: Click random example queries displayed as chips to quickly try different searches
- **Scryfall Tagger Support**: Native support for art and function tags from [Scryfall Tagger](https://tagger.scryfall.com)
  - Art tags: `art:`, `atag:`, `arttag:` (e.g., `art:dragon`, `art:"black cat"`)
  - Function tags: `function:`, `otag:`, `oracletag:` (e.g., `function:removal`, `function:card-advantage`)
- **Query Transparency**: See the generated Scryfall query for learning purposes
- **View on Scryfall**: Open search results directly on Scryfall.com with one click
- **Responsive Design**: Works beautifully on desktop, tablet, and mobile
- **Fast & Clean**: Minimal dependencies, optimized for performance

## Tech Stack

- **Next.js 14+** (App Router)
- **TypeScript**
- **Tailwind CSS**
- **OpenAI API** (for natural language → Scryfall query conversion)
- **Scryfall API** (for card data)

## Local Development

### Prerequisites

- Node.js 18+ and npm/yarn/pnpm
- OpenAI API key ([get one here](https://platform.openai.com/api-keys))

### Setup

1. **Clone the repository** (or navigate to the project directory)

2. **Install dependencies**:
   ```bash
   npm install
   # or
   yarn install
   # or
   pnpm install
   ```

3. **Set up environment variables**:
   
   Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```
   
   Edit `.env.local` and add your OpenAI API key:
   ```env
   OPENAI_API_KEY=your_openai_api_key_here
   SCRYFALL_USER_AGENT=find-that-card/1.0 (+https://findthat.card)
   OPENAI_MODEL=gpt-4.1-mini
   ```

4. **Run the development server**:
   ```bash
   npm run dev
   # or
   yarn dev
   # or
   pnpm dev
   ```

5. **Open your browser**:
   
   Navigate to [http://localhost:3000](http://localhost:3000)

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | - | Your OpenAI API key |
| `SCRYFALL_USER_AGENT` | No | `find-that-card/1.0` | User-Agent string for Scryfall API requests |
| `OPENAI_MODEL` | No | `gpt-4.1-mini` | OpenAI model to use for query conversion |

## Deployment to Vercel

This project is optimized for Vercel deployment:

1. **Push your code to GitHub** (or your preferred Git provider)

2. **Import your project in Vercel**:
   - Go to [vercel.com](https://vercel.com)
   - Click "Add New Project"
   - Import your repository

3. **Add environment variables**:
   - In the Vercel project settings, go to "Environment Variables"
   - Add `OPENAI_API_KEY` with your API key
   - Optionally add `SCRYFALL_USER_AGENT` and `OPENAI_MODEL`

4. **Deploy**:
   - Vercel will automatically detect Next.js and deploy
   - Your app will be live at `https://your-project.vercel.app`

### Vercel Configuration Notes

- No special configuration needed - Next.js App Router works out of the box
- Serverless functions are automatically configured
- Environment variables are securely stored and injected at runtime

## Usage Examples

### Natural Language Queries

- `"white creatures"`
- `"blue instant spells"`
- `"cards with dragons in the art"`
- `"cards with a black cat in the art"`
- `"removal spells"`
- `"Dimir removal spells"`
- `"modern legal cards with sword art"`
- `"commander legal cards"`
- `"pauper removal"`

### Tagger Tag Examples

The app displays 5 random example query chips on each page load from a pool of 200+ examples. These include:
- Natural language queries (e.g., "Dimir removal spells for Commander")
- Art tag queries (e.g., `art:black cat`, `art:sword`)
- Function tag queries (e.g., `function:removal`, `function:card-advantage`)
- Format-specific queries (e.g., "Modern legal cards", "Pauper removal")
- Color identity queries (e.g., "Boros board wipes", "Simic ramp")

You can also combine Tagger tags with regular Scryfall syntax:
- `id:ub function:removal t:instant` - Dimir instant removal spells
- `c:w t:creature art:angel` - White creatures with angel art
- `f:modern art:sword` - Modern-legal cards with sword art

**Note**: You can enter Scryfall queries directly - the app will detect them and skip OpenAI conversion.

## Project Structure

```
find-that-card/
├── app/
│   ├── page.tsx                 # Main UI page with search form, results, pagination
│   ├── layout.tsx               # Root layout with metadata
│   ├── globals.css              # Tailwind imports + base styles
│   └── api/
│       └── search/
│           └── route.ts         # POST endpoint for search (handles pagination)
├── lib/
│   ├── utils.ts                 # Validation & utility functions
│   ├── prompts.ts               # OpenAI system prompts for query conversion
│   └── example-queries.ts       # Pool of 200+ example queries for random chips
├── types/
│   └── scryfall.ts              # TypeScript types for Scryfall API
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
├── next.config.js
└── README.md
```

## How It Works

1. **User Input**: User enters a natural language query (e.g., "cards with dragons in the art") or a direct Scryfall query (e.g., `t:creature c:r`)

2. **Query Detection**: The app checks if the input is already a Scryfall query (contains operators like `:`, `t:`, `c:`, `art:`, etc.)
   - If it's a Scryfall query, it's used directly without conversion
   - If it's natural language, it proceeds to conversion

3. **Query Conversion**: For natural language queries, the app sends the query to OpenAI with a carefully crafted system prompt that:
   - Converts natural language to Scryfall query syntax
   - Handles Tagger tags (`art:`, `function:`, etc.)
   - Supports complex combinations of criteria
   - Provides safe fallbacks for vague queries

4. **Scryfall Search**: The Scryfall query is sent to the Scryfall API with proper headers and pagination support (60 cards per page)

5. **Results Display**: Cards are displayed in a responsive grid with:
   - Card images (when available)
   - Name and mana cost
   - Type line
   - Oracle text (clamped)
   - Click to open full card on Scryfall
   - Pagination controls (Previous/Next) when there are multiple pages
   - Total card count and current page information

6. **Query Editing**: After a search, users can:
   - View the generated Scryfall query in an editable field
   - Modify the query directly to refine results
   - Click "Search" to execute the edited query
   - Click "View on Scryfall" to open the query on Scryfall.com

## Tagger Tag Support

This app natively supports [Scryfall Tagger](https://tagger.scryfall.com) tags, which allow searching by:
- **Art tags**: Search by what's depicted in card art (`art:dragon`, `art:"black cat"`)
- **Function tags**: Search by card function/effect (`function:removal`, `function:ramp`)

The AI conversion automatically recognizes when users want to search by art or function and generates the appropriate Tagger query operators.

## Legal & Attribution

Unofficial fan content. Card data and images come from [Scryfall](https://scryfall.com) and community tags from [Scryfall Tagger](https://tagger.scryfall.com). This project is not endorsed by Wizards of the Coast or Scryfall.

## License

MIT License - feel free to use this project as a starting point for your own MTG tools!
