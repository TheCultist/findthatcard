/**
 * Phase 1 — Natural-language rarity filter resolution.
 *
 * FROZEN — do not add new rarity phrasings here. Novel rarity expressions
 * belong in the Phase 1.5 structured-extraction prompt.
 */

import type { QueryClause } from "@/lib/search-pipeline/types";
import { RARITY_NAME_TO_CODE } from "./constants";

/**
 * Parses natural-language rarity filters and returns Scryfall r: clauses.
 * Examples:
 *   "rarity rare or higher"    → r>=r
 *   "rare or mythic"           → r>=r
 *   "at least uncommon"        → r>=u
 *   "uncommon or lower"        → r<=u
 *   "rarity mythic rare"       → r:m
 *   "rare+"                    → r>=r
 */
export function resolveRarityFilter(naturalQuery: string): {
  clauses: QueryClause[];
  strippedTerms: string[];
} {
  const clauses: QueryClause[] = [];
  const strippedTerms: string[] = [];
  const lower = naturalQuery.toLowerCase();

  // Skip if query already contains Scryfall rarity syntax
  if (/\br(?:arity)?[:><=][a-z]/i.test(lower)) return { clauses, strippedTerms };

  const emitted = new Set<string>();
  const emit = (value: string, rawMatch: string) => {
    if (emitted.has(value)) return;
    emitted.add(value);
    clauses.push({ value, source: "phase1:rarity" });
    rawMatch
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .forEach((w) => { if (!strippedTerms.includes(w)) strippedTerms.push(w); });
  };

  const RARITY_WORD = `(?:mythic\\s+rare|mythic|rare|uncommon|common)`;

  // "rare or mythic [rare]" → r>=r  (special-case before generic patterns)
  const rareOrMythic = lower.match(/\brare\s+or\s+mythic(?:\s+rare)?\b/i);
  if (rareOrMythic) {
    emit("r>=r", rareOrMythic[0]);
    return { clauses, strippedTerms };
  }

  // "[rarity] or (higher|above|better|more|greater)" → r>=[code]
  const higherPat = new RegExp(`\\b(?:rarity\\s+)?(${RARITY_WORD})\\s+or\\s+(?:higher|above|better|more|greater)\\b`, "i");
  const higherMatch = lower.match(higherPat);
  if (higherMatch) {
    const code = RARITY_NAME_TO_CODE[(higherMatch[1] ?? "").toLowerCase().trim()];
    if (code) { emit(`r>=${code}`, higherMatch[0]); return { clauses, strippedTerms }; }
  }

  // "[rarity] or (lower|fewer|less|below|under)" → r<=[code]
  const lowerPat = new RegExp(`\\b(?:rarity\\s+)?(${RARITY_WORD})\\s+or\\s+(?:lower|fewer|less|below|under)\\b`, "i");
  const lowerMatch = lower.match(lowerPat);
  if (lowerMatch) {
    const code = RARITY_NAME_TO_CODE[(lowerMatch[1] ?? "").toLowerCase().trim()];
    if (code) { emit(`r<=${code}`, lowerMatch[0]); return { clauses, strippedTerms }; }
  }

  // "at least [rarity]" → r>=[code]
  const atLeastPat = new RegExp(`\\bat\\s+least\\s+(${RARITY_WORD})\\b`, "i");
  const atLeastMatch = lower.match(atLeastPat);
  if (atLeastMatch) {
    const code = RARITY_NAME_TO_CODE[(atLeastMatch[1] ?? "").toLowerCase().trim()];
    if (code) { emit(`r>=${code}`, atLeastMatch[0]); return { clauses, strippedTerms }; }
  }

  // "at most [rarity]" / "up to [rarity]" → r<=[code]
  const atMostPat = new RegExp(`\\b(?:at\\s+most|up\\s+to)\\s+(${RARITY_WORD})\\b`, "i");
  const atMostMatch = lower.match(atMostPat);
  if (atMostMatch) {
    const code = RARITY_NAME_TO_CODE[(atMostMatch[1] ?? "").toLowerCase().trim()];
    if (code) { emit(`r<=${code}`, atMostMatch[0]); return { clauses, strippedTerms }; }
  }

  // "[rarity]+" e.g. "rare+" → r>=[code]
  const rarityPlusPat = new RegExp(`\\b(${RARITY_WORD})\\+`, "i");
  const rarityPlusMatch = lower.match(rarityPlusPat);
  if (rarityPlusMatch) {
    const code = RARITY_NAME_TO_CODE[(rarityPlusMatch[1] ?? "").toLowerCase().trim()];
    if (code) { emit(`r>=${code}`, rarityPlusMatch[0]); return { clauses, strippedTerms }; }
  }

  // "rarity [name]" or "[name] rarity" → r:[code]
  const rarityNamePat = new RegExp(`\\brarity\\s+(${RARITY_WORD})\\b|\\b(${RARITY_WORD})\\s+rarity\\b`, "i");
  const rarityNameMatch = lower.match(rarityNamePat);
  if (rarityNameMatch) {
    const name = ((rarityNameMatch[1] ?? rarityNameMatch[2]) || "").toLowerCase().trim();
    const code = RARITY_NAME_TO_CODE[name];
    if (code) { emit(`r:${code}`, rarityNameMatch[0]); return { clauses, strippedTerms }; }
  }

  // Bare "rarity [name]"
  const bareRarityPat = new RegExp(`\\brarity\\s+(${RARITY_WORD})\\b`, "i");
  const bareRarityMatch = lower.match(bareRarityPat);
  if (bareRarityMatch) {
    const code = RARITY_NAME_TO_CODE[(bareRarityMatch[1] ?? "").toLowerCase().trim()];
    if (code) { emit(`r:${code}`, bareRarityMatch[0]); return { clauses, strippedTerms }; }
  }

  // Fallback: bare standalone rarity word e.g. "blue rare instants"
  const standalonePat = new RegExp(`\\b(${RARITY_WORD})\\b`, "i");
  const standaloneMatch = lower.match(standalonePat);
  if (standaloneMatch) {
    const code = RARITY_NAME_TO_CODE[(standaloneMatch[1] ?? "").toLowerCase().trim()];
    if (code) { emit(`r:${code}`, standaloneMatch[0]); }
  }

  return { clauses, strippedTerms };
}
