/**
 * Shared Scryfall query parser.
 *
 * Lexer (`lexQuery`): splits a Scryfall query into flat tokens that, joined back together,
 * reproduce the input exactly. Quoted ("…", '…') and regex (/…/) values stay inside their word,
 * so spaces and parentheses inside them never end a word or open a group.
 *
 * Term parser (`parseTerm`, `parseQueryTokens`): reads the inside of a word — negation, field,
 * operator and value — and `formatTerm` turns it back into the exact source text.
 *
 * Tree builder (`parseQuery`, `printQuery`): groups, `or`/`and`, implicit and, with every
 * structural problem reported in `problems` instead of thrown. Whitespace and malformed pieces
 * are kept as trivia / stray leaves so printing the tree reproduces the input exactly.
 *
 * Editing (`pruneQuery`): removes nodes and simplifies the tree so the printed result is a clean
 * query — no empty groups, no dangling connectives.
 *
 * Value-opening rules match balanceScryfallQuery in query-converter.ts:
 *  - `"` always opens a value. Mid-word it stays part of the word — Scryfall reads `o:draw"card"`
 *    and `goblin"king"` as single terms with a literal quote in the value — except right after
 *    the connective `or`/`and`, where it starts a new word (`or"king"` is `or` then `"king"`,
 *    verified live against Scryfall).
 *  - `'` and `/` open a value only right after an operator (`:`, `=`, `!`, `<`, `>`); anywhere
 *    else they are an apostrophe (Urza's) or a slash (Fire // Ice). `!/` is the exception: an
 *    exact name is never a regex, Scryfall looks for that literal name.
 *  - Inside /…/ a backslash escapes the next character.
 *  - A closed value that starts the term also ends it: `o:"draw"-t:creature` is two terms on
 *    Scryfall (verified live).
 *
 * No dependencies and no Node imports: this runs in the browser too.
 */

export type LexTokenKind = "space" | "open" | "close" | "word";

export interface LexToken {
  kind: LexTokenKind;
  /** Exact source text; `tokens.map((t) => t.raw).join("")` is the original query. */
  raw: string;
  /** Index of the first character of `raw` in the query. */
  start: number;
  /** Set on a word whose "…", '…' or /…/ value reached the end of the input without closing. */
  unterminated?: true;
}

const OPERATOR_CHARS = ":=!<>";

/** `or` / `and` in any case — the words Scryfall treats as connectives. */
function isConnective(word: string): boolean {
  const lower = word.toLowerCase();
  return lower === "or" || lower === "and";
}

/**
 * Whitespace that separates terms: the JavaScript `\s` set (ASCII whitespace plus Unicode spaces
 * such as U+00A0 no-break space, U+2003 em space, U+3000 ideographic space and U+FEFF) plus
 * U+0085 (next line) and U+200B (zero-width space), which `\s` lacks. Scryfall treats all of
 * these like a normal space (verified live).
 */
const SPACE_RE = /[\s\u0085\u200b]/;

function isSpace(ch: string): boolean {
  return SPACE_RE.test(ch);
}

/**
 * Returns true when the character at `i` opens a quoted or regex value. The `'`/`/` check looks
 * at the previous character of the query (not of the word) exactly like scanScryfallQuery does.
 */
function opensValue(query: string, i: number): boolean {
  const ch = query[i];
  if (ch === '"') return true;
  if (ch !== "'" && ch !== "/") return false;
  if (ch === "/" && query[i - 1] === "!") return false;
  return i > 0 && OPERATOR_CHARS.includes(query[i - 1]);
}

/** True when the value opening at `i` is the first thing in the term that began at `start`. */
function startsTermValue(query: string, i: number, start: number): boolean {
  return i === start || OPERATOR_CHARS.includes(query[i - 1]) || (i === start + 1 && query[start] === "-");
}

/**
 * Scans a value starting at the delimiter at `start`. Returns the index just past the closing
 * delimiter, or `query.length` (with `closed: false`) when the value never closes.
 */
function scanValue(query: string, start: number): { end: number; closed: boolean } {
  const closer = query[start];
  const isRegex = closer === "/";
  let i = start + 1;
  while (i < query.length) {
    const ch = query[i];
    if (isRegex && ch === "\\") {
      // Escape: skip the next character (a trailing backslash simply runs off the end).
      i += 2;
      continue;
    }
    if (ch === closer) return { end: i + 1, closed: true };
    i += 1;
  }
  return { end: query.length, closed: false };
}

/** Tokenizes a Scryfall query. Never throws; every input yields a token list that round-trips. */
export function lexQuery(query: string): LexToken[] {
  const tokens: LexToken[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];

    if (isSpace(ch)) {
      const start = i;
      while (i < query.length && isSpace(query[i])) i += 1;
      tokens.push({ kind: "space", raw: query.slice(start, i), start });
      continue;
    }

    if (ch === "(" || ch === ")") {
      tokens.push({ kind: ch === "(" ? "open" : "close", raw: ch, start: i });
      i += 1;
      continue;
    }

    // A word runs until whitespace or a paren outside any value; a `"` glued to a connective
    // starts the next word instead (`or"x"` → `or`, `"x"`), and so does whatever follows a closed
    // value that started the term.
    const start = i;
    let unterminated = false;
    while (i < query.length) {
      const c = query[i];
      if (isSpace(c) || c === "(" || c === ")") break;
      if (c === '"' && i - start <= 3 && isConnective(query.slice(start, i))) break;
      if (opensValue(query, i)) {
        const value = scanValue(query, i);
        const endsTerm = value.closed && startsTermValue(query, i, start);
        i = value.end;
        if (!value.closed) unterminated = true;
        if (endsTerm) break;
        continue;
      }
      i += 1;
    }
    const token: LexToken = { kind: "word", raw: query.slice(start, i), start };
    if (unterminated) token.unterminated = true;
    tokens.push(token);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Term parser
// ---------------------------------------------------------------------------------------------

export type QueryOperator = ":" | "=" | "!=" | "<" | "<=" | ">" | ">=";
export type QueryValueKind = "bare" | "quoted" | "regex";

/**
 * The inside of one word. Examples:
 *   `-t:creature`          → negated, field "t", operator ":", bare value "creature"
 *   `o:"draw a card"`      → field "o", quoted value `draw a card` (quote `"`)
 *   `name:/^Urza/`         → field "name", regex value `^Urza`
 *   `!"Fire // Ice"`       → exact, quoted value `Fire // Ice`
 *   `mv>=3`                → field "mv", operator ">=", bare value "3"
 *   `creature` / `or`      → plain word: no field, bare value "creature" / "or"
 *
 * `value` holds the content without its delimiters; `raw` is always the original text and
 * `formatTerm` rebuilds it. Nothing here is normalized (field case, escapes) — that is up to
 * the caller.
 */
export interface QueryTerm {
  /** Exact source text of the word. */
  raw: string;
  /** Leading `-`. */
  negated: boolean;
  /** Leading `!` — exact card name; there is never a field on an exact term. */
  exact: boolean;
  /** Field name as written (`t`, `o`, `set-type`). Absent on plain words and exact names. */
  field?: string;
  /** Present exactly when `field` is. */
  operator?: QueryOperator;
  /** Value content without the surrounding `"`, `'` or `/`; a bare value keeps any quotes inside it. */
  value: string;
  valueKind: QueryValueKind;
  /** Delimiter of a quoted value. */
  quote?: '"' | "'";
  /** A `"`, `'` or `/` somewhere in the word opens a value that never closes (`o:draw"x`). */
  unterminated?: true;
}

/** Field names: letters first, then letters, digits, `_` or `-` (set-type, usd). */
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_-]*/;
const OPERATORS: readonly QueryOperator[] = ["!=", "<=", ">=", ":", "=", "<", ">"];

function matchOperator(raw: string, at: number): QueryOperator | undefined {
  return OPERATORS.find((op) => raw.startsWith(op, at));
}

/**
 * Parses one word (as produced by `lexQuery`). Never throws: anything it does not recognize
 * becomes a plain bare value, and `formatTerm(parseTerm(raw)) === raw` for every input.
 */
export function parseTerm(raw: string): QueryTerm {
  let i = 0;
  // A lone "-" or "!" is a plain word, not an empty negation/exact name.
  const negated = raw[i] === "-" && raw.length > 1;
  if (negated) i += 1;
  const exact = raw[i] === "!" && i + 1 < raw.length;
  if (exact) i += 1;

  let field: string | undefined;
  let operator: QueryOperator | undefined;
  if (!exact) {
    const name = FIELD_RE.exec(raw.slice(i))?.[0];
    const op = name ? matchOperator(raw, i + name.length) : undefined;
    if (name && op) {
      field = name;
      operator = op;
      i += name.length + op.length;
    }
  }

  const term: QueryTerm = { raw, negated, exact, value: "", valueKind: "bare" };
  if (field && operator) {
    term.field = field;
    term.operator = operator;
  }

  // Same rule as the lexer: `"` always delimits; `'` and `/` only right after an operator
  // character, which covers both `o:'…'` and the exact-name form `!'…'`.
  // Text after a closed value only reaches here from a caller that skipped lexQuery; it reads as bare.
  const value = opensValue(raw, i) ? scanValue(raw, i) : undefined;
  if (!value || value.end < raw.length) {
    // A bare value is the whole rest of the word, quotes included: Scryfall reads `o:draw"card"`
    // literally. A quote in it still opens a value for the lexer, so it may be unterminated.
    term.value = raw.slice(i);
    if (hasUnterminatedValue(raw, i)) term.unterminated = true;
    return term;
  }

  const opener = raw[i];
  term.value = raw.slice(i + 1, value.closed ? value.end - 1 : value.end);
  if (opener === "/") {
    term.valueKind = "regex";
  } else {
    term.valueKind = "quoted";
    term.quote = opener as '"' | "'";
  }
  if (!value.closed) term.unterminated = true;
  return term;
}

/** True when a value opened at or after `from` in `raw` never closes. */
function hasUnterminatedValue(raw: string, from: number): boolean {
  let i = from;
  while (i < raw.length) {
    if (opensValue(raw, i)) {
      const value = scanValue(raw, i);
      if (!value.closed) return true;
      i = value.end;
    } else {
      i += 1;
    }
  }
  return false;
}

/** Inverse of `parseTerm`: rebuilds the word's source text (also for edited terms). */
export function formatTerm(term: QueryTerm): string {
  let out = "";
  if (term.negated) out += "-";
  if (term.exact) out += "!";
  if (term.field !== undefined) out += term.field + (term.operator ?? ":");
  if (term.valueKind === "bare") {
    out += term.value;
  } else {
    // Scryfall has no escape inside quotes, so an edited value containing its quote swaps quotes.
    const quote = term.quote ?? '"';
    const delimiter = term.valueKind === "regex" ? "/" : term.value.includes(quote) ? (quote === '"' ? "'" : '"') : quote;
    out += delimiter + term.value + (term.unterminated ? "" : delimiter);
  }
  return out;
}

export type ParsedQueryToken =
  | (LexToken & { kind: "space" })
  | (LexToken & { kind: "open" })
  | (LexToken & { kind: "close" })
  | (LexToken & { kind: "word"; term: QueryTerm });

/** `lexQuery` with every word token parsed into a `term`. Never throws. */
export function parseQueryTokens(query: string): ParsedQueryToken[] {
  return lexQuery(query).map((token) =>
    token.kind === "word" ? { ...token, kind: "word", term: parseTerm(token.raw) } : (token as ParsedQueryToken)
  );
}

// ---------------------------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------------------------

/**
 * Scryfall binds implicit/explicit `and` tighter than `or`: `a b or c d` is `(a b) or (c d)`.
 * All positions are indexes into the source query (end exclusive); they describe where a node
 * came from and are not maintained through edits.
 */
export type QueryNode = TermNode | StrayNode | GroupNode | BinaryNode;

/** One search term (`-t:creature`, `o:"draw a card"`, a plain word). */
export interface TermNode {
  type: "term";
  term: QueryTerm;
  start: number;
  end: number;
}

/** Source text with no meaning that is kept so the tree prints back exactly: an unmatched `)` or a dangling `or`/`and`. */
export interface StrayNode {
  type: "stray";
  raw: string;
  reason: "unmatched-close" | "dangling-connective";
  start: number;
  end: number;
}

/** A parenthesized group, optionally negated with `-(`. */
export interface GroupNode {
  type: "group";
  negated: boolean;
  /** Whitespace after `(`. */
  leading: string;
  /** `null` for an empty group `()`. */
  inner: QueryNode | null;
  /** Whitespace before `)`. */
  trailing: string;
  /** False when the `)` is missing (reported as a problem). */
  closed: boolean;
  start: number;
  end: number;
}

/** Text between two operands: whitespace, optional keyword as written (`or`, `OR`, `and`), whitespace. */
export interface Joiner {
  before: string;
  /** Empty for implicit and. */
  keyword: string;
  after: string;
}

/** `and` (implicit or explicit) or `or` over two or more operands; `joiners[i]` sits between `operands[i]` and `operands[i + 1]`. */
export interface BinaryNode {
  type: "and" | "or";
  operands: QueryNode[];
  joiners: Joiner[];
  start: number;
  end: number;
}

export type QueryProblemCode =
  | "unmatched-close"
  | "unclosed-group"
  | "empty-group"
  | "dangling-connective"
  | "unterminated-value"
  | "exact-group";

export interface QueryProblem {
  code: QueryProblemCode;
  message: string;
  start: number;
  end: number;
}

export interface ParsedQuery {
  raw: string;
  /** Whitespace before the first node. */
  leading: string;
  /** `null` for an empty or whitespace-only query. */
  root: QueryNode | null;
  /** Whitespace after the last node. */
  trailing: string;
  /** Everything wrong with the query, in source order. Empty for a well-formed query. */
  problems: QueryProblem[];
}

/** `or` / `and` as a plain, unquoted, unnegated word with nothing attached (Scryfall accepts any case). */
function connectiveOf(term: QueryTerm): "or" | "and" | undefined {
  if (term.field !== undefined || term.negated || term.exact || term.valueKind !== "bare") return undefined;
  return isConnective(term.value) ? (term.value.toLowerCase() as "or" | "and") : undefined;
}

/** Phase-1 item: a leaf/group, or a connective keyword that phase 2 decides is a joiner or stray. */
type Item = { node: QueryNode } | { keyword: "or" | "and"; raw: string; start: number; end: number };

/** One open sequence: the root query or the inside of a `(` not yet closed. */
interface Frame {
  /** `null` for the root. */
  open: { token: LexToken; negated: boolean; start: number } | null;
  items: Item[];
  gaps: string[];
  leading: string;
  trailing: string;
}

/**
 * Phase 1: walks the tokens once with an explicit stack of open groups (no recursion, so 3000
 * nested parens are fine) and hands each finished sequence to `buildExpression`.
 */
class TreeBuilder {
  private pos = 0;
  readonly problems: QueryProblem[] = [];

  constructor(private readonly tokens: ParsedQueryToken[]) {}

  private peek(offset = 0): ParsedQueryToken | undefined {
    return this.tokens[this.pos + offset];
  }

  private takeSpace(): string {
    let out = "";
    while (this.peek()?.kind === "space") out += this.tokens[this.pos++].raw;
    return out;
  }

  private report(code: QueryProblemCode, message: string, start: number, end: number): void {
    this.problems.push({ code, message, start, end });
  }

  /** End of the last consumed token. */
  private consumedEnd(): number {
    const last = this.tokens[this.pos - 1];
    return last.start + last.raw.length;
  }

  parse(): Frame {
    const stack: Frame[] = [];
    let frame: Frame = { open: null, items: [], gaps: [], leading: this.takeSpace(), trailing: "" };
    for (;;) {
      const token = this.peek();
      // `space` cannot occur here: takeSpace always ran just before.
      if (!token || token.kind === "space") break;
      if (token.kind === "close") {
        this.pos += 1;
        if (frame.open) {
          const group = this.finishGroup(frame, true, token.start + 1);
          frame = stack.pop()!;
          this.addItem(frame, { node: group });
        } else {
          this.report("unmatched-close", 'Unmatched ")" has no opening parenthesis', token.start, token.start + 1);
          this.addItem(frame, { node: { type: "stray", raw: ")", reason: "unmatched-close", start: token.start, end: token.start + 1 } });
        }
        continue;
      }
      const next = this.peek(1);
      const negatedOpen = token.kind === "word" && token.raw === "-" && next?.kind === "open" && next.start === token.start + 1;
      if (token.kind === "open" || negatedOpen) {
        if (negatedOpen) this.pos += 1;
        const openToken = this.tokens[this.pos++];
        stack.push(frame);
        frame = { open: { token: openToken, negated: negatedOpen, start: token.start }, items: [], gaps: [], leading: this.takeSpace(), trailing: "" };
        continue;
      }
      this.addItem(frame, this.parseWord(token));
    }
    // End of input: every still-open group is unclosed.
    while (frame.open) {
      const group = this.finishGroup(frame, false, this.consumedEnd());
      frame = stack.pop()!;
      this.addItem(frame, { node: group });
    }
    return frame;
  }

  private parseWord(token: ParsedQueryToken & { kind: "word" }): Item {
    this.pos += 1;
    const end = token.start + token.raw.length;
    if (token.term.unterminated) {
      this.report("unterminated-value", `Missing closing delimiter in ${token.raw}`, token.start, end);
    }
    const next = this.peek();
    if (token.raw === "!" && next?.kind === "open" && next.start === end) {
      this.report("exact-group", '"!" looks up one card name and cannot apply to a group', token.start, end + 1);
    }
    const keyword = connectiveOf(token.term);
    if (keyword) return { keyword, raw: token.raw, start: token.start, end };
    return { node: { type: "term", term: token.term, start: token.start, end } };
  }

  /** Appends an item, then files the whitespace after it as a gap or as the frame's trailing space. */
  private addItem(frame: Frame, item: Item): void {
    frame.items.push(item);
    const space = this.takeSpace();
    const next = this.peek();
    if (!next || (next.kind === "close" && frame.open)) frame.trailing = space;
    else frame.gaps.push(space);
  }

  private finishGroup(frame: Frame, closed: boolean, end: number): GroupNode {
    const open = frame.open!;
    const inner = buildExpression(frame.items, frame.gaps, this.problems);
    if (!closed) this.report("unclosed-group", "Missing closing parenthesis", open.token.start, end);
    if (inner === null) this.report("empty-group", "Empty parentheses", open.token.start, end);
    return { type: "group", negated: open.negated, leading: frame.leading, inner, trailing: frame.trailing, closed, start: open.start, end };
  }
}

/**
 * Phase 2: turns a flat item list into an and/or tree. A keyword with an operand on both sides is
 * a joiner; otherwise it is a stray leaf (dangling). `or` splits the list into branches, each
 * branch of several items becomes an `and` node.
 */
function buildExpression(items: Item[], gaps: string[], problems: QueryProblem[]): QueryNode | null {
  if (items.length === 0) return null;

  // Resolve keywords left to right so `a or or b` keeps the second `or` as the joiner.
  const resolved: Item[] = [...items];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!("keyword" in item)) continue;
    const prev = resolved[i - 1];
    const next = items[i + 1];
    const valid = prev !== undefined && !("keyword" in prev) && next !== undefined && !("keyword" in next);
    if (!valid) {
      problems.push({
        code: "dangling-connective",
        message: `"${item.raw}" needs a term on both sides`,
        start: item.start,
        end: item.end,
      });
      resolved[i] = {
        node: { type: "stray", raw: item.raw, reason: "dangling-connective", start: item.start, end: item.end },
      };
    }
  }

  // Split into or-branches; within a branch, collect and-operands with their joiners.
  const branches: { operands: QueryNode[]; joiners: Joiner[] }[] = [{ operands: [], joiners: [] }];
  const orJoiners: Joiner[] = [];
  let pendingJoiner: Joiner | null = null;
  for (let i = 0; i < resolved.length; i++) {
    const item = resolved[i];
    if ("keyword" in item) {
      const joiner: Joiner = { before: gaps[i - 1], keyword: item.raw, after: gaps[i] };
      if (item.keyword === "or") {
        orJoiners.push(joiner);
        branches.push({ operands: [], joiners: [] });
        pendingJoiner = null;
      } else {
        pendingJoiner = joiner;
      }
      continue;
    }
    const branch = branches[branches.length - 1];
    if (branch.operands.length > 0) {
      branch.joiners.push(pendingJoiner ?? { before: gaps[i - 1], keyword: "", after: "" });
    }
    pendingJoiner = null;
    branch.operands.push(item.node);
  }

  const operands = branches.map(({ operands: ops, joiners }) =>
    ops.length === 1 ? ops[0] : ({ type: "and", operands: ops, joiners, start: ops[0].start, end: ops[ops.length - 1].end } as BinaryNode)
  );
  if (operands.length === 1) return operands[0];
  return { type: "or", operands, joiners: orJoiners, start: operands[0].start, end: operands[operands.length - 1].end };
}

/** Builds the query tree. Never throws; problems are listed in `problems` and the input is fully preserved. */
export function parseQuery(query: string): ParsedQuery {
  const builder = new TreeBuilder(parseQueryTokens(query));
  const root = builder.parse();
  const node = buildExpression(root.items, root.gaps, builder.problems);
  const problems = [...builder.problems].sort((a, b) => a.start - b.start || a.end - b.end);
  return { raw: query, leading: root.leading, root: node, trailing: root.trailing, problems };
}

/**
 * Prints a node back to Scryfall syntax; for an unedited tree this is the exact source text.
 * Iterative, so deeply nested groups cannot overflow the stack.
 */
export function printNode(node: QueryNode): string {
  const out: string[] = [];
  const work: (QueryNode | string)[] = [node];
  while (work.length > 0) {
    const item = work.pop()!;
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    switch (item.type) {
      case "term":
        out.push(formatTerm(item.term));
        break;
      case "stray":
        out.push(item.raw);
        break;
      case "group":
        out.push((item.negated ? "-" : "") + "(" + item.leading);
        work.push(item.trailing + (item.closed ? ")" : ""));
        if (item.inner) work.push(item.inner);
        break;
      case "and":
      case "or":
        // Push in reverse so operands pop in order, each preceded by its joiner.
        for (let i = item.operands.length - 1; i >= 0; i--) {
          work.push(item.operands[i]);
          if (i > 0) {
            const joiner = item.joiners[i - 1];
            work.push(joiner.before + joiner.keyword + joiner.after);
          }
        }
        break;
    }
  }
  return out.join("");
}

/** Inverse of `parseQuery`: `printQuery(parseQuery(q)) === q` for every input. */
export function printQuery(parsed: ParsedQuery): string {
  return parsed.leading + (parsed.root ? printNode(parsed.root) : "") + parsed.trailing;
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

/** Every node of the tree in pre-order, iteratively. */
export function walkQuery(root: QueryNode | null): QueryNode[] {
  const out: QueryNode[] = [];
  const stack = root ? [root] : [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    if (node.type === "group" && node.inner) stack.push(node.inner);
    if (node.type === "and" || node.type === "or") for (let i = node.operands.length - 1; i >= 0; i--) stack.push(node.operands[i]);
  }
  return out;
}

/**
 * Removes every node `keep` rejects (with its subtree) and simplifies what is left so the printed
 * query is clean: an `and`/`or` keeps only surviving operands (one survivor replaces the node),
 * a group whose inside is gone goes away, `((a))` becomes `(a)`, and strays (dangling `or`/`and`,
 * unmatched `)`) and empty groups are dropped. Whitespace runs between terms collapse to one space. Quoted and
 * regex values are never touched. The input tree is not modified; positions on new nodes are
 * inherited from the originals.
 */
export function pruneQuery(parsed: ParsedQuery, keep: (node: QueryNode) => boolean): ParsedQuery {
  const order = walkQuery(parsed.root);
  const result = new Map<QueryNode, QueryNode | null>();
  // Children come after their parent in pre-order, so walking backwards resolves them first.
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    result.set(node, keep(node) ? rebuild(node, result) : null);
  }
  const root = parsed.root ? (result.get(parsed.root) ?? null) : null;
  return { raw: parsed.raw, leading: "", root, trailing: "", problems: parsed.problems };
}

const tidy = (space: string) => (space ? " " : "");

function rebuild(node: QueryNode, result: Map<QueryNode, QueryNode | null>): QueryNode | null {
  switch (node.type) {
    case "term":
      return node;
    case "stray":
      return null;
    case "group": {
      const inner = node.inner ? (result.get(node.inner) ?? null) : null;
      if (!inner) return null;
      // `((a))` → `(a)`: a plain group directly inside a group adds nothing.
      if (inner.type === "group" && !inner.negated && inner.closed) return { ...inner, negated: node.negated, closed: node.closed };
      return { ...node, inner, leading: tidy(node.leading), trailing: tidy(node.trailing) };
    }
    case "and":
    case "or": {
      const operands: QueryNode[] = [];
      const joiners: Joiner[] = [];
      node.operands.forEach((operand, i) => {
        const kept = result.get(operand) ?? null;
        if (!kept) return;
        if (operands.length > 0) {
          // Use the joiner right before this operand; for `or` they all read `or` anyway. A keyword
          // needs a space on both sides; an implicit joiner may be empty only next to a group's
          // paren — two terms that lost what separated them (`a ) b`) would otherwise fuse.
          const joiner = node.joiners[i - 1];
          const previous = operands[operands.length - 1];
          const separated =
            (previous.type === "group" && previous.closed) ||
            (kept.type === "group" && !kept.negated && !(previous.type === "term" && previous.term.raw === "-"));
          joiners.push(
            joiner.keyword
              ? { before: " ", keyword: joiner.keyword, after: " " }
              : { before: tidy(joiner.before) || (separated ? "" : " "), keyword: "", after: "" }
          );
        }
        operands.push(kept);
      });
      if (operands.length === 0) return null;
      if (operands.length === 1) return operands[0];
      return { ...node, operands, joiners };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Scryfall fields
// ---------------------------------------------------------------------------------------------

/**
 * Field names Scryfall's search syntax accepts (scryfall.com/docs/syntax), lower-case, aliases
 * included. `set-type` is not a Scryfall field but has been accepted by this app historically.
 */
export const SCRYFALL_FIELDS: ReadonlySet<string> = new Set([
  // colors
  "c", "color", "id", "identity", "ci", "commander",
  // types and text
  "t", "type", "o", "oracle", "fo", "fulloracle", "kw", "keyword", "name", "lore",
  // mana and stats
  "m", "mana", "mv", "cmc", "manavalue", "devotion", "produces",
  "pow", "power", "tou", "toughness", "pt", "powtou", "loy", "loyalty", "def", "defense",
  // flags
  "is", "not", "has",
  // rarity, sets, printings
  "r", "rarity", "s", "set", "e", "edition", "cn", "number", "collector", "b", "block", "st", "set-type", "in", "cube",
  "papersets", "sets", "prints", "paperprints", "spellbook",
  // formats
  "f", "format", "banned", "restricted", "legal",
  // prices
  "usd", "eur", "tix", "cheapest",
  // art, flavor, artists
  "a", "artist", "artists", "ft", "flavor", "flavour", "wm", "watermark", "illustrations", "new",
  "art", "atag", "arttag", "function", "otag", "oracletag",
  // misc
  "lang", "language", "border", "frame", "stamp", "game", "year", "date",
  "prefer", "order", "direction", "dir", "unique", "display", "include",
]);

/** True when `name` (any case) is a field Scryfall's search syntax accepts. */
export function isScryfallField(name: string): boolean {
  return SCRYFALL_FIELDS.has(name.toLowerCase());
}
