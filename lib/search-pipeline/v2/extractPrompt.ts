import { SCRYFALL_FORMAT_PROMPT_LIST } from "@/lib/scryfall/formats";
import { getArchetypeMenu, type ArchetypeMenuEntry } from "@/lib/scryfall/query-converter";

export type ExtractPromptArgs = {
  query: string;
  /** Card names recognized in the query by the catalog pre-pass (protected entities). */
  recognizedCardNames: string[];
  /** Narrowed Tagger function tag slugs relevant to the query. */
  availableFunctionTags: string[];
  /** Narrowed Tagger art tag slugs relevant to the query. */
  availableArtTags: string[];
};

function formatArchetypeMenu(entries: ArchetypeMenuEntry[]): string {
  return entries
    .map((e) => {
      const quals = e.qualifiers ? ` [qualifiers: ${e.qualifiers.join(", ")}]` : "";
      return `  ${e.name}: ${e.description}${quals}`;
    })
    .join("\n");
}

/**
 * Worked examples do most of the teaching: small models follow "query → JSON"
 * pairs far more reliably than prose rules (especially negative ones). Each
 * output lists ONLY the fields that carry a value — that is the expected shape.
 */
const EXAMPLES: Array<[string, Record<string, unknown>]> = [
  ["snow lands", { intent: "search", typesAll: ["land"], supertypes: ["snow"] }],
  [
    "artifact creatures under 3 mana with flying",
    { intent: "search", typesAll: ["artifact", "creature"], stats: [{ field: "mv", op: "<", value: 3 }], keywords: ["flying"] },
  ],
  [
    "instants and sorceries that deal damage to each opponent",
    { intent: "search", typesAny: ["instant", "sorcery"], archetypes: [{ name: "damage", qualifier: "opponent" }] },
  ],
  [
    "white, blue, or black cards that draw cards for commander",
    {
      intent: "search",
      colors: { mode: "identity", op: ":", letters: "wub", combine: "or" },
      format: "commander",
      archetypes: [{ name: "card-draw", qualifier: null }],
    },
  ],
  [
    "cheap gruul removal",
    {
      intent: "search",
      colors: { mode: "identity", op: ":", letters: "rg", combine: "and" },
      stats: [{ field: "mv", op: "<=", value: 2 }],
      archetypes: [{ name: "removal", qualifier: null }],
    },
  ],
  [
    "uncommon or better green ramp printed before 2015",
    {
      intent: "search",
      colors: { mode: "identity", op: ":", letters: "g", combine: "and" },
      rarity: { op: ">=", codes: ["u"] },
      year: { op: "<", year: 2015 },
      archetypes: [{ name: "ramp", qualifier: null }],
    },
  ],
  ["counterspells that cost 1", { intent: "search", stats: [{ field: "mv", op: "=", value: 1 }], archetypes: [{ name: "counterspell", qualifier: null }] }],
  ["goblin tribal payoffs for EDH", { intent: "search", format: "commander", functionTags: ["tribal-goblin"] }],
  ["pauper edh commanders with double strike", { intent: "search", format: "paupercommander", keywords: ["double strike"] }],
  ["creatures that strip other creatures of their abilities", { intent: "search", typesAll: ["creature"], oraclePhrases: ["lose", "abilities"] }],
  ["board wipes that don't hit my own creatures", { intent: "search", functionTags: ["boardwipe"], oraclePhrases: ["you don't control"] }],
  ["cards with dragons in the art", { intent: "search", artSubjects: ["dragon"] }],
  [
    "cards similar to Sheoldred, the Apocalypse that aren't instants",
    { intent: "similar-cards", cardName: "Sheoldred, the Apocalypse", negatedTypes: ["instant"] },
  ],
];

function formatExamples(): string {
  return EXAMPLES.map(([q, out]) => `"${q}"\n${JSON.stringify(out)}`).join("\n\n");
}

/**
 * Static part of the prompt (role, rules, examples, archetype menu). Contains no
 * per-query content so it can sit in `system` — query-independent text first,
 * the query itself last, which is both the better layout for recall on small
 * models and the prerequisite for provider prompt caching.
 */
export function buildExtractSystemPrompt(): string {
  return [
    "You are a Magic: The Gathering search parser. Convert a natural-language card-search request into a JSON object of concrete search constraints. Fix spelling implicitly. Never invent constraints the user did not express — when unsure, omit the field.",
    "",
    "OUTPUT SHAPE: include ONLY fields that carry a value. Omit empty arrays and nulls. `intent` is always present.",
    "",
    "FIELDS",
    "- intent: 'search' (default) | 'similar-cards' ('cards like/similar to X') | 'art-like-cards' ('art like X') | 'synergy-with-card' ('synergy with X', 'for my X deck'). Named intents require X to be a specific card name (set cardName); if X is a colour, guild, tribe or theme, use 'search'.",
    "- cardName: the referenced card for named intents, or a card the user searches by name. Prefer the recognized card names given with the query.",
    "- colors: mode 'identity' (Scryfall id:, the default for colour requests) or 'color' (c:, only when the user clearly means the card's own colours). letters w u b r g (c colorless). op ':' contains, '=' exactly, '>=' / '<=' at least / at most. combine 'and' = must have ALL (guild/shard/wedge names: azorius=wu, jund=brg, 'red and green'); 'or' = alternatives ('red or green', 'white, blue, or black'). Single colour → 'and'.",
    "- typesAll: base types the card must have ALL of ('artifact creatures' → [artifact, creature]; a single type also goes here). typesAny: enumerated alternatives ('instants or sorceries', 'instants and sorceries' → [instant, sorcery] — one card is never both). negatedTypes: excluded base types. Base types only: creature, instant, sorcery, artifact, enchantment, land, planeswalker, battle.",
    "- subtypes: dragon, goblin, equipment, aura, saga… supertypes: legendary, snow, basic, world.",
    "- stats: mv (mana value), pow, tou, loy with op and value. cheap → mv<=2; expensive → mv>=6; big → pow>=5; small creatures → pow<=1.",
    "- rarity: op + codes list (c/u/r/m). 'common and uncommon' → ':' [c,u]; 'uncommon or better' → '>=' [u]. year: 4-digit year + op.",
    "- keywords: ability keywords the card ITSELF has (flying, ward, flash…). Keywords it GRANTS to others are oraclePhrases, not keywords.",
    `- format: exactly one slug from: ${SCRYFALL_FORMAT_PROMPT_LIST}. 'edh' → commander; 'pauper edh' / 'pdh' / 'pedh' → paupercommander (never pauper + commander); 'penny dreadful' → penny; 'duel commander' → duel; 'old school' / '93/94' → oldschool; 'standard brawl' → standardbrawl; 'tiny leaders' → tlr. A request for commanders / brawlers / oathbreakers / PDH commanders sets format only — no creature or legendary type (eligibility flags are added downstream).`,
    "- set: set name or 3-letter code. artist: illustrator name. artSubjects: things DEPICTED in the art — only when the user says art/illustration/artwork/depicts.",
    "",
    "EFFECTS — pick ONE channel per concept, in this order of preference:",
    "1. archetypes: when the request matches a KNOWN ARCHETYPE below (name + qualifier if listed). Preferred for strategies and roles.",
    "2. functionTags: Tagger slugs, ONLY from the AVAILABLE FUNCTION TAGS given with the query. One broad accurate tag beats several narrow ones.",
    "3. oraclePhrases: short rules-text tokens (1–2 words each, AND-ed) for specific triggers/effects no archetype or tag covers. Never quote an inflectable verb inside a phrase — split it: 'loses all abilities' → ['lose','abilities']; 'draws a card when it enters' → ['enters','draw']. '~' = the card's own name.",
    "Never emit an archetype AND a functionTag AND/OR an oraclePhrase for the same concept. Never put card types in functionTags/oraclePhrases/artSubjects.",
    "Synergy / support / payoff / tribal wording ('elf synergies', 'goblin tribal payoffs', 'support for my X deck') means enablers and payoffs FOR the theme — do NOT add the subtype filter. Generic 'tribal'/'typal' with no creature type → function tag 'tribal' or 'typal' if offered.",
    "Structural-only queries (types, colours, mv, rarity, keywords, format, set, artist, no effect or role) emit NO archetypes, functionTags or oraclePhrases.",
    "",
    "EXAMPLES (function tags shown were in that query's available list)",
    formatExamples(),
    "",
    "KNOWN ARCHETYPES",
    formatArchetypeMenu(getArchetypeMenu()),
  ].join("\n");
}

/** Per-query part: protected names, narrowed tag vocabulary, and the query itself (last). */
export function buildExtractPrompt(args: ExtractPromptArgs): string {
  const fnTags = args.availableFunctionTags.join(", ") || "none";
  const artTags = args.availableArtTags.join(", ") || "none";
  const recognized = args.recognizedCardNames.length
    ? args.recognizedCardNames.map((n) => `"${n}"`).join(", ")
    : "none";

  return [
    `Recognized card names (protected — never turn these into filters): ${recognized}`,
    `AVAILABLE FUNCTION TAGS: ${fnTags}`,
    `AVAILABLE ART TAGS: ${artTags}`,
    "",
    `User query: "${args.query}"`,
  ].join("\n");
}
