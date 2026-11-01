/**
 * lexQuery / parseTerm / parseQuery self-check (no network).
 *
 * Run: tsx lib/scryfall/query-ast.test.ts
 */

import assert from "node:assert/strict";
import seo from "@/data/seo-queries.json";
import {
  formatTerm,
  lexQuery,
  parseQuery,
  parseQueryTokens,
  parseTerm,
  printNode,
  printQuery,
  pruneQuery,
  walkQuery,
  type QueryNode,
  type QueryTerm,
  type LexToken,
} from "@/lib/scryfall/query-ast";
import { balanceScryfallQuery } from "@/lib/scryfall/query-converter";

let passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed += 1;
  console.log(`[PASS] ${name}`);
}

const join = (tokens: LexToken[]) => tokens.map((t) => t.raw).join("");
const words = (tokens: LexToken[]) => tokens.filter((t) => t.kind === "word").map((t) => t.raw);
const kinds = (tokens: LexToken[]) => tokens.map((t) => t.kind);

// Every pre-rendered SEO query round-trips: joined raw text is the exact input, and each token's
// start/raw agree with the source.
{
  const pages = seo.pages as { scryfallQuery: string }[];
  const broken = pages.filter((p) => join(lexQuery(p.scryfallQuery)) !== p.scryfallQuery);
  check(
    `round-trips all ${pages.length} SEO queries`,
    pages.length > 0 && broken.length === 0,
    broken.map((p) => p.scryfallQuery).join(" | ")
  );
  const misplaced = pages.filter((p) =>
    lexQuery(p.scryfallQuery).some((t) => p.scryfallQuery.slice(t.start, t.start + t.raw.length) !== t.raw)
  );
  check("token start positions match the source", misplaced.length === 0, misplaced[0]?.scryfallQuery);
  const unterminated = pages.filter((p) => lexQuery(p.scryfallQuery).some((t) => t.unterminated));
  check("no SEO query is marked unterminated", unterminated.length === 0, unterminated[0]?.scryfallQuery);
}

// Regex value: the parens inside /…/ are content, not grouping.
{
  const q = "o:/(?<!this )creature[^.]*die/ t:creature";
  const tokens = lexQuery(q);
  check("regex query round-trips", join(tokens) === q);
  check("regex query → two words", words(tokens).length === 2, words(tokens).join(" | "));
  check("regex word keeps its value", words(tokens)[0] === "o:/(?<!this )creature[^.]*die/", words(tokens)[0]);
  check("regex query has no open/close", !kinds(tokens).some((k) => k === "open" || k === "close"));
}

// Single-quoted value holding double quotes and a space.
{
  const q = `name:'Henzie "Toolbox" Torre' t:creature`;
  const tokens = lexQuery(q);
  check("single-quoted query round-trips", join(tokens) === q);
  check("single-quoted query → two words", words(tokens).length === 2, words(tokens).join(" | "));
  check("single-quoted word intact", words(tokens)[0] === `name:'Henzie "Toolbox" Torre'`, words(tokens)[0]);
}

// Exact name with a single-quoted value: `'` opens a value right after `!`.
{
  const q = `!'Henzie "Toolbox" Torre' t:creature`;
  const tokens = lexQuery(q);
  check("exact single-quoted name → two words", words(tokens).length === 2, words(tokens).join(" | "));
  check("exact single-quoted name intact", words(tokens)[0] === `!'Henzie "Toolbox" Torre'`, words(tokens)[0]);
}

// A mid-word `"` stays in the word (verified live: o:draw"card" and goblin"king" differ from the
// spaced forms), except glued to a connective (t:goblin or"king" equals t:goblin or "king").
{
  check('o:draw"card" → one word', words(lexQuery('o:draw"card"')).join("|") === 'o:draw"card"');
  check('t:instant"bolt" → one word', words(lexQuery('t:instant"bolt"')).join("|") === 't:instant"bolt"');
  check('goblin"king" → one word', words(lexQuery('goblin"king"')).join("|") === 'goblin"king"');
  check('goblin "king" → two words', words(lexQuery('goblin "king"')).join("|") === 'goblin|"king"');
  check('or"king" → two words', words(lexQuery('t:goblin or"king"')).join("|") === 't:goblin|or|"king"', words(lexQuery('t:goblin or"king"')).join("|"));
  check('OR"king" → two words (any case)', words(lexQuery('OR"king"')).join("|") === 'OR|"king"');
  check('and"x" → two words', words(lexQuery('and"x"')).join("|") === 'and|"x"');
  check('-or"x" stays one word (negated word, not a connective)', words(lexQuery('-or"x"')).join("|") === '-or"x"');
  check('o:draw"x t:creature → one unterminated word', lexQuery('o:draw"x t:creature').length === 1 && lexQuery('o:draw"x t:creature')[0].unterminated === true);
  check('-"x" stays one word', words(lexQuery('-"x" a')).join("|") === '-"x"|a');
  check('!"x" stays one word', words(lexQuery('!"x" a')).join("|") === '!"x"|a');
  check(`or'x' stays one word (' is not a delimiter here)`, words(lexQuery("or'x'")).join("|") === "or'x'");
  check('o:"draw"-t:creature → two words', words(lexQuery('o:"draw"-t:creature')).join("|") === 'o:"draw"|-t:creature');
  check('o:"draw"x → two words', words(lexQuery('o:"draw"x')).join("|") === 'o:"draw"|x');
  check("o:/draw/x → two words", words(lexQuery("o:/draw/x")).join("|") === "o:/draw/|x");
  check('-"a"b → two words', words(lexQuery('-"a"b')).join("|") === '-"a"|b');
  check('!"a"b → two words', words(lexQuery('!"a"b')).join("|") === '!"a"|b');
  check('"a"or"b" → three words', words(lexQuery('"a"or"b"')).join("|") === '"a"|or|"b"');
  check('o:draw"a"b stays one word (mid-word quote)', words(lexQuery('o:draw"a"b')).join("|") === 'o:draw"a"b');
  check("!/a b/ is not a regex", words(lexQuery("!/a b/")).join("|") === "!/a|b/");
}

// Long quote runs stay linear: the connective check must not rescan the word for every quote.
{
  const q = 'a"'.repeat(300_000);
  const started = Date.now();
  check("600k quote run lexes fast", join(lexQuery(q)) === q && Date.now() - started < 1000, `${Date.now() - started} ms`);
}

// Unicode spaces separate terms like a normal space (Scryfall treats them alike) and round-trip.
{
  for (const [name, ch] of [["no-break space", "\u00a0"], ["em space", "\u2003"], ["thin space", "\u2009"], ["narrow no-break space", "\u202f"], ["ideographic space", "\u3000"], ["punctuation space", "\u2008"], ["next line U+0085", "\u0085"], ["zero-width space", "\u200b"], ["tab", "\t"], ["newline", "\n"]] as const) {
    const q = `t:creature${ch}o:draw`;
    const tokens = lexQuery(q);
    check(`${name} separates words`, kinds(tokens).join(",") === "word,space,word" && join(tokens) === q, kinds(tokens).join(","));
  }
}

// Double-quoted value holding parens.
{
  const q = `name:"B.F.M. (Big Furry Monster)"`;
  const tokens = lexQuery(q);
  check("quoted parens → one word", tokens.length === 1 && tokens[0].kind === "word", kinds(tokens).join(","));
  check("quoted parens word is whole input", tokens[0].raw === q);
}

// Apostrophe and slashes outside an operator are plain characters.
{
  const q = "Urza's Fire // Ice";
  const tokens = lexQuery(q);
  check("apostrophe/slash query → four words", words(tokens).length === 4, words(tokens).join(" | "));
  check(
    "apostrophe/slash words split on spaces only",
    words(tokens).join("|") === "Urza's|Fire|//|Ice",
    words(tokens).join("|")
  );
  check("apostrophe/slash query not unterminated", !tokens.some((t) => t.unterminated));
}

// Unterminated value runs to the end and is flagged; never throws.
{
  const q = 'o:"unterminated';
  const tokens = lexQuery(q);
  check("unterminated → one word", tokens.length === 1 && tokens[0].kind === "word", kinds(tokens).join(","));
  check("unterminated word flagged", tokens[0].unterminated === true);
  check("unterminated word runs to end", tokens[0].raw === q);

  const regex = lexQuery("o:/a\\/b t:creature");
  check("unterminated regex (escaped slash) → one flagged word", regex.length === 1 && regex[0].unterminated === true);
  const trailingEscape = lexQuery("o:/abc\\");
  check("trailing backslash in regex never throws", trailingEscape.length === 1 && trailingEscape[0].unterminated === true);
  check("empty query → no tokens", lexQuery("").length === 0);
}

// Token kinds and positions on a typical grouped query.
{
  const q = 't:creature (o:"draw a card" or kw:flying) -c:r !"exact name"';
  const tokens = lexQuery(q);
  check("grouped query round-trips", join(tokens) === q);
  check(
    "grouped query kinds",
    kinds(tokens).join(",") ===
      "word,space,open,word,space,word,space,word,close,space,word,space,word",
    kinds(tokens).join(",")
  );
  check(
    "grouped query words",
    words(tokens).join("|") === 't:creature|o:"draw a card"|or|kw:flying|-c:r|!"exact name"',
    words(tokens).join("|")
  );
  check("open token position", tokens[2].kind === "open" && tokens[2].start === 11, String(tokens[2].start));
  check("runs of whitespace form one space token", lexQuery("a  \t b").length === 3);
  check("paren touching a word ends the word", words(lexQuery("(t:creature)")).join("|") === "t:creature");
}

// ---------------------------------------------------------------------------------------------
// Term parser
// ---------------------------------------------------------------------------------------------

/** Asserts the parsed term has exactly these properties (besides raw) and round-trips. */
function term(raw: string, expected: Omit<QueryTerm, "raw">): void {
  const parsed = parseTerm(raw);
  const rest: Partial<QueryTerm> = { ...parsed };
  delete rest.raw;
  let same = true;
  try {
    assert.deepStrictEqual(rest, expected);
  } catch {
    same = false;
  }
  check(`parse ${raw}`, same, JSON.stringify(rest));
  check(`round-trip ${raw}`, parsed.raw === raw && formatTerm(parsed) === raw, formatTerm(parsed));
}
const plain = (value: string): Omit<QueryTerm, "raw"> => ({ negated: false, exact: false, value, valueKind: "bare" });

// Fields, operators and bare values.
term("t:creature", { negated: false, exact: false, field: "t", operator: ":", value: "creature", valueKind: "bare" });
term("-t:creature", { negated: true, exact: false, field: "t", operator: ":", value: "creature", valueKind: "bare" });
term("mv>=3", { negated: false, exact: false, field: "mv", operator: ">=", value: "3", valueKind: "bare" });
term("c!=r", { negated: false, exact: false, field: "c", operator: "!=", value: "r", valueKind: "bare" });
term("id=wu", { negated: false, exact: false, field: "id", operator: "=", value: "wu", valueKind: "bare" });
term("pow<tou", { negated: false, exact: false, field: "pow", operator: "<", value: "tou", valueKind: "bare" });
term("set-type:expansion", { negated: false, exact: false, field: "set-type", operator: ":", value: "expansion", valueKind: "bare" });
term("function:sacrifice-outlet", { negated: false, exact: false, field: "function", operator: ":", value: "sacrifice-outlet", valueKind: "bare" });
term("o:", { negated: false, exact: false, field: "o", operator: ":", value: "", valueKind: "bare" });

// Quoted and regex values.
term('o:"draw a card"', { negated: false, exact: false, field: "o", operator: ":", value: "draw a card", valueKind: "quoted", quote: '"' });
term(`name:'Henzie "Toolbox" Torre'`, { negated: false, exact: false, field: "name", operator: ":", value: 'Henzie "Toolbox" Torre', valueKind: "quoted", quote: "'" });
term("o:/(?<!this )creature[^.]*die/", { negated: false, exact: false, field: "o", operator: ":", value: "(?<!this )creature[^.]*die", valueKind: "regex" });
term("o:/a\\/b/", { negated: false, exact: false, field: "o", operator: ":", value: "a\\/b", valueKind: "regex" });
term('-o:"draw a card"', { negated: true, exact: false, field: "o", operator: ":", value: "draw a card", valueKind: "quoted", quote: '"' });
term('name="B.F.M. (Big Furry Monster)"', { negated: false, exact: false, field: "name", operator: "=", value: "B.F.M. (Big Furry Monster)", valueKind: "quoted", quote: '"' });

// Exact names.
term('!"Fire // Ice"', { negated: false, exact: true, value: "Fire // Ice", valueKind: "quoted", quote: '"' });
term("!fire", { negated: false, exact: true, value: "fire", valueKind: "bare" });
term('-!"Lightning Bolt"', { negated: true, exact: true, value: "Lightning Bolt", valueKind: "quoted", quote: '"' });
term("!name:foo", { negated: false, exact: true, value: "name:foo", valueKind: "bare" });
term(`!'Henzie "Toolbox" Torre'`, { negated: false, exact: true, value: 'Henzie "Toolbox" Torre', valueKind: "quoted", quote: "'" });
term(`-!'Henzie "Toolbox" Torre'`, { negated: true, exact: true, value: 'Henzie "Toolbox" Torre', valueKind: "quoted", quote: "'" });
term("!'unterminated", { negated: false, exact: true, value: "unterminated", valueKind: "quoted", quote: "'", unterminated: true });
term("-'tis", { negated: true, exact: false, value: "'tis", valueKind: "bare" });
check("' after - is an apostrophe in the lexer too", words(lexQuery("-'not a quote'")).length === 3);

// Plain words: no field; apostrophes and slashes are literal; quoted name search has no field.
term("creature", plain("creature"));
term("or", plain("or"));
term("Urza's", plain("Urza's"));
term("//", plain("//"));
term("-Urza's", { negated: true, exact: false, value: "Urza's", valueKind: "bare" });
term('"Lightning Bolt"', { negated: false, exact: false, value: "Lightning Bolt", valueKind: "quoted", quote: '"' });
term("2:3", plain("2:3"));
term("'quoted'", plain("'quoted'"));
term("-", plain("-"));
term("!", plain("!"));
term(":", plain(":"));

// Malformed input never throws and stays recoverable.
term('o:"unterminated', { negated: false, exact: false, field: "o", operator: ":", value: "unterminated", valueKind: "quoted", quote: '"', unterminated: true });
term("o:/abc\\", { negated: false, exact: false, field: "o", operator: ":", value: "abc\\", valueKind: "regex", unterminated: true });
term('o:"draw"x', { negated: false, exact: false, field: "o", operator: ":", value: '"draw"x', valueKind: "bare" });
term("!/^Urza/", { negated: false, exact: true, value: "/^Urza/", valueKind: "bare" });
term('o:draw"card"', { negated: false, exact: false, field: "o", operator: ":", value: 'draw"card"', valueKind: "bare" });
term('goblin"king"', plain('goblin"king"'));
term('o:draw"x', { negated: false, exact: false, field: "o", operator: ":", value: 'draw"x', valueKind: "bare", unterminated: true });
term('o:draw"x t:creature', { negated: false, exact: false, field: "o", operator: ":", value: 'draw"x t:creature', valueKind: "bare", unterminated: true });
term('o:"a"x"b', { negated: false, exact: false, field: "o", operator: ":", value: '"a"x"b', valueKind: "bare", unterminated: true });
term("o:'unterminated", { negated: false, exact: false, field: "o", operator: ":", value: "unterminated", valueKind: "quoted", quote: "'", unterminated: true });
term("--t:creature", { negated: true, exact: false, value: "-t:creature", valueKind: "bare" });
term("", plain(""));

// formatTerm also serializes edited terms.
{
  const edited: QueryTerm = { ...parseTerm("t:creature"), negated: true, value: "artifact" };
  check("formatTerm edited term", formatTerm(edited) === "-t:artifact", formatTerm(edited));
  const requoted: QueryTerm = { ...parseTerm("o:draw"), valueKind: "quoted", quote: '"', value: "draw a card" };
  check("formatTerm requoted term", formatTerm(requoted) === 'o:"draw a card"', formatTerm(requoted));
  const clashing: QueryTerm = { ...parseTerm('name:"x"'), value: 'Henzie "Toolbox" Torre' };
  check("formatTerm swaps a quote the value contains", formatTerm(clashing) === `name:'Henzie "Toolbox" Torre'`, formatTerm(clashing));
}

// Every word of every SEO query parses, round-trips, and is a clean field term or plain word.
{
  const pages = seo.pages as { scryfallQuery: string }[];
  const allWords = pages.flatMap((p) => lexQuery(p.scryfallQuery).filter((t) => t.kind === "word"));
  const broken = allWords.filter((t) => formatTerm(parseTerm(t.raw)) !== t.raw);
  check(`all ${allWords.length} SEO words round-trip through parseTerm/formatTerm`, broken.length === 0, broken[0]?.raw);
  const malformed = allWords.filter((t) => {
    const parsed = parseTerm(t.raw);
    return parsed.unterminated;
  });
  check("no SEO word is unterminated or has trailing text", malformed.length === 0, malformed[0]?.raw);
  const fields = new Set(allWords.map((t) => parseTerm(t.raw).field).filter(Boolean));
  check("SEO fields include t/o/id/function/prefer", ["t", "o", "id", "function", "prefer"].every((f) => fields.has(f)), [...fields].join(","));
  const plainWords = new Set(allWords.map((t) => parseTerm(t.raw)).filter((p) => !p.field).map((p) => p.value.toLowerCase()));
  check("SEO plain words are only or/and", [...plainWords].every((w) => w === "or" || w === "and"), [...plainWords].join(","));

  const joined = pages.map((p) => parseQueryTokens(p.scryfallQuery).map((t) => (t.kind === "word" ? formatTerm(t.term) : t.raw)).join(""));
  check("parseQueryTokens rebuilds every SEO query", joined.every((q, i) => q === pages[i].scryfallQuery));
}

// parseQueryTokens attaches a term to every word and nothing else.
{
  const tokens = parseQueryTokens('-t:creature (o:"draw a card" or kw:flying)');
  check("parseQueryTokens words have terms", tokens.every((t) => (t.kind === "word") === ("term" in t)));
  const words = tokens.filter((t) => t.kind === "word");
  check("parseQueryTokens first term negated", words[0].term.negated && words[0].term.field === "t");
  check("parseQueryTokens quoted term", words[1].term.valueKind === "quoted" && words[1].term.value === "draw a card");
  check("parseQueryTokens or is plain", words[2].term.field === undefined && words[2].term.value === "or");
}

// ---------------------------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------------------------

/** Compact shape: terms by raw, `stray<x>`, `(…)` / `-(…)` groups (`…` open), AND[…] / OR[…]. */
function shape(node: QueryNode | null): string {
  if (!node) return "∅";
  switch (node.type) {
    case "term":
      return node.term.raw;
    case "stray":
      return `stray<${node.raw}>`;
    case "group":
      return `${node.negated ? "-" : ""}(${shape(node.inner)}${node.closed ? ")" : "…"}`;
    default:
      return `${node.type.toUpperCase()}[${node.operands.map(shape).join(", ")}]`;
  }
}
function tree(query: string, expected: string, ...problems: string[]): void {
  const parsed = parseQuery(query);
  check(`tree ${JSON.stringify(query)}`, shape(parsed.root) === expected, shape(parsed.root));
  check(`print ${JSON.stringify(query)}`, printQuery(parsed) === query, JSON.stringify(printQuery(parsed)));
  const got = parsed.problems.map((p) => `${p.code}@${p.start}-${p.end}`);
  check(`problems ${JSON.stringify(query)}`, got.join(" ") === problems.join(" "), got.join(" ") || "(none)");
}
/** Every node in the tree, iteratively (deep nesting must not overflow the test either). */
function walk(node: QueryNode | null): QueryNode[] {
  const out: QueryNode[] = [];
  const stack = node ? [node] : [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    out.push(current);
    if (current.type === "group" && current.inner) stack.push(current.inner);
    if (current.type === "and" || current.type === "or") stack.push(...current.operands);
  }
  return out;
}
const STRUCTURAL = new Set(["unmatched-close", "unclosed-group", "unterminated-value"]);

// Connectives and precedence: and (implicit or explicit) binds tighter than or.
tree("a b", "AND[a, b]");
tree("a and b", "AND[a, b]");
tree("a or b", "OR[a, b]");
tree("a b or c d", "OR[AND[a, b], AND[c, d]]");
tree("a or b c or d", "OR[a, AND[b, c], d]");
tree("a AND b Or c", "OR[AND[a, b], c]");
tree("t:creature (o:\"draw a card\" or kw:flying) -c:r", 'AND[t:creature, (OR[o:"draw a card", kw:flying]), -c:r]');
tree("(a or b) c", "AND[(OR[a, b]), c]");
tree("((a))", "((a))");
tree("(a)(b)", "AND[(a), (b)]");
tree("a(b)", "AND[a, (b)]");

// Negated groups: `-(` only when adjacent; `- (` is a plain word then a group.
tree("-(a or b) c", "AND[-(OR[a, b]), c]");
tree("- (a) b", "AND[-, (a), b]");
tree("-(a)", "-(a)");

// Live Scryfall behavior: a quote glued to a word is part of it; glued to a connective it starts
// a new term, so t:goblin or"king" and t:goblin or "king" are the same query.
tree('o:draw"card"', 'o:draw"card"');
tree('o:draw "card"', 'AND[o:draw, "card"]');
tree('t:instant"bolt"', 't:instant"bolt"');
tree('goblin"king"', 'goblin"king"');
tree('goblin "king"', 'AND[goblin, "king"]');
tree('t:goblin or"king"', 'OR[t:goblin, "king"]');
tree('t:goblin or "king"', 'OR[t:goblin, "king"]');
tree('a or"x" and a or"x b', 'OR[a, AND["x", a], "x b]', "unterminated-value@16-20");
tree('or"x"', 'AND[stray<or>, "x"]', "dangling-connective@0-2");
tree("or'x'", "or'x'");
tree('o:draw"x t:creature', 'o:draw"x t:creature', "unterminated-value@0-19");

// Deep nesting never overflows the stack (the parser and printer are iterative).
{
  const deep = "(".repeat(3000) + "a" + ")".repeat(3000);
  const parsed = parseQuery(deep);
  check("3000 nested groups parse", parsed.problems.length === 0 && walk(parsed.root).length === 3001);
  check("3000 nested groups print back", printQuery(parsed) === deep);
  const open = parseQuery("(".repeat(3000));
  check("3000 open parens → 3000 unclosed + 1 empty, printed back", open.problems.filter((p) => p.code === "unclosed-group").length === 3000 && open.problems.filter((p) => p.code === "empty-group").length === 1 && printQuery(open) === "(".repeat(3000));
  const close = parseQuery(")".repeat(3000));
  check("3000 close parens → 3000 strays, printed back", close.problems.length === 3000 && printQuery(close) === ")".repeat(3000));
  const negated = parseQuery("-(".repeat(3000));
  check("3000 negated opens print back", printQuery(negated) === "-(".repeat(3000));
}

// Connective-looking words that are not connectives.
tree('"or" a', 'AND["or", a]');
tree("-or a", "AND[-or, a]");
tree("t:or a", "AND[t:or, a]");

// Values keep their parens and spaces out of the structure.
tree('name:"B.F.M. (Big Furry Monster)" t:creature', 'AND[name:"B.F.M. (Big Furry Monster)", t:creature]');
tree("o:/(?<!this )creature[^.]*die/ t:creature", "AND[o:/(?<!this )creature[^.]*die/, t:creature]");
tree(`!'Henzie "Toolbox" Torre'`, `!'Henzie "Toolbox" Torre'`);

// Empty and whitespace-only input.
tree("", "∅");
tree("   ", "∅");

// Problems are reported with positions, never thrown, and the text is preserved.
tree("(a b", "(AND[a, b]…", "unclosed-group@0-4");
tree("(a (b c) d", "(AND[a, (AND[b, c]), d]…", "unclosed-group@0-10");
tree("a) b", "AND[a, stray<)>, b]", "unmatched-close@1-2");
tree(")", "stray<)>", "unmatched-close@0-1");
tree("())", "AND[(∅), stray<)>]", "empty-group@0-2", "unmatched-close@2-3");
tree("()", "(∅)", "empty-group@0-2");
tree("( )", "(∅)", "empty-group@0-3");
tree("a or", "AND[a, stray<or>]", "dangling-connective@2-4");
tree("or a", "AND[stray<or>, a]", "dangling-connective@0-2");
tree("or", "stray<or>", "dangling-connective@0-2");
tree("a or or b", "OR[AND[a, stray<or>], b]", "dangling-connective@2-4");
tree("a and and b", "AND[a, stray<and>, b]", "dangling-connective@2-5");
tree("a and or b", "OR[AND[a, stray<and>], b]", "dangling-connective@2-5");
tree("(a or) b", "AND[(AND[a, stray<or>]), b]", "dangling-connective@3-5");
tree('o:"x', 'o:"x', "unterminated-value@0-4");
tree('o:"x y', 'o:"x y', "unterminated-value@0-6");
tree('o:"a"x b', 'AND[o:"a", x, b]');
tree("!(a)", "AND[!, (a)]", "exact-group@0-2");
tree("! (a)", "AND[!, (a)]");
tree('(o:"a', '(o:"a…', "unclosed-group@0-5", "unterminated-value@1-5");

// Whitespace is kept exactly where it was.
{
  const parsed = parseQuery("  a   OR  b  ");
  check("leading whitespace kept", parsed.leading === "  ");
  check("trailing whitespace kept", parsed.trailing === "  ");
  const root = parsed.root;
  check("or joiner keeps spacing and keyword case", root?.type === "or" && root.joiners[0].before === "   " && root.joiners[0].keyword === "OR" && root.joiners[0].after === "  ");
  const grouped = parseQuery("( a\tb )").root;
  check("group keeps inner whitespace", grouped?.type === "group" && grouped.leading === " " && grouped.trailing === " ");
  const implicit = parseQuery("a\t\tb").root;
  check("implicit joiner keeps whitespace", implicit?.type === "and" && implicit.joiners[0].before === "\t\t" && implicit.joiners[0].keyword === "");
}

// Node positions point at the printed text.
{
  const q = 't:creature -(o:"draw a card" or kw:flying) -c:r';
  const parsed = parseQuery(q);
  const mismatched = walk(parsed.root).filter((n) => q.slice(n.start, n.end) !== printNode(n));
  check("node start/end cover the printed text", mismatched.length === 0, mismatched.map((n) => `${n.type}@${n.start}-${n.end}`).join(" "));
  const group = walk(parsed.root).find((n) => n.type === "group");
  check("negated group starts at the -", group?.start === 11 && q.slice(group.start, group.end) === '-(o:"draw a card" or kw:flying)');
}

// Every SEO query builds a clean tree that prints back exactly.
{
  const pages = seo.pages as { scryfallQuery: string }[];
  const parsed = pages.map((p) => parseQuery(p.scryfallQuery));
  const notPrinted = pages.filter((p, i) => printQuery(parsed[i]) !== p.scryfallQuery);
  check(`printQuery reproduces all ${pages.length} SEO queries`, notPrinted.length === 0, notPrinted[0]?.scryfallQuery);
  const withProblems = parsed.filter((p) => p.problems.length > 0);
  check("no SEO query has problems", withProblems.length === 0, withProblems[0] && `${withProblems[0].raw}: ${withProblems[0].problems[0].message}`);
  check("every SEO query has a root", parsed.every((p) => p.root !== null));
  const badPositions = parsed.filter((p) => walk(p.root).some((n) => p.raw.slice(n.start, n.end) !== printNode(n)));
  check("SEO node positions cover their printed text", badPositions.length === 0, badPositions[0]?.raw);
  const strays = parsed.filter((p) => walk(p.root).some((n) => n.type === "stray"));
  check("no SEO query has stray nodes", strays.length === 0, strays[0]?.raw);
  const withOr = parsed.filter((p) => walk(p.root).some((n) => n.type === "or")).length;
  const withGroup = parsed.filter((p) => walk(p.root).some((n) => n.type === "group")).length;
  check("SEO corpus exercises or-nodes and groups", withOr > 50 && withGroup > 50, `${withOr} or, ${withGroup} group`);
}

// ---------------------------------------------------------------------------------------------
// pruneQuery
// ---------------------------------------------------------------------------------------------

/** Removes field terms whose raw text is in `drop`, then prints. */
function prune(query: string, ...drop: string[]): string {
  return printQuery(pruneQuery(parseQuery(query), (n) => n.type !== "term" || !drop.includes(n.term.raw)));
}
{
  check("prune: nothing dropped prints the same", prune("t:creature (a or b) -c:r") === "t:creature (a or b) -c:r");
  check("prune: first of an implicit and", prune("x t:creature", "x") === "t:creature");
  check("prune: last of an implicit and", prune("t:creature x", "x") === "t:creature");
  check("prune: middle of an or keeps one or", prune("a or x or b", "x") === "a or b", prune("a or x or b", "x"));
  check("prune: or with one survivor keeps its group", prune("(x or b) t:creature", "x") === "(b) t:creature", prune("(x or b) t:creature", "x"));
  check("prune: group emptied disappears", prune("(x) t:creature", "x") === "t:creature");
  check("prune: nested group emptied disappears", prune("((x)) t:creature", "x") === "t:creature");
  check("prune: whole query removed → empty", prune("x", "x") === "" && prune("(x or x)", "x") === "");
  check("prune: negated group kept", prune("-(x or b) c", "x") === "-(b) c", prune("-(x or b) c", "x"));
  check("prune: negated group emptied disappears", prune("-(x) c", "x") === "c");
  check("prune: explicit and keyword kept", prune("a and x and b", "x") === "a and b", prune("a and x and b", "x"));
  check("prune: quoted values untouched", prune('o:"x or or x" x', "x") === 'o:"x or or x"');
  check("prune: regex values untouched", prune("o:/(x) x/ x", "x") === "o:/(x) x/");
  check("prune: strays removed", prune("a or or b )", ) === "a or b", prune("a or or b )"));
  check("prune: pre-existing empty group removed", prune("a () b") === "a b");
  check("prune: double parens collapse", prune("((a or b)) c") === "(a or b) c" && prune("-((a)) c") === "-(a) c", prune("-((a)) c"));
  check("prune: whitespace collapses", prune("a   x    b\t\tc", "x") === "a b c", prune("a   x    b\t\tc", "x"));
  check("prune: unclosed group keeps its survivor", prune("(x t:creature", "x") === "(t:creature");
  check("prune: adjacency without space kept", prune("(a)(x)(b)", "x") === "(a)(b)");
  const deep = "(".repeat(3000) + "x" + ")".repeat(3000);
  check("prune: 3000 nested groups do not throw", prune(deep, "x") === "" && prune(deep) === "(x)");
  const parsed = parseQuery("a x");
  const before = printQuery(parsed);
  pruneQuery(parsed, (n) => n.type !== "term" || n.term.raw !== "x");
  check("prune: input tree not modified", printQuery(parsed) === before);
  check("walkQuery: pre-order", walkQuery(parseQuery("a (b or c)").root).map((n) => n.type).join(",") === "and,term,group,or,term,term");
}

// Deterministic fuzz: random strings built from tricky characters and realistic fragments never
// throw and always round-trip. mulberry32 keeps every step in 32-bit integer math, so the
// sequence is exact and well distributed; the checks below verify the generator is actually
// producing variety before trusting what it found.
{
  const pieces = [
    '"', "'", "/", "\\", "(", ")", " ", " ", ":", "=", "!", "<", ">", "-",
    "a", "o", "t", "3", "or", "and", "OR",
    "t:creature", 'o:"draw a card"', "name:'Henzie \"Toolbox\" Torre'", "o:/a\\/b/", "!fire", "-(", "mv>=3", "c!=r", "Urza's", "//",
  ];
  let state = 20240601;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rnd = (n: number) => Math.floor(next() * n);

  const COUNT = 20000;
  const queries: string[] = [];
  for (let n = 0; n < COUNT; n++) {
    let q = "";
    const len = 1 + rnd(12);
    for (let k = 0; k < len; k++) q += pieces[rnd(pieces.length)];
    queries.push(q);
  }
  const distinct = new Set(queries).size;
  // Short strings (1–2 pieces) collide often; ~86% distinct is the expected rate for this mix.
  check(`fuzz generator: ${distinct} distinct of ${COUNT} queries`, distinct > COUNT * 0.75, String(distinct));
  const unusedPieces = pieces.filter((piece) => !queries.some((q) => q.includes(piece)));
  check("fuzz generator: every piece appears", unusedPieces.length === 0, unusedPieces.join(" "));
  const lengths = new Set(queries.map((q) => q.length));
  check("fuzz generator: lengths vary", lengths.size > 30, String(lengths.size));

  let failures = 0;
  let sample = "";
  for (const q of queries) {
    try {
      const parsed = parseQueryTokens(q);
      const rebuilt = parsed.map((t) => (t.kind === "word" ? formatTerm(t.term) : t.raw)).join("");
      const lexed = lexQuery(q).map((t) => t.raw).join("");
      if (rebuilt !== q || lexed !== q) throw new Error(`rebuilt ${JSON.stringify(rebuilt)}`);
      for (const t of parsed) {
        if (t.kind === "word" && t.unterminated !== t.term.unterminated) throw new Error(`unterminated disagree on ${JSON.stringify(t.raw)}`);
      }
      const tree = parseQuery(q);
      const printed = printQuery(tree);
      if (printed !== q) throw new Error(`printQuery ${JSON.stringify(printed)}`);
      for (const n of walk(tree.root)) {
        if (q.slice(n.start, n.end) !== printNode(n)) throw new Error(`node ${n.type}@${n.start}-${n.end} position`);
      }
      // Pruning nothing gives a clean, re-parsable query with the same terms; pruning never throws.
      const cleaned = printQuery(pruneQuery(tree, () => true));
      const reparsed = parseQuery(cleaned);
      const termsBefore = walk(tree.root).filter((n) => n.type === "term").map((n) => n.term.raw).join("\u0000");
      const termsAfter = walk(reparsed.root).filter((n) => n.type === "term").map((n) => n.term.raw).join("\u0000");
      if (termsBefore !== termsAfter) throw new Error(`prune changed terms: ${JSON.stringify(cleaned)}`);
      if (reparsed.problems.some((p) => p.code === "dangling-connective" || p.code === "empty-group" || p.code === "unmatched-close")) throw new Error(`prune left junk: ${JSON.stringify(cleaned)}`);
      printQuery(pruneQuery(tree, (n) => n.type !== "term" || !n.term.raw.includes("a")));
      // The tree reports a paren/quote problem exactly when balanceScryfallQuery would repair something.
      const structural = tree.problems.some((p) => STRUCTURAL.has(p.code));
      if (structural === (balanceScryfallQuery(q) === q)) throw new Error(`structural problems ${structural} but balance ${JSON.stringify(balanceScryfallQuery(q))}`);
    } catch (err) {
      failures += 1;
      if (!sample) sample = `${JSON.stringify(q)}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  check(`fuzz: ${COUNT} random queries never throw, round-trip at every layer, and agree with balanceScryfallQuery`, failures === 0, sample);
}

console.log(`\nAll ${passed} query-ast self-checks passed.`);
