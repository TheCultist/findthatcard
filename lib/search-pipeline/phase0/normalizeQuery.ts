import { callAI } from "@/lib/ai-client";
import { levenshteinDistance } from "@/lib/utils/text";

function shouldLog(): boolean {
  const configured = process.env.LOG_AI_AGENT_PROMPT?.toLowerCase();
  if (configured === "true" || configured === "1") return true;
  if (configured === "false" || configured === "0") return false;
  return process.env.NODE_ENV !== "production";
}

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
"blue counterspell cheap modern" → "cheap blue counterspell for modern"`;

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
export async function normalizeQuery(
  query: string
): Promise<{ normalized: string; didNormalize: boolean }> {
  if (!shouldNormalize(query)) {
    return { normalized: query, didNormalize: false };
  }

  try {
    const response = await callAI({
      system: SYSTEM_PROMPT,
      user: query,
      max_output_tokens: 200,
    });

    if (shouldLog()) {
      const { input_tokens, output_tokens, total_tokens } = response.usage;
      console.log(
        `[Phase0][AI Usage] input_tokens=${input_tokens} output_tokens=${output_tokens} total_tokens=${total_tokens}`
      );
    }

    const text = response.text;
    const validated = validateResponse(query, text);

    if (validated && validated.toLowerCase() !== query.toLowerCase()) {
      if (shouldLog()) {
        console.log(`[Phase0] "${query}" -> "${validated}"`);
      }
      return { normalized: validated, didNormalize: true };
    }

    return { normalized: query, didNormalize: false };
  } catch (error) {
    console.warn("[Phase0] Normalization failed, using original query:", error);
    return { normalized: query, didNormalize: false };
  }
}
