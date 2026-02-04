export type QueryTokenType = "field" | "logical" | "group" | "text";

export type QueryToken = {
  raw: string;
  type: QueryTokenType;
  field?: string;
  value?: string;
  negated?: boolean;
};

export type TokenMetadata = QueryToken & {
  title: string;
  description: string;
  reason: string;
  tip?: string;
};

const FIELD_DESCRIPTIONS: Record<
  string,
  { title: string; description: string; tip?: string }
> = {
  id: {
    title: "Color Identity (id:)",
    description: "Matches cards by their color identity.",
    tip: "Use id= if you want an exact color identity match.",
  },
  c: {
    title: "Color (c:)",
    description: "Matches card colors and color count.",
  },
  t: {
    title: "Type Line (t:)",
    description: "Matches card types and creature types.",
  },
  o: {
    title: "Oracle Text (o:)",
    description: "Matches words or phrases in Oracle rules text.",
  },
  function: {
    title: "Function Tag (function:/oracletag:)",
    description: "Matches community tags describing the card's role.",
  },
  art: {
    title: "Art/Artist Tag (art:/a:)",
    description:
      "Matches art depictions or artist names depending on the prefix; treated as synonyms here.",
  },
  format: {
    title: "Format (f:)",
    description: "Matches cards legal in a specific format.",
  },
  game: {
    title: "Game (game:)",
    description: "Matches cards available in a specific game platform.",
  },
  kw: {
    title: "Keyword (kw:)",
    description: "Matches cards with keyword abilities.",
  },
  set: {
    title: "Set (set:/s:)",
    description: "Matches cards printed in a specific set.",
  },
  block: {
    title: "Block (block:/b:)",
    description: "Matches cards printed in a specific block.",
  },
  mv: {
    title: "Mana Value (mv:)",
    description: "Matches cards by mana value.",
  },
  power: {
    title: "Power (power:/pow:)",
    description: "Matches cards by power.",
  },
  toughness: {
    title: "Toughness (toughness:/tou:)",
    description: "Matches cards by toughness.",
  },
  pt: {
    title: "Power/Toughness (pt:)",
    description: "Matches cards by power/toughness comparisons.",
  },
  loyalty: {
    title: "Loyalty (loyalty:/loy:)",
    description: "Matches planeswalkers by loyalty.",
  },
  rarity: {
    title: "Rarity (rarity:/r:)",
    description: "Matches cards by rarity.",
  },
  is: {
    title: "Flag (is:)",
    description: "Matches cards with a specific property.",
  },
  not: {
    title: "Negated Flag (not:)",
    description: "Excludes cards with a specific property.",
  },
};

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
};

const FUNCTION_TAGS: Record<
  string,
  { title: string; description: string; tip?: string }
> = {
  removal: {
    title: "Removal (function tag)",
    description:
      "This tag matches cards whose primary role is removing threats (destroy, exile, bounce, or otherwise neutralize permanents).",
    tip: "You can replace this with function:destroy if you want stricter results.",
  },
  ramp: {
    title: "Ramp (function tag)",
    description: "This tag matches cards that accelerate mana development.",
  },
  treasure: {
    title: "Treasure (function tag)",
    description: "This tag matches cards that create or reward Treasure tokens.",
  },
  sacrifice: {
    title: "Sacrifice (function tag)",
    description: "This tag matches cards that sacrifice permanents for value.",
  },
};

const OPERATOR_DESCRIPTIONS: Record<string, { title: string; description: string }> = {
  or: {
    title: "OR",
    description: "Matches cards that satisfy either side of the query.",
  },
  "(": {
    title: "Grouping",
    description: "Groups tokens so the query reads them together.",
  },
  ")": {
    title: "Grouping",
    description: "Closes a grouped expression.",
  },
};

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/\s+/g, " ")
    .trim();

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

    const fieldMatch = tokenValue.match(/^([a-z]+):(.*)$/i);
    if (fieldMatch) {
      const field = fieldMatch[1].toLowerCase();
      const valuePart = fieldMatch[2];
      tokens.push({
        raw,
        type: "field",
        field,
        value: valuePart,
        negated,
      });
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
    ];
    if (patterns.some((pattern) => normalizedSource.includes(pattern))) {
      return `Added because you asked to exclude "${token.value ?? token.raw}".`;
    }
  }

  return "Derived from your search request.";
};

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
    const canonicalField = FIELD_ALIASES[token.field ?? ""] ?? token.field;

    if (canonicalField === "function" && token.value) {
      const key = normalizeText(token.value);
      const details = FUNCTION_TAGS[key];
      if (details) {
        return {
          ...token,
          title: details.title,
          description: details.description,
          reason: buildReason(token, sourceQuery),
          tip: details.tip,
        };
      }
    }

    if (canonicalField === "game") {
      return {
        ...token,
        title: FIELD_DESCRIPTIONS.game.title,
        description: FIELD_DESCRIPTIONS.game.description,
        reason: buildReason(token, sourceQuery),
        tip:
          "Defaulted to paper. Remove this to include all platforms or change it to the platform(s) you want.",
      };
    }

    const fieldDetails = FIELD_DESCRIPTIONS[canonicalField ?? ""];
    if (fieldDetails) {
      const baseTitle = token.negated
        ? `Excluding ${token.value ?? token.field}`
        : fieldDetails.title;
      return {
        ...token,
        title: baseTitle,
        description: fieldDetails.description,
        reason: buildReason(token, sourceQuery),
        tip: fieldDetails.tip,
      };
    }

    return {
      ...token,
      title: token.negated ? `Excluding ${token.value ?? token.raw}` : "Filter",
      description: "Matches cards using a Scryfall filter.",
      reason: buildReason(token, sourceQuery),
    };
  }

  return {
    ...token,
    title: token.negated ? `Excluding ${token.raw}` : "Query Token",
    description: "This token is part of the Scryfall query.",
    reason: buildReason(token, sourceQuery),
  };
};
