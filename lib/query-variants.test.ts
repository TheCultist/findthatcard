/**
 * query-variants self-check (no network): the chip menus for mana value, color identity and
 * format legality, and the query each option rewrites.
 *
 * Run: tsx lib/query-variants.test.ts
 */

import assert from "node:assert/strict";
import {
  applyCatalogSelection,
  catalogCurrentValue,
  catalogKindOf,
  getTokenVariants,
  type QueryVariantGroup,
} from "@/lib/query-variants";
import { tokenizeQuery, type QueryToken } from "@/lib/query-tokens";

let passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed += 1;
  console.log(`[PASS] ${name}`);
}

/** Variant groups of the chip whose raw text is `raw`. */
function variantsOf(query: string, raw: string): QueryVariantGroup[] {
  const token = tokenizeQuery(query).find((t) => t.raw === raw);
  assert.ok(token, `chip ${raw} not found in ${query}`);
  return getTokenVariants(token as QueryToken, query);
}

const group = (groups: QueryVariantGroup[], title: string) => groups.find((g) => g.title === title);
/** The field-specific groups: everything but the Exclude/Remove group every term chip gets. */
const fieldGroups = (groups: QueryVariantGroup[]) => groups.filter((g) => g.title !== "Term");
const variant = (groups: QueryVariantGroup[], title: string, label: string) =>
  group(groups, title)?.variants.find((v) => v.label === label);
const clauses = (groups: QueryVariantGroup[], title: string) => group(groups, title)?.variants.map((v) => v.clause) ?? [];

// Mana value: every comparator, current marked, query rewritten in place.
{
  const groups = variantsOf("t:creature mv>=4 game:paper", "mv>=4");
  check("mv has Comparison, Value and Term groups", groups.map((g) => g.title).join(",") === "Comparison,Value,Term");
  check(
    "mv comparators",
    clauses(groups, "Comparison").join(" ") === "mv=4 mv:4 mv!=4 mv<4 mv<=4 mv>4 mv>=4",
    clauses(groups, "Comparison").join(" ")
  );
  const current = group(groups, "Comparison")!.variants.filter((v) => v.current);
  check("mv current is >=", current.length === 1 && current[0].clause === "mv>=4");
  const gt = group(groups, "Comparison")!.variants.find((v) => v.clause === "mv>4")!;
  check("mv rewrite keeps the rest of the query", gt.query === "t:creature mv>4 game:paper", gt.query);
  check("mv option says what it changes", /above 4/.test(gt.description), gt.description);
  check("mv parity values", clauses(groups, "Value").join(" ") === "mv:even mv:odd", clauses(groups, "Value").join(" "));
}

// Aliases and negation are kept as written; the explanation mentions the minus.
{
  const groups = variantsOf("-cmc<=2 f:modern", "-cmc<=2");
  check("cmc alias kept", clauses(groups, "Comparison").includes("-cmc>2"));
  const lt = group(groups, "Comparison")!.variants.find((v) => v.clause === "-cmc<2")!;
  check("negated rewrite", lt.query === "-cmc<2 f:modern", lt.query);
  check("negated description notes the minus", /leading -/.test(lt.description));
}

// Non-numeric mana values: no comparators, parity still offered and marked current.
{
  const groups = variantsOf("mv:even", "mv:even");
  check("mv:even has no comparators", group(groups, "Comparison") === undefined);
  check("mv:even current", group(groups, "Value")!.variants.find((v) => v.current)?.clause === "mv:even");
  const odd = group(groups, "Value")!.variants.find((v) => v.clause === "mv:odd")!;
  check("mv:even → mv:odd", odd.query === "mv:odd");
  const fromCompare = variantsOf("mv>3", "mv>3");
  check("parity from a comparison uses :", clauses(fromCompare, "Value")[0] === "mv:even");
}

// Color identity: every comparator plus the c: swap; names resolve from the letters.
{
  const groups = variantsOf("id:wub t:instant", "id:wub");
  check(
    "id comparators",
    clauses(groups, "Comparison").join(" ") === "id:wub id<=wub id=wub id<wub id>=wub id>wub id!=wub",
    clauses(groups, "Comparison").join(" ")
  );
  const fits = group(groups, "Comparison")!.variants.find((v) => v.current)!;
  check("id: current", fits.clause === "id:wub");
  check("id option names the shard", /Esper/.test(fits.description), fits.description);
  const exact = group(groups, "Comparison")!.variants.find((v) => v.clause === "id=wub")!;
  check("id= rewrite", exact.query === "id=wub t:instant", exact.query);
  check("id → c swap", clauses(groups, "Field").join(" ") === "c:wub id:wub");
  check("id field current", !group(groups, "Field")!.variants[0].current && group(groups, "Field")!.variants[1].current);
}

// Identity edge cases: colorless has no menu; a named color works; unknown values have none.
{
  check("id:c has no field menu", fieldGroups(variantsOf("id:c", "id:c")).length === 0);
  check("id:esper named", clauses(variantsOf("id:esper", "id:esper"), "Comparison").includes("id=esper"));
  check("id:xyz unknown", fieldGroups(variantsOf("id:xyz", "id:xyz")).length === 0);
  check("commander alias kept", clauses(variantsOf("commander:rg", "commander:rg"), "Comparison").includes("commander>=rg"));
}

// Format: every format as a value, legality kinds as fields, alias kept.
{
  const groups = variantsOf("f:modern mv<=2", "f:modern");
  const formats = group(groups, "Format")!.variants;
  check("format list offered", formats.length > 20 && formats.some((v) => v.clause === "f:pauper"));
  check("format current", formats.find((v) => v.current)?.clause === "f:modern");
  const legacy = formats.find((v) => v.clause === "f:legacy")!;
  check("format rewrite", legacy.query === "f:legacy mv<=2", legacy.query);
  check("format option names the format", /Legacy/.test(legacy.description), legacy.description);
  check("legality kinds", clauses(groups, "Legality").join(" ") === "f:modern banned:modern restricted:modern");
  check("legality current", group(groups, "Legality")!.variants.find((v) => v.current)?.clause === "f:modern");
}

{
  const groups = variantsOf("banned:legacy", "banned:legacy");
  check("banned values use banned:", clauses(groups, "Format").includes("banned:vintage"));
  check("banned → legal uses f:", clauses(groups, "Legality")[0] === "f:legacy");
  const described = group(groups, "Format")!.variants.find((v) => v.clause === "banned:vintage")!;
  check("banned wording", /banned in Vintage/.test(described.description), described.description);
  const legal = variantsOf("legal:standard", "legal:standard");
  check("legal: alias kept", clauses(legal, "Legality")[0] === "legal:standard" && clauses(legal, "Format").includes("legal:pioneer"));
}

// Chips without a field menu: text chips and fields without a builder still get Exclude/Remove.
{
  check("text chip", variantsOf("goblin mv=1", "goblin").map((g) => g.title).join() === "Term");
  check("field without builder", variantsOf("o:draw", "o:draw").map((g) => g.title).join() === "Term");
  check("empty value", variantsOf("mv: t:creature", "mv:").map((g) => g.title).join() === "Term");
  check("unterminated value", variantsOf('f:"modern', 'f:"modern').length === 0);
  check("lone - has no menu", variantsOf("- t:creature", "-").length === 0);
}

// Exclude / Include: a leading -, or is: ↔ not: for flags.
{
  const groups = variantsOf("t:creature mv>=4 game:paper", "mv>=4");
  const exclude = variant(groups, "Term", "Exclude")!;
  check("exclude clause", exclude.clause === "-mv>=4" && exclude.query === "t:creature -mv>=4 game:paper", exclude.query);
  const include = variant(variantsOf("t:creature -mv>=4", "-mv>=4"), "Term", "Include")!;
  check("include clause", include.clause === "mv>=4" && include.query === "t:creature mv>=4", include.query);
  check("text exclude", variant(variantsOf("goblin t:creature", "goblin"), "Term", "Exclude")!.query === "-goblin t:creature");
  check("exact name exclude", variant(variantsOf('!"Lightning Bolt"', '!"Lightning Bolt"'), "Term", "Exclude")!.clause === '-!"Lightning Bolt"');
  check("quoted exclude", variant(variantsOf('o:"draw a card" t:instant', 'o:"draw a card"'), "Term", "Exclude")!.query === '-o:"draw a card" t:instant');
  const isFlip = variant(variantsOf("is:commander t:creature", "is:commander"), "Term", "Exclude")!;
  check("is: flips to not:", isFlip.clause === "not:commander" && /not:/.test(isFlip.description), isFlip.description);
  const notFlip = variant(variantsOf("not:reprint", "not:reprint"), "Term", "Exclude")!;
  check("not: flips to is:", notFlip.clause === "is:reprint");
  check("-is: includes by dropping the -", variant(variantsOf("-is:reprint", "-is:reprint"), "Term", "Include")!.clause === "is:reprint");
  check("IS: keeps case", variant(variantsOf("IS:reprint", "IS:reprint"), "Term", "Exclude")!.clause === "NOT:reprint");
  check("exclude never current", groups.every((g) => g.title !== "Term" || g.variants.every((v) => !v.current)));
}

// Remove: the term goes, and so does whatever it would leave dangling.
{
  const remove = (query: string, raw: string) => variant(variantsOf(query, raw), "Term", "Remove this term")?.query;
  check("remove middle term", remove("t:creature mv>=4 game:paper", "mv>=4") === "t:creature game:paper");
  check("remove first term", remove("t:creature mv>=4", "t:creature") === "mv>=4");
  check("remove last term", remove("t:creature mv>=4", "mv>=4") === "t:creature");
  check("remove or operand", remove("t:creature (kw:flying or kw:trample)", "kw:flying") === "t:creature (kw:trample)");
  check("remove both-sided or", remove("kw:flying or kw:trample", "kw:flying") === "kw:trample");
  check("remove from three-way or", remove("a:x or b:y or c:z", "b:y") === "a:x or c:z");
  check("remove empties a group", remove("t:creature (kw:flying) mv<3", "kw:flying") === "t:creature mv<3");
  check("remove empties a negated group", remove("t:creature -(kw:flying) mv<3", "kw:flying") === "t:creature mv<3");
  check("remove collapses spaces", remove("t:creature   mv>=4   game:paper", "mv>=4") === "t:creature game:paper");
  check("remove nested", remove("a:x ((b:y or c:z) d:w)", "c:z") === "a:x ((b:y) d:w)");
  check("remove written and", remove("kw:flying and kw:trample", "kw:trample") === "kw:flying");
  check("remove keeps quotes", remove('o:"draw a card" t:instant', "t:instant") === 'o:"draw a card"');
  check("remove unclosed group operand", remove("t:creature (kw:flying or", "kw:flying") === "t:creature");
  check("only term cannot be removed", variant(variantsOf("mv>=4", "mv>=4"), "Term", "Remove this term") === undefined);
  check("remove description", /parentheses/.test(variant(variantsOf("a:x b:y", "a:x"), "Term", "Remove this term")!.description));
}

// Parenthesis chips negate or remove their group.
{
  const query = "t:creature (kw:flying or kw:trample) mv<3";
  const open = variantsOf(query, "(");
  check("group chip has Group only", open.map((g) => g.title).join() === "Group");
  const exclude = variant(open, "Group", "Exclude the group")!;
  check("group exclude", exclude.clause === "-(" && exclude.query === "t:creature -(kw:flying or kw:trample) mv<3", exclude.query);
  const remove = variant(open, "Group", "Remove the group")!;
  check("group remove", remove.query === "t:creature mv<3", remove.query);
  const close = variantsOf(query, ")");
  check("close chip, same group", variant(close, "Group", "Exclude the group")!.query === exclude.query && variant(close, "Group", "Remove the group")!.query === remove.query);
  const negatedQuery = "t:creature -(kw:flying or kw:trample) mv<3";
  const include = variant(variantsOf(negatedQuery, "-("), "Group", "Include the group")!;
  check("group include", include.clause === "(" && include.query === query, include.query);
  check("group include from )", variant(variantsOf(negatedQuery, ")"), "Group", "Include the group")!.query === query);
  const inner = variantsOf("a:x ((b:y) or c:z)", "(").length;
  check("outer paren picks the outer group", inner === 1 && variant(variantsOf("a:x ((b:y) or c:z)", "("), "Group", "Remove the group")!.query === "a:x");
  check("only group cannot be removed", variant(variantsOf("(a:x or b:y)", "("), "Group", "Remove the group") === undefined);
  check("unmatched ) has no menu", variantsOf("a:x )", ")").length === 0);
}

// Other numeric fields share the comparator group; aliases and nouns differ, odd values get nothing.
{
  const pow = variantsOf("t:creature pow>=4", "pow>=4");
  check("pow comparators", clauses(pow, "Comparison").join(" ") === "pow=4 pow:4 pow!=4 pow<4 pow<=4 pow>4 pow>=4", clauses(pow, "Comparison").join(" "));
  check("pow has no Value group", group(pow, "Value") === undefined && group(pow, "Term") !== undefined);
  check("pow noun", /power above 4/i.test(group(pow, "Comparison")!.variants.find((v) => v.clause === "pow>4")!.description));
  check("pow=* has no field menu", fieldGroups(variantsOf("pow=*", "pow=*")).length === 0);
  check("pow>tou has no field menu", fieldGroups(variantsOf("pow>tou", "pow>tou")).length === 0);
  for (const [raw, noun] of [
    ["toughness<=2", "toughness"],
    ["loy>=4", "starting loyalty"],
    ["def>3", "defense"],
    ["year<2000", "release year"],
    ["usd<=0.5", "USD price"],
    ["eur>10", "EUR price"],
    ["tix<1", "MTGO ticket price"],
  ] as const) {
    const groups = variantsOf(`${raw} t:creature`, raw);
    const comps = group(groups, "Comparison")!.variants;
    check(`${raw} seven comparators`, comps.length === 7 && comps.filter((v) => v.current).length === 1);
    check(`${raw} noun`, comps.some((v) => v.description.toLowerCase().includes(noun.toLowerCase())), comps[0].description);
    check(`${raw} field kept`, comps.every((v) => v.clause.startsWith(raw.match(/^[a-z]+/)![0])));
  }
}

// Color: comparators with c: semantics, mono vs multi wording, the id: swap.
{
  const groups = variantsOf("c:rg t:creature", "c:rg");
  check("c comparators", clauses(groups, "Comparison").join(" ") === "c:rg c>=rg c=rg c<=rg c<rg c>rg c!=rg", clauses(groups, "Comparison").join(" "));
  const includes = group(groups, "Comparison")!.variants.find((v) => v.current)!;
  check("c: current", includes.clause === "c:rg" && /Gruul/.test(includes.description));
  const exact = group(groups, "Comparison")!.variants.find((v) => v.clause === "c=rg")!;
  check("c= multi wording", /Exactly Gruul/.test(exact.description), exact.description);
  check("c → id swap", clauses(groups, "Field").join(" ") === "c:rg id:rg");
  check("c field current", group(groups, "Field")!.variants[0].current && !group(groups, "Field")!.variants[1].current);
  const mono = variantsOf("c=r", "c=r");
  check("c= mono wording", /Mono-red/.test(group(mono, "Comparison")!.variants.find((v) => v.clause === "c=r")!.description));
  check("c:c has no field menu", fieldGroups(variantsOf("c:c", "c:c")).length === 0);
  check("c:m has no field menu", fieldGroups(variantsOf("c:m", "c:m")).length === 0);
  check("color alias kept", clauses(variantsOf("color:wu", "color:wu"), "Comparison").includes("color=wu"));
}

// Rarity: ordered comparators and the value list; short and long forms.
{
  const groups = variantsOf("r:rare t:creature", "r:rare");
  check("rarity comparators", clauses(groups, "Comparison").join(" ") === "r:rare r=rare r!=rare r>rare r>=rare r<rare r<=rare", clauses(groups, "Comparison").join(" "));
  const atLeast = group(groups, "Comparison")!.variants.find((v) => v.clause === "r>=rare")!;
  check("r>= lists rarities", /Rare or rarer: Rare, Mythic Rare/.test(atLeast.description), atLeast.description);
  const rarer = group(groups, "Comparison")!.variants.find((v) => v.clause === "r>rare")!;
  check("r> lists mythic", /Mythic Rare\./.test(rarer.description), rarer.description);
  check("rarity values", clauses(groups, "Rarity").join(" ") === "r:common r:uncommon r:rare r:mythic r:special r:bonus");
  check("rarity current", group(groups, "Rarity")!.variants.find((v) => v.current)?.clause === "r:rare");
  const short = variantsOf("rarity>=u", "rarity>=u");
  check("short rarity recognised", group(short, "Rarity")!.variants.find((v) => v.current)?.clause === "rarity>=uncommon");
  check("short rarity comparator current", group(short, "Comparison")!.variants.find((v) => v.current)?.clause === "rarity>=u");
  const special = variantsOf("r:special", "r:special");
  check("special has values but no comparators", group(special, "Comparison") === undefined && group(special, "Rarity") !== undefined);
}

// is / not: field toggle plus every known property.
{
  const groups = variantsOf("is:commander t:creature", "is:commander");
  check("is → not", clauses(groups, "Field").join(" ") === "is:commander not:commander");
  check("is current", group(groups, "Field")!.variants[0].current);
  const not = group(groups, "Field")!.variants[1];
  check("not rewrite", not.query === "not:commander t:creature" && /valid commander/.test(not.description), not.description);
  check("properties listed", group(groups, "Property")!.variants.length > 30 && clauses(groups, "Property").includes("is:reprint"));
  check("property current", group(groups, "Property")!.variants.find((v) => v.current)?.clause === "is:commander");
  const fromNot = variantsOf("not:reprint", "not:reprint");
  check("not → is", clauses(fromNot, "Field")[0] === "is:reprint" && group(fromNot, "Field")!.variants[1].current);
  check("not wording", /not reprint/.test(group(fromNot, "Property")!.variants.find((v) => v.clause === "not:reprint")!.description));
  check("unknown flag still toggles", clauses(variantsOf("is:whatever", "is:whatever"), "Field").join(" ") === "is:whatever not:whatever");
}

// Fixed value lists: game, order, direction, unique.
{
  const game = variantsOf("t:creature game:paper", "game:paper");
  check("game values", clauses(game, "Platform").join(" ") === "game:paper game:arena game:mtgo");
  check("game current", group(game, "Platform")!.variants.find((v) => v.current)?.clause === "game:paper");
  const order = variantsOf("t:creature order:cmc", "order:cmc");
  check("order values", group(order, "Sort by")!.variants.length === 15 && clauses(order, "Sort by").includes("order:edhrec"));
  check("order current", group(order, "Sort by")!.variants.find((v) => v.current)?.clause === "order:cmc");
  const dir = variantsOf("order:cmc direction:desc", "direction:desc");
  check("direction values", clauses(dir, "Direction").join(" ") === "direction:asc direction:desc");
  check("dir alias kept", clauses(variantsOf("dir:asc", "dir:asc"), "Direction").join(" ") === "dir:asc dir:desc");
  const unique = variantsOf("unique:prints", "unique:prints");
  check("unique values", clauses(unique, "Show").join(" ") === "unique:cards unique:prints unique:art");
  check("unique current", group(unique, "Show")!.variants.find((v) => v.current)?.clause === "unique:prints");
  const unknown = variantsOf("game:xbox", "game:xbox");
  check("unknown value lists options, none current", group(unknown, "Platform")!.variants.every((v) => !v.current));
}

// Connectives: a written or/and swaps; implicit AND has no chip.
{
  const groups = variantsOf("t:creature (kw:flying or kw:trample) mv<3", "or");
  check("or → and offered", clauses(groups, "Connective").join(" ") === "and or");
  const and = group(groups, "Connective")!.variants[0];
  check("or → and rewrite", and.query === "t:creature (kw:flying and kw:trample) mv<3", and.query);
  check("or current", group(groups, "Connective")!.variants[1].current && !and.current);
  check("connective has no Term group", groups.length === 1);
  const fromAnd = variantsOf("kw:flying AND kw:trample", "AND");
  check("AND case-insensitive", group(fromAnd, "Connective")!.variants[0].current);
  check("and → or rewrite", group(fromAnd, "Connective")!.variants[1].query === "kw:flying or kw:trample");
  const second = tokenizeQuery("a:x or b:y or c:z").filter((t) => t.raw === "or")[1];
  check("second or rewrites in place", getTokenVariants(second, "a:x or b:y or c:z")[0].variants[0].query === "a:x or b:y and c:z");
}

// Catalog pickers: which chips have one, and how picked values rewrite the query.
{
  const tokenOf = (query: string, raw: string) => tokenizeQuery(query).find((t) => t.raw === raw)!;
  check("t: reads types", catalogKindOf(tokenOf("t:creature", "t:creature")) === "types");
  check("type alias reads types", catalogKindOf(tokenOf("type:goblin", "type:goblin")) === "types");
  check("kw: reads keywords", catalogKindOf(tokenOf("kw:flying", "kw:flying")) === "keywords");
  check("keyword alias", catalogKindOf(tokenOf("keyword:flying", "keyword:flying")) === "keywords");
  check("set aliases read sets", ["set:dmu", "s:dmu", "e:dmu", "edition:dmu"].every((raw) => catalogKindOf(tokenOf(raw, raw)) === "sets"));
  check("function aliases read Tagger function tags", ["function:ramp", "otag:ramp", "oracletag:ramp"].every((raw) => catalogKindOf(tokenOf(raw, raw)) === "functions"));
  check("other fields have no catalog", catalogKindOf(tokenOf("mv>=4", "mv>=4")) === undefined);
  check("text chips have no catalog", catalogKindOf(tokenOf("goblin", "goblin")) === undefined);
  check("current value unquoted lower-case", catalogCurrentValue(tokenOf('t:"Time Lord"', 't:"Time Lord"')) === "time lord");

  const q = "c:r t:goblin mv<3";
  const t = tokenOf(q, "t:goblin");
  check("single pick swaps in place", applyCatalogSelection(t, q, ["Elf"]) === "c:r t:Elf mv<3");
  check("several picks build an OR group", applyCatalogSelection(t, q, ["Elf", "Goblin"]) === "c:r (t:Elf or t:Goblin) mv<3");
  check("spaced value gets quotes", applyCatalogSelection(t, q, ["Time Lord", "Elf"]) === 'c:r (t:"Time Lord" or t:Elf) mv<3');
  check("duplicates and blanks dropped", applyCatalogSelection(t, q, ["Elf", "Elf", " ", "Goblin"]) === "c:r (t:Elf or t:Goblin) mv<3");
  check("empty pick does nothing", applyCatalogSelection(t, q, []) === "" && applyCatalogSelection(t, q, [" "]) === "");

  const nq = "-t:goblin mv<3";
  const nt = tokenOf(nq, "-t:goblin");
  check("negated single pick keeps -", applyCatalogSelection(nt, nq, ["Elf"]) === "-t:Elf mv<3");
  check("negated picks exclude the group", applyCatalogSelection(nt, nq, ["Elf", "Goblin"]) === "-(t:Elf or t:Goblin) mv<3");

  const kq = 'kw:"first strike" t:creature';
  const kt = tokenOf(kq, 'kw:"first strike"');
  check("quoted chip picks cleanly", applyCatalogSelection(kt, kq, ["Flying", "First strike"]) === '(kw:Flying or kw:"First strike") t:creature');
  const sq = "e:dmu r:rare";
  check("set alias kept", applyCatalogSelection(tokenOf(sq, "e:dmu"), sq, ["neo", "dmu"]) === "(e:neo or e:dmu) r:rare");
  const fq = "t:creature function:ramp id:g";
  check("function picks build an OR group", applyCatalogSelection(tokenOf(fq, "function:ramp"), fq, ["ramp", "mana-dork"]) === "t:creature (function:ramp or function:mana-dork) id:g");
  check("misplaced token picks nothing", applyCatalogSelection({ ...t, start: 0 }, q, ["Elf"]) === "");
}

// A token whose position does not match the query yields nothing instead of a wrong rewrite.
{
  const token: QueryToken = { raw: "mv>=4", start: 3, type: "field", field: "mv", op: ">=", value: "4" };
  check("misplaced token", getTokenVariants(token, "mv>=4 t:creature").length === 0);
}

// Every rewritten query still tokenizes to the same number of chips, with the new clause in place.
{
  const big = "t:creature (id:rg or c:w) mv>=4 pow>2 r>=u f:commander is:spell game:paper order:usd direction:desc unique:cards";
  for (const [query, raw] of [
    [big, "id:rg"],
    [big, "or"],
    [big, "c:w"],
    [big, "mv>=4"],
    [big, "pow>2"],
    [big, "r>=u"],
    [big, "f:commander"],
    [big, "is:spell"],
    [big, "game:paper"],
    [big, "order:usd"],
    [big, "direction:desc"],
    [big, "unique:cards"],
  ] as const) {
    const before = tokenizeQuery(query).length;
    for (const g of fieldGroups(variantsOf(query, raw))) {
      for (const v of g.variants) {
        const after = tokenizeQuery(v.query);
        assert.equal(after.length, before, `${v.query} changed chip count`);
        assert.ok(after.some((t) => t.raw === v.clause), `${v.query} lacks ${v.clause}`);
      }
    }
  }
  check("rewrites keep the query shape", true);
}

console.log(`\nquery-variants: ${passed} checks passed`);
