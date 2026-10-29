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
  [
    "sphinxes in esper with odd mana value",
    { intent: "search", colors: { mode: "identity", op: ":", letters: "wub", combine: "and" }, subtypes: ["sphinx"], mvParity: "odd" },
  ],
  ["counterspells that cost 1", { intent: "search", stats: [{ field: "mv", op: "=", value: 1 }], archetypes: [{ name: "counterspell", qualifier: null }] }],
  ["goblin tribal payoffs for EDH", { intent: "search", format: "commander", functionTags: ["tribal-goblin"] }],
  [
    "pauper edh commanders with double strike",
    { intent: "search", format: "paupercommander", commanderEligible: true, keywords: ["double strike"] },
  ],
  ["commanders with flying", { intent: "search", commanderEligible: true, keywords: ["flying"] }],
  [
    "removal for my golgari commander deck",
    {
      intent: "search",
      format: "commander",
      colors: { mode: "identity", op: ":", letters: "bg", combine: "and" },
      archetypes: [{ name: "removal", qualifier: null }],
    },
  ],
  [
    "white creature removal",
    {
      intent: "search",
      colors: { mode: "identity", op: ":", letters: "w", combine: "and" },
      archetypes: [{ name: "removal", qualifier: "creature" }],
    },
  ],
  ["cards that make zombie tokens", { intent: "search", archetypes: [{ name: "tokens", qualifier: "zombie" }] }],
  [
    "creatures with flying that aren't blue and don't have trample",
    { intent: "search", typesAll: ["creature"], keywords: ["flying"], negatedColors: "u", negatedKeywords: ["trample"] },
  ],
  ["squirrels from bloomburrow", { intent: "search", subtypes: ["squirrel"], sets: ["Bloomburrow"] }],
  ["artifacts that aren't from Kaladesh", { intent: "search", typesAll: ["artifact"], negatedSets: ["Kaladesh"] }],
  ["creatures that strip other creatures of their abilities", { intent: "search", typesAll: ["creature"], oraclePhrases: ["lose", "abilities"] }],
  [
    "board wipes that don't hit my own creatures",
    { intent: "search", archetypes: [{ name: "board-wipe", qualifier: null }], oraclePhrases: ["you don't control"] },
  ],
  [
    "orzhov creatures that gain life when they enter",
    {
      intent: "search",
      colors: { mode: "identity", op: ":", letters: "wb", combine: "and" },
      typesAll: ["creature"],
      triggeredEffects: [{ subject: "~", trigger: "enters", effect: "gain life" }],
    },
  ],
  [
    "creatures that make you draw whenever another creature dies",
    { intent: "search", typesAll: ["creature"], triggeredEffects: [{ subject: "creature", trigger: "dies", effect: "draw" }] },
  ],
  [
    "enchantments that drain opponents when a land enters",
    { intent: "search", typesAll: ["enchantment"], triggeredEffects: [{ subject: "land", trigger: "enters", effect: "opponent lose life" }] },
  ],
  ["cards with dragons in the art", { intent: "search", artSubjects: ["dragon"] }],
  ["cards set on Ravnica", { intent: "search", artSubjects: ["ravnica"] }],
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
    "- colors: mode 'identity' (Scryfall id:, the default for colour requests) or 'color' (c:, only when the user clearly means the card's own colours). letters w u b r g (c colorless). op ':' contains, '=' exactly, '>=' / '<=' at least / at most. combine 'and' = must have ALL (guild/shard/wedge names: azorius=wu, jund=brg, 'red and green'); 'or' = alternatives ('red or green', 'white, blue, or black'). Single colour → 'and'. negatedColors: letters the card must NOT be ('not blue' → 'u', 'non-red' → 'r').",
    "- typesAll: base types the card must have ALL of ('artifact creatures' → [artifact, creature]; a single type also goes here). typesAny: enumerated alternatives ('instants or sorceries', 'instants and sorceries' → [instant, sorcery] — one card is never both). negatedTypes: excluded base types. Base types only: creature, instant, sorcery, artifact, enchantment, land, planeswalker, battle.",
    "- subtypes: dragon, goblin, equipment, aura, saga… supertypes: legendary, snow, basic, world.",
    "- stats: mv (mana value), pow, tou, loy with op and value. cheap → mv<=2; expensive → mv>=6; big → pow>=5; small creatures → pow<=1. mvParity: 'odd' / 'even' for 'odd/even mana value' or 'odd/even cmc'.",
    "- rarity: op + codes list (c/u/r/m). 'common and uncommon' → ':' [c,u]; 'uncommon or better' → '>=' [u]. year: 4-digit year + op.",
    "- keywords: ability keywords the card ITSELF has (flying, ward, flash…). Keywords it GRANTS to others are oraclePhrases, not keywords. negatedKeywords: keywords the card must NOT have ('without flying').",
    `- format: exactly one slug from: ${SCRYFALL_FORMAT_PROMPT_LIST}. 'edh' → commander; 'pauper edh' / 'pdh' / 'pedh' → paupercommander (never pauper + commander); 'penny dreadful' → penny; 'duel commander' → duel; 'old school' / '93/94' → oldschool; 'standard brawl' → standardbrawl; 'tiny leaders' → tlr. Only set format when the user names one.`,
    "- commanderEligible: true when the cards must be able to LEAD a deck ('commanders', 'PDH commanders', 'brawlers', 'can be my commander') — never add creature or legendary types for it. A deck context ('for my commander deck', 'my commander is golgari') is NOT commanderEligible: it is format commander plus the deck's colours as identity.",
    "- sets: set names or codes the card must be printed in ('from Bloomburrow', 'blb', 'Final Fantasy cards'); several = alternatives. negatedSets: excluded sets ('not from Alpha'). A story location ('set on Ravnica', 'takes place on Innistrad') is artSubjects, never a set. 'Universes Beyond' is not a set.",
    "- artist: illustrator name. artSubjects: things DEPICTED in the art — only when the user says art/illustration/artwork/depicts, or a story location.",
    "",
    "EFFECTS — pick ONE channel per concept, in this order of preference:",
    "1. archetypes: when the request matches a KNOWN ARCHETYPE below (name + qualifier if listed). Preferred for strategies and roles.",
    "2. functionTags: Tagger slugs, ONLY from the AVAILABLE FUNCTION TAGS given with the query. One broad accurate tag beats several narrow ones.",
    "3. oraclePhrases: short rules-text tokens (1–2 words each, AND-ed anywhere on the card) for specific triggers/effects no archetype or tag covers. Never quote an inflectable verb inside a phrase — split it: 'loses all abilities' → ['lose','abilities']. '~' = the card's own name.",
    "4. triggeredEffects: an effect TIED TO a trigger ('draws when it dies', 'deals damage when it enters', 'makes a token whenever it attacks') is ONE object {subject, trigger, effect}. subject: '~' when the card itself triggers ('when it/they die', 'when this enters'); the noun of ANOTHER object when something else triggers it ('when a creature enters' → 'creature', 'whenever a land enters' → 'land'); null only when the user leaves it open ('death triggers that draw'). trigger and effect: literal rules-text words, never slang ('drain' → 'opponent lose life', 'ETB' → 'enters', 'make/give a token' → 'create', 'ramp' → 'add'). 'draws when it dies' → {subject:'~', trigger:'dies', effect:'draw'}; 'makes you draw when a creature enters' → {subject:'creature', trigger:'enters', effect:'draw'}. Never split a linked trigger+effect into oraclePhrases, and do not add an archetype/functionTag for the effect it already covers.",
    "Never emit an archetype AND a functionTag AND/OR an oraclePhrase/triggeredEffect for the same concept. Never put card types in functionTags/oraclePhrases/artSubjects or in a triggeredEffect's trigger/effect.",
    "An archetype qualifier names the effect's TARGET, so never repeat it as a type or subtype ('creature removal' → removal/creature, no typesAll). For tokens the qualifier is the token kind, any token type allowed ('makes zombie tokens' → tokens/zombie, no subtypes).",
    "Synergy / support / payoff / tribal wording ('elf synergies', 'goblin tribal payoffs', 'support for my X deck') means enablers and payoffs FOR the theme — do NOT add the subtype filter. Generic 'tribal'/'typal' with no creature type → function tag 'tribal' or 'typal' if offered.",
    "Structural-only queries (types, colours, mv, rarity, keywords, format, sets, artist, no effect or role) emit NO archetypes, functionTags or oraclePhrases.",
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
