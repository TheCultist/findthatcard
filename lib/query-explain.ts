/**
 * Plain-English reading of a Scryfall query for the /explain page: one summary sentence, every
 * part of the query with its explanation, and the syntax problems worth showing, attached to the
 * part that causes them. Runs in the browser; makes no AI or Scryfall call.
 */

import {
  COLOR_NAMES,
  FIELD_ALIASES,
  FORMAT_NAMES,
  getTokenMetadata,
  IS_FLAG_NAMES,
  OP_WORDS,
  RARITY_NAMES,
  tokenizeQuery,
  type TokenMetadata,
} from "@/lib/query-tokens";
import {
  isScryfallField,
  parseQuery,
  walkQuery,
  type QueryNode,
  type QueryProblemCode,
  type QueryTerm,
} from "@/lib/scryfall/query-ast";

export type ExplainWarning = {
  /** "error": Scryfall refuses the query. "warning": it still runs, maybe not as written. */
  severity: "error" | "warning";
  message: string;
  /** Index in the query where the problem starts. */
  start: number;
};

/** One chip of the query, explained. */
export type QueryPart = TokenMetadata & {
  /** How many groups this part sits inside. */
  depth: number;
  /** False when an earlier part already gave this same explanation. */
  firstMention: boolean;
  warnings: ExplainWarning[];
};

export type QueryExplanation = {
  /** One sentence; empty when the query has nothing to describe. */
  summary: string;
  /** In query order. */
  parts: QueryPart[];
  /** Every problem, errors first; each also sits on the part that causes it. */
  warnings: ExplainWarning[];
};

/** What Scryfall does with each problem (measured live). */
const PROBLEM_EFFECTS: Record<QueryProblemCode, ExplainWarning["severity"] | string> = {
  "unmatched-close": "error",
  "unclosed-group": "error",
  "exact-group": "error",
  "empty-group": "Scryfall ignores them.",
  "dangling-connective": "Scryfall ignores it.",
  "unterminated-value": "Scryfall may not read it the way you expect.",
};

/** Polarity pair: what a term says, and what it says once negated. */
type Phrase = [positive: string, negative: string];

const be = (text: string): Phrase => [`are ${text}`, `are not ${text}`];
const have = (text: string): Phrase => [`have ${text}`, `do not have ${text}`];

const RULES_FIELDS = new Set(["o", "fo", "fulloracle"]);
const ARTIST_FIELDS = new Set(["a", "artist"]);
const FLAVOR_FIELDS = new Set(["ft", "flavor", "flavour"]);
const COLOR_FIELDS = new Set(["c", "id"]);
const PLATFORMS: Record<string, string> = { paper: "in paper", arena: "on MTG Arena", mtgo: "on Magic Online" };

/** Fields compared to a number; the label reads after "have". */
const NUMERIC_LABELS: Record<string, string> = {
  mv: "mana value",
  power: "power",
  toughness: "toughness",
  loyalty: "loyalty",
  year: "a release year of",
  usd: "a USD price of",
  eur: "a EUR price of",
  tix: "a MTGO ticket price of",
};

/** Fields whose value reads straight after a label, such as "have language fr". */
const LABELED_FIELDS: Record<string, string> = {
  lang: "language",
  language: "language",
  border: "border",
  frame: "frame",
  wm: "watermark",
  watermark: "watermark",
  devotion: "devotion",
  produces: "mana production",
};

/** Search options rather than filters; each maps its value to a closing clause of the sentence. */
const MODIFIERS: Record<string, (value: string) => string> = {
  order: (value) => `sorted by ${value}`,
  direction: (value) => (/^desc/i.test(value) ? "in descending order" : "in ascending order"),
  prefer: (value) => `preferring the ${value} printing`,
  unique: (value) => `showing unique ${value}`,
  display: (value) => `displayed as ${value}`,
  include: (value) => `including ${value}`,
};

const canonical = (term: QueryTerm) => {
  const field = term.field?.toLowerCase() ?? "";
  return FIELD_ALIASES[field] ?? field;
};

const shown = (term: QueryTerm) => (term.valueKind === "regex" ? `/${term.value}/` : term.value);

/** `"value" in their <place>`, or the regex form of the same idea. */
const textPhrase = (term: QueryTerm, place: string): Phrase =>
  term.valueKind === "regex" ? have(`${place} matching ${shown(term)}`) : have(`"${term.value}" in their ${place}`);

function comparison(term: QueryTerm, label: string): Phrase {
  const operator = term.operator === "!=" ? ":" : term.operator ?? ":";
  return have(`${label} ${[OP_WORDS[operator], term.value].filter(Boolean).join(" ")}`);
}

function colorPhrase(term: QueryTerm, field: string): Phrase | undefined {
  const name = COLOR_NAMES[term.value.toLowerCase()]?.toLowerCase();
  if (!name) return undefined;
  const exact = term.operator === "=";
  if (field === "c" && (term.operator === ":" || exact || term.operator === "!=")) return be(`${exact ? "exactly " : ""}${name}`);
  return comparison({ ...term, value: name }, field === "c" ? "color" : "color identity");
}

/** Reads a term that names no field: an exact card name or words searched in the name. */
function namePhrase(term: QueryTerm): Phrase {
  return term.exact ? be(`named exactly "${term.value}"`) : textPhrase(term, "name");
}

function fieldPhrase(term: QueryTerm): Phrase {
  const raw = term.field?.toLowerCase() ?? "";
  const field = canonical(term);
  const value = term.value;
  const v = value.toLowerCase();

  if (RULES_FIELDS.has(raw)) return textPhrase(term, "rules text");
  if (FLAVOR_FIELDS.has(raw)) return textPhrase(term, "flavor text");
  if (ARTIST_FIELDS.has(raw)) return [`were illustrated by ${value}`, `were not illustrated by ${value}`];
  if (raw === "name") return textPhrase(term, "name");

  if (value) {
    if (COLOR_FIELDS.has(field)) {
      const phrase = colorPhrase(term, field);
      if (phrase) return phrase;
    }
    if (NUMERIC_LABELS[field]) return comparison(term, NUMERIC_LABELS[field]);
    if (LABELED_FIELDS[raw]) return have(`${LABELED_FIELDS[raw]} ${value}`);
    switch (field) {
      case "t":
        return be(`of type ${value}`);
      case "kw":
        return have(`the keyword ${value}`);
      case "rarity":
        return term.operator === ":" || term.operator === "="
          ? be((RARITY_NAMES[v] ?? value).toLowerCase())
          : comparison({ ...term, value: (RARITY_NAMES[v] ?? value).toLowerCase() }, "rarity");
      case "format":
      case "legal":
        return be(`legal in ${FORMAT_NAMES[v] ?? value}`);
      case "banned":
        return be(`banned in ${FORMAT_NAMES[v] ?? value}`);
      case "restricted":
        return be(`restricted in ${FORMAT_NAMES[v] ?? value}`);
      case "set":
        return be(`from set ${value.toUpperCase()}`);
      case "block":
        return be(`from block ${value.toUpperCase()}`);
      case "is":
        return be(IS_FLAG_NAMES[v] ?? value);
      case "not": {
        const [positive, negative] = be(IS_FLAG_NAMES[v] ?? value);
        return [negative, positive];
      }
      case "art":
        return have(`art tagged ${value}`);
      case "function":
        return be(`tagged ${value}`);
      case "game":
        return be(`available ${PLATFORMS[v] ?? `on ${value}`}`);
    }
  }

  const text = term.raw.replace(/^-/, "");
  return [`match ${text}`, `do not match ${text}`];
}

function describeTerm(term: QueryTerm): string {
  const phrase = term.field === undefined ? namePhrase(term) : fieldPhrase(term);
  // `-a!=b` negates twice, so the two cancel out.
  const negated = term.negated !== (term.operator === "!=");
  return phrase[negated ? 1 : 0];
}

/** `a`, `a and b`, `a, b, and c`. */
function listAll(parts: string[]): string {
  if (parts.length < 3) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

const isIgnored = (term: QueryTerm) =>
  term.raw === "!" || (term.field !== undefined && !isScryfallField(term.field));

const isModifier = (node: QueryNode) => node.type === "term" && canonical(node.term) in MODIFIERS;

/** Sentence fragment for one node; `text` already holds every child's fragment. */
function describeNode(node: QueryNode, text: Map<QueryNode, string>): string {
  switch (node.type) {
    case "term":
      // Scryfall ignores a lone `!` and unknown fields (measured live), so the sentence does too.
      return isModifier(node) || isIgnored(node.term) ? "" : describeTerm(node.term);
    case "stray":
      return "";
    case "group": {
      const inner = node.inner ? (text.get(node.inner) ?? "") : "";
      if (!inner) return "";
      if (node.negated) return `are not (cards that ${inner})`;
      return node.inner?.type === "or" && inner.includes(" or ") ? `either ${inner}` : inner;
    }
    case "and":
      return listAll(node.operands.map((operand) => text.get(operand) ?? "").filter(Boolean));
    case "or": {
      const branches = node.operands.map((operand) => text.get(operand) ?? "").filter(Boolean);
      // A comma keeps `(a b) or c` from reading as `a and (b or c)`.
      const hasList = node.operands.some((operand) => operand.type === "and");
      return branches.join(hasList ? ", or " : " or ");
    }
  }
}

function summarize(root: QueryNode | null): string {
  const order = walkQuery(root);
  const text = new Map<QueryNode, string>();
  // Children come after their parent in pre-order, so walking backwards resolves them first.
  for (let i = order.length - 1; i >= 0; i--) text.set(order[i], describeNode(order[i], text));

  const options = order.flatMap((node) =>
    node.type === "term" && isModifier(node) && node.term.value ? [MODIFIERS[canonical(node.term)](node.term.value)] : []
  );
  const filters = root ? (text.get(root) ?? "") : "";
  if (!filters && options.length === 0) return "";
  return `${[filters ? `Cards that ${filters}` : "All cards", ...options].join(", ")}.`;
}

function fieldWarnings(root: QueryNode | null): ExplainWarning[] {
  return walkQuery(root).flatMap((node): ExplainWarning[] => {
    if (node.type !== "term" || node.term.field === undefined) return [];
    const { term } = node;
    if (!isScryfallField(term.field!)) {
      return [{ severity: "warning", message: `Unknown filter "${term.field}". Scryfall ignores it.`, start: node.start }];
    }
    if (!term.value) {
      return [{ severity: "warning", message: "This has no value, so Scryfall may not read it the way you expect.", start: node.start }];
    }
    return [];
  });
}

function explainParts(query: string, warnings: ExplainWarning[]): QueryPart[] {
  const seen = new Set<string>();
  let depth = 0;
  const parts = tokenizeQuery(query).map((token): QueryPart => {
    if (token.raw === ")") depth = Math.max(0, depth - 1);
    const metadata = getTokenMetadata(token, "");
    const part = { ...metadata, depth, firstMention: !seen.has(metadata.description), warnings: [] };
    seen.add(metadata.description);
    if (token.type === "group" && token.raw !== ")") depth += 1;
    return part;
  });
  // Every problem starts at a token, so the last part starting at or before it is its part.
  for (const warning of warnings) {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].start <= warning.start) {
        parts[i].warnings.push(warning);
        break;
      }
    }
  }
  return parts;
}

/** Summary, parts and warnings for a query. Never throws. */
export function explainQuery(query: string): QueryExplanation {
  const parsed = parseQuery(query);
  const problems = parsed.problems.map(({ code, message, start }): ExplainWarning => {
    const effect = PROBLEM_EFFECTS[code];
    return effect === "error"
      ? { severity: "error", message: `${message}. Scryfall rejects this query.`, start }
      : { severity: "warning", message: `${message}. ${effect}`, start };
  });
  const found = [...problems, ...fieldWarnings(parsed.root)];
  const warnings = [...found.filter((w) => w.severity === "error"), ...found.filter((w) => w.severity === "warning")];
  return { summary: summarize(parsed.root), parts: explainParts(query, warnings), warnings };
}
