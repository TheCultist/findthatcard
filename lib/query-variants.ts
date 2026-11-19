/**
 * Variants of one query chip: the other operators, values or fields that make sense for that
 * term, each with the Scryfall syntax it writes, what it changes, and the full rewritten query.
 * Shared by the chip menu on the results page and the part-by-part list on /explain, so both
 * teach the same syntax. Pure: no network, never throws.
 *
 * Covered: the numeric fields (mv, pow, tou, loy, def, year, usd, eur, tix), color and color
 * identity (c:, id:), rarity, format legality (f:/legal:/banned:/restricted:), is:/not: flags,
 * game:, the result options order:/direction:/unique:, and the connectives `and`/`or`. Every term
 * chip can also be negated or removed, and a parenthesis chip negates or removes its group. Add a
 * builder to VARIANT_BUILDERS to cover another field.
 *
 * t:, kw: and set: chips additionally offer values from the app's cached Scryfall catalogs:
 * `catalogKindOf` says which catalog a chip reads from, and `applyCatalogSelection` rewrites the
 * query for one or more picked values (several become a parenthesized OR group). The catalog
 * contents themselves are fetched by the UI from the app's own cache routes, never from Scryfall.
 */

import {
  COLOR_NAMES,
  FIELD_ALIASES,
  FORMAT_NAMES,
  IS_FLAG_NAMES,
  RARITY_NAMES,
  type QueryToken,
} from "@/lib/query-tokens";
import {
  formatTerm,
  parseQuery,
  parseTerm,
  printQuery,
  pruneQuery,
  walkQuery,
  type QueryNode,
  type QueryOperator,
  type QueryTerm,
} from "@/lib/scryfall/query-ast";

export type QueryVariant = {
  /** The term as Scryfall reads it, e.g. "mv>4" (keeps a leading "-"). */
  clause: string;
  /** Short name of the option, e.g. "Greater than". */
  label: string;
  /** What choosing it changes, in one or two sentences. */
  description: string;
  /** The whole query with this chip replaced by `clause`. */
  query: string;
  /** True for the option the chip already uses. */
  current: boolean;
};

export type QueryVariantGroup = {
  /** "Comparison", "Format", "Legality", … */
  title: string;
  variants: QueryVariant[];
};

/** A variant before the query is rewritten. */
type Candidate = { term: QueryTerm; label: string; description: string; current: boolean };

type Builder = (term: QueryTerm, written: string) => Array<{ title: string; candidates: Candidate[] }>;

const NUMERIC_RE = /^\d+(\.\d+)?$/;
const COLOR_LETTERS_RE = /^[wubrg]+$/i;

const canonicalField = (field: string): string => FIELD_ALIASES[field.toLowerCase()] ?? field.toLowerCase();

const withOperator = (term: QueryTerm, operator: QueryOperator): QueryTerm => ({ ...term, operator });
const withValue = (term: QueryTerm, value: string): QueryTerm => ({ ...term, value });
const withField = (term: QueryTerm, field: string): QueryTerm => ({ ...term, field });

// ---------------------------------------------------------------------------
// Numeric fields: mv, pow, tou, loy, def, year, usd, eur, tix
// ---------------------------------------------------------------------------

const NUMERIC_COMPARISONS: ReadonlyArray<{
  op: QueryOperator;
  label: string;
  describe: (noun: string, value: string) => string;
}> = [
  { op: "=", label: "Exactly", describe: (noun, v) => `Only cards whose ${noun} is ${v}.` },
  {
    op: ":",
    label: "Exactly (shorthand)",
    describe: (noun, v) => `Same as =${v}: on a number, the colon means "exactly ${v}" too.`,
  },
  { op: "!=", label: "Not", describe: (noun, v) => `Every ${noun} except ${v}.` },
  { op: "<", label: "Less than", describe: (noun, v) => `${capitalize(noun)} below ${v}; ${v} itself is out.` },
  { op: "<=", label: "At most", describe: (noun, v) => `${capitalize(noun)} of ${v} or lower.` },
  { op: ">", label: "Greater than", describe: (noun, v) => `${capitalize(noun)} above ${v}; ${v} itself is out.` },
  { op: ">=", label: "At least", describe: (noun, v) => `${capitalize(noun)} of ${v} or higher.` },
];

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Comparison operators for a numeric field, e.g. mana value, power, loyalty. */
function numericComparisons(term: QueryTerm, noun: string): Candidate[] {
  if (!NUMERIC_RE.test(term.value)) return [];
  return NUMERIC_COMPARISONS.map(({ op, label, describe }) => ({
    term: withOperator(term, op),
    label,
    description: describe(noun, term.value),
    current: term.operator === op,
  }));
}

/** The noun each numeric field compares, after "cards whose … is". */
const NUMERIC_NOUNS: Record<string, string> = {
  mv: "mana value",
  power: "power",
  toughness: "toughness",
  loyalty: "starting loyalty",
  def: "defense",
  year: "release year",
  usd: "USD price",
  eur: "EUR price",
  tix: "MTGO ticket price",
};

/** Comparators only; e.g. pow>=4, year<2000, usd<=1. Values like `*` or `tou` get no menu. */
const buildNumeric: Builder = (term, written) => {
  const noun = NUMERIC_NOUNS[canonicalField(written)];
  if (!noun) return [];
  const comparisons = numericComparisons(term, noun);
  return comparisons.length > 0 ? [{ title: "Comparison", candidates: comparisons }] : [];
};

const buildManaValue: Builder = (term) => {
  const groups: Array<{ title: string; candidates: Candidate[] }> = [];
  const comparisons = numericComparisons(term, "mana value");
  if (comparisons.length > 0) groups.push({ title: "Comparison", candidates: comparisons });

  const parity = term.value.toLowerCase();
  const parityOps: QueryOperator[] = [":", "="];
  const parityTerm = parityOps.includes(term.operator ?? ":") ? term : withOperator(term, ":");
  groups.push({
    title: "Value",
    candidates: [
      {
        term: withValue(parityTerm, "even"),
        label: "Even",
        description: "Cards with an even mana value (0, 2, 4, …). Only works with : or =.",
        current: parity === "even",
      },
      {
        term: withValue(parityTerm, "odd"),
        label: "Odd",
        description: "Cards with an odd mana value (1, 3, 5, …). Only works with : or =.",
        current: parity === "odd",
      },
    ],
  });
  return groups;
};

// ---------------------------------------------------------------------------
// Color identity: id / identity / ci / commander
// ---------------------------------------------------------------------------

const WUBRG = "wubrg";
const sortWubrg = (letters: string) =>
  [...new Set(letters.toLowerCase())].sort((a, b) => WUBRG.indexOf(a) - WUBRG.indexOf(b)).join("");

/** "Esper" for wub, "Red" for r; falls back to the value as written. */
function colorName(value: string): string | undefined {
  const v = value.toLowerCase();
  if (COLOR_LETTERS_RE.test(v)) return (COLOR_NAMES[sortWubrg(v)] ?? v.toUpperCase()).split(" (")[0];
  const named = Object.entries(COLOR_NAMES).find(([, name]) => name.split(" (")[0].toLowerCase() === v);
  return named ? named[1].split(" (")[0] : undefined;
}

const IDENTITY_COMPARISONS: ReadonlyArray<{
  op: QueryOperator;
  label: string;
  describe: (name: string) => string;
}> = [
  {
    op: ":",
    label: "Fits in",
    describe: (n) => `Cards you can play in a ${n} deck: their identity is ${n} or any part of it. Scryfall reads id: as id<=.`,
  },
  { op: "<=", label: "Within", describe: (n) => `Same as id: — identity is ${n} or a subset of it.` },
  { op: "=", label: "Exactly", describe: (n) => `Identity is exactly ${n}: no color missing, none added.` },
  {
    op: "<",
    label: "Strictly within",
    describe: (n) => `Identity uses only some of ${n}'s colors, never all of them.`,
  },
  { op: ">=", label: "Includes", describe: (n) => `Identity contains all of ${n}, possibly with more colors.` },
  { op: ">", label: "More than", describe: (n) => `Identity contains all of ${n} plus at least one other color.` },
  { op: "!=", label: "Not exactly", describe: (n) => `Any identity except exactly ${n}.` },
];

const COLOR_COMPARISONS: ReadonlyArray<{
  op: QueryOperator;
  label: string;
  describe: (name: string, multi: boolean) => string;
}> = [
  {
    op: ":",
    label: "Includes",
    describe: (n, multi) =>
      multi
        ? `Cards that are ${n} and possibly more colors: all of these colors must be present. Scryfall reads c: as c>=.`
        : `Cards that are ${n}, including multicolor cards that are also something else. Scryfall reads c: as c>=.`,
  },
  { op: ">=", label: "Includes (explicit)", describe: (n) => `Same as c: — the card has every color of ${n}, maybe more.` },
  {
    op: "=",
    label: "Exactly",
    describe: (n, multi) => (multi ? `Exactly ${n}: those colors and no others.` : `Mono-${n.toLowerCase()} cards only.`),
  },
  { op: "<=", label: "Within", describe: (n) => `Only colors from ${n}: fewer colors is fine, and colorless cards count too.` },
  { op: "<", label: "Strictly within", describe: (n) => `Some of ${n}'s colors but never all of them; colorless cards count too.` },
  { op: ">", label: "More than", describe: (n) => `All of ${n} plus at least one other color.` },
  { op: "!=", label: "Not exactly", describe: (n) => `Any colors except exactly ${n}.` },
];

/** The c: ↔ id: swap, with the current field marked. */
const colorFieldGroup = (term: QueryTerm, current: "c" | "id") => ({
  title: "Field",
  candidates: [
    {
      term: current === "c" ? term : withField(term, "c"),
      label: "Color",
      description:
        "Only the card's own colors, from its mana cost or color indicator. A land or a colorless artifact with a colored ability does not count.",
      current: current === "c",
    },
    {
      term: current === "id" ? term : withField(term, "id"),
      label: "Color identity",
      description: "Every color on the card or in its rules text, including activation costs. What Commander uses.",
      current: current === "id",
    },
  ],
});

const buildColorIdentity: Builder = (term) => {
  const name = colorName(term.value);
  const v = term.value.toLowerCase();
  if (!name || v === "c" || v === "colorless") return [];
  return [
    {
      title: "Comparison",
      candidates: IDENTITY_COMPARISONS.map(({ op, label, describe }) => ({
        term: withOperator(term, op),
        label,
        description: describe(name),
        current: term.operator === op,
      })),
    },
    colorFieldGroup(term, "id"),
  ];
};

const buildColor: Builder = (term) => {
  const name = colorName(term.value);
  const v = term.value.toLowerCase();
  if (!name || v === "c" || v === "colorless" || v === "m" || v === "multicolor") return [];
  const multi = COLOR_LETTERS_RE.test(v) ? new Set(v).size > 1 : !["white", "blue", "black", "red", "green"].includes(v);
  return [
    {
      title: "Comparison",
      candidates: COLOR_COMPARISONS.map(({ op, label, describe }) => ({
        term: withOperator(term, op),
        label,
        description: describe(name, multi),
        current: term.operator === op,
      })),
    },
    colorFieldGroup(term, "c"),
  ];
};

// ---------------------------------------------------------------------------
// Rarity: r / rarity
// ---------------------------------------------------------------------------

/** Scryfall orders rarities for < and >: common < uncommon < rare < mythic. */
const RARITY_ORDER = ["common", "uncommon", "rare", "mythic"] as const;
const RARITY_LONG: Record<string, string> = { c: "common", u: "uncommon", r: "rare", m: "mythic" };

const buildRarity: Builder = (term) => {
  const v = term.value.toLowerCase();
  const long = RARITY_LONG[v] ?? v;
  const name = RARITY_NAMES[v];
  const groups: Array<{ title: string; candidates: Candidate[] }> = [];

  if ((RARITY_ORDER as readonly string[]).includes(long)) {
    const rank = RARITY_ORDER.indexOf(long as (typeof RARITY_ORDER)[number]);
    const rarer = RARITY_ORDER.slice(rank + 1).map((r) => RARITY_NAMES[r]);
    const commoner = RARITY_ORDER.slice(0, rank).map((r) => RARITY_NAMES[r]);
    const list = (names: string[]) => (names.length ? names.join(", ") : "nothing");
    const comparisons: Array<{ op: QueryOperator; label: string; description: string }> = [
      { op: ":", label: "Exactly", description: `Only ${name} cards.` },
      { op: "=", label: "Exactly (explicit)", description: `Same as r:${term.value} — only ${name} cards.` },
      { op: "!=", label: "Not", description: `Every rarity except ${name}.` },
      { op: ">", label: "Rarer than", description: `Rarer than ${name}: ${list(rarer)}.` },
      { op: ">=", label: "At least", description: `${name} or rarer: ${list([name!, ...rarer])}.` },
      { op: "<", label: "More common than", description: `More common than ${name}: ${list(commoner)}.` },
      { op: "<=", label: "At most", description: `${name} or more common: ${list([...commoner, name!])}.` },
    ];
    groups.push({
      title: "Comparison",
      candidates: comparisons.map((c) => ({
        term: withOperator(term, c.op),
        label: c.label,
        description: c.description,
        current: term.operator === c.op,
      })),
    });
  }

  groups.push({
    title: "Rarity",
    candidates: [...RARITY_ORDER, "special", "bonus"].map((slug) => ({
      term: withValue(term, slug),
      label: RARITY_NAMES[slug] ?? slug,
      description:
        slug === "special"
          ? "Timeshifted and other special-rarity printings."
          : slug === "bonus"
            ? "Bonus-sheet printings, such as The List or Mystical Archive."
            : `${RARITY_NAMES[slug]} printings.`,
      current: long === slug,
    })),
  });
  return groups;
};

// ---------------------------------------------------------------------------
// Property flags: is / not
// ---------------------------------------------------------------------------

const buildFlag: Builder = (term, written) => {
  const canonical = canonicalField(written);
  const v = term.value.toLowerCase();
  const flag = IS_FLAG_NAMES[v] ?? v;
  return [
    {
      title: "Field",
      candidates: [
        {
          term: canonical === "is" ? term : withField(term, "is"),
          label: "Must be",
          description: `Only cards that are ${flag}.`,
          current: canonical === "is",
        },
        {
          term: canonical === "not" ? term : withField(term, "not"),
          label: "Must not be",
          description: `Leaves out every card that is ${flag}. Same as -is:${term.value}.`,
          current: canonical === "not",
        },
      ],
    },
    {
      title: "Property",
      candidates: Object.entries(IS_FLAG_NAMES).map(([slug, name]) => ({
        term: withValue(term, slug),
        label: slug,
        description: canonical === "not" ? `Cards that are not ${name}.` : `Cards that are ${name}.`,
        current: v === slug,
      })),
    },
  ];
};

// ---------------------------------------------------------------------------
// Fixed value lists: game, order, direction, unique
// ---------------------------------------------------------------------------

type ValueList = { title: string; values: ReadonlyArray<{ value: string; label: string; description: string }> };

const VALUE_LISTS: Record<string, ValueList> = {
  game: {
    title: "Platform",
    values: [
      { value: "paper", label: "Paper", description: "Cards printed physically." },
      { value: "arena", label: "MTG Arena", description: "Cards available on MTG Arena, including Alchemy rebalances." },
      { value: "mtgo", label: "Magic Online", description: "Cards available on Magic Online." },
    ],
  },
  order: {
    title: "Sort by",
    values: [
      { value: "name", label: "Name", description: "Alphabetical by card name. Scryfall's default." },
      { value: "set", label: "Set", description: "By set, then collector number." },
      { value: "released", label: "Release date", description: "By the printing's release date." },
      { value: "rarity", label: "Rarity", description: "Common to mythic." },
      { value: "color", label: "Color", description: "By color, then color identity." },
      { value: "cmc", label: "Mana value", description: "By mana value." },
      { value: "power", label: "Power", description: "By creature power." },
      { value: "toughness", label: "Toughness", description: "By creature toughness." },
      { value: "usd", label: "Price (USD)", description: "By US-dollar price." },
      { value: "eur", label: "Price (EUR)", description: "By euro price." },
      { value: "tix", label: "Price (TIX)", description: "By Magic Online ticket price." },
      { value: "edhrec", label: "EDHREC rank", description: "By popularity in Commander decks on EDHREC." },
      { value: "penny", label: "Penny rank", description: "By popularity in Penny Dreadful." },
      { value: "artist", label: "Artist", description: "Alphabetical by artist name." },
      { value: "review", label: "Set review", description: "The order a set review would use: color, then rarity." },
    ],
  },
  direction: {
    title: "Direction",
    values: [
      { value: "asc", label: "Ascending", description: "Lowest or earliest first (A to Z, cheapest first, oldest first)." },
      { value: "desc", label: "Descending", description: "Highest or latest first (Z to A, priciest first, newest first)." },
    ],
  },
  unique: {
    title: "Show",
    values: [
      { value: "cards", label: "One per card", description: "One result per card name. Scryfall's default." },
      { value: "prints", label: "Every printing", description: "Every printing of every matching card." },
      { value: "art", label: "One per artwork", description: "One result per distinct artwork." },
    ],
  },
};

const buildValueList: Builder = (term, written) => {
  const list = VALUE_LISTS[canonicalField(written)];
  if (!list) return [];
  const v = term.value.toLowerCase();
  return [
    {
      title: list.title,
      candidates: list.values.map((entry) => ({
        term: withValue(term, entry.value),
        label: entry.label,
        description: entry.description,
        current: v === entry.value,
      })),
    },
  ];
};

// ---------------------------------------------------------------------------
// Connectives: and / or
// ---------------------------------------------------------------------------

/** `or` ↔ `and`; only a written connective has a chip, so an implicit AND cannot be changed here. */
function connectiveVariants(token: QueryToken, query: string): QueryVariantGroup[] {
  const current = token.raw.toLowerCase();
  if (current !== "and" && current !== "or") return [];
  const options = [
    {
      clause: "and",
      label: "Both",
      description: "Cards must match the term on each side. This is also what a plain space between two terms means.",
    },
    {
      clause: "or",
      label: "Either",
      description: "Cards may match either side; this widens the search. Put parentheses around the pair when the query has more terms.",
    },
  ];
  const variants: QueryVariant[] = [];
  for (const option of options) {
    const next = rewrite(query, token, option.clause);
    if (!next) return [];
    variants.push({ ...option, query: next, current: option.clause === current });
  }
  return [{ title: "Connective", variants }];
}

// ---------------------------------------------------------------------------
// Format legality: f / format / legal / banned / restricted
// ---------------------------------------------------------------------------

const LEGALITY: ReadonlyArray<{ canonical: string; label: string; describe: (name: string) => string }> = [
  { canonical: "format", label: "Legal in", describe: (n) => `Cards you can play in ${n} right now; banned and restricted cards are out.` },
  { canonical: "banned", label: "Banned in", describe: (n) => `Only cards that are banned in ${n}.` },
  {
    canonical: "restricted",
    label: "Restricted in",
    describe: (n) => `Only cards limited to one copy per deck in ${n}. In practice this means Vintage.`,
  },
];

const formatName = (slug: string) => FORMAT_NAMES[slug.toLowerCase()] ?? slug;

const buildFormat: Builder = (term, written) => {
  const canonical = canonicalField(written);
  const kind = LEGALITY.find((l) => l.canonical === canonical || (l.canonical === "format" && canonical === "legal"));
  if (!kind) return [];
  const value = term.value.toLowerCase();

  const formats = Object.entries(FORMAT_NAMES).map(([slug, name]) => ({
    term: withValue(term, slug),
    label: name,
    description: kind.describe(name),
    current: slug === value,
  }));

  const legality = LEGALITY.map((l) => ({
    // Keep the alias the user wrote (f:, format:, legal:) when staying on legality.
    term: withField(term, l.canonical === "format" ? (kind.canonical === "format" ? written : "f") : l.canonical),
    label: l.label,
    description: l.describe(formatName(term.value)),
    current: l === kind,
  }));

  return [
    { title: "Format", candidates: formats },
    { title: "Legality", candidates: legality },
  ];
};

// ---------------------------------------------------------------------------
// Negate and remove (every term chip), negate and remove a group (parenthesis chips)
// ---------------------------------------------------------------------------

const FLAG_FLIP: Record<string, string> = { is: "not", not: "is" };

/** `-term`, or `is:` ↔ `not:` for a flag that is not already negated with `-`. */
function negatedTerm(term: QueryTerm): QueryTerm {
  const flip = term.field && !term.negated ? FLAG_FLIP[canonicalField(term.field)] : undefined;
  if (flip) {
    // Keep the case the user wrote: NOT:reprint → IS:reprint.
    const field = term.field === term.field!.toUpperCase() ? flip.toUpperCase() : flip;
    return { ...term, field };
  }
  return { ...term, negated: !term.negated };
}

/** The query without `node` (and whatever it leaves dangling); "" when nothing is left. */
function queryWithout(query: string, node: QueryNode): string {
  const parsed = parseQuery(query);
  // Nodes are compared by position: the token came from this same query, so positions match.
  const target = walkQuery(parsed.root).find((n) => n.type === node.type && n.start === node.start && n.end === node.end);
  if (!target) return "";
  return printQuery(pruneQuery(parsed, (n) => n !== target)).trim();
}

/** The tree node a chip came from: its term, or the group a `(`, `-(` or `)` belongs to. */
function nodeOfToken(token: QueryToken, query: string): QueryNode | undefined {
  const nodes = walkQuery(parseQuery(query).root);
  if (token.type === "group") {
    return nodes.find(
      (n) =>
        n.type === "group" &&
        (token.raw === ")" ? n.closed && n.end - 1 === token.start : n.start === token.start)
    );
  }
  return nodes.find((n) => n.type === "term" && n.start === token.start);
}

const removeVariant = (query: string, node: QueryNode, what: string): QueryVariant | undefined => {
  const next = queryWithout(query, node);
  if (!next) return undefined;
  return {
    clause: "",
    label: `Remove ${what}`,
    description: `Drops ${what}, along with any or, and or parentheses it would leave behind.`,
    query: next,
    current: false,
  };
};

/** Exclude/include and remove, for a field or text chip. */
function termVariants(token: QueryToken, query: string): QueryVariantGroup[] {
  const term = parseTerm(token.raw);
  if (term.raw === "-" || term.raw === "!") return [];
  const node = nodeOfToken(token, query);
  if (!node) return [];

  const negated = negatedTerm(term);
  const flipped = negated.field !== term.field;
  const clause = formatTerm(negated);
  const next = rewrite(query, token, clause);
  if (!next) return [];

  const variants: QueryVariant[] = [
    {
      clause,
      label: term.negated ? "Include" : "Exclude",
      description: term.negated
        ? "Drops the leading - so cards matching this term are included again."
        : flipped
          ? `Switches to ${negated.field}: so cards with this property are left out.`
          : "Adds a leading - so cards matching this term are left out.",
      query: next,
      current: false,
    },
  ];
  const remove = removeVariant(query, node, "this term");
  if (remove) variants.push(remove);
  return [{ title: "Term", variants }];
}

/** Negate/un-negate and remove, for a `(`, `-(` or `)` chip. */
function groupVariants(token: QueryToken, query: string): QueryVariantGroup[] {
  const node = nodeOfToken(token, query);
  if (!node || node.type !== "group") return [];

  const negated = !node.negated;
  const open = negated ? "-(" : "(";
  const toggled = negated ? `-${query.slice(node.start)}` : query.slice(node.start + 1);
  const next = query.slice(0, node.start) + toggled;

  const variants: QueryVariant[] = [
    {
      clause: open,
      label: negated ? "Exclude the group" : "Include the group",
      description: negated
        ? "Puts - in front of the parentheses so cards matching anything inside are left out."
        : "Drops the - in front of the parentheses so cards matching the group are included again.",
      query: next,
      current: false,
    },
  ];
  const remove = removeVariant(query, node, "the group");
  if (remove) variants.push(remove);
  return [{ title: "Group", variants }];
}

// ---------------------------------------------------------------------------
// Catalog value selection: t:, kw:, set:, function:
// ---------------------------------------------------------------------------

/** Which cached catalog a chip's values come from. */
export type CatalogKind = "types" | "keywords" | "sets" | "functions";

const CATALOG_FIELDS: Record<string, CatalogKind> = {
  t: "types",
  kw: "keywords",
  set: "sets",
  function: "functions",
};

/** The catalog a chip can pick values from, or undefined for chips without one. */
export function catalogKindOf(token: QueryToken): CatalogKind | undefined {
  if (token.type !== "field" || !token.field) return undefined;
  return CATALOG_FIELDS[canonicalField(token.field)];
}

/** The chip's value as a person reads it: unquoted, lower-case; for preselecting catalog rows. */
export function catalogCurrentValue(token: QueryToken): string {
  return parseTerm(token.raw).value.toLowerCase();
}

/** `value` as a term of the same field/operator as `term`, quoted only when Scryfall needs it. */
function valueTerm(term: QueryTerm, value: string, negated: boolean): QueryTerm {
  const bare = /^[\w./-]+$/.test(value);
  return {
    ...term,
    negated,
    value,
    valueKind: bare ? "bare" : "quoted",
    quote: bare ? undefined : '"',
    unterminated: undefined,
  };
}

/**
 * The query with the chip replaced by the picked catalog values: one value swaps in place, several
 * become `(f:a or f:b …)`. A negated chip keeps its exclusion — `-(f:a or f:b)` for several. ""
 * when nothing is picked or the chip does not sit where it says.
 */
export function applyCatalogSelection(token: QueryToken, query: string, values: string[]): string {
  const picked = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  if (token.type !== "field" || picked.length === 0) return "";
  const term = parseTerm(token.raw);
  if (term.field === undefined) return "";

  const clause =
    picked.length === 1
      ? formatTerm(valueTerm(term, picked[0], term.negated))
      : `${term.negated ? "-" : ""}(${picked.map((v) => formatTerm(valueTerm(term, v, false))).join(" or ")})`;
  return rewrite(query, token, clause);
}

// ---------------------------------------------------------------------------
// Registry and entry point
// ---------------------------------------------------------------------------

const VARIANT_BUILDERS: Record<string, Builder> = {
  mv: buildManaValue,
  power: buildNumeric,
  toughness: buildNumeric,
  loyalty: buildNumeric,
  def: buildNumeric,
  year: buildNumeric,
  usd: buildNumeric,
  eur: buildNumeric,
  tix: buildNumeric,
  c: buildColor,
  id: buildColorIdentity,
  rarity: buildRarity,
  format: buildFormat,
  legal: buildFormat,
  banned: buildFormat,
  restricted: buildFormat,
  is: buildFlag,
  not: buildFlag,
  game: buildValueList,
  order: buildValueList,
  direction: buildValueList,
  unique: buildValueList,
};

/** Canonical field names that have a variant menu. */
export const VARIANT_FIELDS: ReadonlySet<string> = new Set(Object.keys(VARIANT_BUILDERS));

/** Replaces the chip's text inside the query; "" when the token does not sit where it says. */
function rewrite(query: string, token: QueryToken, clause: string): string {
  const end = token.start + token.raw.length;
  if (query.slice(token.start, end) !== token.raw) return "";
  return query.slice(0, token.start) + clause + query.slice(end);
}

/**
 * The variant groups for one chip of `query`. Field chips get their field's options (operators,
 * values, field swaps) followed by Exclude/Include and Remove; text chips get only the latter;
 * `(`/`)` chips negate or remove their group; `or`/`and` chips swap. A negated chip keeps its
 * leading "-" in every field option. Group and connective chips that do not sit where they say
 * (a token from another query) get nothing.
 */
export function getTokenVariants(token: QueryToken, query: string): QueryVariantGroup[] {
  if (rewrite(query, token, token.raw) !== query) return [];
  if (token.type === "logical") return connectiveVariants(token, query);
  if (token.type === "group") return groupVariants(token, query);
  if (token.type === "text") return termVariants(token, query);

  const groups: QueryVariantGroup[] = [];
  const builder = token.field && token.value ? VARIANT_BUILDERS[canonicalField(token.field)] : undefined;
  const term = parseTerm(token.raw);
  if (builder && term.field !== undefined && !term.unterminated) {
    for (const group of builder(term, term.field)) {
      const variants: QueryVariant[] = [];
      for (const candidate of group.candidates) {
        const clause = formatTerm(candidate.term);
        variants.push({
          clause,
          label: candidate.label,
          description: term.negated
            ? `${candidate.description} The leading - still excludes these cards.`
            : candidate.description,
          query: rewrite(query, token, clause),
          current: candidate.current,
        });
      }
      if (variants.length > 0) groups.push({ title: group.title, variants });
    }
  }
  if (!term.unterminated) groups.push(...termVariants(token, query));
  return groups;
}
