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
summary("foo:bar", "Cards that match foo:bar.");
summary("-foo:bar", "Cards that do not match foo:bar.");
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

// Every stored query reads as a sentence and raises no false alarm.
{
  const pages = (seo as { pages: { scryfallQuery: string }[] }).pages;
  const unreadable = pages.filter((p) => !/^(Cards that|All cards).*\.$/s.test(explainQuery(p.scryfallQuery).summary));
  check(`all ${pages.length} SEO queries get a summary`, unreadable.length === 0, unreadable[0]?.scryfallQuery);
  const alarmed = pages.filter((p) => explainQuery(p.scryfallQuery).warnings.length > 0);
  check(`no warnings on ${pages.length} SEO queries`, alarmed.length === 0, alarmed[0]?.scryfallQuery);
}

console.log(`\nAll ${passed} query-explain self-checks passed.`);
