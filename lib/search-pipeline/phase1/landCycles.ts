/**
 * Phase 1 — Named land cycle detection.
 *
 * Maps specific MTG land cycle names and "N color land" patterns to their
 * Scryfall function: / is: tags deterministically so they never become
 * unresolved fragments that an AI might misclassify.
 *
 * FROZEN — do not add new land cycles here unless a corresponding Scryfall
 * tagger tag already exists. Novel or colloquial land descriptions belong in
 * the Phase 1.5 structured-extraction prompt.
 */

import type { QueryClause } from "@/lib/search-pipeline/types";

interface LandCycleRule {
  detect: RegExp;
  tags: string[];
  strip: string[];
}

const LAND_CYCLE_RULES: LandCycleRule[] = [
  {
    detect:
      /\b(?:trilands?|triomes?|tri-lands?|(?:3|three)[-\s]?color(?:ed)?\s+lands?|lands?\s+(?:that\s+(?:produce|add|tap\s+for)\s+)?(?:three|3)\s+colors?)\b/i,
    tags: ["function:triland"],
    strip: [
      "triland", "trilands", "triome", "triomes", "tri-land", "tri-lands",
      "3 color lands", "3 color land", "three color lands", "three color land",
      "3-color lands", "3-color land", "three-color lands", "three-color land",
      "3", "three", "color", "colors", "colored", "colour", "colours", "coloured",
    ],
  },
  {
    detect:
      /\b(?:dual\s+lands?|original\s+duals?|abu\s+duals?|original\s+dual\s+lands?|abu\s+dual\s+lands?)\b/i,
    tags: ["function:dual-land"],
    strip: [
      "dual land", "dual lands", "original dual", "original duals",
      "abu dual", "abu duals", "original dual land", "original dual lands",
      "abu dual land", "abu dual lands",
    ],
  },
  {
    detect: /\b(?:fetchlands?|fetch\s+lands?)\b/i,
    tags: ["function:fetchland"],
    strip: ["fetchland", "fetchlands", "fetch land", "fetch lands"],
  },
  {
    detect: /\b(?:shocklands?|shock\s+lands?)\b/i,
    tags: ["function:shockland"],
    strip: ["shockland", "shocklands", "shock land", "shock lands"],
  },
  {
    detect: /\b(?:painlands?|pain\s+lands?)\b/i,
    tags: ["function:painland"],
    strip: ["painland", "painlands", "pain land", "pain lands"],
  },
  {
    detect: /\b(?:filterlands?|filter\s+lands?)\b/i,
    tags: ["function:filterland"],
    strip: ["filterland", "filterlands", "filter land", "filter lands"],
  },
  {
    detect: /\b(?:bouncelands?|bounce\s+lands?)\b/i,
    tags: ["function:bounceland"],
    strip: ["bounceland", "bouncelands", "bounce land", "bounce lands"],
  },
  {
    detect: /\b(?:manlands?|man\s+lands?|creaturelands?|creature\s+lands?)\b/i,
    tags: ["is:manland"],
    strip: [
      "manland", "manlands", "man land", "man lands",
      "creatureland", "creaturelands", "creature land", "creature lands",
    ],
  },
  {
    detect: /\b(?:checklands?|check\s+lands?)\b/i,
    tags: ["function:cycle-checkland"],
    strip: ["checkland", "checklands", "check land", "check lands"],
  },
  {
    detect: /\b(?:fastlands?|fast\s+lands?)\b/i,
    tags: ["function:cycle-fastland"],
    strip: ["fastland", "fastlands", "fast land", "fast lands"],
  },
  {
    detect: /\b(?:tangolands?|tango\s+lands?|battle\s+lands?)\b/i,
    tags: ["function:cycle-tangoland"],
    strip: [
      "tangoland", "tangolands", "tango land", "tango lands",
      "battle land", "battle lands",
    ],
  },
  {
    detect: /\b(?:scrylands?|scry\s+lands?)\b/i,
    tags: ["function:cycle-scryland"],
    strip: ["scryland", "scrylands", "scry land", "scry lands"],
  },
  {
    detect: /\b(?:canopylands?|canopy\s+lands?)\b/i,
    tags: ["function:cycle-canopy-land"],
    strip: ["canopyland", "canopylands", "canopy land", "canopy lands"],
  },
  {
    detect: /\b(?:slowlands?|slow\s+lands?)\b/i,
    tags: ["function:slowland"],
    strip: ["slowland", "slowlands", "slow land", "slow lands"],
  },
];

/**
 * Detects named MTG land cycles and returns their Scryfall function:/is: tags.
 */
export function applyLandCycleRules(
  naturalQuery: string
): { clauses: QueryClause[]; strippedTerms: string[] } {
  const clauses: QueryClause[] = [];
  const strippedTerms: string[] = [];

  for (const rule of LAND_CYCLE_RULES) {
    if (!rule.detect.test(naturalQuery)) continue;
    for (const tag of rule.tags) {
      if (!clauses.some((c) => c.value === tag)) {
        clauses.push({ value: tag, source: "phase1:is-flag" });
      }
    }
    strippedTerms.push(...rule.strip);
  }

  return { clauses, strippedTerms };
}
