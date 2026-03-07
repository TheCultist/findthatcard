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
    unresolvedFragments: [{ text: "etb effects" }],
    resolvedFragments: [
      { fragment: "etb effects", tags: ['o:"~ enters"'], confidence: 0.9, category: "effect" },
    ],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };

  const query = assembleQueryFromIR(ir);
  assert.equal(query, 'f:commander id:wu (set:blb OR set:one) -set:c20 o:"~ enters"');
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
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
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
  assert.ok(mustValues.includes('o:"~ enters"'));
  assert.ok(mustValues.includes("o:draw"));
  assert.ok(
    parsed.unresolvedFragments.every(
      (fragment) => !/\b(enters?|draws?|color\s+identity)\b/i.test(fragment.text)
    )
  );
  assert.equal(parsed.unresolvedFragments.length, 0);
  console.log("[PASS] phase1: resolves ETB draw intent to oracle filters");
}

async function testPhase1PluralTypeIsStrippedFromArtFragments() {
  const parsed = await parseNaturalQuery("enchantments that feature moon art");
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("t:enchantment"), `Expected t:enchantment in ${mustValues.join(", ")}`);
  assert.ok(
    parsed.unresolvedFragments.every((fragment) => !/\benchantments?\b/i.test(fragment.text)),
    "type term should be stripped before unresolved fragment resolution"
  );
  assert.ok(parsed.unresolvedFragments.some((fragment) => /\bmoon\b/i.test(fragment.text)));
  console.log("[PASS] phase1: strips plural type terms from art unresolved fragments");
}

async function testPhase1SorceryPluralKeepsTypeAndStripsFromArtFragment() {
  const parsed = await parseNaturalQuery("sorceries that feature sword art");
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("t:sorcery"), `Expected t:sorcery in ${mustValues.join(", ")}`);
  assert.ok(
    parsed.unresolvedFragments.every((fragment) => !/\bsorcer(?:y|ies)\b/i.test(fragment.text)),
    "sorcery type terms should be stripped from unresolved fragments"
  );
  assert.ok(parsed.unresolvedFragments.some((fragment) => /\bsword\b/i.test(fragment.text)));
  console.log("[PASS] phase1: sorceries query keeps t:sorcery and clean art fragment");
}

async function testPhase1FuzzyColorIdentityTypo() {
  const parsed = await parseNaturalQuery(
    "creature in dimira color identity that draws you cards when it enters the field"
  );
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("id:ub"));
  assert.ok(mustValues.includes('o:"~ enters"'));
  assert.ok(mustValues.includes("o:draw"));
  assert.equal(parsed.unresolvedFragments.length, 0);
  console.log("[PASS] phase1: fuzzy color identity typo maps dimira -> id:ub");
}

async function testPhase1MonocolorUsesExactIdentity() {
  // Commander context → id:<= (deck identity)
  const parsed = await parseNaturalQuery("green creatures for commander");
  const mustValues = parsed.mustClauses.map((entry) => entry.value);
  assert.ok(mustValues.includes("id:g") || mustValues.includes("id=g") || mustValues.includes("id:<=g"), `mono + commander should use id:g/id=g/id:<=g, got ${mustValues.join(",")}`);

  // Multi-color + commander → id:<= (deck identity)
  const parsedB = await parseNaturalQuery("azorius creatures for commander");
  const mustValuesB = parsedB.mustClauses.map((entry) => entry.value);
  assert.ok(mustValuesB.includes("id:wu") || mustValuesB.includes("id=wu") || mustValuesB.includes("id:<=wu"), `multi + commander should use id:wu/id=wu/id:<=wu, got ${mustValuesB.join(",")}`);

  // No commander context → c: (card color)
  const parsedC = await parseNaturalQuery("azorius creatures");
  const mustValuesC = parsedC.mustClauses.map((entry) => entry.value);
  assert.ok(mustValuesC.includes("id:wu"), `non-commander multicolor should use id:wu; got: ${mustValuesC.join(", ")}`);

  // Explicit mono prefix, no commander → c=
  const parsedD = await parseNaturalQuery("mono-green creatures");
  const mustValuesD = parsedD.mustClauses.map((entry) => entry.value);
  assert.ok(mustValuesD.includes("id=g"), `explicit mono should use id=g; got: ${mustValuesD.join(", ")}`);

  // Plain color word, no commander → c: (includes)
  const parsedE = await parseNaturalQuery("blue control spells");
  const mustValuesE = parsedE.mustClauses.map((entry) => entry.value);
  assert.ok(mustValuesE.includes("id:u"), `plain color word should use id:u; got: ${mustValuesE.join(", ")}`);

  // Dual-filter: shorthand identity + individual color word → both id: and c:
  const parsedF = await parseNaturalQuery("mono-blue artifacts with flash in wubr color identity");
  const mustValuesF = parsedF.mustClauses.map((entry) => entry.value);
  assert.ok(mustValuesF.includes("id:wubr") || mustValuesF.includes("id=wubr"), `should include id:wubr or id=wubr; got: ${mustValuesF.join(", ")}`);
  assert.ok(mustValuesF.includes("c=u"), `should include c=u for mono-blue card color; got: ${mustValuesF.join(", ")}`);

  console.log("[PASS] phase1: color filter uses c: by default, id:<= for commander/identity contexts");
}

async function testPhase1FuzzyKeywordTypo() {
  const parsed = await parseNaturalQuery("creatures with fliyng in azorius");
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("kw:flying"));
  // No commander context, but casual search defaults to id:
  assert.ok(mustValues.includes("id:wu"), `should use id:wu for non-commander azorius; got: ${mustValues.join(", ")}`);
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

async function testPhase1SynergyIntentSupportsOrSubjectLists() {
  const parsed = await parseNaturalQuery("esper instant or sorcery synergies for commander");
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("f:commander"));
  assert.ok(!mustValues.includes("t:instant"));
  assert.ok(!mustValues.includes("t:sorcery"));
  assert.ok(
    mustValues.some((value) => /\bfunction:synergy-instant\b/.test(value)),
    "expected instant synergy function tag"
  );
  assert.ok(
    mustValues.some((value) => /\bfunction:synergy-sorcery\b/.test(value)),
    "expected sorcery synergy function tag"
  );
  assert.ok(
    mustValues.some(
      (value) =>
        /\bfunction:synergy-instant\b/.test(value) &&
        /\bor\b/.test(value) &&
        /\bfunction:synergy-sorcery\b/.test(value)
    ),
    "expected instant/sorcery synergy tags in a single OR chain"
  );
  console.log("[PASS] phase1: synergy intent supports 'X or Y synergies' subjects");
}

async function testPhase1SynergyIntentSupportsMixedTypeListBeforeOr() {
  const parsed = await parseNaturalQuery(
    "esper instant sorcery or artifacts synergies for commander"
  );
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("f:commander"));
  assert.ok(!mustValues.includes("t:instant"));
  assert.ok(!mustValues.includes("t:sorcery"));
  assert.ok(!mustValues.includes("t:artifact"));
  assert.ok(
    mustValues.some(
      (value) =>
        /\bfunction:synergy-instant\b/.test(value) &&
        /\bfunction:synergy-sorcery\b/.test(value) &&
        /\bfunction:synergy-artifact\b/.test(value) &&
        /\bor\b/.test(value)
    ),
    "expected instant/sorcery/artifact synergy tags in one OR chain"
  );
  console.log("[PASS] phase1: synergy intent supports mixed type list before OR");
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
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };

  const finalized = await finalizeQuery(ir);
  assert.ok(!/\bis:commander\b/i.test(finalized.queryForLogs));
  assert.ok(/\bf:commander\b/i.test(finalized.queryForLogs));
  console.log("[PASS] phase3: avoids is:commander when query intent is commander format");
}

async function testPhase3LegalInMultipleFormatsKeepsFCommanderNoIsCommander() {
  const ir: SearchPipelineIR = {
    naturalQuery: "goblin cards legal in both modern and commander",
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [
      { value: "f:modern", source: "phase1:format" },
      { value: "f:commander", source: "phase1:format" },
      { value: "function:tribal-goblin", source: "phase2:resolver" },
    ],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };

  const finalized = await finalizeQuery(ir);
  assert.ok(!/\bis:commander\b/i.test(finalized.queryForLogs), "should not add is:commander when legal in multiple formats");
  assert.ok(/\bf:commander\b/i.test(finalized.queryForLogs));
  assert.ok(/\bf:modern\b/i.test(finalized.queryForLogs));
  console.log("[PASS] phase3: legal in both modern and commander keeps f:commander, no is:commander");
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
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
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
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };

  const finalized = await finalizeQuery(ir);
  assert.ok(!/\b(?:t|type):squirrel\b/i.test(finalized.queryForLogs));
  assert.ok(/\bfunction:repeatable-creature-tokens\b/i.test(finalized.queryForLogs));
  console.log("[PASS] phase3: strips generic token type filter for token generation intents");
}

async function testPhase3StripsDamageTargetCreatureTypeFilter() {
  const ir: SearchPipelineIR = {
    naturalQuery: "boros instants and sorceries that damage target creature",
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [
      { value: "t:instant", source: "phase1:type" },
      { value: "t:sorcery", source: "phase1:type" },
      { value: "t:creature", source: "phase1:type" },
      { value: "id:rw", source: "phase1:color" },
    ],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };

  const finalized = await finalizeQuery(ir);
  assert.ok(!/\bt:creature\b/i.test(finalized.queryForLogs), "t:creature should be stripped for damage target");
  assert.ok(/\bt:instant\b/i.test(finalized.queryForLogs) || /\(t:instant or t:sorcery\)/i.test(finalized.queryForLogs));
  assert.ok(/\bfunction:burn-creature\b/i.test(finalized.queryForLogs));
  console.log("[PASS] phase3: strips t:creature when creature is a damage target");
}

async function testPhase3StripsCreatureTypeForRemovalCreatureIntent() {
  const ir: SearchPipelineIR = {
    naturalQuery: "white creature removal spells for commander",
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [
      { value: "f:commander", source: "phase1:format" },
      { value: "t:creature", source: "phase1:type" },
    ],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };

  const finalized = await finalizeQuery(ir);
  assert.ok(!/\bt:creature\b/i.test(finalized.queryForLogs), "t:creature should be stripped for removal-creature intent");
  assert.ok(/\bfunction:removal-creature\b/i.test(finalized.queryForLogs));
  console.log("[PASS] phase3: strips t:creature for creature removal intent");
}

async function testPhase3AddsBlinkTagsAndKeepsCreatureType() {
  const ir: SearchPipelineIR = {
    naturalQuery: "azorius blink creatures for commander",
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [
      { value: "f:commander", source: "phase1:format" },
      { value: "id:wu", source: "phase1:color" },
      { value: "t:creature", source: "phase1:type" },
    ],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };

  const finalized = await finalizeQuery(ir);
  assert.ok(/\bfunction:blink\b/i.test(finalized.queryForLogs) || /\bfunction:flicker\b/i.test(finalized.queryForLogs));
  assert.ok(/\bt:creature\b/i.test(finalized.queryForLogs), "t:creature should remain for blink creatures (not blink target)");
  console.log("[PASS] phase3: adds blink tags and keeps t:creature when creature is the card type");
}

function testAssemblerSkipsArchetypeFragmentTags() {
  const ir: SearchPipelineIR = {
    naturalQuery: "white creatures that prevent attacking",
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [
      { value: "t:creature", source: "phase1:type" },
      { value: "id=w", source: "phase1:color" },
    ],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [
      { fragment: "prevent attacking", tags: ["function:prevent-attack"], confidence: 0.9, category: "effect", archetype: "pillow-fort" },
    ],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };

  const query = assembleQueryFromIR(ir);
  assert.ok(!/function:prevent-attack/.test(query), "assembler should skip raw tags for archetype-classified fragments");
  assert.ok(/t:creature/.test(query));
  assert.ok(/id=w/.test(query));
  console.log("[PASS] assembler: skips raw tags for archetype-classified fragments");
}

function testAssemblerEmitsRawTagsForNonArchetypeFragments() {
  const ir: SearchPipelineIR = {
    naturalQuery: "creatures with cool effects",
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [
      { value: "t:creature", source: "phase1:type" },
    ],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [{ text: "cool effects" }],
    resolvedFragments: [
      { fragment: "cool effects", tags: ["function:some-effect"], confidence: 0.8, category: "semantic" },
    ],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };

  const query = assembleQueryFromIR(ir);
  assert.ok(/function:some-effect/.test(query), "assembler should emit raw tags when no archetype");
  console.log("[PASS] assembler: emits raw tags for non-archetype fragments");
}

function testAssemblerAndsArtConceptsPerFragment() {
  const ir: SearchPipelineIR = {
    naturalQuery: "cards with spider art and sword art",
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [
      { text: "spider art" },
      { text: "sword art" },
    ],
    resolvedFragments: [
      { fragment: "spider art", tags: ["art:spider", "art:spider-like"], confidence: 0.9, category: "art" },
      { fragment: "sword art", tags: ["art:raised-sword", "art:sheathed-sword"], confidence: 0.9, category: "art" },
    ],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };

  const query = assembleQueryFromIR(ir);
  const spiderGroup = /\(art:spider\s+or\s+art:spider-like\)/i;
  const swordGroup = /\(art:raised-sword\s+or\s+art:sheathed-sword\)/i;
  assert.ok(spiderGroup.test(query), "assembler should emit one OR group per art fragment (spider)");
  assert.ok(swordGroup.test(query), "assembler should emit one OR group per art fragment (sword)");
  assert.ok(
    query.indexOf("(art:spider") < query.indexOf("(art:raised-sword"),
    "spider and sword groups should both appear (AND semantics)"
  );
  console.log("[PASS] assembler: ANDs art concepts — one (art:... or ...) per fragment");
}

async function testPhase3InjectsArchetypeTagsFromResolvedFragments() {
  const ir: SearchPipelineIR = {
    naturalQuery: "white creatures that prevent attacking for commander",
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [
      { value: "t:creature", source: "phase1:type" },
      { value: "id=w", source: "phase1:color" },
      { value: "f:commander", source: "phase1:format" },
    ],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [{ text: "prevent attacking" }],
    resolvedFragments: [
      { fragment: "prevent attacking", tags: [], confidence: 0.9, category: "effect", archetype: "pillow-fort" },
    ],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };

  const finalized = await finalizeQuery(ir);
  assert.ok(/function:prevent-attack/.test(finalized.queryForLogs), "should inject prevent-attack from pillow-fort archetype");
  assert.ok(/function:tax-attack/.test(finalized.queryForLogs), "should inject tax-attack from pillow-fort archetype");
  assert.ok(/\bor\b/i.test(finalized.queryForLogs), "pillow-fort tags should be in an OR chain");
  console.log("[PASS] phase3: injects archetype tags from resolved fragments into OR chain");
}

async function testPhase3InjectsDamageArchetypeFromResolvedFragments() {
  const ir: SearchPipelineIR = {
    naturalQuery: "red spells that hurt opponents",
    intent: "search",
    tokenizedQuery: [],
    noiseTokens: [],
    mustClauses: [
      { value: "c:r", source: "phase1:color" },
    ],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [{ text: "hurt opponents" }],
    resolvedFragments: [
      { fragment: "hurt opponents", tags: [], confidence: 0.85, category: "effect", archetype: "damage", qualifier: "opponent" },
    ],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };

  const finalized = await finalizeQuery(ir);
  assert.ok(/function:burn-player/.test(finalized.queryForLogs), "should inject burn-player from damage/opponent archetype");
  assert.ok(/function:opponent-loses-life/.test(finalized.queryForLogs), "should inject opponent-loses-life");
  console.log("[PASS] phase3: injects damage archetype tags with qualifier from resolved fragments");
}

async function testPhase1CreatureTypeFromCatalog() {
  const parsed = await parseNaturalQuery("goblin creatures for commander");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(mustValues.includes("t:goblin"), "should match goblin as creature type from catalog");
  assert.ok(mustValues.includes("t:creature"), "should match creature from TYPE_TOKENS");
  assert.ok(mustValues.includes("f:commander"), "should match commander as format");
  assert.ok(
    parsed.unresolvedFragments.every((f) => !/\bgoblin\b/i.test(f.text)),
    "goblin should be stripped from unresolved fragments"
  );
  console.log("[PASS] phase1: matches creature type 'goblin' from catalog");
}

async function testPhase1LegendaryDragons() {
  const parsed = await parseNaturalQuery("legendary dragons");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(mustValues.includes("t:legendary"), "should match legendary as supertype from catalog");
  assert.ok(mustValues.includes("t:dragon"), "should match dragon as creature type from catalog");
  console.log("[PASS] phase1: matches supertype 'legendary' and creature type 'dragon' from catalog");
}

async function testPhase1EquipmentArtifacts() {
  const parsed = await parseNaturalQuery("equipment artifacts");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(mustValues.includes("t:equipment"), "should match equipment as artifact subtype from catalog");
  assert.ok(mustValues.includes("t:artifact"), "should match artifact from TYPE_TOKENS");
  console.log("[PASS] phase1: matches artifact subtype 'equipment' from catalog");
}

async function testPhase1SagaEnchantments() {
  const parsed = await parseNaturalQuery("saga enchantments");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(mustValues.includes("t:saga"), "should match saga as enchantment subtype from catalog");
  assert.ok(mustValues.includes("t:enchantment"), "should match enchantment from TYPE_TOKENS");
  console.log("[PASS] phase1: matches enchantment subtype 'saga' from catalog");
}

async function testPhase1ElfSynergyExclusion() {
  const parsed = await parseNaturalQuery("elf synergies for commander");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(!mustValues.includes("t:elf"), "should NOT add t:elf when it is a synergy subject");
  assert.ok(
    parsed.unresolvedFragments.some((f) => /\belf\b/i.test(f.text)),
    "elf should be left in unresolved fragments for the AI if no exact tag exists"
  );
  console.log("[PASS] phase1: skips creature type as synergy subject (elf synergies)");
}

async function testPhase1ArtistDetection() {
  const parsed = await parseNaturalQuery("cards by Seb McKinnon");
  const mustValues = parsed.mustClauses.map((c) => c.value);
  const hasArtist = mustValues.some((v) => /artist:"Seb McKinnon"/i.test(v));
  assert.ok(hasArtist, "should detect artist name 'Seb McKinnon' from catalog");
  console.log("[PASS] phase1: detects artist name from catalog");
}

async function testPhase1PluralCreatureType() {
  const parsed = await parseNaturalQuery("elves in modern");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(mustValues.includes("t:elf"), "should match plural 'elves' to singular 'elf' creature type");
  assert.ok(mustValues.includes("f:modern"), "should match modern as format");
  console.log("[PASS] phase1: handles plural creature type 'elves' -> t:elf");
}

async function testPhase1SnowLands() {
  const parsed = await parseNaturalQuery("snow lands");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(mustValues.includes("t:snow"), "should match snow as supertype from catalog");
  assert.ok(mustValues.includes("t:land"), "should match land from TYPE_TOKENS");
  console.log("[PASS] phase1: matches supertype 'snow' and card type 'land'");
}

async function testColorShorthandTwoColor() {
  const parsed = await parseNaturalQuery("rg creatures with trample");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  // No commander context, defaults to id:
  assert.ok(mustValues.includes("id:rg"), `two-letter shorthand 'rg' should produce id:rg; got: ${mustValues.join(", ")}`);
  assert.ok(mustValues.includes("t:creature"), "should also detect t:creature");
  console.log("[PASS] phase1: two-color shorthand 'rg' produces id:rg");
}

async function testColorShorthandFourColor() {
  const parsed = await parseNaturalQuery("wubr instants");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  // No commander context, defaults to id:
  assert.ok(mustValues.includes("id:wubr"), `four-letter shorthand 'wubr' should produce id:wubr; got: ${mustValues.join(", ")}`);
  console.log("[PASS] phase1: four-color shorthand 'wubr' produces id:wubr");
}

async function testColorShorthandNormalisesOrder() {
  const parsed = await parseNaturalQuery("gr aggro");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  // "gr" should be normalised to WUBRG order → "rg"; defaults to id:
  assert.ok(mustValues.includes("id:rg"), `shorthand 'gr' should normalise to id:rg (WUBRG order); got: ${mustValues.join(", ")}`);
  console.log("[PASS] phase1: color shorthand 'gr' normalises to id:rg (WUBRG order)");
}

async function testColorShorthandBlocklist() {
  const parsed = await parseNaturalQuery("bug tribal");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    !mustValues.some((v) => v.startsWith("id:") || v.startsWith("c:")),
    `'bug' should be blocked from shorthand detection; got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: 'bug' is blocked as a color shorthand");
}

async function testArtSubjectNotAddedAsType() {
  const parsed = await parseNaturalQuery("Mono-green cards with forest art");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(!mustValues.includes("t:forest"), `t:forest should NOT appear for art query; got: ${mustValues.join(", ")}`);
  assert.ok(mustValues.includes("id=g"), "should detect mono-green identity (id= for card color)");
  console.log("[PASS] phase1: art subject 'forest' does not produce t:forest");
}

async function testOrConnectorFormats() {
  const parsed = await parseNaturalQuery("goblin cards legal modern or commander");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  const hasOrGroup = mustValues.some((v) => v.includes("(f:modern or f:commander)") || v.includes("(f:commander or f:modern)"));
  assert.ok(hasOrGroup, `formats connected by 'or' should be emitted as a single OR clause; got: ${mustValues.join(", ")}`);
  assert.ok(!mustValues.includes("f:modern"), "f:modern should not appear separately");
  assert.ok(!mustValues.includes("f:commander"), "f:commander should not appear separately");
  console.log("[PASS] phase1: OR connector between formats emits (f:modern or f:commander)");
}

async function testAndConnectorFormatsRemainSeparate() {
  const parsed = await parseNaturalQuery("goblin cards legal in both modern and commander");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(mustValues.includes("f:modern"), "f:modern should be a separate clause");
  assert.ok(mustValues.includes("f:commander"), "f:commander should be a separate clause");
  const noOrGroup = mustValues.every((v) => !v.startsWith("(f:"));
  assert.ok(noOrGroup, `formats connected by 'and' should NOT be merged into an OR clause; got: ${mustValues.join(", ")}`);
  console.log("[PASS] phase1: AND connector between formats keeps separate clauses");
}

async function testOrConnectorTypes() {
  const parsed = await parseNaturalQuery("instant or sorcery spells");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  const hasOrGroup = mustValues.some((v) => v.includes("(t:instant or t:sorcery)") || v.includes("(t:sorcery or t:instant)"));
  assert.ok(hasOrGroup, `types connected by 'or' should be emitted as a single OR clause; got: ${mustValues.join(", ")}`);
  console.log("[PASS] phase1: OR connector between types emits (t:instant or t:sorcery)");
}

async function testOrConnectorSubtypes() {
  const parsed = await parseNaturalQuery("goblin or elf creatures");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  const hasOrGroup = mustValues.some((v) => v.includes("(t:goblin or t:elf)") || v.includes("(t:elf or t:goblin)"));
  assert.ok(hasOrGroup, `subtypes connected by 'or' should be emitted as a single OR clause; got: ${mustValues.join(", ")}`);
  console.log("[PASS] phase1: OR connector between subtypes emits (t:goblin or t:elf)");
}

// ---------------------------------------------------------------------------
// Card name detection tests
// ---------------------------------------------------------------------------

async function testCardNameBare() {
  const parsed = await parseNaturalQuery("Lightning Bolt");
  const mustValues = parsed.mustClauses.map((c) => c.value);
  assert.ok(
    mustValues.some((v) => v.toLowerCase() === `name:"lightning bolt"`),
    `bare card name should produce name:"Lightning Bolt"; got: ${mustValues.join(", ")}`
  );
  assert.equal(parsed.unresolvedFragments.length, 0, "no unresolved fragments expected");
  console.log('[PASS] card name: bare "Lightning Bolt" resolves to name:"Lightning Bolt"');
}

async function testCardNameWithStopwords() {
  const parsed = await parseNaturalQuery("show me Counterspell please");
  const mustValues = parsed.mustClauses.map((c) => c.value);
  assert.ok(
    mustValues.some((v) => v.toLowerCase() === `name:"counterspell"`),
    `query with stopwords should produce name:"Counterspell"; got: ${mustValues.join(", ")}`
  );
  console.log('[PASS] card name: "show me Counterspell please" resolves to name:"Counterspell"');
}

async function testCardNameWithFormat() {
  const parsed = await parseNaturalQuery("Lightning Bolt in Modern");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.some((v) => v === `name:"lightning bolt"`),
    `card name + format query should produce name:"Lightning Bolt"; got: ${mustValues.join(", ")}`
  );
  assert.ok(mustValues.includes("f:modern"), "should also detect f:modern");
  console.log('[PASS] card name: "Lightning Bolt in Modern" resolves to name:"Lightning Bolt" + f:modern');
}

async function testCardNameMultiWord() {
  const parsed = await parseNaturalQuery("Giant Growth");
  const mustValues = parsed.mustClauses.map((c) => c.value);
  assert.ok(
    mustValues.some((v) => v.toLowerCase() === `name:"giant growth"`),
    `"Giant Growth" should produce name:"Giant Growth" (not t:giant); got: ${mustValues.join(", ")}`
  );
  const hasCreatureType = mustValues.some((v) => v.toLowerCase() === "t:giant");
  assert.ok(!hasCreatureType, `t:giant should NOT appear when "Giant" is part of a card name; got: ${mustValues.join(", ")}`);
  console.log('[PASS] card name: "Giant Growth" resolves to name:"Giant Growth" without t:giant');
}

async function testCardNameCommaInName() {
  // "Jace, the Mind Sculptor" has a comma — users typically omit it
  const parsed = await parseNaturalQuery("Jace the Mind Sculptor");
  const mustValues = parsed.mustClauses.map((c) => c.value);
  assert.ok(
    mustValues.some((v) => v.toLowerCase() === `name:"jace, the mind sculptor"`),
    `comma-containing card name typed without comma should still match; got: ${mustValues.join(", ")}`
  );
  console.log('[PASS] card name: "Jace the Mind Sculptor" resolves to name:"Jace, the Mind Sculptor"');
}

async function testCardNameNamedPattern() {
  const parsed = await parseNaturalQuery("cards named Counterspell in Modern");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.some((v) => v === `name:"counterspell"`),
    `"named X" pattern should produce name:"Counterspell"; got: ${mustValues.join(", ")}`
  );
  assert.ok(mustValues.includes("f:modern"), "should also detect f:modern");
  console.log('[PASS] card name: "named Counterspell in Modern" resolves to name:"Counterspell" + f:modern');
}

async function testCardNameCommaSeparatedList() {
  const parsed = await parseNaturalQuery(
    "phyrexian arena,call of the ring, black market connections"
  );
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.equal(mustValues.length, 1, `expected exactly 1 clause; got: ${mustValues.join(", ")}`);
  const clause = mustValues[0];
  assert.ok(clause.includes(`name:"phyrexian arena"`), `missing Phyrexian Arena; got: ${clause}`);
  assert.ok(clause.includes(`name:"call of the ring"`), `missing Call of the Ring; got: ${clause}`);
  assert.ok(
    clause.includes(`name:"black market connections"`),
    `missing Black Market Connections; got: ${clause}`
  );
  assert.equal(parsed.unresolvedFragments.length, 0, "no unresolved fragments expected");
  console.log('[PASS] card name list: comma-separated three-card list → single OR name: clause');
}

async function testCardNameListAndSeparator() {
  // Last item joined with "and" instead of a comma
  const parsed = await parseNaturalQuery(
    "phyrexian arena,call of the ring and black market connections"
  );
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.equal(mustValues.length, 1, `expected exactly 1 clause; got: ${mustValues.join(", ")}`);
  const clause = mustValues[0];
  assert.ok(clause.includes(`name:"phyrexian arena"`), `missing Phyrexian Arena; got: ${clause}`);
  assert.ok(clause.includes(`name:"call of the ring"`), `missing Call of the Ring; got: ${clause}`);
  assert.ok(
    clause.includes(`name:"black market connections"`),
    `missing Black Market Connections; got: ${clause}`
  );
  console.log('[PASS] card name list: "and" within a segment resolves both names');
}

async function testCardNameListCommaInName() {
  // "Animar, Soul of Elements" contains a comma — must not be split into two segments
  const parsed = await parseNaturalQuery(
    "phyrexian arena,call of the ring, animar, soul of elements, the one ring and black market connections"
  );
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.equal(mustValues.length, 1, `expected exactly 1 clause; got: ${mustValues.join(", ")}`);
  const clause = mustValues[0];
  assert.ok(clause.includes(`name:"phyrexian arena"`), `missing Phyrexian Arena; got: ${clause}`);
  assert.ok(clause.includes(`name:"call of the ring"`), `missing Call of the Ring; got: ${clause}`);
  assert.ok(
    clause.includes(`name:"animar, soul of elements"`),
    `missing Animar, Soul of Elements; got: ${clause}`
  );
  assert.ok(clause.includes(`name:"the one ring"`), `missing The One Ring; got: ${clause}`);
  assert.ok(
    clause.includes(`name:"black market connections"`),
    `missing Black Market Connections; got: ${clause}`
  );
  console.log('[PASS] card name list: comma-in-name "Animar, Soul of Elements" is preserved');
}

async function testCardNameListOxfordComma() {
  const parsed = await parseNaturalQuery(
    "Lightning Bolt, Counterspell, and Giant Growth"
  );
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.equal(mustValues.length, 1, `expected exactly 1 clause; got: ${mustValues.join(", ")}`);
  const clause = mustValues[0];
  assert.ok(clause.includes(`name:"lightning bolt"`), `missing Lightning Bolt; got: ${clause}`);
  assert.ok(clause.includes(`name:"counterspell"`), `missing Counterspell; got: ${clause}`);
  assert.ok(clause.includes(`name:"giant growth"`), `missing Giant Growth; got: ${clause}`);
  console.log('[PASS] card name list: Oxford comma ("A, B, and C") resolves all three names');
}

async function testCardNameListPartialMatch() {
  // "animar" alone doesn't match a catalog entry; should become name:animar (unquoted)
  const parsed = await parseNaturalQuery("phyrexian arena, animar, lightning bolt");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.equal(mustValues.length, 1, `expected 1 clause; got: ${mustValues.join(", ")}`);
  const clause = mustValues[0];
  assert.ok(clause.includes(`name:"phyrexian arena"`), `missing Phyrexian Arena; got: ${clause}`);
  assert.ok(clause.includes("name:animar"), `missing name:animar partial; got: ${clause}`);
  assert.ok(clause.includes(`name:"lightning bolt"`), `missing Lightning Bolt; got: ${clause}`);
  console.log('[PASS] card name list: partial single-word "animar" emits name:animar for Scryfall substring search');
}

async function testCardNameDoesNotMatchStructuralQuery() {
  // A query about creature types / colors should NOT produce a name: clause
  const parsed = await parseNaturalQuery("red creatures with flying");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    !mustValues.some((v) => v.startsWith("name:")),
    `structural query should not produce a name: clause; got: ${mustValues.join(", ")}`
  );
  console.log('[PASS] card name: structural query "red creatures with flying" produces no name: clause');
}

async function run() {
  await testPhase1DirectQueryShortCircuit();
  testAssemblerBooleanComposition();
  testAssemblerSkipsArchetypeFragmentTags();
  testAssemblerEmitsRawTagsForNonArchetypeFragments();
  testAssemblerAndsArtConceptsPerFragment();
  await testPhase3DirectQueryAddsPreferBest();
  await testPipelineDirectEndToEnd();
  await testPhase1CommanderFormatColorExtraction();
  await testPhase1EtbDrawUsesOracleFilters();
  await testPhase1PluralTypeIsStrippedFromArtFragments();
  await testPhase1SorceryPluralKeepsTypeAndStripsFromArtFragment();
  await testPhase1FuzzyColorIdentityTypo();
  await testPhase1MonocolorUsesExactIdentity();
  await testPhase1FuzzyKeywordTypo();
  await testPhase1FuzzyStrategyTypo();
  await testPhase1SynergyIntentUsesFunctionTagsForMentionedSubject();
  await testPhase1SynergyIntentSupportsOrSubjectLists();
  await testPhase1SynergyIntentSupportsMixedTypeListBeforeOr();
  await testPhase1CommanderFromFranchiseSetsAvoidsNoise();
  await testPhase1CommanderFromLorwynAvoidsCommanderProductSetNoise();
  await testPhase3DoesNotForceCommanderCreatureForFormatIntent();
  await testPhase3LegalInMultipleFormatsKeepsFCommanderNoIsCommander();
  await testPhase3RemovesTreasureTypeForTokenGenerationIntent();
  await testPhase3RemovesAnyTokenTypeForGenerationIntent();
  await testPhase3StripsDamageTargetCreatureTypeFilter();
  await testPhase3StripsCreatureTypeForRemovalCreatureIntent();
  await testPhase3AddsBlinkTagsAndKeepsCreatureType();
  await testPhase3InjectsArchetypeTagsFromResolvedFragments();
  await testPhase3InjectsDamageArchetypeFromResolvedFragments();
  await testPhase1CreatureTypeFromCatalog();
  await testPhase1LegendaryDragons();
  await testPhase1EquipmentArtifacts();
  await testPhase1SagaEnchantments();
  await testPhase1ElfSynergyExclusion();
  await testPhase1ArtistDetection();
  await testPhase1PluralCreatureType();
  await testPhase1SnowLands();
  await testArtSubjectNotAddedAsType();
  await testColorShorthandTwoColor();
  await testColorShorthandFourColor();
  await testColorShorthandNormalisesOrder();
  await testColorShorthandBlocklist();
  await testOrConnectorFormats();
  await testAndConnectorFormatsRemainSeparate();
  await testOrConnectorTypes();
  await testOrConnectorSubtypes();
  await testCardNameBare();
  await testCardNameWithStopwords();
  await testCardNameWithFormat();
  await testCardNameMultiWord();
  await testCardNameCommaInName();
  await testCardNameNamedPattern();
  await testCardNameCommaSeparatedList();
  await testCardNameListAndSeparator();
  await testCardNameListOxfordComma();
  await testCardNameListCommaInName();
  await testCardNameListPartialMatch();
  await testCardNameDoesNotMatchStructuralQuery();
  await testCardsWithSubtype();
  await testPhase1SynergyWithCardDetectsIntent();
  await testPhase1SynergyWithCardVariants();
  await testPhase1SynergyWithCardDoesNotFalsePositive();
  console.log("search-pipeline tests passed");
}

async function testCardsWithSubtype() {
  const parsed = await parseNaturalQuery("cards with cats");
  const mustValues = parsed.mustClauses.map((c) => c.value);
  assert.ok(mustValues.includes("(t:cat or art:cat)"), `Expected (t:cat or art:cat); got: ${mustValues.join(", ")}`);
  console.log("[PASS] phase1: 'with <subtype>' emits (t:subtype or art:subtype)");
}

async function testPhase1SynergyWithCardDetectsIntent() {
  const parsed = await parseNaturalQuery("cards that synergize with lightning bolt");
  assert.equal(parsed.intent, "synergy-with-card", `expected synergy-with-card, got: ${parsed.intent}`);
  assert.ok(parsed.synergyWithCardName, "expected synergyWithCardName to be set");
  assert.equal(
    parsed.synergyWithCardName!.toLowerCase(),
    "lightning bolt",
    `expected card name "lightning bolt", got: "${parsed.synergyWithCardName}"`
  );
  console.log("[PASS] phase1: 'synergize with <card>' detects synergy-with-card intent");
}

async function testPhase1SynergyWithCardVariants() {
  const variants = [
    "what goes well with sol ring",
    "cards that pair well with sol ring",
    "combo pieces for sol ring",
    "what works well with sol ring",
  ];
  for (const query of variants) {
    const parsed = await parseNaturalQuery(query);
    assert.equal(
      parsed.intent,
      "synergy-with-card",
      `"${query}" should detect synergy-with-card, got: ${parsed.intent}`
    );
    assert.ok(
      parsed.synergyWithCardName,
      `"${query}" should set synergyWithCardName`
    );
  }
  console.log("[PASS] phase1: synergy-with-card intent detected across phrase variants");
}

async function testPhase1SynergyWithCardDoesNotFalsePositive() {
  // "artifact synergies" is a concept-synergy query, not a card-name-synergy query.
  // It should NOT match synergy-with-card because "artifact" is not a card name.
  const parsed = await parseNaturalQuery("artifact synergies for commander");
  assert.notEqual(
    parsed.intent,
    "synergy-with-card",
    `"artifact synergies" should NOT match synergy-with-card intent (got: ${parsed.intent})`
  );
  console.log("[PASS] phase1: 'artifact synergies' does not false-positive as synergy-with-card");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

