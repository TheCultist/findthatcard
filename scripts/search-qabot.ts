/**
 * Dev/CI-only search QA harness. Procedural NL queries → runSearchPipeline + Scryfall.
 * Not exposed to users. Run: pnpm run search:qa -- --help
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { validateNaturalQuery } from "@/lib/utils/validation";
import { runSearchPipeline } from "@/lib/search-pipeline/runSearchPipeline";
import { searchScryfall, CARDS_PER_PAGE } from "@/lib/scryfall/client";
import type { ScryfallCard } from "@/types/scryfall";
import { callAI } from "@/lib/ai-client";

function loadEnvLocal(): void {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/** Return s with first character uppercased (for sentence starts). */
function cap(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Template = {
  id: string;
  /** If set, total_cards must be >= this or row is soft_fail */
  expectMinResults?: number;
  build: (rng: () => number) => string;
};

const COLOR_WORDS = [
  "white",
  "blue",
  "black",
  "red",
  "green",
  "azorius",
  "rakdos",
  "gruul",
  "selesnya",
  "boros",
  "simic",
  "orzhov",
  "golgari",
  "dimir",
  "izzet",
  "esper",
  "grixis",
  "jund",
  "naya",
  "mardu",
  "temur",
] as const;

const TYPE_WORDS = [
  "creatures",
  "instants",
  "sorceries",
  "artifacts",
  "enchantments",
] as const;

const SIMILAR_NAMES = [
  "Lightning Bolt",
  "Sol Ring",
  "Rhystic Study",
  "Cyclonic Rift",
  "Smothering Tithe",
  "Beast Within",
] as const;

const TRIBES = [
  "goblin",
  "elf",
  "zombie",
  "dragon",
  "cat",
  "merfolk",
  "spirit",
  "artifact creature",
] as const;

const EDH_CONTEXT = [
  "for commander",
  "for my commander deck",
  "for EDH",
  "in a casual commander pod",
  "for kitchen-table commander",
  "in commander — not cEDH",
] as const;

function pickEdh(rng: () => number): string {
  return pick(EDH_CONTEXT, rng);
}

const TEMPLATES: Template[] = [
  {
    id: "commander-archetype",
    expectMinResults: 1,
    build(rng) {
      const c = pick(COLOR_WORDS, rng);
      const t = pick(TYPE_WORDS, rng);
      const ctx = pickEdh(rng);
      const patterns = [
        `${c} ${t} ${ctx}`,
        `I'm looking for solid ${c} ${t} ${ctx}`,
        `Show me good ${c} ${t} I can run ${ctx}`,
        `What are some staple ${c} ${t} ${ctx}?`,
        `Trying to tune the deck — need ${c} ${t} ${ctx}`,
        `${cap(c)} ${t} that still feel strong ${ctx}`,
        `Any recommendations for ${c} ${t} ${ctx}?`,
        `Help me find ${c} ${t}; budget-ish ${ctx}`,
      ];
      return pick(patterns, rng);
    },
  },
  {
    id: "removal",
    expectMinResults: 1,
    build(rng) {
      const c = pick(COLOR_WORDS, rng);
      const ctx = pickEdh(rng);
      const patterns = [
        `${c} creature removal ${ctx}`,
        `ways to kill creatures in ${c} ${ctx}`,
        `I need spot removal in ${c} — creatures mostly ${ctx}`,
        `what single-target removal spells should I run in ${c} for commander`,
        `efficient ${c} removal that hits creatures ${ctx}`,
        `Show me ${c} answers to big creatures ${ctx}`,
      ];
      return pick(patterns, rng);
    },
  },
  {
    id: "mana-rock",
    expectMinResults: 1,
    build(rng) {
      const c = pick(COLOR_WORDS, rng);
      const ctx = pickEdh(rng);
      const patterns = [
        `${c} mana rocks ${ctx}`,
        `mana rocks that fit ${c} identities ${ctx}`,
        `I'm short on ramp — ${c} mana rocks or two-mana artifacts ${ctx}`,
        `cheap ${c} ramp artifacts for commander`,
        `two-mana rocks in ${c} I'd actually play ${ctx}`,
      ];
      return pick(patterns, rng);
    },
  },
  {
    id: "draw-effect",
    expectMinResults: 1,
    build(rng) {
      const c = pick(COLOR_WORDS, rng);
      const ctx = pickEdh(rng);
      const patterns = [
        `${c} cards that draw extra cards ${ctx}`,
        `how do I get card advantage in ${c} ${ctx}`,
        `I need draw engines in ${c} — not Rhystic-tier-priced if possible ${ctx}`,
        `repeatable card draw in ${c} for longer games ${ctx}`,
        `${cap(c)} draw spells that don't feel dead early ${ctx}`,
      ];
      return pick(patterns, rng);
    },
  },
  {
    id: "low-mv-creatures",
    expectMinResults: 1,
    build(rng) {
      const c = pick(COLOR_WORDS, rng);
      const ctx = pickEdh(rng);
      const patterns = [
        `cheap low-curve ${c} creatures ${ctx}`,
        `one- and two-mana ${c} creatures that do work ${ctx}`,
        `efficient early creatures in ${c} for aggro-leaning commander`,
        `low mana value ${c} creatures I can play on turn two or three ${ctx}`,
      ];
      return pick(patterns, rng);
    },
  },
  {
    id: "board-wipe",
    expectMinResults: 1,
    build(rng) {
      const c = pick(["", `${pick(COLOR_WORDS, rng)} `], rng);
      const ctx = pickEdh(rng);
      const patterns = [
        `board wipes ${ctx}`,
        `${c}board wipe spells I can cast reliably ${ctx}`,
        `I need a reset button — mass removal ${ctx}`,
        `wraths or sweepers that don't hose only me ${ctx}`,
        `what's a good asymmetric board wipe ${ctx}`,
      ];
      return pick(patterns, rng);
    },
  },
  {
    id: "land-ramp",
    expectMinResults: 1,
    build(rng) {
      const ctx = pickEdh(rng);
      const patterns = [
        `lands that ramp or cheat mana ${ctx}`,
        `lands I can run for ramp in green-heavy commander`,
        `looking for land-based ramp — not just spells ${ctx}`,
        `utility lands that help with mana ${ctx}`,
      ];
      return pick(patterns, rng);
    },
  },
  {
    id: "similar-named",
    expectMinResults: 1,
    build(rng) {
      const name = pick(SIMILAR_NAMES, rng);
      const patterns = [
        `cards similar to ${name}`,
        `what plays like ${name} in commander`,
        `I'm building around effects like ${name} — what else fits`,
        `alternatives to ${name} that fill a similar role`,
        `cards like ${name} for a budget deck`,
      ];
      return pick(patterns, rng);
    },
  },
  {
    id: "synergy-named",
    expectMinResults: 1,
    build(rng) {
      const patterns = [
        `synergy with Sol Ring`,
        `what pairs well with Sol Ring in commander`,
        `Sol Ring payoffs and pieces that reward fast mana ${pickEdh(rng)}`,
        `cards that synergize with mana rocks like Sol Ring`,
        `I'm leaning hard on fast mana — what else should I add with Sol Ring`,
      ];
      return pick(patterns, rng);
    },
  },
  {
    id: "tribal",
    expectMinResults: 1,
    build(rng) {
      const tribe = pick(TRIBES, rng);
      const ctx = pickEdh(rng);
      const patterns = [
        `${tribe} tribal payoffs ${ctx}`,
        `support cards for a ${tribe} tribal commander deck`,
        `best lords and anthems for ${tribe} ${ctx}`,
        `I'm on ${tribe} tribal — what's missing besides beaters ${ctx}`,
      ];
      return pick(patterns, rng);
    },
  },
  {
    id: "combo-vibe",
    expectMinResults: 1,
    build(rng) {
      const ctx = pickEdh(rng);
      const patterns = [
        `pieces that go infinite with common commander combos`,
        `untap shenanigans — stuff that combos with mana dorks ${ctx}`,
        `graveyard combo enablers in black ${ctx}`,
        `extra turn spells that aren't completely antisocial ${ctx}`,
      ];
      return pick(patterns, rng);
    },
  },
  {
    id: "direct-scryfall",
    expectMinResults: 1,
    build(rng) {
      const patterns = [
        "t:creature cmc=1",
        't:instant o:"draw" cmc<=2',
        "f:commander id:simic t:creature",
        'name:"Lightning Bolt" game:paper',
      ];
      return pick(patterns, rng);
    },
  },
  {
    id: "vague-may-empty",
    expectMinResults: undefined,
    build(rng) {
      const patterns = [
        `cool build-around commanders people don't usually see`,
        `interesting commanders with a unique angle — not generic goodstuff`,
        `underrated legendaries that reward a theme`,
        `what's a fun commander for a lower-power table`,
        `commanders that feel like a puzzle to build around`,
      ];
      return pick(patterns, rng);
    },
  },
];

type PipelineDebug = {
  /** Phase 1 fragment buckets (assembly keys), not “still unresolved”. */
  unresolvedFragments: number;
  resolvedFragments: number;
  aiBatchCalls: number;
  aiSequentialCalls: number;
  invalidTagsRemoved: number;
  phase0Normalized: boolean;
};

type ResultRow = {
  templateId: string;
  naturalQuery: string;
  status: "ok" | "skipped" | "hard_fail" | "soft_fail";
  error?: string;
  scryfallQuery?: string;
  totalCards?: number;
  topCardNames?: string[];
  pipelineDebug?: PipelineDebug;
  judge?: { satisfactory: boolean; reason: string; score?: number };
};

function sliceVisibleCards(data: ScryfallCard[], offset: number, max: number): ScryfallCard[] {
  return data.slice(offset, offset + max);
}

function cardsSummary(cards: ScryfallCard[], max: number): string {
  return cards
    .slice(0, max)
    .map((c) => `${c.name} — ${c.type_line}`)
    .join("\n");
}

async function runJudge(args: {
  naturalQuery: string;
  scryfallQuery: string;
  totalCards: number;
  cardSlice: ScryfallCard[];
}): Promise<{ satisfactory: boolean; reason: string; score?: number }> {
  const system = `You audit Magic: The Gathering search quality. Reply with a single JSON object only, no markdown, keys: satisfactory (boolean), score (1-5 integer), reason (short string).`;
  const user = `Natural language query: ${JSON.stringify(args.naturalQuery)}
Scryfall query produced: ${JSON.stringify(args.scryfallQuery)}
Total matching cards (approx): ${args.totalCards}
First results:
${cardsSummary(args.cardSlice, 8) || "(none)"}`;

  const { text } = await callAI({ system, user, max_output_tokens: 300 });
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : text) as {
      satisfactory: boolean;
      reason: string;
      score?: number;
    };
    return {
      satisfactory: !!parsed.satisfactory,
      reason: String(parsed.reason || ""),
      score: typeof parsed.score === "number" ? parsed.score : undefined,
    };
  } catch {
    return { satisfactory: false, reason: `Judge parse failed; raw: ${text.slice(0, 200)}` };
  }
}

function parseArgs(argv: string[]) {
  let count = 12;
  let seed: number | null = null;
  let judge = false;
  let judgeFailuresOnly = true;
  let delayMs = 150;
  let outBase = join("reports", `search-qa-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(`search-qabot — dev/CI search QA

Usage: pnpm run search:qa -- [options]

  --count N        Number of procedural cases (default 12)
  --seed N         RNG seed (default: time-based)
  --judge          Run LLM judge (uses callAI / OPENAI or Claude env)
  --judge-all      Judge every row, not only failures (expensive)
  --delay-ms N     Pause between cases (default 150) for API politeness
  --out PATH       Report base path without extension (.md + .json)
  --quiet          Less console noise

Requires OPENAI_API_KEY (and other pipeline env) like production search.`);
      process.exit(0);
    }
    if (a === "--count" && argv[i + 1]) {
      count = Math.max(1, parseInt(argv[++i], 10) || count);
    } else if (a === "--seed" && argv[i + 1]) {
      seed = parseInt(argv[++i], 10);
    } else if (a === "--judge") {
      judge = true;
    } else if (a === "--judge-all") {
      judge = true;
      judgeFailuresOnly = false;
    } else if (a === "--delay-ms" && argv[i + 1]) {
      delayMs = Math.max(0, parseInt(argv[++i], 10) || 0);
    } else if (a === "--out" && argv[i + 1]) {
      outBase = argv[++i];
    } else if (a === "--quiet") {
      quiet = true;
    }
  }

  if (seed === null) seed = (Date.now() ^ (Math.random() * 0x100000000)) >>> 0;

  return { count, seed, judge, judgeFailuresOnly, delayMs, outBase, quiet };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runCase(
  template: Template,
  naturalQuery: string,
  judge: boolean,
  judgeFailuresOnly: boolean
): Promise<ResultRow> {
  const validation = validateNaturalQuery(naturalQuery);
  if (!validation.valid) {
    return {
      templateId: template.id,
      naturalQuery,
      status: "skipped",
      error: validation.error,
    };
  }

  let scryfallQuery: string;
  let pipelineDebug: PipelineDebug;

  try {
    const pipeline = await runSearchPipeline(naturalQuery);
    scryfallQuery = pipeline.queryForScryfall;
    pipelineDebug = pipeline.debug;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const row: ResultRow = {
      templateId: template.id,
      naturalQuery,
      status: "hard_fail",
      error: `Pipeline: ${msg}`,
    };
    return row;
  }

  if (!scryfallQuery?.trim()) {
    return {
      templateId: template.id,
      naturalQuery,
      status: "hard_fail",
      error: "Empty Scryfall query from pipeline",
      scryfallQuery,
      pipelineDebug,
    };
  }

  let totalCards = 0;
  let cardSlice: ScryfallCard[] = [];
  let scryfallError: string | undefined;

  try {
    const { response, offset } = await searchScryfall(scryfallQuery, 1);
    totalCards = response.total_cards;
    cardSlice = sliceVisibleCards(response.data, offset, Math.min(12, CARDS_PER_PAGE));
  } catch (e) {
    scryfallError = e instanceof Error ? e.message : String(e);
  }

  if (scryfallError) {
    const row: ResultRow = {
      templateId: template.id,
      naturalQuery,
      status: "hard_fail",
      error: `Scryfall: ${scryfallError}`,
      scryfallQuery,
      totalCards,
      topCardNames: cardSlice.map((c) => c.name),
      pipelineDebug,
    };
    return row;
  }

  const topNames = cardSlice.map((c) => c.name);

  if (template.expectMinResults != null && totalCards < template.expectMinResults) {
    const row: ResultRow = {
      templateId: template.id,
      naturalQuery,
      status: "soft_fail",
      error: `Expected >= ${template.expectMinResults} results, got ${totalCards}`,
      scryfallQuery,
      totalCards,
      topCardNames: topNames,
      pipelineDebug,
    };
    if (judge) {
      row.judge = await runJudge({
        naturalQuery,
        scryfallQuery,
        totalCards,
        cardSlice,
      });
    }
    return row;
  }

  const row: ResultRow = {
    templateId: template.id,
    naturalQuery,
    status: "ok",
    scryfallQuery,
    totalCards,
    topCardNames: topNames,
    pipelineDebug,
  };

  if (judge && !judgeFailuresOnly) {
    row.judge = await runJudge({
      naturalQuery,
      scryfallQuery,
      totalCards,
      cardSlice,
    });
  }

  return row;
}

function writeReports(outBase: string, rows: ResultRow[], meta: { seed: number; count: number }) {
  mkdirSync(join(outBase, ".."), { recursive: true });
  const jsonPath = `${outBase}.json`;
  const mdPath = `${outBase}.md`;
  writeFileSync(jsonPath, JSON.stringify({ meta, rows }, null, 2), "utf8");

  const lines: string[] = [
    `# Search QA report`,
    ``,
    `- Seed: ${meta.seed}`,
    `- Cases: ${meta.count}`,
    ``,
    `## Summary`,
    ``,
  ];
  const c = (s: ResultRow["status"]) => rows.filter((r) => r.status === s).length;
  lines.push(`- ok: ${c("ok")}`);
  lines.push(`- soft_fail: ${c("soft_fail")}`);
  lines.push(`- hard_fail: ${c("hard_fail")}`);
  lines.push(`- skipped: ${c("skipped")}`);
  lines.push(``);

  lines.push(`## All cases`);
  lines.push(``);
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.templateId}** (${r.status})`);
    lines.push(`   - **Natural:** ${r.naturalQuery}`);
    lines.push(`   - **Scryfall:** \`${r.scryfallQuery ?? "—"}\``);
    if (r.totalCards !== undefined) {
      lines.push(`   - **Total cards:** ${r.totalCards}`);
    }
    lines.push(``);
  });

  const bad = rows.filter((r) => r.status !== "ok" && r.status !== "skipped");
  if (bad.length) {
    lines.push(`## Issues`);
    lines.push(``);
    for (const r of bad) {
      lines.push(`### ${r.status}: ${r.templateId}`);
      lines.push(``);
      lines.push(`- **Query:** ${r.naturalQuery}`);
      lines.push(`- **Scryfall:** \`${r.scryfallQuery ?? "—"}\``);
      lines.push(`- **Total:** ${r.totalCards ?? "—"}`);
      lines.push(`- **Top cards:** ${(r.topCardNames ?? []).join(", ") || "—"}`);
      lines.push(`- **Error:** ${r.error ?? "—"}`);
      if (r.pipelineDebug) {
        lines.push(
          `- **Pipeline:** phase1Fragments=${r.pipelineDebug.unresolvedFragments} phase2Resolved=${r.pipelineDebug.resolvedFragments} aiBatch=${r.pipelineDebug.aiBatchCalls} aiSeq=${r.pipelineDebug.aiSequentialCalls} invalidTags=${r.pipelineDebug.invalidTagsRemoved} phase0=${r.pipelineDebug.phase0Normalized}`
        );
      }
      if (r.judge) {
        lines.push(
          `- **Judge:** satisfactory=${r.judge.satisfactory}${r.judge.score != null ? ` score=${r.judge.score}` : ""} — ${r.judge.reason}`
        );
      }
      lines.push(``);
    }
  } else {
    lines.push(`No failures.`);
    lines.push(``);
  }

  writeFileSync(mdPath, lines.join("\n"), "utf8");
  return { jsonPath, mdPath };
}

async function main() {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.OPENAI_API_KEY) {
    console.error("search-qabot: OPENAI_API_KEY is required (load .env.local or export it).");
    process.exit(2);
  }

  const rng = mulberry32(args.seed);
  const rows: ResultRow[] = [];

  for (let i = 0; i < args.count; i++) {
    const template = pick(TEMPLATES, rng);
    const naturalQuery = template.build(rng);
    if (!args.quiet) {
      const head =
        naturalQuery.length > 90 ? `${naturalQuery.slice(0, 90)}…` : naturalQuery;
      console.log(`[${i + 1}/${args.count}] ${template.id}: ${head}`);
    }
    const row = await runCase(template, naturalQuery, args.judge, args.judgeFailuresOnly);
    rows.push(row);
    if (!args.quiet && row.status !== "ok") {
      console.log(`  → ${row.status}: ${row.error ?? row.judge?.reason ?? ""}`);
    }
    if (args.delayMs > 0) await sleep(args.delayMs);
  }

  const { jsonPath, mdPath } = writeReports(args.outBase, rows, {
    seed: args.seed,
    count: args.count,
  });

  const hard = rows.filter((r) => r.status === "hard_fail").length;
  const soft = rows.filter((r) => r.status === "soft_fail").length;

  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(`Summary: ok=${rows.filter((r) => r.status === "ok").length} soft_fail=${soft} hard_fail=${hard} skipped=${rows.filter((r) => r.status === "skipped").length}`);

  if (hard > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
