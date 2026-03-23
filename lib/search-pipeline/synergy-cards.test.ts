import assert from "node:assert/strict";
import type { ScryfallNamedCard } from "@/lib/scryfall/lookup";
import { __testOnly } from "@/lib/search-pipeline/synergy-cards";

function minimalCard(partial: Partial<ScryfallNamedCard> & Pick<ScryfallNamedCard, "name" | "type_line" | "cmc">): ScryfallNamedCard {
  return {
    id: "x",
    oracle_id: "x",
    set: "x",
    collector_number: "1",
    keywords: [],
    color_identity: [],
    ...partial,
  };
}

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

function testManaRockStyleDetection() {
  const solRing = minimalCard({
    name: "Sol Ring",
    type_line: "Artifact",
    cmc: 1,
    oracle_text: "{T}: Add {C}{C}.",
  });
  assert.ok(
    __testOnly.isManaRockStyleCard(solRing, solRing.oracle_text ?? "", ["mana-rock"]),
    "Sol Ring + mana-rock tag should be mana-rock style"
  );
  assert.ok(
    __testOnly.isManaRockStyleCard(solRing, solRing.oracle_text ?? "", []),
    "Sol Ring oracle {T} add should detect mana rock without tags"
  );
  const nonRock = minimalCard({
    name: "Steel Overseer",
    type_line: "Artifact Creature — Construct",
    cmc: 3,
    oracle_text: "At the beginning of your upkeep, put a +1/+1 counter on each creature you control.",
  });
  assert.ok(
    !__testOnly.isManaRockStyleCard(nonRock, nonRock.oracle_text ?? "", []),
    "non-mana artifact should not match heuristic"
  );
  console.log("[PASS] synergy: mana-rock style detection");
}

function testStripsPositiveNameFilter() {
  const input = 'name:"Sol Ring" function:mana-cost-matters';
  const out = __testOnly.sanitizeScryfallQuery(input, "Sol Ring");
  assert.ok(out, "sanitize should return a query");
  assert.ok(
    !/(?:^|[^-])name:"/.test(out!),
    `positive name: should be stripped (negative -name: is ok); got: ${out}`
  );
  assert.ok(out!.includes("-name:"), "should still add -name exclusion");
  console.log("[PASS] synergy sanitize: strips positive name: from AI output");
}

function run() {
  testStripsAiInjectedIdentityFilter();
  testStripsIdentityInsideOrBranches();
  testStripsConflictingIdentityFilters();
  testAddsNameExclusion();
  testStripsPositiveNameFilter();
  testManaRockStyleDetection();
  console.log("synergy-cards tests passed");
}

run();
