import { callAI } from "@/lib/ai-client";
import { isAiPromptLoggingEnabled } from "@/lib/search-pipeline/debug";
import { levenshteinDistance } from "@/lib/utils/text";
import { hasCardNameIndex, lookupCardName, lookupCardNameFuzzy } from "@/lib/scryfall/catalog-index";

const shouldLog = isAiPromptLoggingEnabled;

const STOPWORDS = new Set([
  "a", "an", "the", "i", "my", "me", "its", "is", "are", "was",
  "cards", "card", "some", "any", "all", "of", "to", "in", "on",
]);

/**
 * Returns true when the query should go through LLM cleanup
 * (spelling, grammar, and structural normalization).
 * Intentionally broad — the LLM returns clean queries unchanged.
 */
export function shouldNormalize(query: string): boolean {
  const lower = query.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return false;
  if (/[a-z]+:[^\s]/.test(lower)) return false;
  return true;
}

const SYSTEM_PROMPT = `You clean up Magic: The Gathering card search queries — fix spelling, grammar, and add minimal structure so they read as clear English.

Rules:
- Fix obvious spelling mistakes, especially MTG terms (creature types, keywords, card types, colors)
- Fix broken grammar: wrong word order, missing prepositions, broken verb forms
- Add connecting words (with, that, and, or, for, in, to) and commas when missing
- Prefer "that [verb]s" over "to [verb]" — write "sorcery that finds" not "sorcery to find"
- NEVER add new search concepts, card names, or filters the user did not express
- NEVER output Scryfall syntax (no t:, o:, kw:, etc.)
- If the query is already clear, grammatical, and correctly spelled, return it UNCHANGED
- Keep the output as close to the input meaning as possible
- Output ONLY the cleaned-up query. No quotes, no explanations.
- SIMPLIFY PREAMBLES: Remove verbose, meaningless preambles that add no search value. Replace "any type of card that", "any card that", "any kind of card that", "I'm looking for cards that", "show me cards that", "what cards", "find me cards that", "cards that I can use that" with just "cards that". The resulting query must still be natural English.
- REMOVAL TARGET DISAMBIGUATION: When multiple card types appear alongside "removal" (e.g. "creature removal for enchantment and artifact"), ALL of those types are removal targets, not the type of the removing card. Rewrite to make this explicit: "removal that targets creatures, enchantments, and artifacts". This avoids the ambiguity of "[type] removal for [type2]" being misread as the card being a [type].
- SYNERGY DECK CONTEXT: When a query uses "for [a/an/my] X deck" or "in [a/an/my] X deck" and X looks like a specific Magic: The Gathering card name (not a format like "commander"/"modern", a color like "grixis"/"naya", or a generic archetype like "tokens"/"storm"/"aristocrats"), rewrite that portion to "that synergize with X deck". Keep all other constraints (mana value, color, type, etc.) exactly as written. IMPORTANT: keep the word "deck" in the output so the meaning stays intact.

Examples:
"angels lifelink hexproof" → "angels with lifelink and hexproof"
"white creatures haste flash etb draw" → "white creatures with haste and flash that draw on etb"
"green ramp draw instant" → "green instant that ramps and draws"
"creaturs that destory other creaturs" → "creatures that destroy other creatures"
"enchantmens giving fly and indestrutible" → "enchantments that give flying and indestructible"
"red card with deal damage when enter" → "red card that deals damage when it enters"
"sorcary to find lands from deck" → "sorcery to find lands from deck"
"removal not targeting destroy" → "removal that does not target or destroy"
"red burn spell 3 damage creature" → "red burn spell that deals 3 damage to a creature"
"flying tokens white commander" → "white flying tokens for commander"
"sacrifice outlet aristocrats black" → "black sacrifice outlet for aristocrats"
"give creatures indestructible angels" → "angels that give creatures indestructible"
"blue counterspell cheap modern" → "cheap blue counterspell for modern"
"creature removal for enchantment and artifact cards" → "removal that targets creatures, enchantments, and artifacts"
"white creature and artifact removal" → "white removal that targets creatures and artifacts"
"black removal for creatures and planeswalkers" → "black removal that targets creatures and planeswalkers"
"creatures that are removal for enchantment and artifacts" → "creatures that remove enchantments and artifacts"
"spells that are removal for creatures and planeswalkers" → "spells that remove creatures and planeswalkers"
"1 cmc in grixis colors for an Impact Tremors deck" → "1 cmc cards in grixis colors that synergize with Impact Tremors deck"
"green ramp for a Korvold deck" → "green ramp cards that synergize with Korvold deck"
"black removal in a Meren deck" → "black removal cards that synergize with Meren deck"
"cheap white creatures for a Breya deck" → "cheap white creatures that synergize with Breya deck"
"any type of card that deals damage whenever a creature enters" → "cards that deal damage whenever a creature enters"
"I'm looking for cards that give flying to all creatures" → "cards that give flying to all creatures"
"what cards can I use that produce mana" → "cards that produce mana"
"budget cards for commander" → "budget cards for commander" (unchanged — commander is a format)
"1 drop creatures for a token deck" → "1 drop creatures for a token deck" (unchanged — token is a generic archetype)
"self mill black cards" → "black cards that self-mill"
"self mill creatures blue black red" → "blue black red creatures that self-mill"
"blue self mill spells" → "blue spells that self-mill"`;


/**
 * Validates the LLM response. Returns the normalized query if safe,
 * or null if the response should be discarded.
 * Allows spelling corrections (word replacements within Levenshtein <= 3)
 * while rejecting hallucinated concept changes.
 */
export function validateResponse(original: string, response: string): string | null {
  const trimmed = response.trim()
    .replace(/^["']|["']$/g, "")
    .trim();

  if (!trimmed) return null;

  if (/[a-z]+:[^\s]/.test(trimmed)) return null;

  if (trimmed.length > original.length * 2.5) return null;

  const originalWords = new Set(
    original.toLowerCase().match(/[a-z0-9]+/g) ?? []
  );
  const responseWords = new Set(
    trimmed.toLowerCase().match(/[a-z0-9]+/g) ?? []
  );
  const responseArr = [...responseWords];

  for (const word of originalWords) {
    if (STOPWORDS.has(word)) continue;
    if (responseWords.has(word)) continue;
    const hasCloseMatch = responseArr.some(
      (rw) => levenshteinDistance(word, rw) <= 3
    );
    if (!hasCloseMatch) return null;
  }

  return trimmed;
}

/**
 * Phase 0: query cleanup (spelling, grammar, and structural normalization).
 * Fixes misspellings, broken grammar, and missing connectors so Phase 1
 * can parse reliably. Gated on 3+ word natural language queries.
 */
/**
 * Hyphenates known two-word MTG compound terms before they reach the LLM so the
 * LLM treats them as a single semantic unit and doesn't drop either word.
 * The original query is restored after normalization by un-hyphenating.
 */
function protectCompoundTerms(query: string): string {
  return query.replace(/\bself\s+mill\b/gi, "self-mill");
}

/**
 * Named-card typo correction for "similar-cards"-style patterns.
 *
 * Phase 1 (frozen) looks up card names with exact/simplified matching only.
 * If the user misspelled a card name in a "like X / similar to X" phrase
 * (e.g. "creatures like boris reckoner" instead of "Boros Reckoner"), Phase 1
 * fails to detect the intent and falls back to plain attribute parsing.
 *
 * This deterministic pre-pass runs BEFORE the AI call.  It:
 *   1. Tests whether the query matches a "similar-cards" trigger pattern.
 *   2. Extracts the card-name candidate after the trigger.
 *   3. If the candidate doesn't hit the catalog exactly, tries fuzzy lookup
 *      (≤ 2 total per-token Levenshtein edits across all name tokens).
 *   4. Substitutes the corrected name into the query.
 *
 * Returns the (possibly corrected) query unchanged if nothing fires or if
 * the card-name index isn't loaded yet.
 */
const SIMILAR_PRE_PATTERNS: RegExp[] = [
  /\b(?:cards?|spells?|creatures?|instants?|sorceries|enchantments?|artifacts?|lands?|something|anything)\s+(?:that\s+(?:are?\s+|is\s+)?)?like\s+([\s\S]+)/i,
  /\b(?:similar\s+(?:cards?\s+)?to|alternatives?\s+(?:to|for)|effects?\s+(?:like|similar\s+to)|abilities?\s+(?:like|similar\s+to))\s+([\s\S]+)/i,
];

// How many words to try as a name candidate (longest-first).
const MAX_NAME_WORDS = 6;

function correctCardNameTypo(query: string): string {
  if (!hasCardNameIndex()) return query;

  for (const pattern of SIMILAR_PRE_PATTERNS) {
    const m = query.match(pattern);
    if (!m) continue;

    const rawAfter = m[1].trim();
    const words = rawAfter
      .toLowerCase()
      .replace(/[^a-z0-9'\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    // Try longest candidate first; stop at first exact hit.
    for (let len = Math.min(words.length, MAX_NAME_WORDS); len >= 1; len--) {
      const candidate = words.slice(0, len).join(" ");
      if (lookupCardName(candidate)) return query; // already correct, no-op

      const corrected = lookupCardNameFuzzy(candidate, 2);
      if (corrected) {
        // Replace just the misspelled portion while preserving the rest of the query.
        const misspelled = new RegExp(
          words.slice(0, len).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"),
          "i"
        );
        const fixed = query.replace(misspelled, corrected);
        if (fixed !== query) {
          console.log(`[Phase0] Typo correction: "${candidate}" → "${corrected}"`);
          return fixed;
        }
      }
    }
  }

  return query;
}

export async function normalizeQuery(
  query: string
): Promise<{ normalized: string; didNormalize: boolean }> {
  // Deterministic card-name typo correction runs first, regardless of AI gate.
  const typoFixed = correctCardNameTypo(query);
  const didTypoFix = typoFixed !== query;

  if (!shouldNormalize(typoFixed)) {
    return { normalized: typoFixed, didNormalize: didTypoFix };
  }

  const protected_ = protectCompoundTerms(typoFixed);

  try {
    const response = await callAI({
      system: SYSTEM_PROMPT,
      user: protected_,
      max_output_tokens: 200,
    });

    if (shouldLog()) {
      const { input_tokens, output_tokens, total_tokens } = response.usage;
      console.log(
        `[Phase0][AI Usage] input_tokens=${input_tokens} output_tokens=${output_tokens} total_tokens=${total_tokens}`
      );
    }

    const text = response.text;
    const validated = validateResponse(typoFixed, text);

    if (validated && validated.toLowerCase() !== typoFixed.toLowerCase()) {
      if (shouldLog()) {
        console.log(`[Phase0] "${typoFixed}" -> "${validated}"`);
      }
      return { normalized: validated, didNormalize: true };
    }

    return { normalized: typoFixed, didNormalize: didTypoFix };
  } catch (error) {
    console.warn("[Phase0] Normalization failed, using original query:", error);
    return { normalized: typoFixed, didNormalize: didTypoFix };
  }
}
