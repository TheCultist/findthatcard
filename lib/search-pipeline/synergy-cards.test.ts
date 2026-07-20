import assert from "node:assert/strict";
import type { ScryfallNamedCard } from "@/lib/scryfall/lookup";
import { __testOnly } from "@/lib/search-pipeline/synergy-cards";
import {
  dropUnanchoredOrBranches,
  groupBareFieldAlternations,
  sanitizeFunctionalClause,
  splitTopLevelORBranches,
} from "@/lib/search-pipeline/card-query-sanitize";

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

function testGroupsBareTypeAlternation() {
  // Regression: the model emits an unparenthesized `t:instant OR t:sorcery`
  // inside an AND group. Scryfall binds AND tighter than OR, so without the
  // fix the second branch collapses to a bare `t:sorcery`, matching EVERY
  // sorcery (e.g. Acquire). The alternation must be wrapped in parens.
  const input =
    '((function:heroic-payoff t:creature) OR (function:card-draw o:"target" t:instant OR t:sorcery))';
  const out = __testOnly.sanitizeScryfallQuery(input, "Ms. Marvel, Kamala Khan");
  assert.ok(out, "sanitize should return a query");
  assert.ok(
    /\(\s*t:instant\s+OR\s+t:sorcery\s*\)/i.test(out!),
    `bare type alternation should be parenthesized; got: ${out}`
  );
  // The dangling `t:sorcery` must not sit directly under the AND group anymore.
  assert.ok(
    !/o:"target"\s+t:instant\s+OR\s+t:sorcery/i.test(out!),
    `type alternation should no longer leak the OR to the group; got: ${out}`
  );
  console.log("[PASS] synergy sanitize: groups bare type alternation");
}

function testLeavesGenuineTwoBranchOr() {
  // Two branches with DIFFERENT fields must NOT be merged into one group by the
  // alternation grouper (that would corrupt real two-branch expressions).
  assert.equal(
    groupBareFieldAlternations("t:creature OR function:card-draw"),
    "t:creature OR function:card-draw",
    "different-field branches must be left untouched"
  );
  // Same-field alternations across 3+ types are all pulled into one group.
  assert.equal(
    groupBareFieldAlternations("function:x t:instant or t:sorcery or t:enchantment"),
    "function:x (t:instant or t:sorcery or t:enchantment)",
    "same-field alternation run should be wrapped once"
  );
  // Already-parenthesized alternations are not double-wrapped.
  assert.equal(
    groupBareFieldAlternations("(t:instant or t:sorcery)"),
    "(t:instant or t:sorcery)",
    "already-grouped alternation should not be re-wrapped"
  );
  console.log("[PASS] synergy sanitize: alternation grouper is field-aware");
}

function testStripsSingleWordQuotedOracle() {
  // Regression: the old regex had a trailing \b after the closing quote, which
  // never matches (quote and space are both non-word chars), so single-word
  // quoted o: fragments like o:"target" were never stripped despite the rule.
  const out = sanitizeFunctionalClause('function:heroic o:"target" o:"draw a card" t:creature');
  assert.ok(out, "sanitize should return a clause");
  assert.ok(!out!.includes('o:"target"'), `single-word quoted o: should be stripped; got: ${out}`);
  assert.ok(out!.includes('o:"draw a card"'), `multi-word o: must be kept; got: ${out}`);
  console.log("[PASS] sanitize: strips single-word quoted o: fragments");
}

function testDropsUnanchoredOrBranches() {
  // The broad-shell failure mode: an invalid tag was stripped from a branch,
  // leaving only `((t:instant OR t:sorcery))` — every instant/sorcery matches.
  const collapsed = '(((t:instant OR t:sorcery)) OR (function:heroic t:creature))';
  assert.equal(
    dropUnanchoredOrBranches(collapsed),
    "(function:heroic t:creature)",
    "broad shell branch should be dropped, anchored branch kept"
  );
  // Multi-word o: phrases and kw: also count as anchors.
  const anchoredBoth = '(o:"draw a card" t:instant) OR (kw:heroic t:creature)';
  assert.equal(dropUnanchoredOrBranches(anchoredBoth), anchoredBoth, "fully anchored query unchanged");
  // Nothing anchored → null (caller falls back to name:"card").
  assert.equal(dropUnanchoredOrBranches("(t:instant OR t:sorcery)"), null, "all-broad query yields null");
  console.log("[PASS] sanitize: drops unanchored OR branches");
}

function testSplitTopLevelORBranches() {
  assert.deepEqual(
    splitTopLevelORBranches('((function:a x:"b OR c") OR (t:creature))'),
    ['(function:a x:"b OR c")', "(t:creature)"],
    "split must be quote- and paren-aware"
  );
  assert.deepEqual(
    splitTopLevelORBranches("function:a t:creature"),
    ["function:a t:creature"],
    "no top-level OR yields one branch"
  );
  console.log("[PASS] sanitize: splits top-level OR branches");
}

function run() {
  testStripsSingleWordQuotedOracle();
  testDropsUnanchoredOrBranches();
  testSplitTopLevelORBranches();
  testStripsAiInjectedIdentityFilter();
  testStripsIdentityInsideOrBranches();
  testStripsConflictingIdentityFilters();
  testAddsNameExclusion();
  testStripsPositiveNameFilter();
  testGroupsBareTypeAlternation();
  testLeavesGenuineTwoBranchOr();
  testManaRockStyleDetection();
  console.log("synergy-cards tests passed");
}

run();
