/**
 * Modular prompt packs system for building dynamic system prompts
 * Reduces token cost by including only relevant modules based on query analysis
 */

import { STRATEGY_TAG_NAMES } from "@/lib/strategies/oracletagStrategies";

export type PromptPack =
  | "BASE"
  | "COLORS_FORMAT_TYPES"
  | "FUNCTION_TAGS"
  | "ART_TAGS"
  | "KEYWORDS"
  | "ARTIST"
  | "SETS"
  | "REGEX"
  | "ADVANCED";

type PackDefinition = {
  rules: string;
  examples: string[];
};

// Base module - always included
const BASE: PackDefinition = {
  rules: `Output: ONLY the query string. No markdown, no surrounding quotes, no explanations. Max 388 chars (400 with "prefer:best " prefix).

CRITICAL RULES:
- LANGUAGE: If the query is not in English, translate it to English before doing any analysis.
- NO STRAY WORDS: Use fielded tokens (id:, c:, t:, o:, art:) only. No bare words unless name text.
- SIMPLICITY: Prefer single tags (art:zombie) over long OR lists unless explicitly requested.
- PARENTHESES: Always balance. Count opening/closing.
- NO REPETITION: Each parameter/set code appears once.
- TAG LIMIT: For any single purpose (art, function, keyword, type), use at most 3 related tags; if more are needed, simplify to the most representative ones.
- QUOTES: Any multiword search term must be quoted (e.g., a:"Kev Walker", o:"any target", name:"Lightning Bolt").
- OR/Nesting: Alternatives MUST use OR, not spaces. t:fish or t:bird, t:legendary (t:goblin or t:elf).
- IGNORE NON-SEARCHABLE QUALIFIERS: Do NOT add filters for subjective/descriptive phrases with no Scryfall equivalent: "easy", "for a new player", "beginner-friendly", "simple", "accessible", "good for beginners". These are context only—output only filters for searchable criteria (types, sets, colors, keywords).`,
  examples: [
    `Azorius blink for Commander -> f:commander id:wu function:blink (NOT f:commander id:wu function:blink azorius)`,
    `Dimir spells under 3 mana for Commander -> f:commander id:ub t:instant t:sorcery mv<3`,
  ],
};

// Colors, Formats, Types module
const PACK_COLORS_FORMAT_TYPES: PackDefinition = {
  rules: `Colors: c:/color: (w=white, u=blue, b=black, r=red, g=green, c=colorless, m=multicolor). c:g="has green", c=g="exactly green" (mono). Color identity: id:/identity:. Use id: for color combinations/nicknames unless the user explicitly says they want EXACTLY that combination. Use id= only for exact/specific identities or when "exactly" is requested. Guild/shard/wedge nicknames: Azorius=wu, Rakdos=br, Dimir=ub, Boros=rw, Gruul=rg, Selesnya=gw, Orzhov=wb, Izzet=ur, Golgari=bg, Simic=gu, Esper=wub, Grixis=ubr, Jund=brg, Naya=rgw, Bant=guw, Abzan=wbg, Jeskai=urw, Sultai=bug, Mardu=brw, Temur=urg. Use id>= for "at least/contains those colors". Use id<= for "at most/only colors within". "Mono [color]" means exactly that color: use id= (mono blue = id=u, mono red = id=r, mono green = id=g, mono white = id=w, mono black = id=b). When searching for commanders (is:commander) in a color identity, use id= (exact), NOT id:.
COLOR ACCURACY: Match colors exactly. Blue=u, Red=r, Green=g, White=w, Black=b. "Mono blue" = c=u or id=u (NOT c=g or id=g). Double-check color mappings before outputting.
NO REDUNDANT COLOR NICKNAMES: When using id:/c: for colors, NEVER add the nickname as bare text. "Azorius blink" -> f:commander id:wu function:blink (NOT f:commander id:wu function:blink azorius).
Comparisons: c>=uw, id<=esper, c=2.
Types: t:/type: (partial words: t:merfolk). If the query names a creature type as the card's type (e.g., "legendary spirits"), use t:spirit (NOT o:"spirit").
TYPE VS TARGETING: Use t: only when the user wants the cards themselves to be that type. If the user wants cards that affect a creature type (e.g., "discount elementals", "destroy dragons"), use o:"elemental"/o:"dragon" and DO NOT add t: unless explicitly requested.
FRANCHISE VS CREATURE TYPE: "Avatar" in "Avatar: The Last Airbender" is a franchise/set name, NOT the creature type Avatar. Do NOT add t:avatar when the query references the show/franchise (e.g., "likes avatar the last airbender", "from avatar"). Use set: filters for the franchise sets instead. Only use t:avatar when the user explicitly wants Avatar creature type.
Formats: f:/format: and legal: filter by constructed-format legality. Use f:FORMAT or legal:FORMAT (standard, pioneer, modern, legacy, vintage, commander/edh, pauper, brawl). f: and legal: both return cards currently legal in that format (banned cards are excluded). Prefer f: for "legal in X" (e.g. f:modern, f:commander, f:pauper). Commander format: f:commander. Commanders (cards that can be your commander): is:commander. Brawl: is:brawler. Companion: is:companion. Partners: is:partner. Game changer list: is:gamechanger. NEVER use function: for formats.
BANNED/RESTRICTED: banned:FORMAT finds cards forbidden in that format (e.g. banned:modern). restricted:FORMAT finds cards limited to one copy (e.g. restricted:vintage). "Not legal" = never in the format's pool; "banned" = was legal, then forbidden. Use banned: or restricted: only when the user asks for banned/restricted cards. When using banned: or restricted: for a format, do NOT add f: or legal: for that same format (they are mutually exclusive).
MULTIPLE FORMATS: Combine with spaces for cards legal in both (e.g. f:modern f:pauper). f:future = cards that will be legal after next rotation.
PAPER VS DIGITAL: For paper/MTGO legality without Arena-only cards, add (game:paper or game:mtgo) or game:paper when relevant.
COMMANDERS VS COMMANDER FORMAT: If the user asks for commanders/commander cards (or "can be commanders"), use is:commander. If they ask for cards for Commander / commander legal / in Commander / EDH legal, use f:commander. Do NOT use is:commander for commander-legal queries.
MY COMMANDER CONTEXT: When players mention "my commander" or properties of their commander, they are looking for cards for their deck (cards that work with their deck), NOT creatures that can be commanders. Use f:commander (format legal) and NEVER is:commander. "My commander is green and white" = id:gw f:commander. "My commander synergizes with flyers" = f:commander + synergy with flying (function:synergy-flying, kw:flying). "Cards that make tokens for my commander" = f:commander + token generation function tags in OR chain (function:repeatable-token-generator or function:repeatable-creature-tokens or ...). Do NOT add set: filters for Commander precon sets when the user describes their commander—they want cards for their deck, not from a specific product.
GAME CHANGER LIST: If the user asks for cards in the "game changer" list (or "game changer list", "gamechanger"), use is:gamechanger.
FORMAT WORDING VARIANTS: Treat leading format adjectives as f:FORMAT even if not explicitly "legal in". "legacy free counterspells" and "legacy-legal free counterspells" -> f:legacy function:counterspell-free (no o:counterspell).
Negation: Leading dash (-t:human, -function:boardwipe) or not: (not:reprint = -is:reprint). "Not in X"/"without X" must be -c:x where X is the letter or color nickname of that color.`,
  examples: [
    `Mono blue -> id=u`,
    `Jeskai commander -> is:commander id=urw`,
    `Jeskai creatures for Commander -> f:commander id:urw t:creature`,
    `Dimir commanders -> is:commander id=ub`,
  ],
};

// Function tags module
const PACK_FUNCTION_TAGS: PackDefinition = {
  rules: `Function tags: function:/oracletag:/otag: for card functions (removal, ramp, tutor, counterspell, boardwipe, token-creator, treasure-creator, clue-creator, food-creator, sacrifice-outlet, sacrifice-payoff, lifegain, lifegain-matters, mill, synergy, package, counters-matter, etc.).
FUNCTION TAGS FIRST: Check available function tags before using o:. If uncertain tag exists, use o: as fallback. Multiple alternatives -> (function:x or function:y), NOT spaces.
PREFIX: When using function tags, include the full prefix exactly as shown (e.g., function:discount-self).
FUNCTION TAG SPECIFICITY: If a more specific function tag exists in the available list that matches the user’s intent, prefer it over a broader tag (e.g., "tutor for lands" -> function:land-tutor if available, not just function:tutor).
NO REDUNDANT COMBINATIONS: If a function tag covers the concept, don't also add oracle text unless filtering by specific details (e.g., token size). "Cards that make tokens" -> use an OR chain of token-generation function tags: (function:repeatable-token-generator or function:repeatable-creature-tokens or function:create-multiple-tokens or ...) based on available tags. Do NOT add o:token. "Cards that make 1/1 tokens" -> function:token-creator o:/1\\/1/ (use regex for sizes, escape slashes).
BURN: If the user asks for cards that deal direct damage, use function:burn. If the target is specified (players, opponents, any target, creatures, planeswalkers), use the most specific burn child-tag available.
CARDS LIKE X: If the user asks for "cards like X"/"similar to X", treat X as a card name. Only use a function tag if X EXACTLY matches a function tag name after normalizing spaces/hyphens (no fuzzy matching). Otherwise, use an oracle regex capturing the primary effect of the named card (e.g., "Cards like Lightning Bolt" -> o:/deals [0-9]+ damage to any target/). Do NOT map "Lightning Bolt" to function:boltland.
Keep it minimal: Use ONE function tag unless the user explicitly requests multiple distinct functions. Do NOT stack many related counter tags together.
"Counters" can mean counterspells (function:counterspell) or counters that are put on permanents (function:counters-matter) - choose based on context. If the query is about countering spells, ALWAYS use function:counterspell (NOT o:counter, NOT function:ability-counter). Only use function:ability-counter if the user explicitly asks to counter abilities. For +1/+1 counters, use function tags containint "pp-counters". For -1/-1 counters, use function tags containint "mm-counters".
COST REDUCTION: For "discount"/"reduce cost", use oracle text with a mana-cost wildcard, e.g. o:/cost \\{[0-9X]+\\} less/ (NOT o:"cost reduction").
Counterspells: use function:counterspell, not o:counter/o:"counterspell". If the user specifically requests free counterspells, use (function:counterspell-free or (function:counterspell and function:potentially-free)). Do NOT add t:instant unless explicitly requested.
CAST FOR FREE: If the user asks for a card that can be cast for free, use function:potentially-free. Exception: if it's a counterspell, use the counterspell rule instead.
MANA VALUE FILTERS: For mana cost thresholds (e.g., "under 3 mana", "3 mana or less", "at most 4"), use mv comparisons (mv<3, mv<=3, mv<=4). Do NOT use cost-reduction regex unless discounting is explicitly requested.
MANA COST SYMBOLS: If the user asks for cards with a specific mana cost symbol or pattern in the printed cost (e.g., "with X in the mana cost", "with two green pips"), use m: (mana cost) like m:X, m:{G}{G}. This is NOT mv.
IGNORE SUBJECTIVE QUALIFIERS: "Easy", "for new players", "beginner-friendly", "simple", "accessible" have no reliable Scryfall/function equivalent. Do NOT add function:any-player-ability or similar for these—omit such filters entirely.
ETB (enters the battlefield): Oracle text now uses "enters" (e.g., "When this creature enters"). Use o:"~ enters" for self-ETBs (e.g., "when this enters", "ETB"). Use o:enters for effects that trigger when OTHER things enter (e.g., "when a land enters", "when another creature enters"). Do NOT use o:"enters the battlefield".
STRATEGY TAGS: If the query asks for a common MTG strategy, use the placeholder tag strategy:NAME and DO NOT expand to oracletag/function tags. Valid strategy names: ${STRATEGY_TAG_NAMES.join(
    ", "
  )}. Use quotes for multiword names (e.g., strategy:"Cost Reduction"). If the user asks to EXCLUDE a strategy, use -strategy:NAME (or -strategy:"Multi Word").
`,
  examples: [
    `Removal for Commander -> f:commander function:removal`,
    `Counterspells -> function:counterspell`,
    `Counterspells that are not in red -> function:counterspell -c:r`,
    `Orzhov aristocrats -> id:wb strategy:Aristocrats`,
    `Non-aristocrats Orzhov -> id:wb -strategy:Aristocrats`,
    `Cards like Lightning Bolt -> o:/deals [0-9]+ damage to any target/ (NOT function:boltland)`,
    `Tutor for lands -> function:land-tutor (NOT function:tutor)`,
    `Search your library for a land -> function:land-tutor (NOT t:land function:tutor — "land" here is the OBJECT being fetched, not the card's own type)`,
  ],
};

// Art tags module
const PACK_ART_TAGS: PackDefinition = {
  rules: `Art tags: art:/atag:/arttag: for concrete depictions (art:zombie, art:dragon, art:angel, art:demon, art:elf, art:goblin, etc.). Use art tags ONLY when explicitly requested.
If the query is "TYPE with [art]" (e.g., "equipment with sword art"), use t:TYPE for the card type and art: for the depiction (t:equipment art:sword).`,
  examples: [
    `Zombie art -> art:zombie (NOT long OR list)`,
    `Equipment with sword art -> t:equipment art:sword`,
  ],
};

// Keywords module
const PACK_KEYWORDS: PackDefinition = {
  rules: `Keywords: kw: for keyword abilities (flying, trample, vigilance, lifelink, haste, deathtouch, hexproof, ward, disturb, storm, suspend, etc.).
USE kw: ONLY when the cards themselves have the keyword (e.g., "cards with flying", "has deathtouch"). If the request is about cards that GIVE/GRANT a keyword to other permanents/players, do NOT use kw:; use the related function tag if available, otherwise o:.
PRIORITY: If the user explicitly asks for cards WITH a keyword (or that HAVE it), use kw: even if the wording also mentions giving.`,
  examples: [
    `Vigilance and lifelink -> kw:vigilance kw:lifelink`,
    `Flying creatures -> t:creature kw:flying`,
    `Cards with storm -> kw:storm`,
  ],
};

// Artist module
const PACK_ARTIST: PackDefinition = {
  rules: `Artist: a:/artist: for illustrator names. NEVER use art: for artists. Quote multiword artist names: a:"Terese Nielsen".`,
  examples: [
    `Illustrated by Paolo Parente -> a:"Paolo Parente"`,
  ],
};

// Sets module
const PACK_SETS: PackDefinition = {
  rules: `Sets: s:/e:/set:/edition: (set codes). Specific set requests -> set:code (e.g., "Fallout" -> set:pip, "War of the Spark" -> set:war, "Lorwyn Eclipsed" -> set:ecl). "Any X set" -> list ALL codes with OR (set:lrw or set:mor), NO block unless "block" mentioned, NO repeats. Blocks: b:/block: (3-letter code). Collector: cn:/number:. Set types: st:core, st:expansion, st:masters, st:commander. In set: in:lea.
AVOID inventing set codes. Only use if query explicitly asks for set/edition/printing.`,
  examples: [
    `War of the Spark -> set:war`,
    `Any Lorwyn set -> set:lrw or set:mor or set:ecc or set:ecl (NOT block:)`,
  ],
};

// Regex module
const PACK_REGEX: PackDefinition = {
  rules: `Regex: Use ONLY when user asks for starts/contains/whole word/exact phrase.
Oracle text: o:/oracle: - Quotes for exact phrases: o:"draw two". Regex: o:/^draw/ (starts), o:/damage/ (contains), name:/\\bhero\\b/ (whole word). Token sizes: o:/1\\/1/ (escape slashes). Placeholder: \\~ for card name.
Name: name:/^Lightning/ (starts), name:/hero/ (contains), name:/\\bhero\\b/ (whole word).`,
  examples: [
    `Text starts "draw" -> o:/^draw/`,
    `Name starts "Lightning" -> name:/^Lightning/`,
  ],
};

// Advanced filters module
const PACK_ADVANCED: PackDefinition = {
  rules: `Advanced filters:
- Banned/Restricted: banned:FORMAT (cards forbidden in that format, e.g. banned:modern, banned:legacy), restricted:FORMAT (one copy per deck, e.g. restricted:vintage), is:reserved
- Foil/Frame: is:foil/nonfoil/etched/glossy, border:black/white/silver/borderless, frame:1993/1997/2003/2015/future, frame:legendary/colorshifted/tombstone, is:full, new:frame
- Power/Toughness: power:/pow:, toughness:/tou:, pt:/powtou:, loyalty:/loy: (comparisons: pow>=8, pow>tou)
- Mana value: mv:/manavalue: (mv=5, mv>=3)
- Games: game:paper/mtgo/arena, in:paper/mtgo/arena, is:digital, is:alchemy, is:rebalanced
- Rarity: r:/rarity: (common, uncommon, rare, special, mythic, bonus). Comparisons: r>=r
- Multi-faced: is:split, is:flip, is:transform/is:tdfc, is:meld/is:meldpart/is:meldresult, is:leveler, is:dfc, is:mdfc
- Other: is:spell, is:permanent, is:historic, is:party, is:outlaw, is:modal, is:vanilla, is:frenchvanilla, is:bear, is:manland, is:universesbeyond, not:universesbeyond
- GAMES/DIGITAL RULE: If the user mentions Arena/MTGO/paper/digital/alchemy/rebalanced, use the appropriate tag (game:paper or game:arena or game:mtgo; is:digital/is:alchemy/is:rebalanced) and DO NOT add unrelated game filters.
- UNIVERSES BEYOND: If the query specifies Universes Beyond, use is:universesbeyond (or not:universesbeyond if excluded).`,
  examples: [
    `Power 8+ -> pow>=8`,
    `Banned in Legacy -> banned:legacy`,
  ],
};

// Pack registry
const PACK_REGISTRY: Record<PromptPack, PackDefinition> = {
  BASE,
  COLORS_FORMAT_TYPES: PACK_COLORS_FORMAT_TYPES,
  FUNCTION_TAGS: PACK_FUNCTION_TAGS,
  ART_TAGS: PACK_ART_TAGS,
  KEYWORDS: PACK_KEYWORDS,
  ARTIST: PACK_ARTIST,
  SETS: PACK_SETS,
  REGEX: PACK_REGEX,
  ADVANCED: PACK_ADVANCED,
};

/**
 * Selects relevant prompt packs based on natural language query analysis
 * Uses deterministic regex/keyword heuristics - no model calls
 */
export function selectPacks(naturalQuery: string): PromptPack[] {
  const query = naturalQuery.toLowerCase();
  const selected = new Set<PromptPack>(["BASE"]); // BASE always included
  const hasStrategyName = STRATEGY_TAG_NAMES.some((name) =>
    query.includes(name.toLowerCase())
  );
  const hasSimilarityQuery = /\b(cards? like|similar to)\b/.test(query);
  const hasKeywordQuery =
    /\b(flying|trample|vigilance|lifelink|haste|deathtouch|hexproof|indestructible|reach|first strike|double strike|menace|prowess|flash|ward|disturb|storm|suspend|keyword|keywords)\b/.test(
      query
    );
  const hasKeywordGrantQuery =
    hasKeywordQuery &&
    /\b(give|gives|giving|grant|grants|granting)\b/.test(query);

  // COLORS_FORMAT_TYPES: commander/edh, formats, guild/color words, card types, negation, game changer list
  if (
    /\b(commander|edh|brawl|standard|modern|legacy|pauper|vintage|format)\b/.test(query) ||
    /\b(game\s*changer|gamechanger)\b/.test(query) ||
    /\b(azorius|rakdos|dimir|boros|gruul|selesnya|orzhov|izzet|golgari|simic|esper|grixis|jund|naya|bant|abzan|jeskai|sultai|mardu|temur|wubrg|color|colors|colour|colours|guild|mono|monocolor|monocolored)\b/.test(query) ||
    /\b(white|blue|black|red|green|colorless|multicolor)\b/.test(query) ||
    /\b(creature|creatures|instant|instants|sorcery|sorceries|enchantment|enchantments|artifact|artifacts|planeswalker|planeswalkers|land|lands|tribal|legendary|adventure|kindred|battle|battles)\b/.test(query) ||
    /\b(not|without|no|excluding|except)\b/.test(query)
  ) {
    selected.add("COLORS_FORMAT_TYPES");
  }

  // FUNCTION_TAGS: removal, ramp, tutor, counterspell, board wipe, token, treasure, clue, food, sacrifice, lifegain, mill, synergy, package, discount
  if (
    /\b(removal|ramp|tutor|counterspell|counter spell|counters|board wipe|boardwipe|wipes|token|tokens|treasure|treasures|clue|clues|food|sacrifice|sacrificing|lifegain|life gain|mill|milling|synergy|synergies|package|packages|draw|drawing|card advantage|discount|discounts|discounted|reduce cost|reduces cost|reduced cost|cost reduction|cost reducer|cost reducers|cost reducing|cost less|costs less|cheaper|less to cast|control|burn|direct damage|deal(?:s|t)? damage)\b/.test(
      query
    ) ||
    hasStrategyName ||
    hasSimilarityQuery ||
    hasKeywordGrantQuery
  ) {
    selected.add("FUNCTION_TAGS");
  }

  // ART_TAGS: "in the art", "art", "depicts", "illustration", "featuring", "shows"
  if (
    /\b(in the art|art|depicts|depicting|illustration|illustrations|featuring|shows|showing|artwork|art work|picture|pictured)\b/.test(query)
  ) {
    selected.add("ART_TAGS");
  }

  // KEYWORDS: keyword abilities list
  if (hasKeywordQuery) {
    selected.add("KEYWORDS");
  }

  // ARTIST: "illustrated by", "drawn by", "artist", "art by"
  if (
    /\b(illustrated by|drawn by|artist|art by|painted by|created by)\b/i.test(naturalQuery)
  ) {
    selected.add("ARTIST");
  }

  // SETS: "set", "edition", "printing", "from the set", "in the set", plus known set names
  const setKeywords = /\b(set|edition|printing|from the set|in the set|block)\b/.test(query);
  const knownSets = /\b(war of the spark|fallout|lorwyn|innistrad|ravnica|zendikar|theros|kaladesh|amonkhet|ixalan|dominaria|guilds of ravnica|throne of eldraine|theros beyond death|ikoria|core set|modern horizons|time spiral|mirage|visions|weatherlight|tempest|stronghold|exodus|urza|masques|nemesis|prophecy|invasion|planeshift|apocalypse|odyssey|torment|judgment|onslaught|legions|scourge|mirrodin|darksteel|fifth dawn|champions of kamigawa|betrayers of kamigawa|saviors of kamigawa|ravnica|guildpact|dissension|time spiral|planar chaos|future sight|lorwyn|morningtide|shadowmoor|eventide|shards of alara|conflux|alara reborn|zen|worldwake|rise of the eldrazi|scars of mirrodin|mirrodin besieged|new phyrexia|innistrad|dark ascension|avacyn restored|return to ravnica|gatecrash|dragon's maze|theros|born of the gods|journey into nyx|khans of tarkir|fate reforged|dragons of tarkir|battle for zendikar|oath of the gatewatch|shadows over innistrad|eldritch moon|kaladesh|aether revolt|amonkhet|hour of devastation|ixalan|rivals of ixalan|dominaria|guilds of ravnica|ravnica allegiance|war of the spark|throne of eldraine|theros beyond death|ikoria|zendikar rising|kaldheim|strixhaven|adventures in the forgotten realms|innistrad midnight hunt|innistrad crimson vow|kamigawa neon dynasty|streets of new capenna|dominaria united|the brothers' war|phyrexia all will be one|march of the machine|the lord of the rings|wilds of eldraine|the lost caverns of ixalan|murders at karlov manor|bloomburrow|outlaws of thunder junction|modern horizons|duel decks|from the vault|planechase|archenemy|conspiracy|battlebond|unsanctioned|jumpstart|mystery booster|time spiral remastered|modern horizons 2|commander legends|innistrad double feature|streets of new capenna commander|dominaria united commander|the brothers' war commander|phyrexia all will be one commander|march of the machine commander|the lord of the rings commander|wilds of eldraine commander|the lost caverns of ixalan commander|murders at karlov manor commander|bloomburrow commander|outlaws of thunder junction commander)\b/i.test(naturalQuery);
  if (setKeywords || knownSets) {
    selected.add("SETS");
  }

  // REGEX: "starts with", "begins with", "contains", "whole word", "exact phrase"
  if (
    /\b(starts? with|begins? with|contains?|whole word|exact phrase|phrase|matches?|pattern)\b/.test(query)
    || hasSimilarityQuery
  ) {
    selected.add("REGEX");
  }

  // ADVANCED: foil, borderless, frame, rarity, banned, restricted, reserved, arena, mtgo, paper, power, toughness, mana value, mv
  if (
    /\b(foil|borderless|frame|rarity|banned|restricted|reserved|arena|mtgo|paper|power|toughness|mana value|mana cost|mv|cmc|converted mana cost|p\/t|pt|loyalty|split|flip|transform|meld|dfc|mdfc|spell|permanent|historic|party|outlaw|modal|vanilla|french vanilla|bear|manland|digital|alchemy|rebalanced|promo|spotlight|scryfall preview|reprint|unique|prints|sets|paperprints|papersets|language|japanese|russian|chinese|korean|spanish|french|german|italian|portuguese|dual|fetchland|shockland|fastland|checkland|painland|filterland|bounceland|canopyland|scryland|surveilland|shadowland|slowland|tangoland|tricycleland|triland|masterpiece|colorshifted|universes beyond|universes-beyond|universesbeyond)\b/.test(
      query
    )
  ) {
    selected.add("ADVANCED");
  }

  // Return in stable order: BASE first, then others in defined order
  const order: PromptPack[] = [
    "BASE",
    "COLORS_FORMAT_TYPES",
    "FUNCTION_TAGS",
    "ART_TAGS",
    "KEYWORDS",
    "ARTIST",
    "SETS",
    "REGEX",
    "ADVANCED",
  ];
  return order.filter((pack) => selected.has(pack));
}

/**
 * Selects up to 10 relevant examples from selected packs, prioritizing relevance
 */
function selectExamples(
  selectedPacks: PromptPack[],
  naturalQuery: string
): string[] {
  const query = naturalQuery.toLowerCase();
  const examples: string[] = [];

  // Collect examples from selected packs
  for (const pack of selectedPacks) {
    const packDef = PACK_REGISTRY[pack];
    if (!packDef) continue;

    // Score examples by relevance (simple keyword matching)
    const scored = packDef.examples.map((example) => {
      const exampleLower = example.toLowerCase();
      let score = 0;
      const queryWords = query.match(/\b\w{3,}\b/g) || [];
      for (const word of queryWords) {
        if (exampleLower.includes(word)) {
          score += 1;
        }
      }
      return { example, score };
    });

    // Sort by score (descending) and take top examples
    const relevant = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.ceil(10 / selectedPacks.length))
      .map((e) => e.example);

    examples.push(...relevant);
  }

  // Deduplicate while preserving order
  const unique = Array.from(new Set(examples));

  // If we have too many, prioritize by pack order and relevance
  if (unique.length > 10) {
    return unique.slice(0, 10);
  }

  return unique;
}

/**
 * Builds the complete system prompt from selected packs
 */
export function buildSystemPrompt(naturalQuery: string): string {
  const selectedPacks = selectPacks(naturalQuery);
  const examples = selectExamples(selectedPacks, naturalQuery);

  const parts: string[] = [
    "Convert natural language Magic: The Gathering requests into a single Scryfall query string.",
    "",
  ];

  // Add rules from each selected pack
  for (const pack of selectedPacks) {
    const packDef = PACK_REGISTRY[pack];
    if (packDef) {
      parts.push(packDef.rules);
      parts.push("");
    }
  }

  // Add examples section
  if (examples.length > 0) {
    parts.push("Examples:");
    for (const example of examples) {
      parts.push(`- ${example}`);
    }
  }

  return parts.join("\n");
}
