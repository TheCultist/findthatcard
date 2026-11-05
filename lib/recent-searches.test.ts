/**
 * Recent searches self-checks (pure, no browser).
 *
 * Run: tsx lib/recent-searches.test.ts
 */

import assert from "node:assert/strict";
import {
  MAX_RECENT_SEARCHES,
  RECENT_SEARCHES_KEY,
  addRecentSearch,
  loadRecentSearches,
  normalizeSearch,
  removeRecentSearch,
  saveRecentSearches,
  type StorageLike,
} from "@/lib/recent-searches";

let checks = 0;
const pass = (label: string) => {
  checks++;
  console.log(`[PASS] ${label}`);
};

const memoryStorage = (initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } => {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
};

let list: string[] = [];
list = addRecentSearch(list, "t:creature");
list = addRecentSearch(list, "c:r");
assert.deepEqual(list, ["c:r", "t:creature"]);
pass("newest search goes first");

list = addRecentSearch(list, "  T:Creature  ");
assert.deepEqual(list, ["T:Creature", "c:r"]);
assert.equal(normalizeSearch("  red   DRAGONS "), "red dragons");
pass("a repeat (ignoring case and spaces) moves to the top with its latest spelling");

assert.deepEqual(addRecentSearch(list, "   "), list);
pass("empty queries are ignored");

let many: string[] = [];
for (let i = 1; i <= 12; i++) many = addRecentSearch(many, `query ${i}`);
assert.equal(many.length, MAX_RECENT_SEARCHES);
assert.equal(many[0], "query 12");
assert.equal(many.at(-1), "query 5");
pass(`at most ${MAX_RECENT_SEARCHES} entries, oldest dropped`);

assert.deepEqual(removeRecentSearch(["c:r", "t:creature"], "C:R"), ["t:creature"]);
pass("remove one entry");

const storage = memoryStorage();
assert.equal(saveRecentSearches(storage, ["c:r", "t:creature"]), true);
assert.deepEqual(loadRecentSearches(storage), ["c:r", "t:creature"]);
assert.deepEqual(loadRecentSearches(memoryStorage()), []);
pass("save and load round-trip; nothing stored reads as empty");

for (const raw of ["not json", "{\"a\":1}", "42", "null"]) {
  assert.deepEqual(loadRecentSearches(memoryStorage({ [RECENT_SEARCHES_KEY]: raw })), [], raw);
}
const tampered = JSON.stringify(["ok", 7, null, "", "  ", { q: "x" }, "OK", ...Array.from({ length: 20 }, (_, i) => `n${i}`)]);
const cleaned = loadRecentSearches(memoryStorage({ [RECENT_SEARCHES_KEY]: tampered }));
assert.equal(cleaned[0], "ok");
assert.equal(cleaned.length, MAX_RECENT_SEARCHES);
assert.ok(!cleaned.includes("OK"), "duplicate dropped");
pass("corrupt or tampered storage reads as a clean list");

const throwing: StorageLike = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};
assert.deepEqual(loadRecentSearches(throwing), []);
assert.equal(saveRecentSearches(throwing, ["c:r"]), false);
assert.deepEqual(loadRecentSearches(null), []);
assert.equal(saveRecentSearches(null, ["c:r"]), false);
pass("storage that throws (or is missing) never throws to the caller");

console.log(`\nAll ${checks} recent-searches self-checks passed.`);
