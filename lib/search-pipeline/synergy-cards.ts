import OpenAI from "openai";
import { fetchCardByName, ScryfallNamedCard } from "@/lib/scryfall/lookup";
import { fetchTaggerCardData } from "@/lib/scryfall/tagger-graphql";

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

const COLOR_MAP: Record<string, string> = {
  W: "white", U: "blue", B: "black", R: "red", G: "green",
};

function describeColorIdentity(identity: string[]): string {
  if (identity.length === 0) return "colorless";
  return identity.map((c) => COLOR_MAP[c] ?? c).join("/");
}

function getFullOracleText(card: ScryfallNamedCard): string {
  if (card.oracle_text) return card.oracle_text;
  if (card.card_faces?.length) {
    return card.card_faces
      .map((face) => face.oracle_text ?? "")
      .filter(Boolean)
      .join("\n---\n");
  }
  return "";
}

function getFullTypeLine(card: ScryfallNamedCard): string {
  if (card.card_faces?.length) {
    return card.card_faces.map((f) => f.type_line).join(" // ");
  }
  return card.type_line;
}

type SynergyResponse = {
  scryfall_query: string;
  reasoning?: string;
};

function buildSynergyPrompt(
  card: ScryfallNamedCard,
  oracleText: string,
  functionTags: string[],
): string {
  const identity = describeColorIdentity(card.color_identity);
  const keywords = card.keywords.length > 0 ? card.keywords.join(", ") : "none";
  const slugifiedTags = functionTags.map((t) => t.replace(/\s+/g, "-"));
  const tagList = slugifiedTags.length > 0 ? slugifiedTags.join(", ") : "none";

  return [
    "You are a Magic: The Gathering deck-building expert. Given a card, produce a Scryfall search query that finds cards which synergize with it.",
    "",
    `Card: ${card.name}`,
    `Type: ${getFullTypeLine(card)}`,
    `Color identity: ${identity}`,
    `Keywords: ${keywords}`,
    `Mana value: ${card.cmc}`,
    `Community function tags: ${tagList}`,
    `Oracle text:`,
    oracleText,
    "",
    "Task: Write a single Scryfall query string that finds cards which SYNERGIZE with this card — cards that ENABLE it or BENEFIT FROM what it does.",
    "",
    "IMPORTANT: Synergy means COMPLEMENTARY, not SIMILAR. Do NOT find cards that share the same mechanics.",
    "Instead, think about:",
    "  - What INPUTS does this card need? (e.g. if it cares about creature count, find token makers)",
    "  - What SETUP does it require? (e.g. if it triggers on attack, find cards that grant extra combats)",
    "  - What OUTPUT does it produce, and what PAYOFFS capitalize on that? (e.g. if it mills, find graveyard payoffs)",
    "  - Watch for NONBOS: if the card cares about a specific value or state (e.g. creatures having a chosen power), avoid effects that change that state (e.g. pump spells that alter power away from the desired number).",
    "",
    "Guidelines:",
    "- Think like a deck-builder: what other cards make this card shine? What does the deck around this card look like?",
    "- Use Scryfall syntax: o:\"text\" for oracle text, kw:keyword for keyword abilities, t:type for types, function:tag for Tagger function tags.",
    "- Each function: tag alone matches 200–500+ cards. OR-ing 3+ tags easily exceeds 1000 results. Keep it tight:",
    "  - Pick 1–2 function: tags for the card's PRIMARY synergy axis only.",
    "  - Narrow each group with a structural filter: kw:keyword, t:type, or mv>=N (e.g. function:topdeck-manipulation kw:surveil, or function:token-maker t:creature).",
    "  - Do NOT AND two function: tags together (near-zero results). Instead AND a function: tag with a type/keyword/mana-value filter.",
    "- Avoid umbrella tags (function:mana-producer, function:removal, function:draw-card, function:token-maker, function:pump) — prefer narrower variants.",
    "- Prefer function: tags over o: oracle text.",
    "- Only use o:\"...\" for specific multi-word phrases. Never use single-word o: fragments (o:attacks, o:dies, o:draws) — they match thousands of cards.",
    "- Do NOT add -o: or -name: exclusions to remove the original card — the system handles that automatically.",
    "- Do NOT add id: or id<= color identity filters — the system injects those automatically.",
    "- Keep the query under 400 characters.",
    "- Do NOT add format filters (f:commander, f:modern, etc.) — the user may add those separately.",
    "- Do NOT use name: filters for specific card names — find synergy by mechanics, not by listing known good cards.",
    "",
    "Output JSON only (no markdown). Shape:",
    '{"scryfall_query":"...","reasoning":"one sentence explaining the synergy axes"}',
    "",
    "Example — for a Sultai commander that surveils and plays high-MV spells from the top of the library:",
    '{"scryfall_query":"(function:topdeck-manipulation kw:surveil) OR (function:library-manipulation mv>=4) id<=ubg","reasoning":"Surveil cards set up the top of the library, and high-MV library manipulation provides castable spells."}',
  ].join("\n");
}

function sanitizeScryfallQuery(raw: string, cardName: string): string | null {
  let query = raw.trim();
  if (!query || query.length < 3) return null;

  if (query.startsWith('"') && query.endsWith('"')) {
    query = query.slice(1, -1);
  }

  query = query.replace(/\bf:\w+\b/gi, "").replace(/\s{2,}/g, " ").trim();

  // Strip bare single-word oracle text fragments — they match too broadly.
  // o:"multi word phrase" is fine; o:singleword is not.
  query = query.replace(/\bo:"[^"]{1,15}"\b/g, (match) => {
    const inner = match.slice(3, -1);
    return /\s/.test(inner) ? match : "";
  });
  query = query.replace(/\bo:\S+/g, (match) => {
    if (match.startsWith('o:"')) return match;
    return "";
  });
  query = query.replace(/\s{2,}/g, " ").trim();

  query = query.replace(
    /\b(function|otag|oracletag|art|atag|arttag):"([^"]+)"/gi,
    (_match, prefix: string, value: string) => `${prefix}:${value.replace(/\s+/g, "-")}`
  );

  // Strip any identity filters the AI may have added — they are injected by the pipeline.
  query = query.replace(/\bid(?:entity)?(?:<=|>=|=|:)\s*[wubrgc]{1,5}\b/gi, "").replace(/\s{2,}/g, " ").trim();

  query = query.replace(/-o:"[^"]*"/g, "").replace(/-o:\S+/g, "").replace(/-!"[^"]*"/g, "").replace(/-n:"[^"]*"/g, "").replace(/\s{2,}/g, " ").trim();

  if (!query.includes(`-name:"${cardName}"`)) {
    query = `${query} -name:"${cardName}"`;
  }

  return query || null;
}

export const __testOnly = {
  sanitizeScryfallQuery,
};

export type SynergyQueryResult = {
  query: string;
  /** Color identity of the commander, e.g. "bg" or "". Used to inject id<= externally. */
  colorIdentity: string;
  reasoning?: string;
  aiTokens: { input: number; output: number; total: number };
};

/**
 * Given a card name, fetches the card from Scryfall, reads its oracle text
 * and community tags, then asks an LLM to produce a Scryfall query that
 * finds cards which synergize with it.
 */
export async function resolveSynergyQuery(cardName: string): Promise<SynergyQueryResult | null> {
  const card = await fetchCardByName(cardName);
  if (!card) {
    console.warn(`[Synergy] Card not found: "${cardName}"`);
    return null;
  }

  const oracleText = getFullOracleText(card);
  if (!oracleText) {
    console.warn(`[Synergy] No oracle text for "${card.name}"`);
    return null;
  }

  console.log(`[Synergy] Resolving synergy query for: "${card.name}" (${card.set}/${card.collector_number})`);

  let functionTags: string[] = [];
  try {
    const tagger = await fetchTaggerCardData(card.set, card.collector_number);
    if (tagger) {
      functionTags = tagger.functionTags;
      console.log(`[Synergy] Tagger tags for "${card.name}": [${functionTags.join(", ")}]`);
    }
  } catch {
    // Tagger is best-effort
  }

  const prompt = buildSynergyPrompt(card, oracleText, functionTags);

  if (shouldLog()) {
    console.log(`[Synergy][AI Prompt]\n${prompt}`);
  }

  const client = getOpenAIClient();
  const response = await client.responses.create({
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    input: [{ role: "user", content: prompt }],
    max_output_tokens: 2000,
  });

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const totalTokens = response.usage?.total_tokens ?? inputTokens + outputTokens;

  if (shouldLog()) {
    console.log(
      `[Synergy][AI Usage] input_tokens=${inputTokens} output_tokens=${outputTokens} total_tokens=${totalTokens}`
    );
  }

  const text = response.output_text?.trim() || "";

  let parsed: SynergyResponse;
  try {
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    parsed = JSON.parse(cleaned) as SynergyResponse;
  } catch {
    console.warn(`[Synergy] Failed to parse LLM response (${text.length} chars): ${text.slice(0, 300)}`);
    return null;
  }

  const query = sanitizeScryfallQuery(parsed.scryfall_query ?? "", card.name);
  if (!query) {
    console.warn(`[Synergy] LLM returned empty/invalid query for "${card.name}"`);
    return null;
  }

  console.log(`[Synergy] Result for "${card.name}": ${query}`);
  if (parsed.reasoning) {
    console.log(`[Synergy] Reasoning: ${parsed.reasoning}`);
  }

  return {
    query,
    colorIdentity: card.color_identity.length > 0 ? card.color_identity.join("").toLowerCase() : "",
    reasoning: parsed.reasoning,
    aiTokens: { input: inputTokens, output: outputTokens, total: totalTokens },
  };
}
