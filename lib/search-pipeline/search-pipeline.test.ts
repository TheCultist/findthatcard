import assert from "node:assert/strict";
import { assembleQueryFromIR } from "@/lib/search-pipeline/assembleQuery";
import { parseNaturalQuery } from "@/lib/search-pipeline/phase1/parseNaturalQuery";
import { finalizeQuery } from "@/lib/search-pipeline/phase3/finalizeQuery";
import { runSearchPipeline } from "@/lib/search-pipeline/runSearchPipeline";
import { SearchPipelineIR } from "@/lib/search-pipeline/types";

async function testPhase1DirectQueryShortCircuit() {
  const parsed = await parseNaturalQuery("t:dragon c:r");
  assert.equal(parsed.intent, "direct-scryfall");
  assert.equal(parsed.mustClauses[0]?.value, "t:dragon c:r");
  assert.equal(parsed.unresolvedFragments.length, 0);
  console.log("[PASS] phase1: direct query short-circuits deterministic parsing");
}

function testAssemblerBooleanComposition() {
  const ir: SearchPipelineIR = {
    naturalQuery: "dummy",
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [
      { value: "f:commander", source: "phase1:format" },
      { value: "id:wu", source: "phase1:color" },
    ],
    shouldClauses: [
      { value: "set:blb", source: "phase1:set" },
      { value: "set:one", source: "phase1:set" },
    ],
    mustNotClauses: [{ value: "set:c20", source: "phase1:set" }],
    unresolvedFragments: [],
    resolvedFragments: [
      { fragment: "etb effects", tags: ["o:enters"], confidence: 0.9, category: "effect" },
    ],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0 },
  };

  const query = assembleQueryFromIR(ir);
  assert.equal(query, "f:commander id:wu (set:blb OR set:one) -set:c20 o:enters");
  console.log("[PASS] assembler: composes must/should/must-not with resolved fragments");
}

async function testPhase3DirectQueryAddsPreferBest() {
  const ir: SearchPipelineIR = {
    naturalQuery: "t:dragon",
    intent: "direct-scryfall",
    tokenizedQuery: ["t", "dragon"],
    noiseTokens: [],
    mustClauses: [{ value: "t:dragon", source: "phase1:direct" }],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0 },
  };
  const finalized = await finalizeQuery(ir);
  assert.equal(finalized.queryForScryfall, "prefer:best t:dragon");
  assert.equal(finalized.queryForLogs, "t:dragon");
  console.log("[PASS] phase3: direct query gets prefer:best prefix once");
}

async function testPipelineDirectEndToEnd() {
  const result = await runSearchPipeline("is:dfc t:land");
  assert.ok(result.queryForScryfall.startsWith("prefer:best "));
  assert.equal(result.debug.aiBatchCalls, 0);
  assert.equal(result.debug.aiSequentialCalls, 0);
  console.log("[PASS] pipeline: direct query skips AI calls end-to-end");
}

async function testPhase1CommanderFormatColorExtraction() {
  const parsed = await parseNaturalQuery(
    "rakdos cards that make treasure tokens for commander"
  );
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("f:commander"));
  assert.ok(mustValues.includes("id:br"));
  assert.ok(
    parsed.unresolvedFragments.every(
      (fragment) =>
        !/\brakdos\b/i.test(fragment.text) && !/\bcommander\b/i.test(fragment.text)
    )
  );
  console.log(
    "[PASS] phase1: strips commander/color identity terms from unresolved fragments"
  );
}

async function testPhase1EtbDrawUsesOracleFilters() {
  const parsed = await parseNaturalQuery(
    "creature in azorius color identity that draws you cards when it enters the field"
  );
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("t:creature"));
  assert.ok(mustValues.includes("id:wu"));
  assert.ok(mustValues.includes("o:enters"));
  assert.ok(mustValues.includes("o:draw"));
  assert.ok(
    parsed.unresolvedFragments.every(
      (fragment) => !/\b(enters?|draws?|color\s+identity)\b/i.test(fragment.text)
    )
  );
  assert.equal(parsed.unresolvedFragments.length, 0);
  console.log("[PASS] phase1: resolves ETB draw intent to oracle filters");
}

async function testPhase1FuzzyColorIdentityTypo() {
  const parsed = await parseNaturalQuery(
    "creature in dimira color identity that draws you cards when it enters the field"
  );
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("id:ub"));
  assert.ok(mustValues.includes("o:enters"));
  assert.ok(mustValues.includes("o:draw"));
  assert.equal(parsed.unresolvedFragments.length, 0);
  console.log("[PASS] phase1: fuzzy color identity typo maps dimira -> id:ub");
}

async function testPhase1FuzzyKeywordTypo() {
  const parsed = await parseNaturalQuery("creatures with fliyng in azorius");
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("kw:flying"));
  assert.ok(mustValues.includes("id:wu"));
  console.log("[PASS] phase1: fuzzy keyword typo maps fliyng -> kw:flying");
}

async function testPhase1FuzzyStrategyTypo() {
  const parsed = await parseNaturalQuery("aristocarts deck in orzhov colors");
  const mustValues = parsed.mustClauses.map((entry) => entry.value);
  assert.ok(mustValues.some((value) => /strategy:"?Aristocrats"?/i.test(value)));
  assert.ok(
    parsed.unresolvedFragments.every((fragment) => !/\baristocarts\b/i.test(fragment.text))
  );
  console.log("[PASS] phase1: fuzzy strategy typo maps aristocarts -> strategy:Aristocrats");
}

async function testPhase1SynergyIntentUsesFunctionTagsForMentionedSubject() {
  const parsed = await parseNaturalQuery("esper artifact synergies for commander");
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("f:commander"));
  assert.ok(mustValues.includes("id:wub") || mustValues.includes("id:<=wub"));
  assert.ok(!mustValues.includes("t:artifact"));
  assert.ok(
    mustValues.some(
      (value) =>
        /\bfunction:synergy-artifact\b/.test(value) || /\bfunction:artifact-synergy\b/.test(value)
    )
  );
  console.log(
    "[PASS] phase1: synergy intent maps mentioned subject to related function tags"
  );
}

async function testPhase1CommanderFromFranchiseSetsAvoidsNoise() {
  const parsed = await parseNaturalQuery("commanders from avatar sets");
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  const shouldValues = parsed.shouldClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("is:commander"));
  assert.ok(shouldValues.length > 0);
  assert.ok(shouldValues.every((value) => value.startsWith("set:")));
  assert.ok(!mustValues.includes("function:command"));
  assert.ok(!shouldValues.includes("set:cm1"));
  assert.equal(parsed.unresolvedFragments.length, 0);
  console.log(
    "[PASS] phase1: commanders from franchise sets keeps is:commander and avoids resolver/set noise"
  );
}

async function testPhase1CommanderFromLorwynAvoidsCommanderProductSetNoise() {
  const parsed = await parseNaturalQuery("commanders from lorwyn eclipsed");
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  const shouldValues = parsed.shouldClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("is:commander"));
  assert.ok(shouldValues.some((value) => value.startsWith("set:")));
  assert.ok(!shouldValues.includes("set:cm1"));
  console.log(
    "[PASS] phase1: commanders from lorwyn keeps set chain without commander product sets"
  );
}

async function testPhase3DoesNotForceCommanderCreatureForFormatIntent() {
  const ir: SearchPipelineIR = {
    naturalQuery: "rakdos cards that make treasure tokens for commander",
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [
      { value: "f:commander", source: "phase1:format" },
      { value: "id:br", source: "phase1:color" },
      { value: "function:repeatable-treasures", source: "phase2:resolver" },
    ],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0 },
  };

  const finalized = await finalizeQuery(ir);
  assert.ok(!/\bis:commander\b/i.test(finalized.queryForLogs));
  assert.ok(/\bf:commander\b/i.test(finalized.queryForLogs));
  console.log("[PASS] phase3: avoids is:commander when query intent is commander format");
}

async function testPhase3RemovesTreasureTypeForTokenGenerationIntent() {
  const ir: SearchPipelineIR = {
    naturalQuery: "rakdos cards that make treasure tokens for commander",
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [
      { value: "f:commander", source: "phase1:format" },
      { value: "id:br", source: "phase1:color" },
      { value: "function:repeatable-treasures", source: "phase2:resolver" },
      { value: "t:treasure", source: "phase2:resolver" },
    ],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0 },
  };

  const finalized = await finalizeQuery(ir);
  assert.ok(!/\b(?:t|type):treasure\b/i.test(finalized.queryForLogs));
  assert.ok(/\bfunction:repeatable-treasures\b/i.test(finalized.queryForLogs));
  console.log("[PASS] phase3: strips treasure type when user asks for treasure token generation");
}

async function testPhase3RemovesAnyTokenTypeForGenerationIntent() {
  const ir: SearchPipelineIR = {
    naturalQuery: "cards that create squirrel tokens in commander",
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [
      { value: "f:commander", source: "phase1:format" },
      { value: "function:repeatable-creature-tokens", source: "phase2:resolver" },
      { value: "t:squirrel", source: "phase2:resolver" },
    ],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0 },
  };

  const finalized = await finalizeQuery(ir);
  assert.ok(!/\b(?:t|type):squirrel\b/i.test(finalized.queryForLogs));
  assert.ok(/\bfunction:repeatable-creature-tokens\b/i.test(finalized.queryForLogs));
  console.log("[PASS] phase3: strips generic token type filter for token generation intents");
}

async function run() {
  await testPhase1DirectQueryShortCircuit();
  testAssemblerBooleanComposition();
  await testPhase3DirectQueryAddsPreferBest();
  await testPipelineDirectEndToEnd();
  await testPhase1CommanderFormatColorExtraction();
  await testPhase1EtbDrawUsesOracleFilters();
  await testPhase1FuzzyColorIdentityTypo();
  await testPhase1FuzzyKeywordTypo();
  await testPhase1FuzzyStrategyTypo();
  await testPhase1SynergyIntentUsesFunctionTagsForMentionedSubject();
  await testPhase1CommanderFromFranchiseSetsAvoidsNoise();
  await testPhase1CommanderFromLorwynAvoidsCommanderProductSetNoise();
  await testPhase3DoesNotForceCommanderCreatureForFormatIntent();
  await testPhase3RemovesTreasureTypeForTokenGenerationIntent();
  await testPhase3RemovesAnyTokenTypeForGenerationIntent();
  console.log("search-pipeline tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

