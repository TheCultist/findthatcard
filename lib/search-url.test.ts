/**
 * Search URL and sort parsing self-checks (pure, no network).
 *
 * Run: tsx lib/search-url.test.ts
 */

import assert from "node:assert/strict";
import { buildSearchUrl, parsePage, searchFromUrl } from "@/lib/search-url";
import { normalizeSort, parseSortInput, sortKeyOf } from "@/lib/search-sort";

let checks = 0;
const pass = (label: string) => {
  checks++;
  console.log(`[PASS] ${label}`);
};

// Without a sort the URLs are exactly what they were before sorting existed.
assert.equal(buildSearchUrl("white creatures"), "/search/white-creatures");
assert.equal(buildSearchUrl("white creatures", 3), "/search/white-creatures?page=3");
assert.equal(buildSearchUrl("t:creature c:r"), "/search?q=t%3Acreature%20c%3Ar");
assert.equal(buildSearchUrl("t:creature c:r", 2), "/search?q=t%3Acreature%20c%3Ar&page=2");
assert.equal(buildSearchUrl("   "), "/search");
pass("unsorted URLs are unchanged");

assert.equal(buildSearchUrl("white creatures", 1, { by: "cmc", dir: "desc" }), "/search/white-creatures?sort=cmc&dir=desc");
assert.equal(
  buildSearchUrl("t:creature", 2, { by: "usd", dir: "asc" }),
  "/search?q=t%3Acreature&page=2&sort=usd&dir=asc"
);
assert.equal(buildSearchUrl("t:creature", 1, { by: "name", dir: "asc" }), "/search?q=t%3Acreature", "default sort left out");
pass("a non-default sort is added as sort + dir; name ascending is left out");

for (const [query, page, sort] of [
  ["white creatures", 1, null],
  ["white creatures", 4, { by: "released", dir: "desc" }],
  ["t:creature c:r", 2, { by: "cmc", dir: "asc" }],
  ["o:\"draw a card\"", 1, { by: "name", dir: "desc" }],
] as const) {
  const back = searchFromUrl(buildSearchUrl(query, page, sort));
  assert.deepEqual(back, { query, page, sort });
}
pass("query, page and sort round-trip through the URL");

assert.equal(parseSortInput("cmc", undefined)?.dir, "asc");
assert.equal(parseSortInput("power", "desc"), null, "unknown key");
assert.equal(parseSortInput(undefined, "desc"), null, "dir alone");
assert.equal(parseSortInput(42, "asc"), null, "wrong type");
assert.deepEqual(parseSortInput("usd", "sideways"), { by: "usd", dir: "asc" }, "bad dir falls back to ascending");
assert.equal(searchFromUrl("/search/white-creatures?sort=banana").sort, null);
assert.equal(parsePage("0"), 1);
assert.equal(parsePage("abc"), 1);
pass("unusable sort or page values mean the default, never an error");

assert.equal(normalizeSort({ by: "name", dir: "asc" }), null);
assert.equal(sortKeyOf(null), "");
assert.equal(sortKeyOf({ by: "cmc", dir: "desc" }), "cmc:desc");
pass("name ascending normalises to no sort");

console.log(`\nAll ${checks} search-url self-checks passed.`);
