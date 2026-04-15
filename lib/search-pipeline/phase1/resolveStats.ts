/**
 * Phase 1 — Numeric stat filter resolution.
 *
 * Handles deterministic pattern matching for mana value, power, toughness,
 * and loyalty comparisons expressed in natural language.
 *
 * FROZEN — do not add new regex patterns here. Novel colloquial phrasings
 * (e.g. "beefy", "overcosted") belong in the Phase 1.5 structured-extraction
 * prompt, not in this file.
 */

import type { QueryClause } from "@/lib/search-pipeline/types";
import { COMPARISON_OP_PATTERNS, WORD_TO_NUMBER } from "./constants";

export function textToComparisonOp(text: string): string | null {
  for (const [re, op] of COMPARISON_OP_PATTERNS) {
    if (re.test(text)) return op;
  }
  return null;
}

export function wordOrDigitToNumber(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return WORD_TO_NUMBER[t] ?? null;
}

/**
 * Parses natural language numeric stat comparisons (mana value, power, toughness, loyalty)
 * and returns the corresponding Scryfall filter clauses.
 * Examples: "mana value less than 2" → mv<2, "3-drop" → mv=3, "power greater than 4" → pow>4
 */
export function resolveNumericStatFilters(naturalQuery: string): {
  clauses: QueryClause[];
  strippedTerms: string[];
} {
  const clauses: QueryClause[] = [];
  const strippedTerms: string[] = [];
  const lower = naturalQuery.toLowerCase();

  const NUM_PAT = `(?:\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
  const OP_PAT = [
    `less\\s+than`, `fewer\\s+than`, `below`, `under`,
    `more\\s+than`, `greater\\s+than`, `above`, `higher\\s+than`, `over`,
    `at\\s+most`, `at\\s+max(?:imum)?`, `or\\s+(?:less|fewer)`, `up\\s+to`, `no\\s+more\\s+than`,
    `at\\s+least`, `at\\s+min(?:imum)?`, `or\\s+(?:more|greater)`, `no\\s+less\\s+than`,
    `equal(?:\\s+to)?`, `exactly`,
  ].join("|");

  const emitIfNew = (field: string, op: string, num: number, matchedText: string) => {
    const clauseValue = `${field}${op}${num}`;
    if (!clauses.some((c) => c.value === clauseValue)) {
      clauses.push({ value: clauseValue, source: "phase1:stat" });
    }
    strippedTerms.push(matchedText.trim());
  };

  const MV_ALIASES = `(?:mana\\s+value|converted\\s+mana\\s+cost|cmc|mv)`;

  // "[mv alias] [op] [num]" — e.g. "mana value less than 2", "cmc at most 6"
  const mvOpNum = new RegExp(`\\b(${MV_ALIASES})\\s+(?:of\\s+)?(${OP_PAT})\\s+(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(mvOpNum)) {
    const op = textToComparisonOp(m[2] ?? "");
    const num = wordOrDigitToNumber(m[3] ?? "");
    if (op !== null && num !== null) emitIfNew("mv", op, num, m[0]);
  }

  // "[mv alias] [num] or [num] [or [num]...]" — enumerated equality list of specific values
  const mvEnumListPat = new RegExp(
    `\\b(${MV_ALIASES})\\s+(${NUM_PAT})((?:\\s*(?:,\\s*(?:or\\s+|and\\s+)?|(?:or|and)\\s+)${NUM_PAT})+)\\b`,
    "gi"
  );
  for (const m of lower.matchAll(mvEnumListPat)) {
    const fullNumsText = (m[2] ?? "") + (m[3] ?? "");
    const numTokenRe = new RegExp(`\\b(${NUM_PAT})\\b`, "gi");
    const nums = [...fullNumsText.matchAll(numTokenRe)]
      .map((nm) => wordOrDigitToNumber(nm[1] ?? ""))
      .filter((n): n is number => n !== null);
    if (nums.length >= 2) {
      const orGroup = `(${nums.map((n) => `mv=${n}`).join(" or ")})`;
      if (!clauses.some((c) => c.value === orGroup)) {
        clauses.push({ value: orGroup, source: "phase1:stat" });
      }
      strippedTerms.push(m[0].trim());
    }
  }

  // "[mv alias] [num] or more/less"
  const mvNumOp = new RegExp(`\\b(${MV_ALIASES})\\s+(${NUM_PAT})\\s+(or\\s+(?:less|fewer|more|greater))\\b`, "gi");
  for (const m of lower.matchAll(mvNumOp)) {
    const num = wordOrDigitToNumber(m[2] ?? "");
    const op = textToComparisonOp(m[3] ?? "");
    if (op !== null && num !== null) emitIfNew("mv", op, num, m[0]);
  }

  // "[mv alias] of [num]" or "[mv alias] [num]"
  const mvEqNum = new RegExp(`\\b(${MV_ALIASES})\\s+(?:of\\s+|equal\\s+to\\s+|exactly\\s+)?(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(mvEqNum)) {
    const num = wordOrDigitToNumber(m[2] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("mv", "=", num, m[0]);
    }
  }

  // "[num] [mv alias]" — reversed order e.g. "3 cmc"
  const numMvAlias = new RegExp(`\\b(${NUM_PAT})\\s+(${MV_ALIASES})\\b`, "gi");
  for (const m of lower.matchAll(numMvAlias)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("mv", "=", num, m[0]);
    }
  }

  // "[num]-drop" or "[num] drop"
  const dropPat = new RegExp(`\\b(${NUM_PAT})[-\\s]drops?\\b`, "gi");
  for (const m of lower.matchAll(dropPat)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num !== null && num <= 12) emitIfNew("mv", "=", num, m[0]);
  }

  // "costs [op] [num] [mana]"
  const costsOpNum = new RegExp(`\\b(?:mana\\s+)?(?:costs?|costing)\\s+(${OP_PAT})\\s+(${NUM_PAT})(?:\\s+mana)?\\b`, "gi");
  for (const m of lower.matchAll(costsOpNum)) {
    const op = textToComparisonOp(m[1] ?? "");
    const num = wordOrDigitToNumber(m[2] ?? "");
    if (op !== null && num !== null) emitIfNew("mv", op, num, m[0]);
  }

  // "costs [num] [mana] or more/less"
  const costsNumManaOp = new RegExp(`\\b(?:mana\\s+)?(?:costs?|costing)\\s+(${NUM_PAT})(?:\\s+mana)?\\s+(or\\s+(?:less|fewer|more|greater))\\b`, "gi");
  for (const m of lower.matchAll(costsNumManaOp)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    const op = textToComparisonOp(m[2] ?? "");
    if (op !== null && num !== null) emitIfNew("mv", op, num, m[0]);
  }

  // "costs [num] mana"
  const costsNum = new RegExp(`\\b(?:mana\\s+)?(?:costs?|costing)\\s+(${NUM_PAT})(?:\\s+mana)?\\b`, "gi");
  for (const m of lower.matchAll(costsNum)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("mv", "=", num, m[0]);
    }
  }

  // "[num] mana or less/more"
  const numManaOp = new RegExp(`\\b(${NUM_PAT})(?:\\s+mana)?\\s+(or\\s+(?:less|fewer|more|greater))\\b`, "gi");
  for (const m of lower.matchAll(numManaOp)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    const op = textToComparisonOp(m[2] ?? "");
    if (num !== null && op !== null) emitIfNew("mv", op, num, m[0]);
  }

  // "[op] [num] mana" standalone
  const opNumMana = new RegExp(`\\b(${OP_PAT})\\s+(${NUM_PAT})\\s+mana\\b`, "gi");
  for (const m of lower.matchAll(opNumMana)) {
    const op = textToComparisonOp(m[1] ?? "");
    const num = wordOrDigitToNumber(m[2] ?? "");
    if (op !== null && num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("mv", op, num, m[0]);
    }
  }

  // Bare "[num] mana" — skip oracle-text verb contexts
  const ORACLE_MANA_VERBS = /\b(?:add(?:s)?|produce[sd]?|gain(?:s)?|pay[s]?|spend(?:s)?|costs?|tap[s]?|get[s]?)\s*$/i;
  const bareNumMana = new RegExp(`\\b(${NUM_PAT})\\s+mana\\b`, "gi");
  for (const m of lower.matchAll(bareNumMana)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num === null) continue;
    if (strippedTerms.some((t) => t.includes(m[0]))) continue;
    const before = lower.slice(0, m.index ?? 0).trimEnd();
    if (ORACLE_MANA_VERBS.test(before)) continue;
    emitIfNew("mv", "=", num, m[0]);
  }

  // Power
  const POW_ALIASES = `(?:power|pow)`;
  const powOpNum = new RegExp(`\\b(${POW_ALIASES})\\s+(?:of\\s+)?(${OP_PAT})\\s+(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(powOpNum)) {
    const op = textToComparisonOp(m[2] ?? "");
    const num = wordOrDigitToNumber(m[3] ?? "");
    if (op !== null && num !== null) emitIfNew("pow", op, num, m[0]);
  }
  const powEqNum = new RegExp(`\\b(${POW_ALIASES})\\s+(?:of\\s+|equal\\s+to\\s+|exactly\\s+)?(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(powEqNum)) {
    const num = wordOrDigitToNumber(m[2] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("pow", "=", num, m[0]);
    }
  }
  const numPow = new RegExp(`\\b(${NUM_PAT})\\s+power\\b`, "gi");
  for (const m of lower.matchAll(numPow)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("pow", "=", num, m[0]);
    }
  }

  // Toughness
  const TOU_ALIASES = `(?:toughness|tou)`;
  const touOpNum = new RegExp(`\\b(${TOU_ALIASES})\\s+(?:of\\s+)?(${OP_PAT})\\s+(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(touOpNum)) {
    const op = textToComparisonOp(m[2] ?? "");
    const num = wordOrDigitToNumber(m[3] ?? "");
    if (op !== null && num !== null) emitIfNew("tou", op, num, m[0]);
  }
  const touEqNum = new RegExp(`\\b(${TOU_ALIASES})\\s+(?:of\\s+|equal\\s+to\\s+|exactly\\s+)?(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(touEqNum)) {
    const num = wordOrDigitToNumber(m[2] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("tou", "=", num, m[0]);
    }
  }
  const numTou = new RegExp(`\\b(${NUM_PAT})\\s+toughness\\b`, "gi");
  for (const m of lower.matchAll(numTou)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("tou", "=", num, m[0]);
    }
  }

  // Loyalty
  const LOY_ALIASES = `(?:loyalty|loy)`;
  const loyOpNum = new RegExp(`\\b(${LOY_ALIASES})\\s+(?:of\\s+)?(${OP_PAT})\\s+(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(loyOpNum)) {
    const op = textToComparisonOp(m[2] ?? "");
    const num = wordOrDigitToNumber(m[3] ?? "");
    if (op !== null && num !== null) emitIfNew("loy", op, num, m[0]);
  }
  const loyEqNum = new RegExp(`\\b(${LOY_ALIASES})\\s+(?:of\\s+|equal\\s+to\\s+|exactly\\s+)?(${NUM_PAT})\\b`, "gi");
  for (const m of lower.matchAll(loyEqNum)) {
    const num = wordOrDigitToNumber(m[2] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("loy", "=", num, m[0]);
    }
  }
  const numLoy = new RegExp(`\\b(${NUM_PAT})\\s+loyalty\\b`, "gi");
  for (const m of lower.matchAll(numLoy)) {
    const num = wordOrDigitToNumber(m[1] ?? "");
    if (num !== null && !strippedTerms.some((t) => t.includes(m[0]))) {
      emitIfNew("loy", "=", num, m[0]);
    }
  }

  // Colloquial cost descriptors — "big mana" / "expensive" → mv>=6
  const bigManaMatch = lower.match(
    /\b(big[-\s]mana|expensive|high[-\s]cost|high[-\s](?:mana[-\s])?value)\b/
  );
  if (bigManaMatch) {
    emitIfNew("mv", ">=", 6, bigManaMatch[0]);
  }

  // "cheap" / "low cost" → mv<=3
  const cheapManaMatch = lower.match(
    /\b(cheap(?:[-\s](?:spells?|creatures?|cards?|permanents?))?|low[-\s](?:mana|cost|cmc|mv)|low[-\s](?:mana[-\s])?value)\b/
  );
  if (cheapManaMatch) {
    emitIfNew("mv", "<=", 3, cheapManaMatch[0]);
  }

  return { clauses, strippedTerms };
}
