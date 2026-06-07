/**
 * Intent Resolver — runs after Phase 1 when a named-card intent is detected.
 *
 * When the user's query targets a specific card (e.g. "cards similar to
 * Sheoldred", "art like Elspeth", "synergy with Omnath"), Phase 1 records the
 * intent and card name in the IR instead of parsing the query as a generic
 * search.  This module fetches card-specific external data (Tagger
 * relationships, illustration tags, or an LLM synergy query) and injects the
 * result as a `mustClause` so the remaining phases (1.5, 2, 3) apply any
 * extra user constraints on top.
 *
 * ## This is NOT a bypass
 * The IR continues through every subsequent phase after this resolver runs.
 * Extra constraints the user appended (e.g. "…that are not instants",
 * "…in Modern") are left as unresolved fragments and handled by Phase 2.
 *
 * ## Compound-query interaction
 * When a branch of a compound OR query carries a named-card intent, the
 * compound pipeline aborts before calling this function.  A standalone
 * intent-resolved query cannot be meaningfully OR-combined with other
 * branches because it produces a complete, self-contained Scryfall expression.
 */

import type { SearchPipelineIR } from "@/lib/search-pipeline/types";
import { resolveArtLikeCardsQuery, resolveSimilarCardsQuery } from "@/lib/search-pipeline/similar-cards";
import { resolveSynergyQuery } from "@/lib/search-pipeline/synergy-cards";

/**
 * Strips any `name:"X"` must-clauses from the IR that conflict with card
 * names already present (as exclusions) in the resolved intent query.
 *
 * For example, when the intent query contains `-name:"Sheoldred"`, any
 * existing `name:"Sheoldred"` must-clause (injected earlier by Phase 1's
 * card-name detector) is removed so the final query is not self-contradictory.
 */
function dropContradictoryNameClauses(ir: SearchPipelineIR, intentQuery: string): void {
  const excluded = new Set<string>();
  let match: RegExpExecArray | null;
  const excludedNamePattern = /-name:"([^"]+)"/gi;
  while ((match = excludedNamePattern.exec(intentQuery)) !== null) {
    const name = (match[1] || "").trim().toLowerCase();
    if (name) excluded.add(name);
  }
  if (excluded.size === 0) return;

  ir.mustClauses = ir.mustClauses.filter((clause) => {
    const m = /^\s*name:"([^"]+)"\s*$/i.exec(clause.value);
    if (!m) return true;
    return !excluded.has((m[1] || "").trim().toLowerCase());
  });
}

/**
 * Resolves the named-card intent stored in `ir` and injects the resulting
 * Scryfall expression as a `mustClause` at the front of the IR's clause list.
 *
 * Handles three intents:
 *   - `similar-cards`     — Tagger relationship graph + oracle-text clauses
 *   - `art-like-cards`    — Tagger illustration tag scoring
 *   - `synergy-with-card` — LLM prompt with card oracle text + Tagger function tags
 *
 * When resolution fails (card not found, Tagger unavailable, LLM error), the
 * function falls back to a bare `name:"<card>"` clause so the user still gets
 * a useful result rather than a broken query.
 *
 * Mutates `ir` in-place; returns void.
 */
export async function resolveIntentClauses(ir: SearchPipelineIR): Promise<void> {
  if (ir.intent === "similar-cards" && ir.similarToCardName) {
    const similarQuery = await resolveSimilarCardsQuery(ir.similarToCardName);
    if (similarQuery) {
      dropContradictoryNameClauses(ir, similarQuery);
      ir.mustClauses.unshift({ value: `(${similarQuery})`, source: "phase1:intent" });
    } else {
      ir.mustClauses.unshift({ value: `name:"${ir.similarToCardName}"`, source: "phase1:cardname" });
    }
    return;
  }

  if (ir.intent === "art-like-cards" && ir.artLikeCardName) {
    const artQuery = await resolveArtLikeCardsQuery(ir.artLikeCardName);
    if (artQuery) {
      dropContradictoryNameClauses(ir, artQuery);
      ir.mustClauses.unshift({ value: `(${artQuery})`, source: "phase1:intent" });
    } else {
      ir.mustClauses.unshift({ value: `name:"${ir.artLikeCardName}"`, source: "phase1:cardname" });
    }
    return;
  }

  if (ir.intent === "synergy-with-card" && ir.synergyWithCardName) {
    const synergyResult = await resolveSynergyQuery(ir.synergyWithCardName);
    if (synergyResult) {
      dropContradictoryNameClauses(ir, synergyResult.query);
      // Synergy queries are already sanitized; no extra parens needed.
      ir.mustClauses.unshift({ value: synergyResult.query, source: "phase1:intent" });
      // Inject color identity only if the user hasn't already specified one explicitly.
      const hasExplicitColorId = ir.mustClauses.some((c) => /^id[:=<>]/.test(c.value));
      if (synergyResult.colorIdentity && !hasExplicitColorId) {
        ir.mustClauses.push({ value: `id:${synergyResult.colorIdentity}`, source: "phase1:intent" });
      }
      ir.debug.aiBatchCalls += 1;
    } else {
      ir.mustClauses.unshift({ value: `name:"${ir.synergyWithCardName}"`, source: "phase1:cardname" });
    }
  }
}
