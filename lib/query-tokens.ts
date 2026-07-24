export type QueryTokenType = "field" | "logical" | "group" | "text";

export type QueryToken = {
  raw: string;
  type: QueryTokenType;
  field?: string;
  op?: string; // ":", "=", "<", ">", "<=", ">="
  value?: string;
  negated?: boolean;
};

export type TokenMetadata = QueryToken & {
  title: string;
  description: string;
  reason: string;
  tip?: string;
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const COLOR_NAMES: Record<string, string> = {
  w: "White",
  u: "Blue",
  b: "Black",
  r: "Red",
  g: "Green",
  wu: "Azorius (White + Blue)",
  ub: "Dimir (Blue + Black)",
  br: "Rakdos (Black + Red)",
  rg: "Gruul (Red + Green)",
  gw: "Selesnya (Green + White)",
  wb: "Orzhov (White + Black)",
  ur: "Izzet (Blue + Red)",
  bg: "Golgari (Black + Green)",
  rw: "Boros (Red + White)",
  gu: "Simic (Green + Blue)",
  wub: "Esper (White + Blue + Black)",
  ubr: "Grixis (Blue + Black + Red)",
  brg: "Jund (Black + Red + Green)",
  rgw: "Naya (Red + Green + White)",
  guw: "Bant (Green + White + Blue)",
  wbg: "Abzan (White + Black + Green)",
  urw: "Jeskai (Blue + Red + White)",
  bug: "Sultai (Black + Blue + Green)",
  brw: "Mardu (Black + Red + White)",
  urg: "Temur (Blue + Red + Green)",
  wubr: "Four-color (no Green)",
  ubrg: "Four-color (no White)",
  brgw: "Four-color (no Blue)",
  rgwu: "Four-color (no Black)",
  gwub: "Four-color (no Red)",
  wubrg: "Five-color (WUBRG)",
  c: "Colorless",
  m: "Multicolor",
};

// ---------------------------------------------------------------------------
// Color semantic selectors ("Also try" alternatives for c: / id: clauses)
// ---------------------------------------------------------------------------

export type ColorSemanticOption = {
  /** The Scryfall clause this option writes, e.g. "c=rg" or "(c:r or c:g)". */
  clause: string;
  label: string;
  /** Full query with the detected color clause replaced by this option's clause. */
  query: string;
  current: boolean;
};

export type ColorSemanticSelector = {
  field: "c" | "id";
  /** WUBRG-normalized letters of the detected clause. */
  letters: string;
  options: ColorSemanticOption[];
};

const WUBRG = "wubrg";

const sortWubrg = (letters: string): string =>
  [...new Set(letters.toLowerCase())]
    .sort((a, b) => WUBRG.indexOf(a) - WUBRG.indexOf(b))
    .join("");

/** "Gruul" from "rg", "Red" from "r" — parenthetical trimmed. */
const shortColorName = (letters: string): string =>
  (COLOR_NAMES[sortWubrg(letters)] ?? letters.toUpperCase()).split(" (")[0];

type SemanticKind = "any" | "all" | "exact" | "within" | "includes";

/**
 * Detects the first color (`c`) and color-identity (`id`) constraint in a
 * Scryfall query — either a plain token (`c:rg`, `id=wu`) or an OR-group
 * (`(c:r or c:g)`) — and returns the alternative semantic readings the user
 * can switch to, each with the full rewritten query. Negated clauses (`-c:r`)
 * are left alone.
 */
export function getColorSemanticSelectors(query: string): ColorSemanticSelector[] {
  const selectors: ColorSemanticSelector[] = [];

  for (const field of ["c", "id"] as const) {
    const groupRe = new RegExp(
      `\\(\\s*${field}[:=][wubrg]+(?:\\s+or\\s+${field}[:=][wubrg]+)+\\s*\\)`,
      "i"
    );
    const tokenRe = new RegExp(`(?<![\\w-])${field}(<=|>=|[:=])([wubrg]+)\\b`, "i");

    let matched: string;
    let letters: string;
    let currentKind: SemanticKind | null;

    const group = query.match(groupRe);
    if (group) {
      matched = group[0];
      letters = sortWubrg(
        [...matched.matchAll(new RegExp(`${field}[:=]([wubrg]+)`, "gi"))].map((m) => m[1]).join("")
      );
      currentKind = "any";
    } else {
      const token = query.match(tokenRe);
      if (!token) continue;
      matched = token[0];
      letters = sortWubrg(token[2]);
      const op = token[1];
      currentKind =
        op === "="
          ? "exact"
          : op === ":"
            ? field === "id"
              ? "within"
              : "all"
            : op === ">="
              ? "includes"
              : null; // "<=" has no selector entry; options still offered
    }
    if (!letters) continue;

    const names = letters.split("").map((l) => COLOR_NAMES[l] ?? l.toUpperCase());
    const combined = shortColorName(letters);
    const multi = letters.length > 1;

    const candidates: Array<{ kind: SemanticKind; clause: string; label: string }> = [];
    if (field === "c") {
      if (multi) {
        candidates.push({
          kind: "any",
          clause: `(${letters.split("").map((l) => `c:${l}`).join(" or ")})`,
          label: `Any of ${names.join(" or ")}`,
        });
        candidates.push({ kind: "all", clause: `c:${letters}`, label: `All of ${names.join(" + ")} (c:)` });
        candidates.push({ kind: "exact", clause: `c=${letters}`, label: `Exactly ${combined} (c=)` });
      } else {
        candidates.push({ kind: "all", clause: `c:${letters}`, label: `${names[0]} (can be multicolor)` });
        candidates.push({ kind: "exact", clause: `c=${letters}`, label: `Mono ${names[0]} (c=)` });
      }
    } else {
      candidates.push({ kind: "within", clause: `id:${letters}`, label: `Playable in ${combined} (id:)` });
      candidates.push({ kind: "exact", clause: `id=${letters}`, label: `Exact ${combined} identity (id=)` });
      if (multi) {
        candidates.push({
          kind: "includes",
          clause: `id>=${letters}`,
          label: `Identity includes ${names.join(" + ")} (id>=)`,
        });
      }
    }

    selectors.push({
      field,
      letters,
      options: candidates.map((c) => ({
        clause: c.clause,
        label: c.label,
        query: query.replace(matched, c.clause),
        current: c.kind === currentKind,
      })),
    });
  }

  return selectors;
}

const FORMAT_NAMES: Record<string, string> = {
  standard: "Standard",
  future: "Future Standard",
  historic: "Historic",
  timeless: "Timeless",
  gladiator: "Gladiator",
  pioneer: "Pioneer",
  modern: "Modern",
  legacy: "Legacy",
  pauper: "Pauper",
  vintage: "Vintage",
  penny: "Penny Dreadful",
  commander: "Commander",
  oathbreaker: "Oathbreaker",
  standardbrawl: "Standard Brawl",
  brawl: "Brawl",
  competitivebrawl: "Competitive Brawl",
  alchemy: "Alchemy",
  paupercommander: "Pauper Commander",
  duel: "Duel Commander",
  oldschool: "Old School 93/94",
  premodern: "Premodern",
  predh: "PreDH",
  tlr: "Tiny Leaders: Reborn",
  explorer: "Explorer",
};

const RARITY_NAMES: Record<string, string> = {
  common: "Common",
  c: "Common",
  uncommon: "Uncommon",
  u: "Uncommon",
  rare: "Rare",
  r: "Rare",
  mythic: "Mythic Rare",
  m: "Mythic Rare",
  special: "Special",
  bonus: "Bonus",
};

const IS_FLAG_NAMES: Record<string, string> = {
  commander: "valid commander",
  spell: "non-land card",
  permanent: "permanent",
  historic: "historic card",
  legendary: "legendary",
  nonlegendary: "non-legendary",
  modal: "modal card",
  dfc: "double-faced card",
  split: "split card",
  flip: "flip card",
  token: "token",
  digital: "digital-only card",
  booster: "available in booster packs",
  oversized: "oversized card",
  funny: "acorn / silver-bordered",
  foil: "available in foil",
  nonfoil: "available in non-foil",
  fullart: "full-art card",
  borderless: "borderless printing",
  textless: "textless card",
  promo: "promo card",
  reprint: "reprint",
  firstprint: "first printing",
  unique: "unique card",
  land: "land",
  basic: "basic land",
  creature: "creature",
  artifact: "artifact",
  enchantment: "enchantment",
  instant: "instant",
  sorcery: "sorcery",
  planeswalker: "planeswalker",
  saga: "saga",
  battle: "battle",
};

const OP_WORDS: Record<string, string> = {
  "<": "less than",
  "<=": "at most",
  ">": "greater than",
  ">=": "at least",
  "=": "exactly",
  ":": "",
};

// ---------------------------------------------------------------------------
// Static descriptions
// ---------------------------------------------------------------------------

const FIELD_DESCRIPTIONS: Record<
  string,
  { title: string; description: string; tip?: string }
> = {
  id: {
    title: "Color Identity",
    description:
      "Filters by color identity — every color that appears on the card or in its rules text. " +
      "id= matches cards with exactly those colors. id: matches cards whose identity includes those colors.",
    tip: "Commander players: use id: to find cards that fit inside a commander's color identity (e.g. id:wub for an Esper deck).",
  },
  c: {
    title: "Color",
    description:
      "Filters by the card's actual color(s). c= matches cards with exactly those colors (mono, dual, etc.). " +
      "c: matches cards that include those colors but may also contain others.",
    tip: "c=wu finds Azorius cards only. c:wu finds any card that is both white and blue, including three-color cards.",
  },
  t: {
    title: "Type",
    description:
      "Filters by the type line, covering supertypes (Legendary, Basic, Snow), card types (Creature, Instant, Artifact…), " +
      "and subtypes (Goblin, Dragon, Equipment, Aura…).",
    tip: "Combine multiple type filters to narrow results: t:legendary t:creature finds Legendary Creatures.",
  },
  o: {
    title: "Oracle Text",
    description:
      "Searches the canonical Oracle rules text for a word or phrase. Oracle text is the official, reminder-text-free version of a card's rules.",
    tip: 'Use quotes for exact phrases: o:"draw a card". Partial words also work: o:trample matches any card mentioning trample.',
  },
  function: {
    title: "Function / Oracle Tag",
    description:
      "Filters by community-curated role tags from Scryfall's Tagger project. " +
      "These describe what a card does in a deck (e.g. function:ramp, function:draw, function:boardwipe).",
    tip: "Tag coverage varies — not every card is tagged. If results seem sparse, combine with o: oracle text filters as a fallback.",
  },
  art: {
    title: "Art Tag / Artist",
    description:
      "Filters by art tags (subjects depicted in the artwork, e.g. art:dragon) or by the artist's name (artist:\"John Avon\").",
    tip: "Art tags are community-maintained and may be incomplete. Try partial names: artist:avon instead of the full name.",
  },
  format: {
    title: "Format",
    description:
      "Filters to cards that are currently legal (not banned or restricted) in the specified format.",
    tip: "Banned or restricted cards are excluded. To find cards banned in a format, use banned:modern instead.",
  },
  game: {
    title: "Platform",
    description:
      "Filters by game platform. game:paper = physical cards; game:arena = MTG Arena; game:mtgo = Magic Online.",
    tip: "Automatically added to filter out digital-only cards. Remove it if you want to include Arena or MTGO exclusives.",
  },
  kw: {
    title: "Keyword",
    description:
      "Filters cards that have a specific keyword ability (flying, trample, deathtouch, ward, haste, etc.).",
    tip: "Prefer kw: over o: for keywords — oracle text search would also match reminder text and flavor text references.",
  },
  set: {
    title: "Set",
    description:
      "Filters to cards printed in a specific set, identified by its Scryfall set code (e.g. set:dmu for Dominaria United).",
    tip: "Set codes are usually 3–4 letters. Find codes at scryfall.com/sets.",
  },
  block: {
    title: "Block",
    description:
      "Filters to cards printed in any set belonging to a block (e.g. block:innistrad includes Innistrad, Dark Ascension, and Avacyn Restored).",
  },
  mv: {
    title: "Mana Value",
    description:
      "Filters by mana value (MV), previously called converted mana cost (CMC). " +
      "Supports comparisons: mv<3, mv>=4, mv=2.",
    tip: "X spells have a base mana value of 0 unless cast — use mv=0 to find free or X spells.",
  },
  power: {
    title: "Power",
    description:
      "Filters creatures by their printed power. Supports comparisons: pow>4, pow<=2, pow=*.",
    tip: "Power is the left number in a creature's P/T box. Use pow=* for creatures with variable power.",
  },
  toughness: {
    title: "Toughness",
    description:
      "Filters creatures by their printed toughness. Supports comparisons: tou>=3, tou<5.",
    tip: "Toughness is the right number in a creature's P/T box.",
  },
  pt: {
    title: "Power/Toughness",
    description:
      "Filters by a combined power and toughness comparison (e.g. pt>=4 finds cards where both P and T are at least 4).",
  },
  loyalty: {
    title: "Loyalty",
    description:
      "Filters planeswalkers by their starting loyalty counter value. Supports comparisons: loy>=4, loy<3.",
  },
  rarity: {
    title: "Rarity",
    description:
      "Filters by rarity. Values: common (c), uncommon (u), rare (r), mythic (m).",
    tip: "Use r>=r to find cards that are rare or mythic rare.",
  },
  is: {
    title: "Property Flag",
    description:
      "Filters cards by a special property or status flag. Common values: is:commander, is:legendary, is:spell, is:permanent, is:historic, is:token.",
    tip: "Many is: flags have a not: equivalent to exclude cards: not:reprint finds first printings only.",
  },
  not: {
    title: "Excluded Property",
    description:
      "Excludes cards with a specific property. Mirrors is: but filters out instead of filtering in. Example: not:reprint, not:digital.",
  },
  prefer: {
    title: "Prefer",
    description:
      "Instructs Scryfall how to deduplicate results when a card appears in multiple sets. prefer:best returns the highest-quality printing.",
    tip: "prefer:best is added automatically. Remove it to see all printings.",
  },
  order: {
    title: "Sort Order",
    description:
      "Controls the field results are sorted by (e.g. order:cmc, order:color, order:released, order:name, order:edhrec).",
  },
  direction: {
    title: "Sort Direction",
    description: "Controls sort direction: direction:asc (ascending) or direction:desc (descending).",
  },
  unique: {
    title: "Unique Filter",
    description:
      "Controls deduplication of results. unique:cards (one per name), unique:prints (all printings), unique:art (one per artwork).",
  },
  year: {
    title: "Year",
    description:
      "Filters by the year a card was printed. Supports comparisons: year=2022, year>=2020.",
  },
  banned: {
    title: "Banned In",
    description:
      "Filters to cards that are banned in the specified format (e.g. banned:modern).",
  },
  restricted: {
    title: "Restricted In",
    description:
      "Filters to cards that are restricted (limited to 1 copy per deck) in the specified format. Only applies to Vintage.",
  },
  legal: {
    title: "Legal In",
    description:
      "Filters to cards that are legal in the specified format. Equivalent to f: but explicit about legality.",
  },
  new: {
    title: "New Cards",
    description:
      "Filters to cards that are new to a specific context: new:art (new artwork), new:frame (new frame type), new:language.",
  },
  strategy: {
    title: "Strategy",
    description:
      "Internal strategy tag that will be expanded into one or more oracletag: filters before the query is sent to Scryfall.",
    tip: "This tag is resolved automatically and won't reach Scryfall directly.",
  },
  cmc: {
    title: "Mana Value (CMC)",
    description:
      "Alias for mv: — filters by converted mana cost / mana value. Supports comparisons: cmc<3, cmc=4.",
  },
};

// ---------------------------------------------------------------------------
// Function / oracletag value descriptions
// ---------------------------------------------------------------------------

const FUNCTION_TAGS: Record<
  string,
  { title: string; description: string; tip?: string }
> = {
  // --- Removal ---
  removal: {
    title: "Removal",
    description:
      "Matches cards whose primary purpose is eliminating threats — destroy, exile, bounce, or otherwise neutralize permanents.",
    tip: "For stricter results try function:removal-destroy (only destroy effects) or function:removal-exile.",
  },
  "removal-creature": {
    title: "Creature Removal",
    description: "Matches cards that specifically target and remove creatures.",
  },
  "removal-creature-burn": {
    title: "Burn Removal",
    description: "Matches cards that deal damage to destroy creatures (burn spells used as removal).",
  },
  "removal-creature-fight": {
    title: "Fight Removal",
    description: "Matches cards that use the fight mechanic to remove creatures.",
  },
  "removal-exile": {
    title: "Exile Removal",
    description:
      "Matches cards that exile permanents rather than destroying them — superior against indestructible threats.",
  },
  "removal-destroy": {
    title: "Destroy Removal",
    description: "Matches cards that destroy permanents. Does not work against indestructible permanents.",
  },
  "spot-removal": {
    title: "Spot Removal",
    description:
      "Matches targeted removal that handles a single threat at a time, as opposed to mass removal or board wipes.",
  },
  "removal-bounce": {
    title: "Bounce Removal",
    description:
      "Matches cards that return permanents to their owner's hand — temporary removal that doesn't permanently answer a threat.",
  },
  "board-wipe": {
    title: "Board Wipe",
    description:
      "Matches mass removal spells that affect many (usually all) creatures or permanents at once. Also called sweepers or wraths.",
    tip: "Classic examples: Wrath of God, Damnation, Cyclonic Rift.",
  },
  // --- Ramp ---
  ramp: {
    title: "Ramp",
    description:
      "Matches cards that accelerate mana development, putting you ahead of the normal land drop curve.",
    tip: "Ramp includes land fetching (Cultivate), mana rocks (Sol Ring), and mana dorks (Llanowar Elves).",
  },
  "ramp-land": {
    title: "Land Ramp",
    description:
      "Matches cards that put extra lands onto the battlefield, providing durable mana acceleration.",
  },
  "ramp-ritual": {
    title: "Ritual / Burst Ramp",
    description:
      "Matches one-time mana burst effects that don't leave a permanent behind (e.g. Dark Ritual, Pyretic Ritual).",
  },
  "mana-rock": {
    title: "Mana Rock",
    description:
      "Matches artifact cards that produce mana (e.g. Sol Ring, Arcane Signet, Chromatic Lantern).",
  },
  "mana-dork": {
    title: "Mana Dork",
    description:
      "Matches creature cards that tap for mana (e.g. Llanowar Elves, Birds of Paradise, Selvala).",
  },
  // --- Card draw ---
  draw: {
    title: "Card Draw",
    description: "Matches cards that draw one or more cards, increasing hand size and card advantage.",
  },
  "card-draw": {
    title: "Card Draw",
    description: "Matches cards that draw one or more cards, increasing hand size and card advantage.",
  },
  cantrip: {
    title: "Cantrip",
    description:
      "Matches spells that replace themselves by drawing a card. Low-risk card advantage stapled onto an effect.",
  },
  loot: {
    title: "Loot / Looting",
    description:
      "Matches cards that draw and then discard (or discard then draw), filtering your hand without net card advantage.",
  },
  // --- Tokens ---
  "creates-token-of-a-card": {
    title: "Creates Token Copy",
    description: "Matches cards that create token copies of other cards.",
  },
  "creates-oracle-token": {
    title: "Creates Named Token",
    description: "Matches cards that create specific named tokens (e.g. Soldier, Treasure, Food).",
  },
  "creates-card-token": {
    title: "Creates Token",
    description: "Matches cards that create creature or other token permanents.",
  },
  "token-maker": {
    title: "Token Producer",
    description: "Matches cards that produce creature tokens, flooding the board with additional attackers or blockers.",
  },
  // --- Counters / Combat ---
  "gives-pp-counters": {
    title: "+1/+1 Counter Giver",
    description: "Matches cards that place +1/+1 counters on creatures.",
  },
  "counters-matter": {
    title: "Counters Matter",
    description:
      "Matches cards that care about or reward having +1/+1 counters (proliferate payoffs, counter doublers, etc.).",
  },
  anthem: {
    title: "Anthem / Pump",
    description:
      "Matches cards that give a static power/toughness boost to multiple creatures (e.g. Honor of the Pure, Glorious Anthem).",
  },
  lord: {
    title: "Tribal Lord",
    description:
      "Matches creature cards that buff other creatures of the same type. Tribal staples like Goblin Chieftain or Lord of Atlantis.",
  },
  // --- Sacrifice ---
  "sacrifice-outlet": {
    title: "Sacrifice Outlet",
    description:
      "Matches cards that allow or require sacrificing creatures or permanents as a cost or effect.",
  },
  "sacrifice-payoff": {
    title: "Sacrifice Payoff",
    description:
      "Matches cards that reward sacrificing permanents with card advantage, tokens, damage, or other bonuses.",
  },
  "death-trigger": {
    title: "Death Trigger",
    description:
      "Matches cards with abilities that trigger when another creature dies — payoffs for a sacrifice or combat strategy.",
  },
  "death-trigger-self": {
    title: "Dies Trigger (Self)",
    description:
      "Matches cards with abilities that trigger specifically when the card itself dies.",
  },
  "sacrifice-self": {
    title: "Sacrifice Self",
    description: "Matches cards that sacrifice themselves as part of their cost or effect.",
  },
  "alternate-cost-sacrifice": {
    title: "Alternate Cost Sacrifice",
    description: "Matches cards that can be cast or activated by sacrificing another permanent instead of paying mana.",
  },
  // --- Counterspells ---
  counterspell: {
    title: "Counterspell",
    description:
      "Matches cards that counter spells on the stack, the backbone of blue control strategies.",
    tip: "Hard counters (unconditional) tend to be more expensive. Soft counters (conditional) are cheaper but situational.",
  },
  // --- Tutor ---
  tutor: {
    title: "Tutor",
    description:
      "Matches cards that search the library for a specific card and put it in hand, on the battlefield, or on top of the library.",
  },
  "tutor-creature": {
    title: "Creature Tutor",
    description: "Matches cards that specifically search for a creature card.",
  },
  "tutor-land": {
    title: "Land Tutor",
    description:
      "Matches cards that search the library for a land card and typically put it onto the battlefield.",
  },
  "land-tutor": {
    title: "Land Tutor",
    description:
      "Matches cards that search the library for a land card and typically put it onto the battlefield.",
  },
  // --- Graveyard ---
  recursion: {
    title: "Recursion",
    description:
      "Matches cards that return permanents or spells from the graveyard to hand, battlefield, or library.",
  },
  reanimation: {
    title: "Reanimation",
    description:
      "Matches cards that specifically put creature cards from a graveyard directly onto the battlefield.",
    tip: "Reanimation is a subset of recursion. Use it to find dedicated reanimation pieces like Reanimate or Animate Dead.",
  },
  mill: {
    title: "Mill",
    description:
      "Matches cards that put cards from the top of a library into the graveyard — both self-mill and opponent-mill.",
  },
  "self-mill": {
    title: "Self-Mill",
    description:
      "Matches cards that deliberately put your own cards into your graveyard, fueling graveyard strategies.",
  },
  // --- Copy / Clone ---
  "copy-spell": {
    title: "Copy Spell",
    description:
      "Matches cards that copy instants, sorceries, or abilities, doubling their effect.",
  },
  clone: {
    title: "Clone Effect",
    description:
      "Matches creature cards that enter as a copy of another creature, adapting to the best target on the battlefield.",
  },
  // --- Lifegain ---
  lifegain: {
    title: "Lifegain",
    description: "Matches cards that gain life as part of their cost or effect.",
  },
  "lifegain-matters": {
    title: "Lifegain Payoff",
    description:
      "Matches cards that trigger or grow when you gain life — the payoff pieces of a lifegain strategy.",
  },
  // --- Blink / Protection ---
  blink: {
    title: "Blink",
    description:
      "Matches cards that temporarily exile and return a permanent, re-triggering enters-the-battlefield abilities.",
  },
  "blink-own": {
    title: "Blink Self",
    description: "Matches cards that blink (exile and return) themselves.",
  },
  protection: {
    title: "Protection",
    description:
      "Matches cards that grant protection from a color, type, or player — complete damage/targeting/blocking immunity.",
  },
  hexproof: {
    title: "Hexproof Granter",
    description: "Matches cards that grant hexproof to a permanent or player, preventing them from being targeted.",
  },
  indestructible: {
    title: "Indestructible Granter",
    description: "Matches cards that grant indestructible, making permanents immune to destroy effects and lethal damage.",
  },
  // --- Discard / Hand ---
  discard: {
    title: "Discard / Hand Disruption",
    description:
      "Matches cards that force opponents to discard, stripping their hand of threats before they can be played.",
  },
  // --- Prowess / Spellslinger ---
  "gains-prowess": {
    title: "Gains Prowess",
    description: "Matches cards that have the prowess keyword — they get +1/+1 when you cast a non-creature spell.",
  },
  "gives-prowess": {
    title: "Grants Prowess",
    description: "Matches cards that give the prowess ability to other creatures.",
  },
  "grants-prowess": {
    title: "Grants Prowess",
    description: "Matches cards that grant the prowess ability to other creatures.",
  },
  "prowess-anthem": {
    title: "Prowess Anthem",
    description: "Matches cards that boost prowess creatures or trigger off noncreature spells being cast.",
  },
  "affinity-for-spells": {
    title: "Affinity for Spells",
    description: "Matches cards with affinity or similar cost-reduction based on spells cast or in hand.",
  },
  "second-spell-matters": {
    title: "Second Spell Matters",
    description: "Matches cards that reward or trigger on casting a second spell in the same turn.",
  },
  "storm-like": {
    title: "Storm / Spell Count",
    description:
      "Matches cards with storm or similar mechanics that care about spells cast this turn.",
  },
  // --- Misc ---
  treasure: {
    title: "Treasure Producer",
    description: "Matches cards that create Treasure tokens — artifacts that can be sacrificed for one mana of any color.",
    tip: "Treasure tokens provide flexible ramp. Common in Commander and Constructed combo decks.",
  },
  sacrifice: {
    title: "Sacrifice Theme",
    description: "Matches cards that involve sacrificing permanents, either as an outlet, cost, or payoff.",
  },
  haste: {
    title: "Haste Granter",
    description: "Matches cards that grant haste to creatures, allowing them to attack or use tap abilities immediately.",
  },
  "land-destruction": {
    title: "Land Destruction",
    description: "Matches cards that destroy lands, denying mana resources.",
  },
  stax: {
    title: "Stax / Prison",
    description:
      "Matches cards that restrict opponents' actions — taxing spells, locking down permanents, or preventing actions entirely.",
  },
};

// ---------------------------------------------------------------------------
// Operator / logical token descriptions
// ---------------------------------------------------------------------------

const OPERATOR_DESCRIPTIONS: Record<string, { title: string; description: string }> = {
  or: {
    title: "OR",
    description:
      "Results can match either side of this operator — broadens the search to include both options.",
  },
  "(": {
    title: "Group (open)",
    description:
      "Opens a grouped expression. Everything inside the parentheses is evaluated together before combining with the rest of the query.",
  },
  ")": {
    title: "Group (close)",
    description: "Closes a grouped expression.",
  },
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const FIELD_ALIASES: Record<string, string> = {
  color: "c",
  colors: "c",
  type: "t",
  oracle: "o",
  identity: "id",
  format: "format",
  f: "format",
  function: "function",
  oracletag: "function",
  otag: "function",
  art: "art",
  atag: "art",
  arttag: "art",
  a: "art",
  artist: "art",
  game: "game",
  kw: "kw",
  keyword: "kw",
  keywords: "kw",
  s: "set",
  set: "set",
  e: "set",
  edition: "set",
  b: "block",
  block: "block",
  mv: "mv",
  manavalue: "mv",
  cmc: "mv",
  power: "power",
  pow: "power",
  toughness: "toughness",
  tou: "toughness",
  pt: "pt",
  powtou: "pt",
  loyalty: "loyalty",
  loy: "loyalty",
  rarity: "rarity",
  r: "rarity",
  is: "is",
  not: "not",
  prefer: "prefer",
  order: "order",
  direction: "direction",
  unique: "unique",
  year: "year",
  banned: "banned",
  restricted: "restricted",
  legal: "legal",
  new: "new",
  strategy: "strategy",
};

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// Value-aware title builders
// ---------------------------------------------------------------------------

function buildColorTitle(field: "c" | "id", op: string, value: string, negated: boolean): string {
  const key = value.toLowerCase().replace(/['"]/g, "");
  const colorName = COLOR_NAMES[key] ?? value.toUpperCase();
  const label = field === "id" ? "Color Identity" : "Color";
  const qualifier = op === "=" ? " (exact)" : op === ":" ? "" : ` (${op})`;
  if (negated) return `Excluding ${label}: ${colorName}`;
  return `${label}: ${colorName}${qualifier}`;
}

function buildNumericTitle(label: string, op: string, value: string, negated: boolean): string {
  const opWord = OP_WORDS[op] ?? op;
  if (negated) return `Excluding ${label} ${op}${value}`;
  return opWord ? `${label}: ${opWord} ${value}` : `${label}: ${value}`;
}

function buildValueAwareTitle(
  canonicalField: string,
  op: string,
  value: string,
  negated: boolean,
  baseTitle: string
): string {
  const v = (value ?? "").replace(/['"]/g, "").toLowerCase().trim();
  const prefix = negated ? "Excluding — " : "";

  switch (canonicalField) {
    case "c":
      return buildColorTitle("c", op, v, negated);
    case "id":
      return buildColorTitle("id", op, v, negated);
    case "format": {
      const fmtName = FORMAT_NAMES[v] ?? value;
      return negated ? `Not legal in ${fmtName}` : `Format: ${fmtName}`;
    }
    case "t": {
      const typeName = v ? v.charAt(0).toUpperCase() + v.slice(1) : value;
      return negated ? `Excluding type: ${typeName}` : `Type: ${typeName}`;
    }
    case "kw": {
      const kwName = v ? v.charAt(0).toUpperCase() + v.slice(1) : value;
      return negated ? `Without keyword: ${kwName}` : `Keyword: ${kwName}`;
    }
    case "rarity": {
      const rName = RARITY_NAMES[v] ?? value;
      return negated ? `Excluding rarity: ${rName}` : `Rarity: ${rName}`;
    }
    case "is": {
      const flagName = IS_FLAG_NAMES[v] ?? v;
      return negated ? `Must not be: ${flagName}` : `Must be: ${flagName}`;
    }
    case "not": {
      const flagName = IS_FLAG_NAMES[v] ?? v;
      return `Must not be: ${flagName}`;
    }
    case "mv":
      return buildNumericTitle("Mana Value", op, value, negated);
    case "power":
      return buildNumericTitle("Power", op, value, negated);
    case "toughness":
      return buildNumericTitle("Toughness", op, value, negated);
    case "loyalty":
      return buildNumericTitle("Loyalty", op, value, negated);
    case "year":
      return buildNumericTitle("Year", op, value, negated);
    case "set":
      return negated ? `Excluding set: ${value.toUpperCase()}` : `Set: ${value.toUpperCase()}`;
    case "o":
      return negated ? `Oracle text excludes "${value}"` : `Oracle text: "${value}"`;
    case "game": {
      const platName = v === "paper" ? "Paper" : v === "arena" ? "MTG Arena" : v === "mtgo" ? "Magic Online" : value;
      return `Platform: ${platName}`;
    }
    case "banned":
      return `${prefix}Banned in ${FORMAT_NAMES[v] ?? value}`;
    case "restricted":
      return `Restricted in ${FORMAT_NAMES[v] ?? value}`;
    case "legal":
      return negated ? `Not legal in ${FORMAT_NAMES[v] ?? value}` : `Legal in ${FORMAT_NAMES[v] ?? value}`;
    default:
      if (value) return negated ? `Excluding ${value}` : baseTitle;
      return negated ? `Excluding ${baseTitle}` : baseTitle;
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export const tokenizeQuery = (value: string): QueryToken[] => {
  const tokens: QueryToken[] = [];
  let buffer = "";
  let inQuotes = false;

  const pushToken = (raw: string) => {
    if (!raw) return;
    if (raw.toLowerCase() === "or") {
      tokens.push({ raw, type: "logical" });
      return;
    }

    let tokenValue = raw;
    let negated = false;
    if (tokenValue.startsWith("-")) {
      negated = true;
      tokenValue = tokenValue.slice(1);
    }

    // Match field + operator + value (supports :, =, <, >, <=, >=)
    const fieldMatch = tokenValue.match(/^([a-z]+)(<=|>=|<|>|=|:)(.*)$/i);
    if (fieldMatch) {
      const field = fieldMatch[1].toLowerCase();
      const op = fieldMatch[2];
      const valuePart = fieldMatch[3];
      tokens.push({ raw, type: "field", field, op, value: valuePart, negated });
      return;
    }

    tokens.push({ raw, type: "text", negated });
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === '"') {
      buffer += char;
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && (char === "(" || char === ")")) {
      pushToken(buffer.trim());
      buffer = "";
      tokens.push({ raw: char, type: "group" });
      continue;
    }

    if (!inQuotes && /\s/.test(char)) {
      pushToken(buffer.trim());
      buffer = "";
      continue;
    }

    buffer += char;
  }

  pushToken(buffer.trim());
  return tokens;
};

// ---------------------------------------------------------------------------
// Reason builder
// ---------------------------------------------------------------------------

const buildReason = (token: QueryToken, sourceQuery: string) => {
  if (!sourceQuery.trim()) {
    return "Derived from your search request.";
  }

  const normalizedSource = normalizeText(sourceQuery);
  const value = token.value ? normalizeText(token.value) : normalizeText(token.raw);

  if (value && normalizedSource.includes(value)) {
    if (token.negated) {
      return `Added because you asked to exclude "${token.value ?? token.raw}".`;
    }
    return `Added because you asked for "${token.value ?? token.raw}".`;
  }

  if (token.negated) {
    const patterns = [
      `non ${value}`,
      `no ${value}`,
      `without ${value}`,
      `excluding ${value}`,
      `not ${value}`,
    ];
    if (patterns.some((pattern) => normalizedSource.includes(pattern))) {
      return `Added because you asked to exclude "${token.value ?? token.raw}".`;
    }
  }

  return "Derived from your search request.";
};

// ---------------------------------------------------------------------------
// Main metadata resolver
// ---------------------------------------------------------------------------

export const getTokenMetadata = (token: QueryToken, sourceQuery: string): TokenMetadata => {
  if (token.type === "logical") {
    const details = OPERATOR_DESCRIPTIONS.or;
    return {
      ...token,
      title: details.title,
      description: details.description,
      reason: buildReason(token, sourceQuery),
    };
  }

  if (token.type === "group") {
    const details = OPERATOR_DESCRIPTIONS[token.raw] ?? OPERATOR_DESCRIPTIONS["("];
    return {
      ...token,
      title: details.title,
      description: details.description,
      reason: buildReason(token, sourceQuery),
    };
  }

  if (token.type === "field") {
    const canonicalField = FIELD_ALIASES[token.field ?? ""] ?? token.field ?? "";
    const op = token.op ?? ":";
    const val = token.value ?? "";

    // Function / oracletag — look up the tag value first for rich descriptions
    if (canonicalField === "function" && val) {
      const key = normalizeText(val);
      const details = FUNCTION_TAGS[key];
      if (details) {
        return {
          ...token,
          title: token.negated ? `Excluding: ${details.title}` : details.title,
          description: details.description,
          reason: buildReason(token, sourceQuery),
          tip: details.tip,
        };
      }
      // Unknown function tag — show the tag name cleanly
      const cleanTag = val.replace(/['"]/g, "");
      return {
        ...token,
        title: token.negated ? `Excluding tag: ${cleanTag}` : `Tag: ${cleanTag}`,
        description:
          "A community tag from the MTG Tagger project describing this card's role or function in a deck.",
        reason: buildReason(token, sourceQuery),
        tip: "Not all cards are tagged. If results are sparse, try supplementing with o: oracle text filters.",
      };
    }

    // game: gets a custom tip about auto-injection
    if (canonicalField === "game") {
      const platName =
        val.toLowerCase() === "paper"
          ? "Paper"
          : val.toLowerCase() === "arena"
          ? "MTG Arena"
          : val.toLowerCase() === "mtgo"
          ? "Magic Online"
          : val;
      return {
        ...token,
        title: `Platform: ${platName}`,
        description: FIELD_DESCRIPTIONS.game.description,
        reason: buildReason(token, sourceQuery),
        tip: FIELD_DESCRIPTIONS.game.tip,
      };
    }

    // prefer: gets a custom tip
    if (canonicalField === "prefer") {
      return {
        ...token,
        title: `Prefer: ${val}`,
        description: FIELD_DESCRIPTIONS.prefer?.description ?? "Controls how Scryfall selects among duplicate printings.",
        reason: buildReason(token, sourceQuery),
        tip: FIELD_DESCRIPTIONS.prefer?.tip,
      };
    }

    const fieldDetails = FIELD_DESCRIPTIONS[canonicalField];
    if (fieldDetails) {
      const title = val
        ? buildValueAwareTitle(canonicalField, op, val, token.negated ?? false, fieldDetails.title)
        : token.negated
        ? `Excluding ${fieldDetails.title}`
        : fieldDetails.title;

      return {
        ...token,
        title,
        description: fieldDetails.description,
        reason: buildReason(token, sourceQuery),
        tip: fieldDetails.tip,
      };
    }

    // Unknown field — fall back gracefully
    return {
      ...token,
      title: token.negated ? `Excluding ${val || token.field}` : `Filter: ${token.field}`,
      description: "A Scryfall filter field. See scryfall.com/docs/syntax for the full reference.",
      reason: buildReason(token, sourceQuery),
    };
  }

  return {
    ...token,
    title: token.negated ? `Excluding "${token.raw}"` : "Search term",
    description: "A direct search term included in the Scryfall query.",
    reason: buildReason(token, sourceQuery),
  };
};
