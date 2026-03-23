/**
 * Masks text after synergy verbs + "with" so downstream **filter** detection does not
 * treat *deck role mentions* as *search filters*.
 *
 * Covers the structural class: "**[synergy verb] with [noun phrase]**" describes what you
 * already run or pair with (partners), not the card type you are searching for — e.g.
 * "combos with mana dorks" is not a request for `function:mana-dork` cards.
 *
 * Used by:
 * - `detectFunctionConceptClauses` (Phase 1) — `lower` is derived from masked text
 * - `normalizeArchetypeIntents` (Phase 3) — archetype `detect` regexes run on masked text
 *
 * Does **not** change the raw query shown to users; only affects matching for tags/archetypes.
 */
export function maskSynergyWithComplements(query: string): string {
  return query.replace(
    /\b(?:combos?|synerg(?:y|ies|ize|izes)|pairs?|works?)\s+with\s+.+?(?=\s+(?:for|in)\b|\s*[—–]|\s*$)/gi,
    " synergy-with-mask "
  );
}
