/**
 * query-explain self-check (no network): the /explain summary sentence and warnings.
 *
 * Run: tsx lib/query-explain.test.ts
 */

import assert from "node:assert/strict";
import seo from "@/data/seo-queries.json";
import { explainQuery } from "@/lib/query-explain";

let passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed += 1;
  console.log(`[PASS] ${name}`);
}

const summary = (query: string, expected: string) => {
  const actual = explainQuery(query).summary;
  check(`summary ${query}`, actual === expected, actual);
};

const severities = (query: string) => explainQuery(query).warnings.map((w) => w.severity).join(",");

summary("", "");
summary("   ", "");
summary("()", "");
summary("t:creature", "Cards that are of type creature.");
summary("-t:creature", "Cards that are not of type creature.");
summary("dragon", 'Cards that have "dragon" in their name.');
summary('!"Lightning Bolt"', 'Cards that are named exactly "Lightning Bolt".');
summary('o:"draw a card"', 'Cards that have "draw a card" in their rules text.');
summary("o:/^draw/", "Cards that have rules text matching /^draw/.");
summary("c:r", "Cards that are red.");
summary("c=wu", "Cards that are exactly azorius (white + blue).");
summary("c!=r", "Cards that are not red.");
summary("-c!=r", "Cards that are red.");
summary("id<=wu", "Cards that have color identity at most azorius (white + blue).");
summary("ci:g", "Cards that have color identity green.");
summary("mv>=3", "Cards that have mana value at least 3.");
summary("mv=3", "Cards that have mana value exactly 3.");
summary("pow>tou", "Cards that have power greater than tou.");
summary("f:modern", "Cards that are legal in Modern.");
summary("is:commander", "Cards that are valid commander.");
summary("not:foil", "Cards that are not available in foil.");
summary("-not:foil", "Cards that are available in foil.");
summary("r>=rare", "Cards that have rarity at least rare.");
summary("a:avon", "Cards that were illustrated by avon.");
summary("game:paper", "Cards that are available in paper.");
summary("foo:bar", "");
summary("-foo:bar t:a", "Cards that are of type a.");
summary("lore:1", "Cards that match lore:1.");
summary("-lore:1", "Cards that do not match lore:1.");
summary("t:", "Cards that match t:.");
summary("t:goblin c:r", "Cards that are of type goblin and are red.");
summary("t:goblin c:r mv<=2", "Cards that are of type goblin, are red, and have mana value at most 2.");
summary("c:r or c:g", "Cards that are red or are green.");
summary(
  'c:r (o:"draw" or kw:flying)',
  'Cards that are red and either have "draw" in their rules text or have the keyword flying.'
);
summary("t:a c:r or t:b", "Cards that are of type a and are red, or are of type b.");
summary("-(t:a or t:b) c:r", "Cards that are not (cards that are of type a or are of type b) and are red.");
summary("!(t:goblin)", "Cards that are of type goblin.");
summary("(t:a)", "Cards that are of type a.");
summary("t:a order:name dir:desc", "Cards that are of type a, sorted by name, in descending order.");
summary("order:name", "All cards, sorted by name.");
summary("t:goblin (", "Cards that are of type goblin.");

// Scryfall refuses these outright (measured live).
for (const query of ["t:creature (kw:flying", "t:creature )", "!(t:goblin)"]) {
  check(`${query} is an error`, severities(query) === "error", severities(query));
}

// Scryfall accepts these: ignored, or read in a way that may surprise (measured live).
for (const query of ["t:goblin or", "or or", "t:goblin ()", 't:goblin o:"draw', "t:goblin foo:bar", "t:goblin t:"]) {
  check(`${query} is only a warning`, /^warning(,warning)*$/.test(severities(query)), severities(query));
}

check("clean query has no warnings", severities('t:creature (o:"a b" or kw:flying) -c:r mv>=3') === "");
check("U+200B-separated query has no warnings", severities("t:creature\u200bo:draw") === "");
check("errors sort first", severities("or t:a (t:b") === "error,warning", severities("or t:a (t:b"));
check("valid late-added fields are not unknown", severities("ci:wu commander:wu dir:asc lore:1 flavour:fire collector:1") === "");
check(
  "unclosed group warning names the problem",
  explainQuery("t:creature (kw:flying or").warnings.some((w) => w.message.includes("closing parenthesis"))
);
check("3000 nested groups do not overflow", explainQuery(`${"(".repeat(3000)}t:a${")".repeat(3000)}`).summary === "Cards that are of type a.");

// Parts: one per chip, in order, each carrying its own problems.
{
  const parts = (query: string) => explainQuery(query).parts;
  const raws = (query: string) => parts(query).map((p) => p.raw).join(" ");
  const flagged = (query: string) => parts(query).filter((p) => p.warnings.length > 0).map((p) => p.raw).join(" ");

  check("parts follow the query", raws('t:creature (o:"a b" or kw:flying) -c:r') === 't:creature ( o:"a b" or kw:flying ) -c:r', raws('t:creature (o:"a b" or kw:flying) -c:r'));
  check("empty query has no parts", parts("  ").length === 0);
  check("regex stays one part", parts("o:/(?<!this )creature[^.]*die/ t:creature").length === 2);
  check("parts explain themselves", parts("t:creature")[0].title === "Type: Creature" && parts("t:creature")[0].description.length > 0);

  const depths = parts("a (b (c) d) e").map((p) => p.depth).join("");
  check("depth follows the groups", depths === "001121100", depths);
  check("-( opens a group too", parts("-(a) b").map((p) => p.depth).join("") === "0100", parts("-(a) b").map((p) => p.depth).join(""));
  check("an unmatched ) stays at the top", parts("a ) b").map((p) => p.depth).join("") === "000");

  const repeat = parts("t:a t:b or c:r or c:g");
  check("a repeated explanation shows once", repeat.map((p) => p.firstMention).join() === "true,false,true,true,false,false", repeat.map((p) => p.firstMention).join());

  check("unclosed group sits on its (", flagged("t:creature (kw:flying") === "(", flagged("t:creature (kw:flying"));
  check("unclosed negated group sits on its -(", flagged("t:a -(c:r") === "-(", flagged("t:a -(c:r"));
  check("unmatched ) sits on the )", flagged("t:creature )") === ")", flagged("t:creature )"));
  check("dangling or sits on the or", flagged("t:goblin or") === "or", flagged("t:goblin or"));
  check("exact group sits on the !", flagged("!(t:goblin)") === "!", flagged("!(t:goblin)"));
  check("unterminated value sits on its term", flagged('t:a o:"draw') === 'o:"draw', flagged('t:a o:"draw'));
  check("unknown field sits on its term", flagged("t:a foo:bar") === "foo:bar", flagged("t:a foo:bar"));
  check("empty value sits on its term", flagged("t:a c:") === "c:", flagged("t:a c:"));
  check("empty group sits on its (", flagged("t:a ()") === "(", flagged("t:a ()"));

  for (const query of ["or t:a (t:b", "a ) ( or", "() or ()", '-( "x', "t:a foo:bar ( or c:", "!(a) )"]) {
    const { warnings, parts: all } = explainQuery(query);
    const placed = all.reduce((sum, part) => sum + part.warnings.length, 0);
    check(`every warning has a part: ${query}`, placed === warnings.length, `${placed} of ${warnings.length}`);
  }
}

// Every stored query reads as a sentence and raises no false alarm.
{
  const pages = (seo as { pages: { scryfallQuery: string }[] }).pages;
  const unreadable = pages.filter((p) => !/^(Cards that|All cards).*\.$/s.test(explainQuery(p.scryfallQuery).summary));
  check(`all ${pages.length} SEO queries get a summary`, unreadable.length === 0, unreadable[0]?.scryfallQuery);
  const alarmed = pages.filter((p) => explainQuery(p.scryfallQuery).warnings.length > 0);
  check(`no warnings on ${pages.length} SEO queries`, alarmed.length === 0, alarmed[0]?.scryfallQuery);
}

console.log(`\nAll ${passed} query-explain self-checks passed.`);
