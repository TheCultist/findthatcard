import assert from "node:assert/strict";
import { __testOnly } from "@/lib/search-pipeline/synergy-cards";

function testStripsAiInjectedIdentityFilter() {
  // AI was told not to add id<= but might anyway — sanitize should strip it.
  const input = "function:token-maker t:creature kw:spider id<=bg";
  const out = __testOnly.sanitizeScryfallQuery(input, "Shelob, Child of Ungoliant");
  assert.ok(out, "sanitize should return a query");
  assert.ok(
    !/\bid(?:entity)?(?:<=|>=|=|:)\s*[wubrgc]{1,5}\b/i.test(out!),
    `identity filter should be stripped from AI output; got: ${out}`
  );
  console.log("[PASS] synergy sanitize: strips AI-injected identity filter");
}

function testStripsIdentityInsideOrBranches() {
  // Also works when identity is buried inside OR branches.
  const input =
    "((function:typal-spider t:creature id<=bg) OR (function:hunger-reanimation t:artifact))";
  const out = __testOnly.sanitizeScryfallQuery(input, "Shelob, Child of Ungoliant");
  assert.ok(out, "sanitize should return a query");
  assert.ok(
    !/\bid(?:entity)?(?:<=|>=|=|:)\s*[wubrgc]{1,5}\b/i.test(out!),
    `identity filter inside OR branches should be stripped; got: ${out}`
  );
  console.log("[PASS] synergy sanitize: strips identity from inside OR branches");
}

function testStripsConflictingIdentityFilters() {
  const input = "(function:x id<=bg) OR (function:y id<=wub)";
  const out = __testOnly.sanitizeScryfallQuery(input, "Shelob, Child of Ungoliant");
  assert.ok(out, "sanitize should return a query");
  assert.ok(
    !/\bid(?:entity)?(?:<=|>=|=|:)\s*[wubrgc]{1,5}\b/i.test(out!),
    `conflicting identity filters should be dropped; got: ${out}`
  );
  console.log("[PASS] synergy sanitize: strips conflicting identity filters");
}

function testAddsNameExclusion() {
  const input = "function:token-maker t:creature kw:spider";
  const out = __testOnly.sanitizeScryfallQuery(input, "Shelob, Child of Ungoliant");
  assert.ok(out, "sanitize should return a query");
  assert.ok(
    out!.includes('-name:"Shelob, Child of Ungoliant"'),
    `should add -name: exclusion; got: ${out}`
  );
  console.log("[PASS] synergy sanitize: adds -name: exclusion");
}

function run() {
  testStripsAiInjectedIdentityFilter();
  testStripsIdentityInsideOrBranches();
  testStripsConflictingIdentityFilters();
  testAddsNameExclusion();
  console.log("synergy-cards tests passed");
}

run();
