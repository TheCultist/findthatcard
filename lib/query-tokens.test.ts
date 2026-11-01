/**
 * query-tokens self-check (no network): tokenizeQuery chips and the color/prefer selectors.
 *
 * Run: tsx lib/query-tokens.test.ts
 */

import assert from "node:assert/strict";
import seo from "@/data/seo-queries.json";
import { getColorSemanticSelectors, getPreferSelector, getTokenMetadata, tokenizeQuery } from "@/lib/query-tokens";

let passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed += 1;
  console.log(`[PASS] ${name}`);
}

// Multi-color c: token → three options, "all" current, OR-group offered.
{
  const [sel] = getColorSemanticSelectors("c:rg function:sacrifice-outlet game:paper");
  check("c: detected", sel?.field === "c" && sel.letters === "rg");
  check("c: three options", sel.options.length === 3);
  const current = sel.options.find((o) => o.current);
  check("c:rg current is 'all'", current?.clause === "c:rg", current?.clause);
  const any = sel.options.find((o) => o.clause === "(c:r or c:g)");
  check(
    "c OR rewrite",
    any?.query === "(c:r or c:g) function:sacrifice-outlet game:paper",
    any?.query
  );
}

// Existing OR-group is recognized as current "any" and can switch back to c:rg.
{
  const [sel] = getColorSemanticSelectors("(c:r or c:g) t:creature");
  check("group letters normalized", sel?.letters === "rg", sel?.letters);
  check("group current is 'any'", sel.options.find((o) => o.current)?.clause === "(c:r or c:g)");
  const all = sel.options.find((o) => o.clause === "c:rg");
  check("group → all rewrite", all?.query === "c:rg t:creature", all?.query);
}

// id token keeps the legacy toggle semantics plus id>= for multicolor.
{
  const [sel] = getColorSemanticSelectors("id=wu t:instant");
  check("id detected", sel?.field === "id" && sel.letters === "wu");
  check("id= current is exact", sel.options.find((o) => o.current)?.clause === "id=wu");
  const within = sel.options.find((o) => o.clause === "id:wu");
  check("id within rewrite", within?.query === "id:wu t:instant", within?.query);
  check("id>= offered for multicolor", sel.options.some((o) => o.clause === "id>=wu"));
}

// Mono id has no id>= option; letters are WUBRG-sorted for display lookup.
{
  const [sel] = getColorSemanticSelectors("id:gr");
  check("letters wubrg-sorted", sel?.letters === "rg", sel?.letters);
  const [mono] = getColorSemanticSelectors("id:r");
  check("mono id has two options", mono.options.length === 2);
}

// Both c and id present → two selectors; negated clauses ignored.
{
  const both = getColorSemanticSelectors("c:r id:wub");
  check("both fields detected", both.length === 2);
  check("negated ignored", getColorSemanticSelectors("-c:r t:creature").length === 0);
  check("no color → no selector", getColorSemanticSelectors("t:creature o:draw").length === 0);
}

// Printing preference selector: replaces in place, prepends when absent, "" removes, aliases canonicalized.
{
  const withBest = getPreferSelector("prefer:best t:artifact game:paper");
  check("prefer current = best", withBest.current === "best");
  const cheap = withBest.options.find((o) => o.value === "eur-low")!;
  check("prefer replaced in place", cheap.query === "prefer:eur-low t:artifact game:paper", cheap.query);
  const none = withBest.options.find((o) => o.value === "")!;
  check("prefer removable", none.query === "t:artifact game:paper", none.query);

  const absent = getPreferSelector("t:artifact game:paper");
  check("no prefer → current empty", absent.current === "" && absent.options.find((o) => o.current)?.value === "");
  const oldest = absent.options.find((o) => o.value === "oldest")!;
  check("prefer prepended when absent", oldest.query === "prefer:oldest t:artifact game:paper", oldest.query);

  const mid = getPreferSelector("t:artifact prefer:ub game:paper");
  check("prefer alias canonicalized", mid.current === "universesbeyond");
  const newest = mid.options.find((o) => o.value === "newest")!;
  check("mid-query prefer replaced", newest.query === "t:artifact prefer:newest game:paper", newest.query);

  const unknown = getPreferSelector("prefer:foo t:artifact");
  check("unknown prefer surfaced as option", unknown.options.some((o) => o.value === "foo" && o.current));

  // Scryfall applies the last prefer: token; the selector must read that one and collapse the rest.
  const dup = getPreferSelector("prefer:best t:artifact game:paper prefer:usd-low");
  check("duplicate prefer → last wins", dup.current === "usd-low");
  const dupOldest = dup.options.find((o) => o.value === "oldest")!;
  check("duplicate prefer collapsed to one", dupOldest.query === "t:artifact game:paper prefer:oldest", dupOldest.query);
  const dupNone = dup.options.find((o) => o.value === "")!;
  check("duplicate prefer all removed", dupNone.query === "t:artifact game:paper", dupNone.query);
}

// ---------------------------------------------------------------------------------------------
// tokenizeQuery (chips) — built on the shared parser in lib/scryfall/query-ast.ts
// ---------------------------------------------------------------------------------------------

const chips = (q: string) => tokenizeQuery(q).map((t) => `${t.type}:${t.raw}`).join(" | ");
/** True when the chips, read left to right with only whitespace between them, spell the query. */
function chipsCoverQuery(q: string): boolean {
  let pos = 0;
  for (const chip of tokenizeQuery(q)) {
    while (pos < q.length && /\s/.test(q[pos])) pos += 1;
    if (!q.startsWith(chip.raw, pos)) return false;
    pos += chip.raw.length;
  }
  while (pos < q.length && /\s/.test(q[pos])) pos += 1;
  return pos === q.length;
}

{
  check(
    "chips: fields, group, or, negation",
    chips('t:creature (o:"draw a card" or kw:flying) -c:r') ===
      'field:t:creature | group:( | field:o:"draw a card" | logical:or | field:kw:flying | group:) | field:-c:r'
  );
  const neg = tokenizeQuery("-c:r")[0];
  check("chips: field parts", neg.field === "c" && neg.op === ":" && neg.value === "r" && neg.negated === true);
  const quoted = tokenizeQuery('o:"draw a card"')[0];
  check("chips: quoted value kept as written", quoted.value === '"draw a card"', quoted.value);
  check("chips: field lowercased, op kept", tokenizeQuery("T:Elf")[0].field === "t" && tokenizeQuery("mv>=3")[0].op === ">=");
  check("chips: regex value is one chip", chips("o:/(?<!this )creature[^.]*die/ t:creature") === "field:o:/(?<!this )creature[^.]*die/ | field:t:creature", chips("o:/(?<!this )creature[^.]*die/ t:creature"));
  check("chips: single-quoted value is one chip", chips(`name:'Henzie "Toolbox" Torre' t:creature`) === `field:name:'Henzie "Toolbox" Torre' | field:t:creature`);
  check("chips: parens inside quotes are not groups", chips('name:"B.F.M. (Big Furry Monster)"') === 'field:name:"B.F.M. (Big Furry Monster)"');
  check("chips: exact name is one text chip", chips('!"Fire // Ice" t:instant') === 'text:!"Fire // Ice" | field:t:instant');
  check("chips: negated group is one -( chip", chips("-(t:creature or t:instant) c:r") === "group:-( | field:t:creature | logical:or | field:t:instant | group:) | field:c:r", chips("-(t:creature or t:instant) c:r"));
  check("chips: and is logical in any case", chips("a and b AND c") === "text:a | logical:and | text:b | logical:AND | text:c");
  check("chips: != is a field operator", tokenizeQuery("c!=r")[0].type === "field" && tokenizeQuery("c!=r")[0].op === "!=");
  check("chips: or glued to a quote splits (live Scryfall behavior)", chips('t:goblin or"king"') === 'field:t:goblin | logical:or | text:"king"');
  check("chips: quote glued to a word stays (live Scryfall behavior)", chips('goblin"king" o:draw"card"') === 'text:goblin"king" | field:o:draw"card"');
  check("chips: plain words", chips("Urza's Fire // Ice") === "text:Urza's | text:Fire | text:// | text:Ice");
  check("chips: unmatched and unclosed parens still show", chips("a) (b") === "text:a | group:) | group:( | text:b");
  check("chips: dangling or still shows", chips("a or") === "text:a | logical:or");
  check("chips: unterminated quote is one chip", chips('o:"draw t:creature') === 'field:o:"draw t:creature');
  check("chips: empty and whitespace-only queries give no chips", tokenizeQuery("").length === 0 && tokenizeQuery("   ").length === 0);
  check("chips: 3000 nested parens do not throw", tokenizeQuery("(".repeat(3000) + "a" + ")".repeat(3000)).length === 6001);

  check("chips: no-break space separates terms", chips("t:creature\u00a0o:draw") === "field:t:creature | field:o:draw", chips("t:creature\u00a0o:draw"));
  check("chips: em space / ideographic space separate terms", chips("t:creature\u2003o:draw\u3000c:r") === "field:t:creature | field:o:draw | field:c:r");
  const title = (q: string) => getTokenMetadata(tokenizeQuery(q)[0], "").title;
  check("chip titles: quoted oracle text shown once-quoted", title('o:"draw a card"') === 'Oracle text: "draw a card"', title('o:"draw a card"'));
  check("chip titles: negated quoted oracle text", title('-o:"x"') === 'Oracle text excludes "x"');
  check("chip titles: single-quoted value", title("o:'x'") === 'Oracle text: "x"');
  check("chip titles: regex keeps slashes", title("o:/re/") === 'Oracle text: "/re/"');
  check("chip titles: quoted set code", title('set:"neo"') === "Set: NEO");
  check("chip titles: quoted type", title('t:"legendary creature"') === "Type: Legendary creature");
  check("chip titles: quoted unknown function tag", title('function:"pure draw"') === "Tag: pure draw");
  check("chip titles: negated quoted name", title('-"Lightning Bolt"') === 'Excluding "Lightning Bolt"', title('-"Lightning Bolt"'));
  check("chip titles: bare values unchanged", title("o:draw") === 'Oracle text: "draw"' && title("set:neo") === "Set: NEO");
  check("chip titles: and / -( / !=", getTokenMetadata(tokenizeQuery("a and b")[1], "").title === "AND" && getTokenMetadata(tokenizeQuery("-(a)")[0], "").title === "Group (open, excluded)" && getTokenMetadata(tokenizeQuery("mv!=3")[0], "").title === "Mana Value: not 3");
  check("chip titles: unchanged for common fields", getTokenMetadata(tokenizeQuery("-c:r")[0], "").title === "Excluding Color: Red" && getTokenMetadata(tokenizeQuery("mv>=3")[0], "").title === "Mana Value: at least 3");

  const pages = seo.pages as { scryfallQuery: string }[];
  const uncovered = pages.filter((p) => !chipsCoverQuery(p.scryfallQuery));
  check(`chips cover all ${pages.length} SEO queries exactly (whitespace aside)`, uncovered.length === 0, uncovered[0]?.scryfallQuery);
  const oddChips = pages.flatMap((p) => tokenizeQuery(p.scryfallQuery)).filter((t) => t.type === "text" && !/^(or|and)$/i.test(t.raw));
  check("no SEO query has a plain-text chip (every clause is a field)", oddChips.length === 0, oddChips[0]?.raw);
}

console.log(`\nAll ${passed} query-token self-checks passed.`);
