/**
 * Phase 1 — Explicit MTG action verb detection.
 *
 * When the user names a specific game action (exile, destroy, counter, bounce),
 * we emit oracle text directly so the exact method is preserved. This prevents
 * the verb fragment from reaching Phase 2 where it might collapse into a broad
 * removal archetype that ignores the specific method the user asked for.
 *
 * FROZEN — do not add new action verbs here. Novel phrasing belongs in the
 * Phase 1.5 structured-extraction prompt.
 */

import type { QueryClause } from "@/lib/search-pipeline/types";

interface ActionRule {
  detect: RegExp;
  oracle: string[];
  strip: string[];
}

const EXPLICIT_ACTION_RULES: ActionRule[] = [
  {
    detect:
      /\b(?:that\s+|to\s+|can\s+|will\s+|would\s+)?exiles?\s+(?:a\s+|an\s+|target\s+|each\s+|all\s+|any\s+)?(?:creature|permanent|artifact|enchantment|land|card|spell|token|planeswalker)s?\b/i,
    oracle: ["o:exile"],
    strip: ["exile", "exiles"],
  },
  {
    detect:
      /\b(?:that\s+|to\s+|can\s+|will\s+|would\s+)?destroys?\s+(?:a\s+|an\s+|target\s+|each\s+|all\s+|any\s+)?(?:creature|permanent|artifact|enchantment|land|card|token|planeswalker)s?\b/i,
    oracle: ["o:destroy"],
    strip: ["destroy", "destroys"],
  },
  {
    detect:
      /\b(?:that\s+|to\s+|can\s+)?counters?\s+(?:a\s+|an?\s+|target\s+)?(?:spell|ability)s?\b/i,
    oracle: ["o:counter"],
    strip: ["counter", "counters"],
  },
  {
    detect:
      /\bbounce[sd]?\s+(?:a\s+|an?\s+|target\s+|each\s+|all\s+|any\s+)?(?:creature|permanent|artifact|enchantment|land|token)s?\b/i,
    oracle: ["o:return", "o:hand"],
    strip: ["bounce", "bounces", "bounced"],
  },
];

/**
 * Applies all explicit action rules to the query and returns oracle clauses
 * along with the terms that should be stripped from the leftover query.
 */
export function applyExplicitActionRules(
  naturalQuery: string
): { clauses: QueryClause[]; strippedTerms: string[] } {
  const clauses: QueryClause[] = [];
  const strippedTerms: string[] = [];

  for (const rule of EXPLICIT_ACTION_RULES) {
    if (!rule.detect.test(naturalQuery)) continue;
    for (const oracleValue of rule.oracle) {
      if (!clauses.some((c) => c.value === oracleValue)) {
        clauses.push({ value: oracleValue, source: "phase1:oracle" });
      }
    }
    strippedTerms.push(...rule.strip);
  }

  return { clauses, strippedTerms };
}
