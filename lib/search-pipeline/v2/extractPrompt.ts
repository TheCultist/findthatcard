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

export const V2_SYSTEM_PROMPT =
  "You are a Magic: The Gathering search parser. You convert a natural-language " +
  "card-search request into a structured JSON object of concrete search constraints. " +
  "You fix spelling and grammar implicitly while extracting. You never invent " +
  "constraints the user did not express. When unsure, leave a field empty/null rather " +
  "than guessing.";

function formatArchetypeMenu(entries: ArchetypeMenuEntry[]): string {
  return entries
    .map((e) => {
      const quals = e.qualifiers ? ` [qualifiers: ${e.qualifiers.join(", ")}]` : "";
      return `  ${e.name}: ${e.description}${quals}`;
    })
    .join("\n");
}

export function buildExtractPrompt(args: ExtractPromptArgs): string {
  const archetypeMenu = formatArchetypeMenu(getArchetypeMenu());
  const fnTags = args.availableFunctionTags.slice(0, 60).join(", ") || "none";
  const artTags = args.availableArtTags.slice(0, 40).join(", ") || "none";
  const recognized = args.recognizedCardNames.length
    ? args.recognizedCardNames.map((n) => `"${n}"`).join(", ")
    : "none";

  return [
    `User query: "${args.query}"`,
    "",
    `Card names recognized in the query (treat these as protected card names, never as filters): ${recognized}`,
    "",
    "Extract the following into the JSON schema. Fill only what the user actually expressed.",
    "",
    "FIELD RULES:",
    "- intent: 'search' for a normal attribute search. 'commander-deck' when the user asks for cards for a commander/EDH deck of a colour or archetype (not a specific card). 'similar-cards' for 'cards like/similar to X'. 'art-like-cards' for 'art like X'. 'synergy-with-card' for 'synergy with X' / 'for my X deck' where X is a specific card. For named-card intents set cardName to the referenced card.",
    "- cardName: the specific card the query is about (similar/art/synergy intents), or a card the user is literally searching by name. Use the recognized card names above when present. null otherwise.",
    "- colors: mode 'identity' for commander/EDH colour requests (Scryfall id:), mode 'color' for a card's actual colours (Scryfall c:). op ':' means 'contains', '=' means 'exactly', '>=' / '<=' for at-least / at-most. letters use w u b r g (c for colorless). combine 'and' when the card must have ALL the colours together (guild/shard/wedge names like azorius=wu, jund=brg, or 'red and green cards'); combine 'or' when the colours are ALTERNATIVES and any one qualifies ('red or green', 'white, blue, or black cards'). A single colour uses combine 'and'. Use 'identity' by default for colour requests unless the user clearly means the card's own colours. null if no colour mentioned.",
    "- typesAll: base card types the card must have ALL of, for COMPOUND types (e.g. 'artifact creatures' -> [artifact, creature]; 'enchantment creatures' -> [enchantment, creature]). typesAny: base types where ANY qualifies, for ENUMERATED alternatives (e.g. 'instants or sorceries' -> [instant, sorcery]; 'instants and sorceries' also -> typesAny [instant, sorcery] because a card cannot be both). A single base type goes in typesAll. negatedTypes: excluded base types. Base types only (creature, instant, sorcery, artifact, enchantment, land, planeswalker, battle) — never subtypes.",
    "- subtypes: creature/artifact/enchantment/land/etc. subtypes (dragon, goblin, equipment, aura, saga...).",
    "- supertypes: legendary, snow, basic, world.",
    "- stats: mv=mana value/cmc, pow=power, tou=toughness, loy=loyalty. Map colloquials: cheap->mv<=2, expensive->mv>=6, big->pow>=5, small creatures->pow<=1.",
    "- rarity: codes is a list of c/u/r/m. 'common and uncommon' -> op ':' codes ['c','u']; 'rare' -> op ':' codes ['r']; 'uncommon or better' -> op '>=' codes ['u']. year: 4-digit printed year with a comparison op.",
    "- keywords: evergreen/named ability keywords the card ITSELF has (flying, lifelink, deathtouch, ward, flash...). NOT keywords it grants to others (that is oraclePhrases).",
    `- format: one Scryfall format slug from this list only: ${SCRYFALL_FORMAT_PROMPT_LIST}. Compound names are ONE format — never emit two. "pauper edh" / "pauper commander" / "pdh" / "pedh" / "paupercommander" → paupercommander (NOT pauper + commander). "edh" alone → commander. "penny dreadful" → penny; "duel commander" → duel; "old school" / "93/94" → oldschool; "future standard" → future; "standard brawl" → standardbrawl; "competitive brawl" → competitivebrawl; "tiny leaders reborn" → tlr. For paupercommander commanders, still set format to paupercommander (do NOT force legendary — PDH commanders are uncommon creatures, not legendary). When searching for cards that can be a commander / brawler / oathbreaker / duel commander / pauper commander, do NOT put creature or legendary in typesAll/supertypes — eligibility is: flags already imply those.`,
    "- set: a set name or 3-letter code if the user constrained to a set/edition.",
    "- artist: illustrator name only.",
    "- artSubjects: things literally DEPICTED in the card art — ONLY when the user mentions art/illustration/depiction/artwork. Never use art for mechanics or types.",
    "",
    "SEMANTIC EFFECTS (choose archetypes OR functionTags OR oraclePhrases — prefer the most specific that is accurate):",
    "- archetypes: when the request clearly matches one of the KNOWN ARCHETYPES below, use its name (and a qualifier if listed). This is preferred for broad strategies.",
    "- functionTags: Tagger function slugs for gameplay roles (e.g. sacrifice-outlet, boardwipe, counterspell, card-draw). ONLY use slugs from the AVAILABLE FUNCTION TAGS list below. Do not invent slugs. Prefer ONE broad, accurate tag over stacking several narrow ones — extra tags are OR-combined, so many narrow tags still over-narrow when the query also has type/colour filters.",
    "- SYNERGY / SUPPORT phrasing ('elf synergies', 'support for goblins', 'cards that go with X'): the user wants payoffs/enablers for a theme, NOT necessarily cards of that subtype. Do NOT force a subtype filter (no t:elf for 'elf synergies'); use the matching archetype or a tribal/typal function tag instead.",
    "- TRIBAL / TYPAL themes: for a GENERIC tribal/typal request with NO specific creature type named ('a tribal theme', 'tribal payoffs', 'typal matters'), use the broad function tag 'tribal' (or 'typal') if offered — do NOT pick arbitrary per-type function tags like dragon-tribal or hate-tribal-goblin. Only use a specific X-tribal function tag when the user actually names creature type X (e.g. 'goblin tribal' -> tribal-goblin).",
    "- oraclePhrases: SHORT oracle tokens (usually ONE or TWO words) that appear in rules text, for specific triggers/effects not covered by an archetype or function tag. Multiple oraclePhrases are AND-ed, so keep them minimal and generic to avoid zero results. Prefer single tokens: 'draws cards when it enters' -> ['enters','draw'] (NOT 'enters the battlefield' or 'draw a card'); 'whenever you cast a spell' -> ['whenever you cast']. A single unquoted token matches partial words, but a QUOTED PHRASE is an exact substring — it silently misses other inflections (o:\"lose all abilities\" does NOT match 'loses all abilities'). So never put an inflectable verb inside a multi-word phrase: split it into separate stem tokens instead — 'strip creatures of their abilities' -> ['lose','abilities'] (cards say both 'loses all abilities' and 'creatures lose all abilities'); use 'destroy' not 'destroys', 'sacrifice' not 'sacrifices'. Use '~' for the card's own name. Use this for granted keywords too (e.g. giving flying to others -> ['flying']).",
    "- negatedOraclePhrases: text the card must NOT contain.",
    "- Do NOT emit both a functionTag and an oraclePhrase for the same intent — pick one.",
    "- NEVER put card types in functionTags/oraclePhrases/artSubjects.",
    "- STRUCTURAL-ONLY QUERIES: if the query only names card types, supertypes, subtypes, colours, mana value, rarity, keywords, format, artist or a set (no effect, role, or strategy), leave archetypes, functionTags and oraclePhrases EMPTY. Do NOT attach a synergy/support/matters function tag just because a type or subtype is mentioned (e.g. 'snow lands' -> supertypes:[snow], types:[land], nothing else; 'legendary dragons' -> supertypes/subtypes only; 'red rares' -> colours + rarity only).",
    "",
    "KNOWN ARCHETYPES:",
    archetypeMenu,
    "",
    `AVAILABLE FUNCTION TAGS (only use these slugs): ${fnTags}`,
    `AVAILABLE ART TAGS (only use these slugs): ${artTags}`,
    "",
    "Return the structured object now.",
  ].join("\n");
}
