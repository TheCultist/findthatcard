/**
 * Phase 1 — Card face / layout IS-flag detection.
 *
 * Maps specific layout abbreviations and terms to Scryfall is: flags
 * deterministically so they never reach the AI as fragments.
 *
 * FROZEN — to add new card layout types, first check if a Phase 1.5
 * structured-extraction pattern makes more sense.
 */

import type { QueryClause } from "@/lib/search-pipeline/types";

interface IsFlagRule {
  detect: RegExp;
  flag: string;
  strip: string[];
}

const IS_FLAG_RULES: IsFlagRule[] = [
  {
    detect: /\b(?:mdfc|modal\s+double[-\s]faced|double[-\s]faced\s+modal)\b/i,
    flag: "is:mdfc",
    strip: ["mdfc", "modal double-faced", "double faced modal", "modal", "double-faced", "double faced"],
  },
  {
    detect: /\b(?:tdfc|transform(?:ing)?\s+double[-\s]faced|double[-\s]faced\s+transform(?:ing)?)\b/i,
    flag: "is:tdfc",
    strip: ["tdfc", "transform double-faced", "transforming double-faced", "double faced transform"],
  },
  {
    // Generic double-faced — only if more-specific tdfc/mdfc not already emitted
    detect: /\b(?:dfc|double[-\s]faced\s+cards?)\b/i,
    flag: "is:dfc",
    strip: ["dfc", "double-faced card", "double faced card", "double-faced cards", "double faced cards"],
  },
  {
    detect: /\b(?:meld\s+cards?|(?:is|are)\s+(?:a\s+)?meld)\b/i,
    flag: "is:meld",
    strip: ["meld"],
  },
  {
    detect: /\bsplit\s+cards?\b/i,
    flag: "is:split",
    strip: ["split"],
  },
  {
    detect: /\buniverses\s+beyond\b|\bfrom\s+universes\s+beyond\s+sets?\b/i,
    flag: "is:universesbeyond",
    strip: ["universes beyond", "from universes beyond sets", "from universes beyond set", "universes beyond sets"],
  },
  {
    detect: /\bflip\s+cards?\b/i,
    flag: "is:flip",
    strip: ["flip"],
  },
  {
    detect: /\bsaga\s+cards?\b/i,
    flag: "t:saga",
    strip: ["saga"],
  },
  {
    // Explicitly Un-set / silver-border / acorn cards only — NOT generic "funny"
    detect: /\b(?:silver[-\s]border(?:ed)?|acorn\s+cards?|un[-\s]?sets?(?:\s+cards?)?|un-?glued|un-?hinged|un-?stable|un-?finityy?|undone)\b/i,
    flag: "is:funny",
    strip: ["silver border", "silver-border", "silver bordered", "acorn", "un-set", "unset", "unglued", "un-glued", "unhinged", "un-hinged", "unstable", "un-stable", "unfinity", "un-finity"],
  },
];

/**
 * Applies all IS-flag rules to the query. Returns clauses and terms to strip.
 * More-specific flags (mdfc, tdfc) take precedence over the generic is:dfc.
 */
export function applyIsFlagRules(
  naturalQuery: string
): { clauses: QueryClause[]; strippedTerms: string[] } {
  const clauses: QueryClause[] = [];
  const strippedTerms: string[] = [];
  const emittedFlags = new Set<string>();

  for (const rule of IS_FLAG_RULES) {
    if (!rule.detect.test(naturalQuery)) continue;
    // Specific wins over generic: skip is:dfc if is:mdfc or is:tdfc already emitted
    if (rule.flag === "is:dfc" && (emittedFlags.has("is:mdfc") || emittedFlags.has("is:tdfc"))) {
      continue;
    }
    if (!clauses.some((c) => c.value === rule.flag)) {
      clauses.push({ value: rule.flag, source: "phase1:is-flag" });
    }
    emittedFlags.add(rule.flag);
    strippedTerms.push(...rule.strip);
  }

  return { clauses, strippedTerms };
}
