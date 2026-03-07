import OpenAI from "openai";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClient) return openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

function shouldLog(): boolean {
  const configured = process.env.LOG_AI_AGENT_PROMPT?.toLowerCase();
  if (configured === "true" || configured === "1") return true;
  if (configured === "false" || configured === "0") return false;
  return process.env.NODE_ENV !== "production";
}

// Connectors that give Phase 1 structural cues about how concepts relate.
const CONNECTOR_PATTERN =
  /\b(with|that|which|who|where|for|from|when|whenever|if)\b/i;

// Words that separate concepts and remove adjacency ambiguity.
const SEPARATOR_PATTERN = /\b(and|or|but|then|also)\b|,|;/i;

// Known MTG keyword abilities that are commonly listed without connectors.
const MTG_KEYWORDS = new Set([
  "flying", "trample", "vigilance", "lifelink", "haste",
  "deathtouch", "hexproof", "indestructible", "reach",
  "first strike", "double strike", "menace", "prowess",
  "flash", "ward", "defender", "shroud", "protection",
  "fear", "intimidate", "skulk", "shadow",
]);

// Single-word subset for fast adjacency checks.
const SINGLE_WORD_KEYWORDS = new Set(
  [...MTG_KEYWORDS].filter((kw) => !kw.includes(" "))
);

const GRANT_VERBS = /\b(give[sd]?|giving|grant[sd]?|granting|make[sd]?|making)\b/i;

const STOPWORDS = new Set([
  "a", "an", "the", "i", "my", "me", "its", "is", "are", "was",
  "cards", "card", "some", "any", "all", "of", "to", "in", "on",
]);

/**
 * Deterministic heuristic — returns true when the query is structurally
 * ambiguous enough that an LLM rewrite is likely to help Phase 1.
 */
export function shouldNormalize(query: string): boolean {
  const lower = query.toLowerCase().trim();

  // Very short queries are inherently unambiguous.
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return false;

  // Already contains Scryfall syntax — user typed a direct query.
  if (/[a-z]+:[^\s]/.test(lower)) return false;

  // If the query already has structural connectors, Phase 1 can parse it.
  if (CONNECTOR_PATTERN.test(lower) && SEPARATOR_PATTERN.test(lower)) {
    return false;
  }

  const substantive = words.filter((w) => !STOPWORDS.has(w));

  // Signal 1: multiple keywords listed adjacently without separators.
  const keywordsPresent = substantive.filter((w) => SINGLE_WORD_KEYWORDS.has(w));
  if (keywordsPresent.length >= 2 && !SEPARATOR_PATTERN.test(lower)) {
    return true;
  }

  // Signal 2: grant verb + keyword(s) but no connector between them.
  if (GRANT_VERBS.test(lower) && keywordsPresent.length >= 1 && !CONNECTOR_PATTERN.test(lower)) {
    return true;
  }

  // Signal 3: 4+ substantive tokens with NO connectors and NO separators at all.
  // Pure "stacked nouns" like "white creatures haste flash etb draw".
  if (
    substantive.length >= 4 &&
    !CONNECTOR_PATTERN.test(lower) &&
    !SEPARATOR_PATTERN.test(lower)
  ) {
    return true;
  }

  return false;
}

const SYSTEM_PROMPT = `You add minimal grammatical structure to ambiguous Magic: The Gathering card search queries.

Rules:
- Add ONLY connecting words (with, that, and, or, for, in, to) and commas
- NEVER remove, replace, or rephrase the user's words
- NEVER add new search concepts, card names, or filters
- NEVER output Scryfall syntax (no t:, o:, kw:, etc.)
- If the query is already clear and grammatical, return it unchanged
- Preserve typos — downstream systems handle spelling correction
- Keep the output as close to the input as possible
- Output ONLY the restructured query. No quotes, no explanations.

Examples:
"angels lifelink hexproof" → "angels with lifelink and hexproof"
"white creatures haste flash etb draw" → "white creatures with haste and flash that draw on etb"
"green ramp draw instant" → "green instant that ramps and draws"
"removal not targeting destroy" → "removal that does not target or destroy"
"red burn spell 3 damage creature" → "red burn spell that deals 3 damage to a creature"
"flying tokens white commander" → "white flying tokens for commander"
"sacrifice outlet aristocrats black" → "black sacrifice outlet for aristocrats"
"give creatures indestrucible angels" → "angels that give creatures indestrucible"
"blue counterspell cheap modern" → "cheap blue counterspell for modern"`;

/**
 * Validates the LLM response. Returns the normalized query if safe,
 * or null if the response should be discarded.
 */
function validateResponse(original: string, response: string): string | null {
  const trimmed = response.trim()
    // Strip surrounding quotes the model might add
    .replace(/^["']|["']$/g, "")
    .trim();

  if (!trimmed) return null;

  // Reject if the model produced Scryfall syntax.
  if (/[a-z]+:[^\s]/.test(trimmed)) return null;

  // Reject if unreasonably longer than original.
  if (trimmed.length > original.length * 2.5) return null;

  // Reject if the model removed substantive words from the original.
  const originalWords = new Set(
    original.toLowerCase().match(/[a-z0-9]+/g) ?? []
  );
  const responseWords = new Set(
    trimmed.toLowerCase().match(/[a-z0-9]+/g) ?? []
  );
  for (const word of originalWords) {
    if (STOPWORDS.has(word)) continue;
    if (!responseWords.has(word)) return null;
  }

  return trimmed;
}

/**
 * Phase 0: structural query normalization.
 * Adds grammatical connectors to ambiguous queries so Phase 1 can parse
 * them reliably. Gated — returns the original query unchanged when the
 * input is already structurally clear.
 */
export async function normalizeQuery(
  query: string
): Promise<{ normalized: string; didNormalize: boolean }> {
  if (!shouldNormalize(query)) {
    return { normalized: query, didNormalize: false };
  }

  try {
    const response = await getOpenAIClient().responses.create({
      model: OPENAI_MODEL,
      reasoning: { effort: "low" },
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
      max_output_tokens: 200,
    });

    const usage = response.usage;
    if (shouldLog()) {
      const input = usage?.input_tokens ?? 0;
      const output = usage?.output_tokens ?? 0;
      const total = usage?.total_tokens ?? input + output;
      console.log(
        `[Phase0][AI Usage] input_tokens=${input} output_tokens=${output} total_tokens=${total}`
      );
    }

    const text = response.output_text?.trim() ?? "";
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
