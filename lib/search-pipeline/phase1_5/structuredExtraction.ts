/**
 * Phase 1.5 — Structured AI Extraction
 *
 * Runs AFTER Phase 1 (deterministic NLP) and BEFORE Phase 2 (fragment resolver)
 * when the IR still has unresolved fragments that look like they carry concrete
 * game-mechanic or stat intent that Phase 1's regex corpus couldn't match.
 *
 * Unlike Phase 2 (which asks "what Scryfall tags describe this vibe?"), Phase 1.5
 * asks "what concrete stat/rarity/year/colloquial values are embedded in this text?"
 * and returns them as first-class IR clauses — zero ambiguity, zero hallucination
 * risk because the schema is narrow and validated before use.
 *
 * ## When this phase runs
 * - At least one unresolved fragment remains after Phase 1, AND
 * - The fragment text matches one of the known colloquial trigger patterns
 *   (e.g. numeric adjectives, size comparisons, release year references, etc.)
 *
 * ## What it produces
 * - Additional `mustClauses` injected into the IR (mana value, power, toughness,
 *   loyalty, rarity, year printed, format legality)
 * - The consuming fragment removed from `unresolvedFragments`
 *
 * ## Architecture note
 * This phase is intentionally narrow. It replaces problematic open-ended regex
 * expansion in Phase 1. It does NOT attempt to interpret abstract vibe/strategy
 * queries — those remain Phase 2's domain.
 */

import { callAI } from "@/lib/ai-client";
import type { SearchPipelineIR, QueryClause, UnresolvedFragment } from "@/lib/search-pipeline/types";

// ---------------------------------------------------------------------------
// Output schema (manually validated — no Zod dep required)
// ---------------------------------------------------------------------------

type NumericOp = "<" | "<=" | "=" | ">=" | ">";

interface ExtractedStat {
  field: "mv" | "pow" | "tou" | "loy";
  op: NumericOp;
  value: number;
}

interface ExtractedRarity {
  op: ":" | "<=" | ">=";
  code: "c" | "u" | "r" | "m";
}

interface ExtractedYear {
  op: NumericOp;
  year: number;
}

interface StructuredExtractionResult {
  stats: ExtractedStat[];
  rarity: ExtractedRarity | null;
  year: ExtractedYear | null;
  /** Fragments that were consumed by this extraction and should be removed. */
  consumedFragmentTexts: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_OPS = new Set(["<", "<=", "=", ">=", ">"]);
const VALID_STAT_FIELDS = new Set(["mv", "pow", "tou", "loy"]);
const VALID_RARITY_CODES = new Set(["c", "u", "r", "m"]);
const RARITY_OPS = new Set([":", "<=", ">="]);

function isNumericOp(v: unknown): v is NumericOp {
  return typeof v === "string" && VALID_OPS.has(v);
}

function validateResult(raw: unknown): StructuredExtractionResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const stats: ExtractedStat[] = [];
  if (Array.isArray(obj["stats"])) {
    for (const s of obj["stats"] as unknown[]) {
      if (typeof s !== "object" || s === null) continue;
      const stat = s as Record<string, unknown>;
      if (
        typeof stat["field"] === "string" &&
        VALID_STAT_FIELDS.has(stat["field"]) &&
        isNumericOp(stat["op"]) &&
        typeof stat["value"] === "number" &&
        Number.isFinite(stat["value"])
      ) {
        stats.push({
          field: stat["field"] as ExtractedStat["field"],
          op: stat["op"],
          value: stat["value"] as number,
        });
      }
    }
  }

  let rarity: ExtractedRarity | null = null;
  if (typeof obj["rarity"] === "object" && obj["rarity"] !== null) {
    const r = obj["rarity"] as Record<string, unknown>;
    if (
      typeof r["op"] === "string" &&
      RARITY_OPS.has(r["op"]) &&
      typeof r["code"] === "string" &&
      VALID_RARITY_CODES.has(r["code"])
    ) {
      rarity = { op: r["op"] as ExtractedRarity["op"], code: r["code"] as ExtractedRarity["code"] };
    }
  }

  let year: ExtractedYear | null = null;
  if (typeof obj["year"] === "object" && obj["year"] !== null) {
    const y = obj["year"] as Record<string, unknown>;
    if (
      isNumericOp(y["op"]) &&
      typeof y["year"] === "number" &&
      y["year"] >= 1993 &&
      y["year"] <= 2100
    ) {
      year = { op: y["op"], year: y["year"] as number };
    }
  }

  const consumedFragmentTexts: string[] = [];
  if (Array.isArray(obj["consumedFragmentTexts"])) {
    for (const t of obj["consumedFragmentTexts"] as unknown[]) {
      if (typeof t === "string") consumedFragmentTexts.push(t);
    }
  }

  if (stats.length === 0 && rarity === null && year === null) return null;
  return { stats, rarity, year, consumedFragmentTexts };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(fragments: UnresolvedFragment[], originalQuery: string): string {
  const fragmentList = fragments
    .map((f, i) => `  ${i + 1}. "${f.text}" (category: ${f.category})`)
    .join("\n");

  return `You are a Magic: The Gathering search assistant. Extract CONCRETE game values from the user's search intent.

Original query: "${originalQuery}"

Unresolved fragments from the NLP parser:
${fragmentList}

Return ONLY a JSON object (no markdown, no commentary) matching this exact shape:
{
  "stats": [
    { "field": "mv"|"pow"|"tou"|"loy", "op": "<"|"<="|"="|">="|">", "value": <integer> }
  ],
  "rarity": { "op": ":"|"<="|">=", "code": "c"|"u"|"r"|"m" } | null,
  "year": { "op": "<"|"<="|"="|">="|">", "year": <4-digit year> } | null,
  "consumedFragmentTexts": ["<fragment text that is now covered by the above values>"]
}

Rules:
- Only extract values you are CERTAIN about from the fragments/query above.
- "mv" = mana value (CMC). "pow" = power. "tou" = toughness. "loy" = loyalty.
- Rarity codes: c=common, u=uncommon, r=rare, m=mythic.
- Colloquial mappings: "cheap"→mv<=2, "expensive/costly"→mv>=6, "big/huge"→pow>=5, "small/tiny"→pow<=1, "beefy"→pow>=4 AND tou>=4.
- If a fragment is NOT about concrete stats/rarity/year, leave it out of consumedFragmentTexts.
- Return empty arrays/nulls when nothing concrete was found — never guess.`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Returns true if Phase 1.5 should run based on the current IR state.
 * Only activates when unresolved fragments survive that look like they encode
 * concrete numeric/rarity/year values Phase 1 couldn't parse.
 */
export function shouldRunPhase1_5(ir: SearchPipelineIR): boolean {
  if (ir.unresolvedFragments.length === 0) return false;

  const COLLOQUIAL_TRIGGERS = [
    /\b(?:cheap|expensive|costly|budget|overcosted|undercosted)\b/i,
    /\b(?:big|huge|large|small|tiny|weak|strong|powerful|beefy|fat|slim|chonky)\b/i,
    /\b(?:early|late)\s+(?:game|turn)\b/i,
    /\b(?:in|from|before|after|since|around)\s+(?:19|20)\d{2}\b/i,
    /\b(?:printed|released|from)\s+(?:in\s+)?(?:19|20)\d{2}\b/i,
    /\b(?:19|20)\d{2}\b/,
    /\b(?:high|low)\s+(?:power|toughness|loyalty|mana)\b/i,
  ];

  const combinedText = ir.unresolvedFragments.map((f) => f.text).join(" ");
  return COLLOQUIAL_TRIGGERS.some((pat) => pat.test(combinedText));
}

/**
 * Runs Phase 1.5 structured extraction against the current IR.
 * Mutates `ir` in-place: adds clauses and removes consumed fragments.
 */
export async function runPhase1_5(ir: SearchPipelineIR): Promise<void> {
  const prompt = buildPrompt(ir.unresolvedFragments, ir.naturalQuery);

  let rawText: string;
  try {
    const response = await callAI({
      system:
        "You extract concrete Magic: The Gathering filter values from natural language. " +
        "Respond ONLY with valid JSON. No markdown fences, no prose.",
      user: prompt,
      max_output_tokens: 400,
    });
    rawText = response.text.trim();
    ir.debug.aiBatchCalls += 1;
  } catch {
    // Phase 1.5 is best-effort — silently degrade to Phase 2 on AI errors
    return;
  }

  // Strip any accidental markdown fences the model might add
  rawText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return;
  }

  const result = validateResult(parsed);
  if (!result) return;

  // --- Inject stat clauses ---
  const newClauses: QueryClause[] = [];

  for (const stat of result.stats) {
    const value = `${stat.field}${stat.op}${stat.value}`;
    if (!ir.mustClauses.some((c) => c.value === value)) {
      newClauses.push({ value, source: "phase1:stat" });
    }
  }

  if (result.rarity) {
    const value = `r${result.rarity.op}${result.rarity.code}`;
    if (!ir.mustClauses.some((c) => c.value === value)) {
      newClauses.push({ value, source: "phase1:rarity" });
    }
  }

  if (result.year) {
    const value = `year${result.year.op}${result.year.year}`;
    if (!ir.mustClauses.some((c) => c.value === value)) {
      newClauses.push({ value, source: "phase1:stat" });
    }
  }

  ir.mustClauses.push(...newClauses);

  // --- Remove consumed fragments ---
  if (result.consumedFragmentTexts.length > 0) {
    const consumed = new Set(result.consumedFragmentTexts.map((t) => t.toLowerCase().trim()));
    ir.unresolvedFragments = ir.unresolvedFragments.filter(
      (f) => !consumed.has(f.text.toLowerCase().trim())
    );
  }
}
