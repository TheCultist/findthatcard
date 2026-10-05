import { TaggerTagContext, extractArtKeywords } from "@/lib/tagger/context";
import { SCRYFALL_FORMATS, stripRedundantTypesForCommanderEligible } from "@/lib/scryfall/formats";
import { escapeRegex } from "@/lib/utils/text";

const MAX_SCRYFALL_QUERY_LENGTH = 1200;
export const PREFER_BEST_PREFIX = "prefer:best "; // 12 characters
export const EFFECTIVE_MAX_QUERY_LENGTH =
  MAX_SCRYFALL_QUERY_LENGTH - PREFER_BEST_PREFIX.length; // 1188 characters
const FORMAT_NAMES = SCRYFALL_FORMATS;

function normalizeFormatFunctionTags(query: string): string {
  return FORMAT_NAMES.reduce((acc, format) => {
    // Use (?![-\w]) instead of \b to prevent incorrectly matching compound tagger tags
    // whose prefix is a format name, e.g. function:commander-tax-evasion would be
    // truncated to f:commander-tax-evasion by \b matching at the hyphen.
    const pattern = new RegExp(`(^|\\s|\\()(-)?function:${format}(?![-\\w])`, "gi");
    return acc.replace(pattern, (_match, prefix, negation) => {
      const negated = negation ? "-" : "";
      return `${prefix}${negated}f:${format}`;
    });
  }, query);
}

function normalizeWhitespace(query: string): string {
  return query
    .replace(/\s{2,}/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

function normalizeLeadingStrayToken(query: string): string {
  // Strip leading stray "i" or "I" (often from "I need" leaking into AI output)
  const updated = query.replace(/^\s*[iI]\s+/i, "").trim();
  if (updated !== query) {
    return normalizeWhitespace(updated);
  }

  const tokens = splitQueryTokens(query);
  if (tokens.length < 2) {
    return query;
  }

  const hasFieldToken = tokens.some((token) => /^-?[a-z]+[:=]/i.test(token));
  if (!hasFieldToken) {
    return query;
  }

  const firstToken = tokens[0];
  if (!/^[iI]$/.test(firstToken)) {
    return query;
  }

  const remaining = tokens.slice(1).join(" ");
  return normalizeWhitespace(remaining);
}

function splitQueryTokens(query: string): string[] {
  const tokens: string[] = [];
  let buffer = "";
  let inQuotes = false;

  const pushBuffer = () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      tokens.push(trimmed);
    }
    buffer = "";
  };

  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];

    if (char === '"') {
      buffer += char;
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && (char === "(" || char === ")")) {
      pushBuffer();
      tokens.push(char);
      continue;
    }

    if (!inQuotes && /\s/.test(char)) {
      pushBuffer();
      continue;
    }

    buffer += char;
  }

  pushBuffer();
  return tokens;
}

function quoteOracleTextPhrases(query: string): string {
  const tokens = splitQueryTokens(query);
  const result: string[] = [];

  const isFieldToken = (token: string) => /^-?[a-z]+:/i.test(token);
  const oracleMatch = (token: string) => token.match(/^(-?)(o|oracle):(.+)$/i);

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    const match = oracleMatch(token);
    if (!match) {
      result.push(token);
      index += 1;
      continue;
    }

    const prefix = `${match[1]}${match[2]}:`;
    const value = match[3];
    if (value.startsWith('"') || value.startsWith("/")) {
      result.push(token);
      index += 1;
      continue;
    }

    const phraseParts = [value];
    let lookahead = index + 1;
    while (lookahead < tokens.length) {
      const next = tokens[lookahead];
      const lowerNext = next.toLowerCase();
      if (next === "(" || next === ")") {
        break;
      }
      if (lowerNext === "or" || lowerNext === "and" || lowerNext === "not") {
        break;
      }
      if (isFieldToken(next)) {
        break;
      }
      phraseParts.push(next);
      lookahead += 1;
    }

    if (phraseParts.length > 1) {
      result.push(`${prefix}"${phraseParts.join(" ")}"`);
      index = lookahead;
      continue;
    }

    result.push(token);
    index += 1;
  }

  return normalizeWhitespace(result.join(" "));
}

function dedupeTokens(query: string): string {
  const seen = new Set<string>();
  const tokens = splitQueryTokens(query);
  const result: string[] = [];
  const nonDedupedTokens = new Set(["or", "and", "not"]);

  for (const token of tokens) {
    const key = token.toLowerCase();
    if (token === "(" || token === ")") {
      result.push(token);
      continue;
    }
    if (nonDedupedTokens.has(key)) {
      result.push(token);
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(token);
  }

  return normalizeWhitespace(result.join(" "));
}

function normalizeManaCostSymbolIntent(naturalQuery: string, query: string): string {
  const wantsXInCost =
    /\b(x|x's)\b/i.test(naturalQuery) &&
    /\b(mana cost|cost)\b/i.test(naturalQuery);
  if (!wantsXInCost) {
    return query;
  }

  let updated = query;
  if (!/\bm:X\b/i.test(updated)) {
    updated = `${updated} m:X`;
  }
  updated = updated.replace(/\bo:"?X"?\b/gi, "");
  updated = updated.replace(/\bfunction:converted-mana-cost-matters\b/gi, "");

  return normalizeWhitespace(updated);
}

function normalizeGameChangerIntent(naturalQuery: string, query: string): string {
  const lower = naturalQuery.toLowerCase();
  const wantsGameChangerList =
    /\b(game\s*changer\s*(list)?|gamechanger\s*(list)?|cards?\s+in\s+the\s+game\s*changer\s*(list)?)\b/i.test(
      lower
    );

  if (!wantsGameChangerList) {
    return query;
  }

  let updated = query;
  if (!/\bis:gamechanger\b/i.test(updated)) {
    updated = `${updated} is:gamechanger`;
  }
  return normalizeWhitespace(updated);
}

/**
 * When the user asks for banned or restricted cards in a format, the query must not
 * also require legality in that same format (f:X / legal:X). Remove those conflicting filters.
 */
function removeFormatLegalityWhenBannedOrRestricted(query: string): string {
  const bannedRestrictedFormats = new Set<string>();
  const banRestrictRegex = /\b(?:banned|restricted):([a-z]+)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = banRestrictRegex.exec(query)) !== null) {
    bannedRestrictedFormats.add(match[1].toLowerCase());
  }
  if (bannedRestrictedFormats.size === 0) {
    return query;
  }
  let updated = query;
  for (const format of bannedRestrictedFormats) {
    const escaped = escapeRegex(format);
    // Remove f:format, legal:format, format:format and their negated forms
    const legalityPattern = new RegExp(
      `\\s*-?(?:f|legal|format):${escaped}\\b\\s*`,
      "gi"
    );
    updated = updated.replace(legalityPattern, " ").trim();
  }
  return normalizeWhitespace(updated);
}

function normalizeCommanderIdentity(query: string): string {
  if (!/\bis:commander\b/i.test(query)) {
    return query;
  }
  return query.replace(/\bid:([wubrgc]{1,5})\b/gi, "id=$1");
}

function normalizeInstantSorceryTypeChain(query: string): string {
  const instantPattern = /(^|\s)(t|type):instant\b/gi;
  const sorceryPattern = /(^|\s)(t|type):sorcery\b/gi;
  const hasInstant = instantPattern.test(query);
  const hasSorcery = sorceryPattern.test(query);
  if (!hasInstant || !hasSorcery) {
    return query;
  }

  const hasNegatedInstantOrSorcery = /\s-(?:t|type):(instant|sorcery)\b/i.test(query);
  if (hasNegatedInstantOrSorcery) {
    return query;
  }

  const alreadyGrouped = /\((?:[^()]*\b(?:t|type):instant\b[^()]*)\bor\b(?:[^()]*\b(?:t|type):sorcery\b[^()]*)\)/i.test(
    query
  );
  if (alreadyGrouped) {
    return query;
  }

  let updated = query.replace(instantPattern, " ").replace(sorceryPattern, " ");
  updated = normalizeWhitespace(updated);
  return normalizeWhitespace(`(t:instant or t:sorcery) ${updated}`);
}

type DamageTarget = "opponent" | "creature" | "planeswalker" | "player" | "any" | "battle" | "general";

/**
 * Function tags for opponent- / player-target burn and direct life-loss (damage archetype).
 * Single source for `DAMAGE_TAG_FAMILIES.opponent` / `player` and Phase 3 spell-cast ping fixes.
 */
export const OPPONENT_BURN_DAMAGE_FUNCTION_TAGS = [
  "burn-player",
  "burn-player-each",
  "burn-any",
  "opponent-loses-life",
  "life-drain",
  "drain-life",
  "lifegain-to-damage",
] as const;

const DAMAGE_TAG_FAMILIES: Record<DamageTarget, string[]> = {
  opponent: [...OPPONENT_BURN_DAMAGE_FUNCTION_TAGS],
  creature: [
    "burn-creature", "burn-any", "removal-creature-burn", "removal-burn",
  ],
  planeswalker: [
    "burn-planeswalker", "burn-any", "removal-planeswalker-burn", "removal-burn",
  ],
  player: [...OPPONENT_BURN_DAMAGE_FUNCTION_TAGS],
  battle: [
    "burn-battle", "burn-any", "removal-battle-burn", "removal-burn",
  ],
  any: [
    "burn-any", "burn-creature", "burn-player", "burn-planeswalker",
    "removal-burn", "opponent-loses-life",
  ],
  general: [
    "burn", "burn-any", "burn-creature", "burn-player",
    "removal-burn",
  ],
};

type ArchetypeQualifier = {
  name: string;
  tags: string[];
};

type ArchetypeEntry = {
  name: string;
  description: string;
  defaultTags: string[];
  qualifiers?: ArchetypeQualifier[];
};

/**
 * Canonical Scryfall function tags for the **hate-magnet** (“you become the archenemy”) archetype:
 * group slug, extra turns, mass LD, lockdown, storm-style wins, taxes, infect, etc.
 *
 * Single source of truth for:
 * - The `hate-magnet` registry entry’s `defaultTags`
 * - Phase 1 / other code that needs the full set or a **subset** via {@link hateMagnetFunctionTagsExcluding}
 */
export const HATE_MAGNET_FUNCTION_TAGS = [
  "group-slug",
  "extra-turn",
  "mass-land-denial",
  "lockdown",
  "lockdown-permanent",
  "storm",
  "storm-like",
  "tax",
  "cast-tax",
  "infect",
] as const;

export type HateMagnetFunctionTag = (typeof HATE_MAGNET_FUNCTION_TAGS)[number];

/**
 * Hate-magnet tags minus any omitted names (case-insensitive). Order matches {@link HATE_MAGNET_FUNCTION_TAGS}.
 *
 * - **`omit` omitted or empty** → returns **all** hate-magnet tags (e.g. “don’t be the archenemy” with no subset kept).
 * - **`omit: "extra-turn"`** → every tag except extra turns (e.g. “extra turns but not stax”).
 * - **Multiple omits** → `hateMagnetFunctionTagsExcluding(["extra-turn", "storm"])`, etc.
 */
export function hateMagnetFunctionTagsExcluding(
  omit?: string | readonly string[]
): string[] {
  const omitList =
    omit === undefined
      ? []
      : typeof omit === "string"
        ? [omit]
        : [...omit];
  if (omitList.length === 0) {
    return [...HATE_MAGNET_FUNCTION_TAGS];
  }
  const omitSet = new Set(omitList.map((t) => t.toLowerCase()));
  return HATE_MAGNET_FUNCTION_TAGS.filter((t) => !omitSet.has(t.toLowerCase()));
}

const ARCHETYPE_REGISTRY: ArchetypeEntry[] = [
  {
    name: "removal",
    description:
      "Destroy, exile, bounce, or tuck permanents (not exile as a zone: 'cast from exile', impulse, foretell, suspend)",
    defaultTags: ["removal", "spot-removal", "repeatable-removal", "oblivion-ring-effect"],
    qualifiers: [
      {
        name: "creature",
        tags: ["removal-creature", "removal-creature-burn", "removal-creature-fight", "removal-exile", "removal-destroy", "spot-removal"],
      },
      {
        name: "enchantment",
        tags: ["removal-enchantment"],
      },
      {
        name: "artifact",
        tags: ["removal-artifact"],
      },
      {
        name: "planeswalker",
        tags: ["removal-planeswalker", "removal-planeswalker-burn"],
      },
      {
        name: "land",
        tags: ["removal-land"],
      },
      {
        name: "permanent",
        tags: ["removal-permanent", "removal-exile", "removal-destroy", "removal-bounce"],
      },
      {
        name: "noncreature",
        tags: ["removal-noncreature", "removal-enchantment", "removal-artifact", "removal-planeswalker", "removal-land"],
      },
      {
        name: "any",
        tags: ["removal-exile", "removal-destroy", "removal-bounce", "removal-permanent", "spot-removal"],
      },
    ],
  },
  {
    name: "ramp",
    description: "Accelerate mana production or cheat mana costs",
    defaultTags: ["ramp", "mana-ramp"],
  },
  {
    name: "tokens",
    description: "Create or multiply creature/artifact/treasure tokens",
    defaultTags: ["repeatable-token-generator", "repeatable-creature-tokens", "young-pyromancer-ability"],
    qualifiers: [
      {
        name: "treasure",
        tags: ["repeatable-token-generator", "repeatable-artifact-tokens"],
      },
      {
        name: "creature",
        tags: ["repeatable-token-generator", "repeatable-creature-tokens"],
      },
      {
        name: "artifact",
        tags: ["repeatable-token-generator", "repeatable-artifact-tokens"],
      },
      {
        name: "noncreature",
        tags: ["repeatable-token-generator", "repeatable-noncreature-tokens"],
      },
    ],
  },
  {
    name: "reanimator",
    description: "Return permanents from graveyard to battlefield",
    defaultTags: ["reanimate", "reanimate-creature", "reanimate-permanent", "reanimate-from-any"],
    qualifiers: [
      {
        name: "creature",
        tags: ["reanimate", "reanimate-creature", "reanimate-from-any"],
      },
      {
        name: "artifact",
        tags: ["reanimate", "reanimate-artifact", "reanimate-from-any"],
      },
      {
        name: "self",
        tags: ["reanimate-self", "self-reanimate"],
      },
    ],
  },
  {
    name: "mill",
    description: "Put cards from libraries into graveyards",
    defaultTags: ["mill", "mill-opponent", "mill-any"],
    qualifiers: [
      {
        name: "self",
        tags: ["mill-self", "self-mill", "mill"],
      },
      {
        name: "opponent",
        tags: ["mill-opponent", "mill", "mill-any"],
      },
      {
        name: "each",
        tags: ["mill-each", "mill", "mill-any"],
      },
    ],
  },
  {
    name: "blink",
    description: "Exile a permanent and return it to the battlefield to re-trigger ETB effects",
    defaultTags: ["blink", "flicker", "flicker-creature", "flicker-permanent"],
    qualifiers: [
      {
        name: "creature",
        tags: ["blink", "flicker", "flicker-creature"],
      },
      {
        name: "artifact",
        tags: ["blink", "flicker", "flicker-artifact"],
      },
      {
        name: "permanent",
        tags: ["blink", "flicker", "flicker-permanent", "flicker-nonland"],
      },
      {
        name: "self",
        tags: ["flicker-self"],
      },
    ],
  },
  {
    name: "discard",
    description: "Force discarding cards or benefit from discarding",
    defaultTags: ["discard", "discard-outlet", "discard-matters"],
    qualifiers: [
      {
        name: "self",
        tags: ["discard", "discard-outlet", "free-discard-outlet", "self-discard-matters"],
      },
      {
        name: "opponent",
        tags: ["discard", "opponent-discard-matters", "random-discard", "specter-ability", "thoughtseize"],
      },
    ],
  },
  {
    name: "card-draw",
    description: "Draw extra cards or generate card advantage",
    defaultTags: ["draw-engine", "repeatable-draw", "pure-draw", "impulse-draw", "burst-draw", "card-advantage"],
  },
  {
    name: "cantrip",
    description: "Spells that replace themselves by drawing a card (e.g. Brainstorm, Ponder, Opt)",
    defaultTags: ["cantrip"],
  },
  {
    name: "counterspell",
    description: "Counter spells and permission magic (hard and soft counters)",
    defaultTags: ["counterspell"],
  },
  {
    name: "recursion",
    description: "Graveyard recursion and self-recursion effects",
    defaultTags: ["recursion"],
  },
  {
    name: "mana-dork",
    description: "Creatures that tap to produce mana (e.g. Llanowar Elves, Birds of Paradise)",
    defaultTags: ["mana-dork"],
  },
  {
    name: "anthem",
    description: "Permanent effects that buff all creatures you control (e.g. Glorious Anthem)",
    defaultTags: ["anthem"],
  },
  {
    name: "lord",
    description: "Tribal lords that grant +1/+1 or abilities to creatures of a specific type",
    defaultTags: ["lord"],
  },
  {
    name: "voltron",
    description: "Buff a single creature with equipment or auras to win via commander damage",
    defaultTags: ["synergy-equipment", "synergy-aura", "sneak-equipment", "sneak-aura"],
  },
  {
    name: "stax",
    description: "Tax or restrict opponents' actions (casting, attacking, untapping)",
    defaultTags: ["tax", "tax-attack", "tax-block", "cast-tax", "kismet-effect"],
  },
  {
    name: "landfall",
    description: "Trigger effects when lands enter the battlefield",
    defaultTags: ["landfall", "landfall-other"],
  },
  {
    name: "infect",
    description: "Deal damage as poison counters or infect/toxic mechanics",
    // Infect / toxic / poisonous are keywords — Tagger has no function:infect or function:poison.
    defaultTags: ["kw:infect", "kw:toxic", "kw:poisonous", "poison-opponents", "gives-infect", "synergy-infect", "synergy-poison"],
  },
  {
    name: "storm",
    description: "Copy spells based on number of spells cast this turn",
    defaultTags: ["kw:storm", "storm-like", "storm-count-matters", "gives-storm"],
  },
  {
    name: "extra-combat",
    description: "Grant additional combat phases in a turn",
    defaultTags: ["extra-combat", "extra-combat-phase"],
  },
  {
    name: "pillow-fort",
    description: "Prevent or tax opponents from attacking you",
    defaultTags: ["prevent-attack", "prevent-attacker", "tax-attack"],
  },
  {
    name: "enchantress",
    description: "Draw a card whenever an enchantment is cast or enters; enchantress-effect payoffs",
    defaultTags: ["enchantress"],
  },
  {
    name: "tutor",
    description: "Search, fetch, or find specific cards from your library or deck",
    defaultTags: ["tutor", "tutor-to-hand"],
    qualifiers: [
      {
        name: "creature",
        tags: ["tutor-creature"],
      },
      {
        name: "enchantment",
        tags: ["tutor-enchantment"],
      },
      {
        name: "land",
        tags: ["tutor-land"],
      },
      {
        name: "artifact",
        tags: ["tutor-artifact"],
      },
      {
        name: "instant",
        tags: ["tutor-instant"],
      },
      {
        name: "sorcery",
        tags: ["tutor-sorcery"],
      },
      {
        name: "planeswalker",
        tags: ["tutor-planeswalker"],
      },
    ],
  },
  {
    name: "finisher",
    description: "End the game on the spot: 'you win the game' effects, Craterhoof-style overrun pumps, or primary win conditions",
    defaultTags: ["win-condition", "alternate-win-condition", "automatic-win", "overrun"],
  },
  {
    name: "aristocrats",
    description: "Sacrifice creatures for value: sacrifice outlets, death triggers, and payoffs when creatures die",
    defaultTags: ["sacrifice-outlet", "sac-outlet", "death-trigger", "death-trigger-self", "synergy-sacrifice", "blood-artist-ability"],
  },
  {
    name: "group-slug",
    description: "Deal damage or impose costs on all opponents simultaneously",
    defaultTags: ["group-slug"],
  },
  {
    name: "group-hug",
    description: "Benefit all players equally: draw cards for everyone, accelerate everyone's mana, etc.",
    defaultTags: ["group-hug", "selective-group-hug"],
  },
  {
    name: "hate-magnet",
    description: "Cards that make you the archenemy: group slug, stax, extra turns, land destruction, lockdown, storm, or infect strategies that antagonise the whole table",
    defaultTags: [...HATE_MAGNET_FUNCTION_TAGS],
  },
  // ── Hate archetypes ────────────────────────────────────────────────────────
  {
    name: "hate-etb",
    description: "Prevent or punish opponents' creatures from triggering enters-the-battlefield abilities",
    defaultTags: ["hate-etb"],
  },
  {
    name: "graveyard-hate",
    description: "Exile or permanently neutralize opponents' graveyards",
    defaultTags: ["graveyard-hate", "hate-graveyard", "hate-graveyard-cast"],
  },
  {
    name: "artifact-hate",
    description: "Punish, restrict, or hate against artifacts and artifact strategies",
    defaultTags: ["hate-artifact", "hate-artifact-creature", "hate-artifact-land"],
  },
  {
    name: "enchantment-hate",
    description: "Punish, restrict, or hate against enchantments",
    defaultTags: ["hate-enchantment", "hate-enchantment-creature"],
  },
  {
    name: "token-hate",
    description: "Prevent or punish opponents from creating or benefiting from tokens",
    defaultTags: ["hate-token", "hate-token-creature"],
  },
  {
    name: "draw-hate",
    description: "Punish or restrict opponents from drawing extra cards",
    defaultTags: ["hate-draw", "draw-hate"],
  },
  {
    name: "lifegain-hate",
    description: "Prevent or punish opponents from gaining life",
    defaultTags: ["hate-lifegain"],
  },
  {
    name: "storm-hate",
    description: "Shut down or punish storm and spell-copy strategies",
    defaultTags: ["hate-storm"],
  },
  {
    name: "ramp-hate",
    description: "Punish or restrict mana ramp and mana acceleration",
    defaultTags: ["hate-ramp"],
  },
  {
    name: "nonbasic-hate",
    description: "Punish or restrict non-basic lands",
    defaultTags: ["hate-nonbasic-land"],
  },
  {
    name: "flying-hate",
    description: "Punish or destroy creatures with flying",
    defaultTags: ["hate-flying", "flying-hate"],
  },
  {
    name: "flash-hate",
    description: "Prevent or punish opponents from playing spells at instant speed",
    defaultTags: ["hate-flash"],
  },
  {
    name: "hexproof-hate",
    description: "Bypass, remove, or punish hexproof on permanents",
    defaultTags: ["hate-hexproof"],
  },
  {
    name: "indestructible-hate",
    description: "Bypass or punish indestructible permanents",
    defaultTags: ["hate-indestructible"],
  },
  {
    name: "copy",
    description: "Create token copies of permanents or copy spells on the stack",
    defaultTags: ["clone", "copy-permanent", "copy-spell", "creates-oracle-copy"],
    qualifiers: [
      {
        name: "spell",
        tags: ["copy-spell", "copy-instant", "copy-sorcery"],
      },
      {
        name: "creature",
        tags: ["clone", "copy-creature"],
      },
      {
        name: "permanent",
        tags: ["copy-permanent", "clone"],
      },
      {
        name: "artifact",
        tags: ["copy-artifact"],
      },
      {
        name: "enchantment",
        tags: ["copy-enchantment"],
      },
    ],
  },
  // ── Card-name effect archetypes ─────────────────────────────────────────
  // Card names that have become generic shorthand for an effect category.
  {
    name: "fog",
    description: "Prevent all combat damage this turn (Fog effects)",
    defaultTags: ["fog", "fog-limited", "fog-selective", "pseudo-fog"],
  },
  {
    name: "wheel",
    description: "Each player discards their hand and draws a new hand (Wheel of Fortune effects)",
    defaultTags: ["wheel"],
  },
  {
    name: "curiosity",
    description: "Draw a card whenever a creature deals combat damage to a player (Curiosity effects)",
    defaultTags: ["curiosity", "curiosity-like"],
  },
  {
    name: "brainstorm",
    description: "Draw cards and put cards back on top of your library (Brainstorm-style card selection)",
    defaultTags: ["brainstorm"],
  },
  {
    name: "impact-tremors",
    description: "Deal damage to opponents whenever a creature enters the battlefield (Impact Tremors effects)",
    defaultTags: ["impact-effect"],
  },
  // ── Deck strategies ─────────────────────────────────────────────────────
  // Tags may be full Scryfall tokens (o:"…", kw:…); bare slugs mean function:<slug>.
  {
    name: "lifegain",
    description: "Gain life and payoffs that care about gaining life",
    defaultTags: ["lifegain", "lifegain-matters", "soul-warden-ability", "pridemate"],
  },
  {
    name: "sacrifice",
    description: "Sacrifice outlets and payoffs for sacrificing permanents",
    defaultTags: ["sacrifice-outlet", "synergy-sacrifice"],
  },
  {
    name: "counters",
    description: "+1/+1 counters: put them on creatures and payoffs that care about them",
    defaultTags: ["counters-matter", "gives-pp-counters"],
  },
  {
    name: "board-wipe",
    description: "Destroy, exile, or bounce all (or most) creatures or permanents at once",
    defaultTags: ["boardwipe", "wrath-of-god"],
  },
  {
    name: "control",
    description: "Counterspells, removal, and board wipes to control the game",
    defaultTags: ["counterspell", "removal", "boardwipe"],
  },
  {
    name: "spellslinger",
    description: "Cast many instants and sorceries; payoffs that trigger on casting them",
    defaultTags: [
      "copy-spell",
      "affinity-for-spells",
      "second-spell-matters",
      "prowess-anthem",
      "gains-prowess",
      "gives-prowess",
      "grants-prowess",
      "storm-like",
      'o:"whenever you cast an instant or sorcery"',
      'o:"whenever a player casts an instant or sorcery"',
      'o:"whenever you cast an instant"',
      'o:"whenever a player casts an instant"',
      'o:"whenever you cast a sorcery"',
      'o:"whenever a player casts a sorcery"',
      'o:"whenever a player casts a spell"',
      'o:"whenever you cast a spell"',
      "kw:prowess",
    ],
  },
];

export type ArchetypeMenuEntry = {
  name: string;
  description: string;
  qualifiers?: string[];
};

export function getArchetypeMenu(): ArchetypeMenuEntry[] {
  const damageEntry: ArchetypeMenuEntry = {
    name: "damage",
    description: "Deal direct damage or burn to opponents, creatures, planeswalkers, or any target",
    qualifiers: ["opponent", "creature", "planeswalker", "player", "any", "battle", "general"],
  };

  const archetypeEntries = ARCHETYPE_REGISTRY.map((entry) => {
    const result: ArchetypeMenuEntry = {
      name: entry.name,
      description: entry.description,
    };
    if (entry.qualifiers && entry.qualifiers.length > 0) {
      result.qualifiers = entry.qualifiers.map((q) => q.name);
    }
    return result;
  });

  return [damageEntry, ...archetypeEntries];
}

export function lookupArchetypeTags(
  archetype: string,
  qualifier?: string
): string[] | null {
  if (archetype === "damage") {
    const target = (qualifier || "general") as DamageTarget;
    return DAMAGE_TAG_FAMILIES[target] || DAMAGE_TAG_FAMILIES.general;
  }

  const entry = ARCHETYPE_REGISTRY.find(
    (e) => e.name.toLowerCase() === archetype.toLowerCase()
  );
  if (!entry) return null;

  if (qualifier && entry.qualifiers) {
    const q = entry.qualifiers.find(
      (q) => q.name.toLowerCase() === qualifier.toLowerCase()
    );
    if (q) return q.tags;
  }

  return entry.defaultTags;
}

function normalizeArtIntent(
  naturalQuery: string,
  query: string,
  tagContext?: TaggerTagContext
): string {
  const hasArtIntent =
    /\b(in the art|art|depicts|depicting|illustration|illustrations|featuring|shows|showing|artwork|art work|picture|pictured)\b/i.test(
      naturalQuery
    );
  if (!hasArtIntent) {
    return query;
  }

  const hasArtToken = /\b-?(?:art|atag|arttag):/i.test(query);
  if (hasArtToken) {
    return query;
  }

  const artKeywords = extractArtKeywords(naturalQuery);
  if (artKeywords.length === 0) {
    return query;
  }

  const normalizedContextTags =
    tagContext?.art?.map((tag) => tag.toLowerCase()) || [];
  const hasContext = normalizedContextTags.length > 0;

  const eligibleKeywords = artKeywords.filter((keyword) => {
    if (!hasContext) {
      return true;
    }
    return normalizedContextTags.includes(keyword.toLowerCase());
  });

  if (eligibleKeywords.length === 0) {
    return query;
  }

  let updated = query;

  for (const keyword of eligibleKeywords) {
    const escapedKeyword = escapeRegex(keyword);
    const oraclePattern = new RegExp(
      `\\b(o|oracle):(?:"${escapedKeyword}"|${escapedKeyword})\\b`,
      "gi"
    );
    if (oraclePattern.test(updated)) {
      updated = updated.replace(oraclePattern, `art:${keyword}`);
    }
  }

  if (!/\b-?(?:art|atag|arttag):/i.test(updated)) {
    const additions = eligibleKeywords.slice(0, 3).map((keyword) => `art:${keyword}`);
    updated = `${updated} (${additions.join(" or ")})`.trim();
  }

  return normalizeWhitespace(updated);
}

/** Counts parenthesized art OR groups like (art:x or art:y). */
function countArtOrGroups(query: string): number {
  const matches = query.match(/\(\s*art:/gi);
  return matches ? matches.length : 0;
}

/** Collects all art/atag/arttag tokens and replaces them with a single OR chain. Leaves query unchanged when it already has multiple (art:... or ...) groups (AND of concepts). */
function normalizeArtTagsToOrChain(query: string): string {
  if (countArtOrGroups(query) >= 2) return query;
  // Preserve explicit AND intent when multiple standalone art tags are already
  // present as separate clauses (e.g. "art:goth art:woman art:cleavage").
  const standaloneArtAndChain =
    /(?:^|\s)(?:art|atag|arttag):[^\s()]+(?:\s+(?:art|atag|arttag):[^\s()]+){1,}(?:\s|$)/i;
  if (standaloneArtAndChain.test(query)) return query;

  const artPattern = /\b(?:art|atag|arttag):([^\s()]+)(?=\s|$|\))/gi;
  const tags: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = artPattern.exec(query)) !== null) {
    const slug = match[1];
    if (slug && !tags.some((t) => t.toLowerCase() === `art:${slug.toLowerCase()}`)) {
      tags.push(`art:${slug}`);
    }
  }
  if (tags.length < 2) return query;
  let updated = query.replace(artPattern, " ");
  updated = normalizeWhitespace(updated);
  updated = `${updated} (${tags.join(" or ")})`.trim();
  return normalizeWhitespace(updated);
}

/** Function tags that create/make tokens. Used to expand "make tokens" to OR chain. */
const TOKEN_GENERATION_FUNCTION_TAGS = [
  "repeatable-token-generator",
  "repeatable-creature-tokens",
  "repeatable-artifact-tokens",
  "repeatable-noncreature-tokens",
  "young-pyromancer-ability",
  "create-multiple-tokens",
  "creates-token-of-a-card",
  "creates-oracle-token",
  "creates-card-token",
  "create-land-tokens",
] as const;

function normalizeTokenGenerationIntent(
  naturalQuery: string,
  query: string,
  tagContext?: TaggerTagContext
): string {
  const wantsTokenGeneration =
    /\b(?:make|create|generat|produc)(?:e|es|ed|ing)?\s+tokens?\b|\btoken\s+makers?\b|\btoken\s+generators?\b|\bcards?\s+that\s+(?:make|create)\s+tokens?\b/i.test(
      naturalQuery
    );
  if (!wantsTokenGeneration) {
    return query;
  }

  const availableTags = tagContext?.function?.map((t) => t.toLowerCase()) || [];
  let eligibleTags = TOKEN_GENERATION_FUNCTION_TAGS.filter((tag) =>
    availableTags.includes(tag.toLowerCase())
  );
  if (eligibleTags.length <= 1) {
    return query;
  }

  // When the user asks for a specific token type, exclude tags that produce other types.
  const wantsCreatureTokens =
    /\bcreature\s+tokens?\b|\btoken\s+creatures?\b/i.test(naturalQuery);
  const wantsArtifactTokens =
    /\b(?:artifact|treasure|food|clue|gold|blood|map|junk)\s+tokens?\b|\btoken\s+(?:artifact|treasure|food|clue)s?\b/i.test(naturalQuery);
  const wantsLandTokens =
    /\bland\s+tokens?\b|\btoken\s+lands?\b/i.test(naturalQuery);
  const wantsNoncreatureTokens =
    /\bnon-?creature\s+tokens?\b|\btoken\s+non-?creatures?\b/i.test(naturalQuery);

  type TagName = typeof TOKEN_GENERATION_FUNCTION_TAGS[number];
  let tagsToExclude: Set<TagName> | null = null;

  if (wantsCreatureTokens && !wantsArtifactTokens && !wantsLandTokens) {
    tagsToExclude = new Set<TagName>([
      "repeatable-token-generator",
      "repeatable-artifact-tokens",
      "repeatable-noncreature-tokens",
      "create-land-tokens",
    ]);
  } else if (wantsLandTokens && !wantsCreatureTokens && !wantsArtifactTokens) {
    tagsToExclude = new Set<TagName>([
      "repeatable-token-generator",
      "repeatable-creature-tokens",
      "repeatable-artifact-tokens",
      "repeatable-noncreature-tokens",
      "young-pyromancer-ability",
      "creates-token-of-a-card",
      "creates-oracle-token",
      "creates-card-token",
    ]);
  } else if (wantsArtifactTokens && !wantsCreatureTokens && !wantsLandTokens) {
    tagsToExclude = new Set<TagName>([
      "repeatable-token-generator",
      "repeatable-creature-tokens",
      "repeatable-noncreature-tokens",
      "create-land-tokens",
      "young-pyromancer-ability",
      "creates-token-of-a-card",
      "creates-oracle-token",
      "creates-card-token",
    ]);
  } else if (wantsNoncreatureTokens && !wantsCreatureTokens) {
    tagsToExclude = new Set<TagName>([
      "repeatable-token-generator",
      "repeatable-creature-tokens",
      "young-pyromancer-ability",
    ]);
  }

  if (tagsToExclude) {
    const narrowed = eligibleTags.filter((tag) => !(tagsToExclude as Set<TagName>).has(tag));
    if (narrowed.length > 0) eligibleTags = narrowed;
  }

  const orChain = `(${eligibleTags.map((t) => `function:${t}`).join(" or ")})`;

  let updated = query;
  const hasAnyTokenTag = TOKEN_GENERATION_FUNCTION_TAGS.some((tag) =>
    new RegExp(`\\bfunction:${escapeRegex(tag)}\\b`, "i").test(updated)
  );
  if (!hasAnyTokenTag) {
    return query;
  }

  for (const tag of TOKEN_GENERATION_FUNCTION_TAGS) {
    updated = updated.replace(
      new RegExp(`\\s*-?function:${escapeRegex(tag)}\\b`, "gi"),
      " "
    );
  }

  updated = `${updated.trim()} ${orChain}`.trim();
  return normalizeWhitespace(updated);
}

function stripFranchiseCreatureTypeConfusion(
  naturalQuery: string,
  query: string
): string {
  const isAvatarFranchise =
    /\bavatar\s+the\s+last\s+airbender\b|\bairbender\b|\blikes\s+avatar\b|\bfrom\s+avatar\b/i.test(
      naturalQuery
    );
  if (!isAvatarFranchise) return query;
  const updated = query.replace(/\s*-?t:avatar\b/gi, " ");
  return normalizeWhitespace(updated);
}

function stripSubjectiveQualifierTags(
  naturalQuery: string,
  query: string
): string {
  const hasSubjectiveQualifier =
    /\b(easy|simple|accessible|beginner|new\s+player|for\s+(?:a\s+)?new\s+player)\b/i.test(
      naturalQuery
    );
  if (!hasSubjectiveQualifier) {
    return query;
  }
  const updated = query.replace(
    /\s*-?function:any-player-ability\b/gi,
    " "
  );
  return normalizeWhitespace(updated);
}

/**
 * Phase 2 sometimes emits o:casual / o:fun / o:play when the user means table
 * meta ("casual commander pod"), not oracle text. Those AND together and
 * usually return zero hits. Strip them when the natural language is clearly
 * playgroup / format talk; always strip o:casual (almost never a real search axis).
 */
function stripPlaygroupMetaOracleFilters(
  naturalQuery: string,
  query: string
): string {
  const playgroupTalk =
    /\b(?:casual|cedh|kitchen\s*table|low\s*power|precon|pre-con)\b/i.test(
      naturalQuery
    ) &&
    /\b(?:commander|edh|pod|meta|table|group)\b/i.test(naturalQuery);
  let updated = query.replace(/\s*-?o:casual\b/gi, " ");
  if (playgroupTalk) {
    updated = updated.replace(/\s*-?o:fun\b/gi, " ");
    updated = updated.replace(/\s*-?o:play\b/gi, " ");
  }
  return normalizeWhitespace(updated);
}

/**
 * Phase 2 may emit o:combo / o:"combo with" when the user means synergy
 * ("combos with mana dorks"), not oracle text containing the word "combo".
 * Those AND with other o: filters and usually return zero hits.
 */
function stripColloquialComboOracleFilters(
  naturalQuery: string,
  query: string
): string {
  if (!/\bo:combo\b|o:"combo/i.test(query)) {
    return query;
  }
  const synergyTalk =
    /\bcombos?\s+with\b/i.test(naturalQuery) ||
    /\b(?:stuff|things|cards)\s+that\s+.*\bcombo/i.test(naturalQuery) ||
    /\bshenanigans\b/i.test(naturalQuery) ||
    /\b(?:synergy|synergizes?|pairs?\s+with|works?\s+with)\b/i.test(
      naturalQuery
    );
  if (!synergyTalk) {
    return query;
  }
  let updated = query.replace(/\s*-?o:combo\b/gi, " ");
  updated = updated.replace(/\s*-?o:"combo\s+with"/gi, " ");
  updated = updated.replace(/\s*-?o:'combo\s+with'/gi, " ");
  updated = updated.replace(/\s*-?o:"combos\s+with"/gi, " ");
  return normalizeWhitespace(updated);
}

function normalizeBounceCounterspellOr(naturalQuery: string, query: string): string {
  const wantsBounce = /\bbounce\b/i.test(naturalQuery);
  const wantsCounter = /\bcounter\s*spells?\b|\bcounterspells?\b/i.test(naturalQuery);
  const wantsEither = /\b(either|or)\b/i.test(naturalQuery);

  if (!wantsBounce || !wantsCounter || !wantsEither) {
    return query;
  }

  let updated = query;
  if (/\bfunction:counterspell-bounce\b/i.test(updated)) {
    updated = updated.replace(
      /\bfunction:counterspell-bounce\b/gi,
      "(function:bounce OR function:counterspell)"
    );
  }

  return normalizeWhitespace(updated);
}

function normalizeOrphanedOr(query: string): string {
  let updated = query;
  // Remove empty OR branches inside parentheses (case-insensitive "or").
  updated = updated.replace(/\(\s*OR\s+([^)]+)\)/gi, "($1)");
  updated = updated.replace(/\(\s*([^)]+)\s+OR\s*\)/gi, "($1)");
  // Drop parentheses that only contain ORs, e.g. rogue "(or)" from empty OR-merge slots.
  updated = updated.replace(/\(\s*(?:OR\s*)+\)/gi, "");
  updated = updated.replace(/\(\s*or\s*\)/gi, "");
  // Unwrap redundant single-member groups left after a sibling was stripped from an
  // OR-chain (e.g. "(function:zombie-lord)" ← "(function:zombie-lord or function:anthem)").
  // In Scryfall, parens around one space-free token add nothing; preserve any leading "-".
  updated = updated.replace(/(^|\s)(-?)\(\s*(-?[^\s()]+)\s*\)/g, "$1$2$3");
  // Collapse repeated OR tokens that can be introduced by removals.
  updated = updated.replace(/\bOR(?:\s+OR)+\b/gi, "OR");
  updated = updated.replace(/\bor(?:\s+or)+\b/gi, "or");
  return normalizeWhitespace(updated);
}

function pickLandTutorTag(
  naturalQuery: string,
  tagContext?: TaggerTagContext
): string | null {
  if (!tagContext?.function || tagContext.function.length === 0) {
    return null;
  }

  const query = naturalQuery.toLowerCase();
  if (!/\btutor\b/.test(query) || !/\blands?\b/.test(query)) {
    return null;
  }

  const candidates = tagContext.function.filter((tag) => {
    const lower = tag.toLowerCase();
    return lower.includes("tutor") && lower.includes("land");
  });

  if (candidates.length === 0) {
    return null;
  }

  const landTypes = ["forest", "island", "mountain", "plains", "swamp", "gate", "desert", "cave"];
  const keywords = [
    { word: "basic", weight: 2 },
    { word: "any", weight: 1 },
    { word: "snow", weight: 1 },
  ];

  let bestLand = candidates[0];
  let bestScore = -1;

  for (const tag of candidates) {
    const lower = tag.toLowerCase();
    let score = 0;

    for (const entry of keywords) {
      if (query.includes(entry.word) && lower.includes(entry.word)) {
        score += entry.weight;
      }
    }

    for (const landType of landTypes) {
      if (query.includes(landType) && lower.includes(landType)) {
        score += 2;
      }
    }

    if (score > bestScore || (score === bestScore && tag.length < bestLand.length)) {
      bestLand = tag;
      bestScore = score;
    }
  }

  return bestLand;
}

export function finalizeScryfallQuery(args: {
  naturalQuery: string;
  rawQuery: string;
  tagContext?: TaggerTagContext;
  maxLength?: number;
}): string {
  const {
    naturalQuery,
    rawQuery,
    tagContext,
    maxLength = EFFECTIVE_MAX_QUERY_LENGTH,
  } = args;

  // Clean up any markdown code blocks if the model adds them
  const cleanedQuery = rawQuery
    .replace(/^```[\w]*\n?/g, "")
    .replace(/```$/g, "")
    .trim();
  let normalizedQuery = normalizeFormatFunctionTags(cleanedQuery);

  const landTutorTag = pickLandTutorTag(naturalQuery, tagContext);
  if (landTutorTag) {
    if (/\bfunction:tutor\b(?!-)/i.test(normalizedQuery)) {
      normalizedQuery = normalizedQuery.replace(
        /\bfunction:tutor\b(?!-)/gi,
        `function:${landTutorTag}`
      );
    }

    const toHandTag =
      tagContext?.function.find((tag) => tag === "tutor-to-hand") ||
      tagContext?.function.find((tag) => tag === "tutor-hand");
    const toBattlefieldTag = tagContext?.function.find(
      (tag) => tag === "tutor-to-battlefield"
    );

    const wantsHand = /\bhand\b/i.test(naturalQuery);
    const wantsBattlefield = /\b(battlefield|into play|onto the battlefield)\b/i.test(
      naturalQuery
    );
    const hasOr = /\bor\b/i.test(normalizedQuery);

    if (wantsHand && toHandTag) {
      const hasLandTag = new RegExp(`\\bfunction:${landTutorTag}\\b`, "i").test(
        normalizedQuery
      );
      const hasToHandTag = new RegExp(`\\bfunction:${toHandTag}\\b`, "i").test(
        normalizedQuery
      );
      if (hasOr || !hasLandTag || !hasToHandTag) {
        const additions: string[] = [];
        if (!hasLandTag) {
          additions.push(`function:${landTutorTag}`);
        }
        if (!hasToHandTag) {
          additions.push(`function:${toHandTag}`);
        }
        if (additions.length > 0) {
          normalizedQuery = `${normalizedQuery} ${additions.join(" ")}`.trim();
        }
      }
    } else if (wantsBattlefield && toBattlefieldTag) {
      const hasLandTag = new RegExp(`\\bfunction:${landTutorTag}\\b`, "i").test(
        normalizedQuery
      );
      const hasToBattlefieldTag = new RegExp(
        `\\bfunction:${toBattlefieldTag}\\b`,
        "i"
      ).test(normalizedQuery);
      if (hasOr || !hasLandTag || !hasToBattlefieldTag) {
        const additions: string[] = [];
        if (!hasLandTag) {
          additions.push(`function:${landTutorTag}`);
        }
        if (!hasToBattlefieldTag) {
          additions.push(`function:${toBattlefieldTag}`);
        }
        if (additions.length > 0) {
          normalizedQuery = `${normalizedQuery} ${additions.join(" ")}`.trim();
        }
      }
    }
  }

  normalizedQuery = normalizeManaCostSymbolIntent(naturalQuery, normalizedQuery);
  normalizedQuery = normalizeGameChangerIntent(naturalQuery, normalizedQuery);
  normalizedQuery = removeFormatLegalityWhenBannedOrRestricted(normalizedQuery);
  normalizedQuery = normalizeCommanderIdentity(normalizedQuery);
  normalizedQuery = normalizeInstantSorceryTypeChain(normalizedQuery);
  normalizedQuery = normalizeTokenGenerationIntent(
    naturalQuery,
    normalizedQuery,
    tagContext
  );
  normalizedQuery = normalizeArtIntent(naturalQuery, normalizedQuery, tagContext);
  normalizedQuery = normalizeArtTagsToOrChain(normalizedQuery);
  normalizedQuery = normalizeBounceCounterspellOr(naturalQuery, normalizedQuery);
  normalizedQuery = quoteOracleTextPhrases(normalizedQuery);
  normalizedQuery = normalizeOrphanedOr(normalizedQuery);
  // normalizeEtbOracleText removed: the blanket o:"enters the battlefield" → o:"~ enters"
  // rewrite was incorrect for trigger queries (e.g. "whenever a creature enters or leaves").
  // Phase 1 now emits function:etb-other-creature directly for the other-ETB case.
  normalizedQuery = stripFranchiseCreatureTypeConfusion(
    naturalQuery,
    normalizedQuery
  );
  normalizedQuery = stripSubjectiveQualifierTags(naturalQuery, normalizedQuery);
  normalizedQuery = stripPlaygroupMetaOracleFilters(
    naturalQuery,
    normalizedQuery
  );
  normalizedQuery = stripColloquialComboOracleFilters(
    naturalQuery,
    normalizedQuery
  );
  normalizedQuery = normalizeLeadingStrayToken(normalizedQuery);
  normalizedQuery = dedupeTokens(normalizedQuery);
  // Second pass: dedupeTokens preserves "(", "or", ")" triples; strip empty (or) groups again.
  normalizedQuery = normalizeOrphanedOr(normalizedQuery);
  // is:commander (and siblings) already imply type/supertype — drop redundant filters.
  normalizedQuery = stripRedundantTypesForCommanderEligible(normalizedQuery);

  if (!normalizedQuery) {
    throw new Error("Failed to generate Scryfall query (empty response)");
  }

  const balanced = balanceScryfallQuery(normalizedQuery);
  if (balanced !== normalizedQuery) {
    console.warn(`[Finalize] Repaired unbalanced query: "${normalizedQuery}" → "${balanced}"`);
  }
  return truncateScryfallQuery(balanced, maxLength);
}

/**
 * Quotes a value for a Scryfall field (name:, o:, a:…). Scryfall has no escape inside "…" but
 * accepts '…' as a delimiter, so a value holding a double quote (Henzie "Toolbox" Torre) is
 * single-quoted. A value holding both kinds (no known card) loses its double quotes.
 */
export function quoteScryfallValue(value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/"/g, "")}"`;
}

/**
 * Repairs grouping structure: unmatched ")" are dropped, an unterminated quote or /regex/ is
 * closed, and missing ")" are appended. Parens inside "…", '…' and /…/ values are content, not
 * grouping (B.F.M. (Big Furry Monster)). A ' or / only opens a value right after an operator
 * (o:'…', o:/…/) — anywhere else it is an apostrophe or a slash.
 */
export function balanceScryfallQuery(query: string): string {
  const { out, closer, depth } = scanScryfallQuery(query);
  return out + (closer ?? "") + ")".repeat(depth);
}

/** One pass over the query's grouping structure; see balanceScryfallQuery for the rules. */
function scanScryfallQuery(query: string) {
  let out = "";
  let depth = 0;
  let closer: string | null = null;
  let valueStart = -1; // index in `query` of the delimiter that opened the current value
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (closer) {
      out += ch;
      if (ch === "\\" && closer === "/" && i + 1 < query.length) out += query[++i];
      else if (ch === closer) closer = null;
      continue;
    }
    if (ch === '"' || ((ch === "'" || ch === "/") && /[:=<>!]/.test(query[i - 1] ?? ""))) {
      closer = ch;
      valueStart = i;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      if (depth === 0) continue;
      depth--;
    }
    out += ch;
  }
  return { out, closer, depth, valueStart: closer ? valueStart : -1 };
}

/**
 * Truncates a Scryfall query to `maxLength` at a clause boundary: cuts at the last space, drops a
 * clause whose quoted/regex value the cut split (a half phrase means something else; a half regex
 * is invalid), drops a dangling `or`/`and`/`(`/`-`, then re-balances any open group.
 */
export function truncateScryfallQuery(
  query: string,
  maxLength: number = MAX_SCRYFALL_QUERY_LENGTH
): string {
  if (query.length <= maxLength) {
    return query;
  }

  let cut = query.slice(0, maxLength);
  for (;;) {
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > 0) cut = cut.slice(0, lastSpace);
    const { valueStart } = scanScryfallQuery(cut);
    if (valueStart >= 0) cut = cut.slice(0, Math.max(0, cut.lastIndexOf(" ", valueStart)));
    cut = cut.replace(/(?:\s+(?:or|and)|[\s(-])+$/i, "");
    const balanced = balanceScryfallQuery(cut);
    if (balanced.length <= maxLength || !cut) return balanced;
    // Closing the cut added characters — shorten by that much and cut again.
    cut = cut.slice(0, cut.length - (balanced.length - maxLength));
  }
}

/**
 * Checks if a query looks like a Scryfall query (contains operators like :, t:, c:, art:, etc.)
 * Only matches actual Scryfall operators, not just any word followed by a colon
 */
export function isScryfallQuery(query: string): boolean {
  const trimmed = query.trim();

  // List of known Scryfall operators (common ones)
  // These must be complete words immediately followed by a colon
  // This ensures "function tag:" doesn't match, but "function:" does
  const scryfallOperators = [
    "t:",
    "type:",
    "c:",
    "color:",
    "cmc:",
    "mana:",
    "m:",
    "power:",
    "p:",
    "toughness:",
    "loyalty:",
    "oracle:",
    "o:",
    "kw:",
    "keyword:",
    "art:",
    "atag:",
    "arttag:",
    "function:",
    "otag:",
    "oracletag:",
    "set:",
    "s:",
    "rarity:",
    "r:",
    "is:",
    "in:",
    "not:",
    "format:",
    "game:",
    "border:",
    "frame:",
    "lang:",
    "foil:",
    "promo:",
    "date:",
    "year:",
    "artist:",
    "watermark:",
    "banned:",
    "legal:",
    "id:",
    "id=",
    "name:",
    "number:",
    "block:",
    "set-type:",
  ];

  // Check if the query contains any Scryfall operator
  // Pattern: word boundary + operator word + colon (colon must immediately follow the word)
  // This ensures "function tag:" doesn't match because there's a space before "tag:"
  for (const operator of scryfallOperators) {
    // Escape special regex characters in the operator
    const escapedOperator = escapeRegex(operator);
    // Match: word boundary + operator (colon must immediately follow, no space)
    const pattern = new RegExp(`\\b${escapedOperator}`, "i");
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}
