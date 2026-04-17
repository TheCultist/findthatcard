import { ResolverCategory } from "../types";
import { getArchetypeMenu, type ArchetypeMenuEntry } from "@/lib/scryfall/query-converter";

type BuildResolverPromptArgs = {
  category: ResolverCategory;
  fragments: string[];
  naturalQuery: string;
  availableArtTags: string[];
  availableFunctionTags: string[];
};

function categoryInstructions(category: ResolverCategory): string {
  switch (category) {
    case "art":
      return "Map each fragment to art:* tags for depicted visual subjects in the card illustration.";
    case "mechanic":
      return "Map each fragment to keyword/function/oracle tags representing game mechanics.";
    case "effect":
      return "Map each fragment to function:/oracletag:/o: tags for gameplay effects.";
    default:
      return "Map each fragment to the best Scryfall tags/operators.";
  }
}

function formatArchetypeMenu(entries: ArchetypeMenuEntry[]): string {
  return entries
    .map((e) => {
      const quals = e.qualifiers ? ` [qualifiers: ${e.qualifiers.join(", ")}]` : "";
      return `  ${e.name}: ${e.description}${quals}`;
    })
    .join("\n");
}

const FEW_SHOT_EXAMPLES = `
{"results":[{"fragment":"make opponents pay to swing at me","archetype":"pillow-fort","qualifier":null,"tags":[],"confidence":0.9}]}
{"results":[{"fragment":"etb draw effects","archetype":null,"qualifier":null,"tags":["o:\"~ enters\"","o:draw"],"confidence":0.85}]}
{"results":[{"fragment":"give mana when enter","archetype":null,"qualifier":null,"tags":["o:\"~ enters\"","o:\"add\""],"confidence":0.85}]}
{"results":[{"fragment":"trigger when a zombie enters","archetype":null,"qualifier":null,"tags":["o:enters","o:zombie"],"confidence":0.85}]}
{"results":[{"fragment":"deal damage to creatures","archetype":"damage","qualifier":"creature","tags":[],"confidence":0.9}]}
{"results":[{"fragment":"cards depicting a forest at night","archetype":null,"qualifier":null,"tags":["art:forest","art:night"],"confidence":0.8}]}
{"results":[{"fragment":"ways to get lands back from graveyard","archetype":"reanimator","qualifier":"self","tags":[],"confidence":0.7}]}
{"results":[{"fragment":"give creatures indestructible","archetype":null,"qualifier":null,"tags":["o:indestructible"],"confidence":0.9}]}
{"results":[{"fragment":"grants flying to others","archetype":null,"qualifier":null,"tags":["o:flying"],"confidence":0.9}]}
{"results":[{"fragment":"make tokens hexproof","archetype":null,"qualifier":null,"tags":["o:hexproof"],"confidence":0.85}]}
{"results":[{"fragment":"makes blue mana for each spell you cast","archetype":null,"qualifier":null,"tags":["o:\"add {U}\"","o:\"for each\"","o:spell"],"confidence":0.9}]}
{"results":[{"fragment":"gets bigger for each artifact you control","archetype":null,"qualifier":null,"tags":["o:\"+1/+1\"","o:\"for each\"","o:artifact"],"confidence":0.9}]}
{"results":[{"fragment":"deals damage equal to the number of cards in hand","archetype":null,"qualifier":null,"tags":["o:\"equal to\"","o:\"cards in hand\""],"confidence":0.9}]}
{"results":[{"fragment":"whenever you cast an instant or sorcery draw a card","archetype":null,"qualifier":null,"tags":["o:\"whenever you cast\"","o:\"instant or sorcery\"","o:draw"],"confidence":0.9}]}
{"results":[{"fragment":"pings all opponents for damage when a noncreature spell is played","archetype":null,"qualifier":null,"tags":["function:cast-trigger-you","o:\"noncreature spell\"","function:burn-player"],"confidence":0.9}]}
{"results":[{"fragment":"that make themselves cheaper","archetype":null,"qualifier":null,"tags":["function:cheaper-than-mv"],"confidence":0.9}]}
{"results":[{"fragment":"create a token creature whenever you cast a spell","archetype":"tokens","qualifier":"creature","tags":["function:cast-trigger-you"],"confidence":0.95}]}
{"results":[{"fragment":"exile top library","archetype":null,"qualifier":null,"tags":["function:mill-exile"],"confidence":0.9}]}
{"results":[{"fragment":"exile cards from the top of a library","archetype":null,"qualifier":null,"tags":["function:mill-exile"],"confidence":0.95}]}`;

export function buildResolverPrompt({
  category,
  fragments,
  naturalQuery,
  availableArtTags,
  availableFunctionTags,
}: BuildResolverPromptArgs): string {
  const safeFragments = fragments.filter((f) => f.trim().length > 0).slice(0, 8);
  const compactArtTags = availableArtTags.slice(0, 40).join(", ");
  const compactFunctionTags = availableFunctionTags.slice(0, 60).join(", ");
  const archetypeMenu = formatArchetypeMenu(getArchetypeMenu());

  return [
    "You help resolve unresolved search fragments from a Magic: The Gathering card search query into Scryfall query tags.",
    "",
    `Full user query: "${naturalQuery}"`,
    `Category: ${category}`,
    categoryInstructions(category),
    "",
    "KNOWN ARCHETYPES (prefer classifying into one of these when the fragment clearly matches):",
    archetypeMenu,
    "",
    "Output JSON only (no markdown/prose). Shape:",
    '{"results":[{"fragment":"...","archetype":"name-or-null","qualifier":"qualifier-or-null","tags":["..."],"confidence":0.0}]}',
    "",
    "Rules:",
    "- If the fragment matches a known archetype above, set archetype (and qualifier if applicable). Leave tags empty UNLESS the fragment also specifies a trigger condition that further narrows the archetype (e.g. 'whenever you cast a spell', 'when a creature dies', 'when this enters'). In that case, set archetype AND include the relevant trigger tag (e.g. function:cast-trigger-you for spell-cast triggers) in tags.",
    "- If no archetype fits, set archetype to null and provide raw Scryfall tags (function:..., art:..., kw:..., o:\"...\"). NEVER use t: or type: tags — card-type filters are managed elsewhere.",
    "- use art: ONLY when the query explicitly mentions art, illustration, depiction, or visual appearance (e.g. 'with thopter art', 'depicting a dragon'). Do NOT use art: for creature types, card mechanics, or named MTG permanents that happen to appear in card art. use artist: for illustrator names.",
    "- max 4 raw tags per fragment.",
    "- confidence: 0.0-1.0. If uncertain, return empty tags with low confidence.",
    "- NEVER emit t: or type: tags under any circumstances. Card-type filtering (creature, instant, sorcery, etc.) is handled by a separate parser — emitting them here corrupts the query.",
    "- PLAYGROUP / POWER LEVEL: Words like casual, cEDH, kitchen table, pod, and meta describe the play environment or deck power — NOT printed oracle text. NEVER emit o:casual, o:fun, o:play, or similar for these; omit them entirely.",
    "- PLANESWALKER SUBTYPES: NEVER emit t: for a planeswalker subtype name (e.g. dack, jace, chandra) unless the user is clearly searching for planeswalkers. These are not creature types — t:creature plus t:dack yields zero Scryfall results. Kitchen-table / low-curve / playgroup phrasing is not a subtype.",
    "- DECK SUPPORT vs SUPPORT KEYWORD: Phrases like \"support cards\", \"tribal support\", \"deck support\", \"support for my commander deck\" mean enablers / synergy pieces for an archetype — NOT the Oath of the Gatewatch **Support** keyword mechanic. NEVER emit kw:support for those. ONLY use kw:support when the user clearly means the printed keyword (e.g. \"support 2\", \"Support N\", \"the Support keyword\"). Prefer function: tribal-synergy / typal / artifact-matter style tags or omit.",
    "- COMBO / SYNERGY (colloquial): Phrases like \"combos with\", \"synergy\", \"pairs with\", or \"shenanigans\" describe deckbuilding intent, not the word \"combo\" in rules text. NEVER emit o:combo or o:\"combo with\" for these — use function: / relevant o: mechanics (e.g. o:untap) or omit.",
    "- SPECIFIC CONDITIONS / TRIGGERS: When the fragment describes a specific trigger condition (enters, dies, attacks, taps, etc.) or a named effect unique to certain cards, use o: oracle text tags. Do NOT fall back to a broad function: tag that ignores the condition. Example: 'give mana when enters' → o:\"~ enters\" + o:\"add\", 'trigger when a land enters' → o:enters + o:land.",
    "- GROUP-SLUG vs SPELL-CAST DAMAGE: Archetype **group-slug** means informal table-wide damage/costs to **all opponents at once** with no extra condition. If the user ties damage/pings to **casting spells**, that is **NOT** group-slug — use archetype null and tags. For **noncreature spell** phrasing, use o:\"noncreature spell\" (covers instants/sorceries **and** artifacts, enchantments, planeswalkers, battles, etc.). **Do NOT** substitute o:\"instant or sorcery\" for noncreature spell — I/S is only a **subset** of noncreature spells. Only use o:\"instant or sorcery\" when the user explicitly asks for instants/sorceries. Prefer **function:cast-trigger-you** and **function:burn-player** (or related burn tags) over oracle for cast + damage — they are combined with **AND** (both required), not OR; avoid bare o:opponent alone (pulls non-damage payoffs).",
    "- SCALING / CONDITIONAL EFFECTS: When the fragment contains 'for each', 'for every', 'equal to the number of', 'per [noun]', 'proportional to', or any other quantitative scaling, you MUST use o: oracle text filters. NEVER map these to a broad function: tag AND NEVER classify them as any archetype (e.g. 'makes mana for each spell' is NOT archetype:ramp and is NOT function:ramp — it is o:\"add\" + o:\"for each\" + o:spell).",
    "- COST REDUCTION vs MANA RAMP: Phrases like **make itself/themselves cheaper**, **cheaper to cast**, **cost reduction**, **reduce its cost**, **costs less to cast**, or **make your spells cheaper** mean the **card costs less mana to cast** (self-discount / affinity-style), NOT adding mana or accelerating lands. Use **function:cheaper-than-mv** with archetype null — NEVER archetype:ramp and NEVER function:ramp or function:mana-ramp. True ramp is **putting extra lands into play** or **adding mana from permanents** (mana dorks, rocks, land search) — not paying less for the same spell.",
    "- LIBRARY-EXILE vs PEEK vs EXILE-ON-RESOLUTION: Use **function:mill-exile** when the fragment describes exiling cards FROM the top of a library (yours or an opponent's) — e.g. 'exile top of library', 'exile top card', 'exile from library'. Use **function:peek-library** ONLY for looking at / scrying the top card(s) WITHOUT necessarily moving them. Use **function:exile-on-resolution** ONLY for cards that exile a permanent or spell as their primary effect (i.e. removal-adjacent exile). NEVER use peek-library or exile-on-resolution for 'exile top of library' phrasing.",
    "- BROAD FUNCTION TAGS: Use function: tags only for broad, untriggered gameplay roles (e.g. 'counterspell effects', 'card draw engines', 'removal spells'). If the fragment is more specific than what a function tag captures, use o: instead.",
    "- When you emit a function: tag, do NOT also add o: oracle text for the same intent. The function: tag already covers that search space and adding oracle text will over-restrict results.",
    "- GRANT/GIVE KEYWORDS: When the fragment describes granting or giving a keyword ability (flying, hexproof, indestructible, lifelink, haste, trample, etc.) to other permanents, use o:<keyword> (e.g. o:indestructible, o:flying). Do NOT use function:grows-others or similar generic tags — use the specific keyword in an oracle text filter.",
    "",
    FEW_SHOT_EXAMPLES,
    "",
    `Fragments: ${JSON.stringify(safeFragments)}`,
    `Available art tags: ${compactArtTags || "none"}`,
    `Available function tags: ${compactFunctionTags || "none"}`,
  ].join("\n");
}
