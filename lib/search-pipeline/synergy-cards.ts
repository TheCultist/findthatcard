import { callAI } from "@/lib/ai-client";
import {
  dropUnanchoredOrBranches,
  sanitizeFunctionalClause,
} from "@/lib/search-pipeline/card-query-sanitize";
import { isAiPromptLoggingEnabled } from "@/lib/search-pipeline/debug";
import { removeInvalidTagsFromQuery } from "@/lib/search-pipeline/phase3/finalizeQuery";
import { fetchCardByName, ScryfallNamedCard } from "@/lib/scryfall/lookup";
import { fetchTaggerCardData } from "@/lib/scryfall/tagger-graphql";
import { getTaggerTagContext } from "@/lib/tagger/context";
import { validateTaggerTags } from "@/lib/tagger/validation";

const shouldLog = isAiPromptLoggingEnabled;

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

/**
 * Cheap mana artifacts (Sol Ring, Signets, etc.) — used to add tighter prompt rules so
 * the model does not emit three broad OR branches that each match thousands of cards.
 */
function isManaRockStyleCard(
  card: ScryfallNamedCard,
  oracleText: string,
  functionTags: string[],
): boolean {
  const normalized = functionTags.map((t) => t.toLowerCase().replace(/\s+/g, "-"));
  if (
    normalized.some((t) =>
      [
        "mana-rock",
        "manarock",
        "utility-mana-rock",
        "mana-rock-with-sets-mechanic",
      ].some((needle) => t.includes(needle))
    )
  ) {
    return true;
  }
  const tl = getFullTypeLine(card).toLowerCase();
  if (!tl.includes("artifact")) return false;
  if (typeof card.cmc === "number" && card.cmc > 3) return false;
  const ot = oracleText.toLowerCase();
  return /\{t\}[^\n]{0,40}\badd\s+\{/.test(ot);
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
  const manaRock = isManaRockStyleCard(card, oracleText, functionTags);

  const manaRockBlock = manaRock
    ? [
        "",
        "CARD CLASS — mana rock / cheap mana artifact (taps for mana, low MV):",
        "- Goal: cards that COMBINE with the extra mana or with cheap artifacts — not every artifact payoff in the game.",
        "- **At most TWO top-level OR groups** (one OR between them). Never three OR branches — that routinely returns 1000+ cards.",
        "- **Forbidden pattern:** do NOT OR together function:artifact-payoff, function:activated-ability, and o:\"whenever you activate\" (or similar triples of ultra-broad umbrella tags).",
        "- Prefer ONE primary axis with tight filters, e.g.:",
        "  • function:extra-untap or o:\"untap\" with mv<=3 or t:instant, OR",
        "  • function:copy-spell OR function:copy-permanent with mv<=4, OR",
        "  • artifact-matter payoffs AND t:creature or mv<=2, OR",
        "  • cost reduction / affinity for artifacts with a concrete o:\"...\" phrase under 5 words.",
        "- If you use o:\"...\", it must be a distinctive phrase (not a single generic verb).",
      ].join("\n")
    : "";

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
    "- **Hard cap: at most TWO top-level OR branches** (one OR token: `A OR B`). Never `A OR B OR C` — that almost always returns 1000+ cards.",
    "- Each function: tag alone matches 200–500+ cards. Keep it tight:",
    "  - Pick 1–2 function: tags for the card's PRIMARY synergy axis only.",
    "  - Narrow each group with a structural filter: kw:keyword, t:type, or mv>=N (e.g. function:topdeck-manipulation kw:surveil, or function:token-maker t:creature).",
    "  - Do NOT AND two function: tags together (near-zero results). Instead AND a function: tag with a type/keyword/mana-value filter.",
    "- Avoid umbrella tags (function:mana-producer, function:removal, function:draw-card, function:token-maker, function:pump) — prefer narrower variants.",
    "- Prefer function: tags over o: oracle text.",
    "- Every function: tag MUST be a real Scryfall Tagger tag — do NOT invent plausible-sounding tags (function:card-draw-payoff does not exist). The community tags listed above are guaranteed valid. If unsure a tag exists, use kw:/t:/mv filters or a multi-word o:\"…\" phrase instead.",
    "- Only use o:\"...\" for specific multi-word phrases. Never use single-word o: fragments (o:attacks, o:dies, o:draws) — they match thousands of cards.",
    "- Do NOT add -o: or -name: exclusions to remove the original card — the system handles that automatically.",
    "- Do NOT add id: or id<= color identity filters — the system injects those automatically.",
    "- Keep the query under 400 characters.",
    "- Do NOT add format filters (f:commander, f:modern, etc.) — the user may add those separately.",
    "- Do NOT use name: filters for specific card names — find synergy by mechanics, not by listing known good cards.",
    manaRockBlock,
    "",
    "Output JSON only (no markdown). Shape:",
    '{"scryfall_query":"...","reasoning":"one sentence explaining the synergy axes"}',
    "",
    "Example — for a Sultai commander that surveils and plays high-MV spells from the top of the library:",
    '{"scryfall_query":"(function:topdeck-manipulation kw:surveil) OR (function:library-manipulation mv>=4) id<=ubg","reasoning":"Surveil cards set up the top of the library, and high-MV library manipulation provides castable spells."}',
  ].join("\n");
}

function sanitizeScryfallQuery(raw: string, cardName: string): string | null {
  const clause = sanitizeFunctionalClause(raw);
  if (!clause) return null;

  if (!clause.includes(`-name:"${cardName}"`)) {
    return `${clause} -name:"${cardName}"`;
  }
  return clause;
}

/**
 * Builds the correction message appended to the prompt when the model's first
 * query used Tagger tags that don't exist. Suggests valid catalog tags whose
 * segments resemble the hallucinated ones (best-effort, via the same scorer
 * that narrows tag context for extraction).
 */
async function buildInvalidTagFeedback(
  previousQuery: string,
  invalid: Array<{ type: "art" | "function"; tag: string }>
): Promise<string> {
  let suggestions: string[] = [];
  try {
    const ctx = await getTaggerTagContext(
      invalid.map((t) => t.tag.replace(/-/g, " ")).join(" ")
    );
    suggestions = ctx.function.slice(0, 25);
  } catch {
    // Suggestions are best-effort; the feedback works without them.
  }
  return [
    "",
    `Your previous query was: ${previousQuery}`,
    "It used Tagger tags that DO NOT EXIST in the catalog and matched zero cards:",
    ...invalid.map((t) => `- ${t.type}:${t.tag}`),
    suggestions.length > 0
      ? `Real catalog tags with similar meaning: ${suggestions.join(", ")}`
      : "",
    'Rewrite the query using ONLY the community tags listed for the card, the real catalog tags above, or structural filters (kw:/t:/mv/o:"multi word phrase"). Same JSON shape.',
  ]
    .filter(Boolean)
    .join("\n");
}

export const __testOnly = {
  sanitizeScryfallQuery,
  isManaRockStyleCard,
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

  const usage = { input: 0, output: 0, total: 0 };

  const askModel = async (userPrompt: string): Promise<SynergyResponse | null> => {
    const response = await callAI({
      user: userPrompt,
      max_output_tokens: 2000,
    });
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.total += response.usage.total_tokens;
    if (shouldLog()) {
      console.log(
        `[Synergy][AI Usage] input_tokens=${response.usage.input_tokens} output_tokens=${response.usage.output_tokens} total_tokens=${response.usage.total_tokens}`
      );
    }
    try {
      const cleaned = response.text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
      return JSON.parse(cleaned) as SynergyResponse;
    } catch {
      console.warn(
        `[Synergy] Failed to parse LLM response (${response.text.length} chars): ${response.text.slice(0, 300)}`
      );
      return null;
    }
  };

  let parsed = await askModel(prompt);
  if (!parsed) return null;

  let clause = sanitizeFunctionalClause(parsed.scryfall_query ?? "");
  if (!clause) {
    console.warn(`[Synergy] LLM returned empty/invalid query for "${card.name}"`);
    return null;
  }

  // The model routinely invents plausible-sounding tags (function:card-draw-payoff).
  // An invalid tag makes its branch match ZERO cards — and stripping it later
  // leaves an unanchored broad shell instead. Validate here and retry ONCE with
  // explicit feedback; ponytail: single retry, no correction loop.
  let invalidTags = await validateTaggerTags(clause);
  if (invalidTags.length > 0) {
    console.warn(
      `[Synergy] Query for "${card.name}" uses nonexistent tags [${invalidTags.map((t) => t.tag).join(", ")}]; retrying with feedback`
    );
    const feedback = await buildInvalidTagFeedback(parsed.scryfall_query ?? "", invalidTags);
    const retried = await askModel(prompt + "\n" + feedback);
    const retriedClause = retried ? sanitizeFunctionalClause(retried.scryfall_query ?? "") : null;
    if (retriedClause) {
      parsed = retried!;
      clause = retriedClause;
      invalidTags = await validateTaggerTags(clause);
    }
  }

  // Last resort: strip tags that are still invalid, then drop any OR branch
  // left without a selective anchor — a branch reduced to `(t:instant OR
  // t:sorcery)` floods the results with every instant/sorcery.
  if (invalidTags.length > 0) {
    console.warn(
      `[Synergy] Retry still used nonexistent tags [${invalidTags.map((t) => t.tag).join(", ")}]; stripping them`
    );
    const stripped = removeInvalidTagsFromQuery(clause, invalidTags);
    const anchored = dropUnanchoredOrBranches(stripped);
    if (!anchored) {
      console.warn(`[Synergy] No anchored clause left after stripping invalid tags for "${card.name}"`);
      return null;
    }
    clause = anchored;
  }

  const query = clause.includes(`-name:"${card.name}"`)
    ? clause
    : `${clause} -name:"${card.name}"`;

  console.log(`[Synergy] Result for "${card.name}": ${query}`);
  if (parsed.reasoning) {
    console.log(`[Synergy] Reasoning: ${parsed.reasoning}`);
  }

  return {
    query,
    colorIdentity: card.color_identity.length > 0 ? card.color_identity.join("").toLowerCase() : "",
    reasoning: parsed.reasoning,
    aiTokens: { input: usage.input, output: usage.output, total: usage.total },
  };
}
