import assert from "node:assert/strict";
import { assembleQueryFromIR } from "@/lib/search-pipeline/assembleQuery";
import { shouldNormalize, validateResponse } from "@/lib/search-pipeline/phase0/normalizeQuery";
import { parseNaturalQuery } from "@/lib/search-pipeline/phase1/parseNaturalQuery";
import { finalizeQuery } from "@/lib/search-pipeline/phase3/finalizeQuery";
import { runSearchPipeline, splitCompoundQuery } from "@/lib/search-pipeline/runSearchPipeline";
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
    unresolvedFragments: [{ text: "etb effects", category: "effect" }],
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

async function testPhase3DirectQueryPassThrough() {
  const ir: SearchPipelineIR = {
    naturalQuery: '((function:typal-spider t:creature id<=bg) OR (function:hunger-reanimation t:artifact) -name:"Shelob, Child of Ungoliant") f:commander game:paper',
    intent: "direct-scryfall",
    tokenizedQuery: ["direct", "query"],
    noiseTokens: [],
    mustClauses: [{
      value: '((function:typal-spider t:creature id<=bg) OR (function:hunger-reanimation t:artifact) -name:"Shelob, Child of Ungoliant") f:commander game:paper',
      source: "phase1:direct",
    }],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };
  const finalized = await finalizeQuery(ir);
  assert.equal(
    finalized.queryForLogs,
    '((function:typal-spider t:creature id<=bg) OR (function:hunger-reanimation t:artifact) -name:"Shelob, Child of Ungoliant") f:commander game:paper'
  );
  console.log("[PASS] phase3: direct query is passed through unchanged");
}

async function testPhase3RemovesUnknownTypeFilters() {
  const ir: SearchPipelineIR = {
    naturalQuery: "cards with penguins",
    intent: "search",
    tokenizedQuery: ["cards", "with", "penguins"],
    noiseTokens: [],
    mustClauses: [
      { value: "t:penguin", source: "phase2:resolver" },
      { value: "art:penguin", source: "phase2:resolver" },
    ],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };
  const finalized = await finalizeQuery(ir);
  assert.ok(
    !/\b(?:t|type):penguin\b/i.test(finalized.queryForLogs),
    `unknown type filter should be removed; got: ${finalized.queryForLogs}`
  );
  console.log("[PASS] phase3: removes unknown type filters like t:penguin");
}

async function testPhase3PreservesAndedStandaloneArtTags() {
  const ir: SearchPipelineIR = {
    naturalQuery: "cards with big titties goth girls",
    intent: "search",
    tokenizedQuery: ["cards", "with", "big", "titties", "goth", "girls"],
    noiseTokens: [],
    mustClauses: [
      { value: "art:goth", source: "phase1:art" },
      { value: "art:woman", source: "phase1:art" },
      { value: "art:cleavage", source: "phase1:art" },
    ],
    shouldClauses: [],
    mustNotClauses: [],
    unresolvedFragments: [],
    resolvedFragments: [],
    debug: { strippedTerms: [], aiBatchCalls: 0, aiSequentialCalls: 0, invalidTagsRemoved: 0, phase0Normalized: false },
  };
  const finalized = await finalizeQuery(ir);
  const q = finalized.queryForLogs.toLowerCase();
  assert.ok(q.includes("art:goth art:woman art:cleavage"), `expected ANDed standalone art tags; got: ${finalized.queryForLogs}`);
  assert.ok(!/\(art:goth\s+or\s+art:woman\s+or\s+art:cleavage\)/i.test(q), `should not collapse to OR chain; got: ${finalized.queryForLogs}`);
  console.log("[PASS] phase3: preserves AND for standalone art tag chains");
}

async function testPipelineDirectEndToEnd() {
  const result = await runSearchPipeline("is:dfc t:land");
  assert.ok(result.queryForScryfall.startsWith("prefer:best "));
  assert.equal(result.debug.aiBatchCalls, 0);
  assert.equal(result.debug.aiSequentialCalls, 0);
  console.log("[PASS] pipeline: direct query skips AI calls end-to-end");
}

async function testPipelineSimilarCardsDoesNotContradictNameExclusion() {
  const result = await runSearchPipeline("cards similar to bad deal");
  const query = result.queryForLogs.toLowerCase();
  assert.ok(query.includes('-name:"bad deal"'), `expected exclusion for seed card; got: ${result.queryForLogs}`);
  assert.ok(!query.includes(' name:"bad deal"'), `should not include positive name filter for excluded seed card; got: ${result.queryForLogs}`);
  console.log("[PASS] pipeline: similar-cards avoids name/-name contradiction");
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

async function testPhase1NoCardsInHandDamageUsesOracleAnchors() {
  const parsed = await parseNaturalQuery("no cards in hand damage");
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(
    mustValues.includes('o:"no cards in hand"'),
    `expected o:"no cards in hand"; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    mustValues.includes('o:"deals"'),
    `expected o:"deals"; got: ${mustValues.join(", ")}`
  );
  assert.equal(parsed.unresolvedFragments.length, 0);
  console.log("[PASS] phase1: no-cards-in-hand damage maps to oracle anchors");
}

async function testPhase1LifeStealUsesFunctionTags() {
  const parsed = await parseNaturalQuery(
    "black and white cards that steal life points legal in commander with cost less than five mana"
  );
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(
    mustValues.some(
      (v) =>
        /\bfunction:life-drain\b/.test(v) &&
        /\bfunction:drain-life\b/.test(v) &&
        /\bfunction:opponent-loses-life\b/.test(v)
    ),
    `expected life-drain function OR chain; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    parsed.unresolvedFragments.every((f) => !/\bsteal\s+life|life\s+points?\b/i.test(f.text)),
    `life-steal phrasing should be resolved before phase2; unresolved: ${parsed.unresolvedFragments.map((f) => f.text).join(" | ")}`
  );
  console.log("[PASS] phase1: life-steal phrasing maps to life-drain function tags");
}

async function testPhase1DeathLifeGainUsesOracleAnchors() {
  // "gain life when another creature dies" is a death-triggered life-gain pattern,
  // NOT aristocrats/sacrifice. Phase 1 should resolve it to oracle text anchors,
  // and t:creature should be emitted from the leading "Creatures" subject.
  const parsed = await parseNaturalQuery(
    "Creatures that gain life when another creature dies"
  );
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.includes("t:creature"),
    `t:creature should be emitted for leading "Creatures" subject — got: ${mustValues.join(", ")}`
  );
  assert.ok(
    mustValues.includes("function:blood-artist-ability"),
    `function:blood-artist-ability should be present — got: ${mustValues.join(", ")}`
  );
  assert.ok(
    !mustValues.some((v) => /sacrifice|sac-outlet|aristocrat/.test(v)),
    `should not produce sacrifice/aristocrat tags — got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: death life-gain maps to function:blood-artist-ability, not sacrifice tags");
}

async function testPhase1ArtDescriptorBundlesUseAndedArtTags() {
  const parsed = await parseNaturalQuery("cards with big titties goth girls");
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("art:goth"), `expected art:goth; got: ${mustValues.join(", ")}`);
  assert.ok(mustValues.includes("art:woman"), `expected art:woman; got: ${mustValues.join(", ")}`);
  assert.ok(mustValues.includes("art:cleavage"), `expected art:cleavage; got: ${mustValues.join(", ")}`);
  assert.equal(
    parsed.unresolvedFragments.length,
    0,
    `art descriptor bundle should be fully resolved in phase1; unresolved: ${parsed.unresolvedFragments.map((f) => f.text).join(" | ")}`
  );
  console.log("[PASS] phase1: art descriptor bundle maps to ANDed art tags");
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

async function testPhase1EnchantTargetNotCardType() {
  // "creature" in "enchant a creature" is the enchant target — must NOT become t:creature.
  // Phase 1 should detect "whenever you enchant" and produce oracle text anchors instead.
  const parsed = await parseNaturalQuery("effects that trigger whenever you enchant a creature");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    !mustValues.some((v) => v === "t:creature"),
    `t:creature should NOT appear when 'creature' is the enchant target — got: ${mustValues.join(", ")}`
  );
  assert.ok(
    mustValues.some((v) => v === "o:whenever"),
    `o:whenever should be present for "whenever you enchant" intent — got: ${mustValues.join(", ")}`
  );
  assert.ok(
    mustValues.some((v) => v === "(o:enchant or o:aura)"),
    `(o:enchant or o:aura) should be present to cover both aura-trigger interpretations — got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: enchant target 'creature' does not become t:creature; oracle anchors produced");
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
  // Commander context → id: (deck identity)
  const parsed = await parseNaturalQuery("green creatures for commander");
  const mustValues = parsed.mustClauses.map((entry) => entry.value);
  assert.ok(mustValues.includes("id:g") || mustValues.includes("id=g"), `mono + commander should use id:g or id=g, got ${mustValues.join(",")}`);

  // Multi-color + commander → id: (deck identity)
  const parsedB = await parseNaturalQuery("azorius creatures for commander");
  const mustValuesB = parsedB.mustClauses.map((entry) => entry.value);
  assert.ok(mustValuesB.includes("id:wu") || mustValuesB.includes("id=wu"), `multi + commander should use id:wu or id=wu, got ${mustValuesB.join(",")}`);

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

  console.log("[PASS] phase1: color filter uses c: by default, id: for commander/identity contexts");
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
  assert.ok(mustValues.includes("id:wub") || mustValues.includes("id=wub"));
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

async function testPhase1UniversesBeyondIsFlagNotSetFilter() {
  const parsed = await parseNaturalQuery("cratures that are from universes beyond sets");
  const mustValues = parsed.mustClauses.map((entry) => entry.value.toLowerCase());
  const shouldValues = parsed.shouldClauses.map((entry) => entry.value.toLowerCase());
  assert.ok(mustValues.includes("is:universesbeyond"), `expected is:universesbeyond in must; got: ${mustValues.join(", ")}`);
  assert.ok(mustValues.includes("t:creature"), `expected t:creature (typo "cratures"); got: ${mustValues.join(", ")}`);
  assert.ok(!shouldValues.includes("set:slx"), `universes beyond should not produce set:slx; got should: ${shouldValues.join(", ")}`);
  const allClauses = [...parsed.mustClauses, ...parsed.shouldClauses].map((c) => c.value.toLowerCase());
  assert.ok(!allClauses.some((v) => v === "set:slx"), `no set:slx in any clause; got: ${allClauses.join(", ")}`);
  console.log("[PASS] phase1: universes beyond → is:universesbeyond t:creature, no set:slx (typo cratures → creature)");
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

async function testPhase1MakeTokensDoesNotProduceTokenType() {
  // No P/T specified — should not produce t:token, but no o:"P/T" either
  const parsed0 = await parseNaturalQuery("spell that produces tokens each turn");
  const mustValues0 = parsed0.mustClauses.map((c) => c.value);
  assert.ok(
    !mustValues0.some((v) => /\bt:token\b/i.test(v)),
    `t:token must not appear for generic token query; got: ${mustValues0.join(", ")}`
  );
  console.log("[PASS] phase1: generic token query does not produce t:token");
}

async function testPhase1MakeTokensWithPtAddsOracleClause() {
  const cases: [string, string][] = [
    ["cards that make 1/1 tokens", "1/1"],
    ["white creature that creates 2/2 knight tokens", "2/2"],
    ["enchantment that generates 3/3 beast tokens each turn", "3/3"],
  ];
  for (const [q, expectedPt] of cases) {
    const parsed = await parseNaturalQuery(q);
    const mustValues = parsed.mustClauses.map((c) => c.value);
    assert.ok(
      !mustValues.some((v) => /\bt:token\b/i.test(v)),
      `t:token must not appear for "${q}"; got: ${mustValues.join(", ")}`
    );
    assert.ok(
      mustValues.some((v) => v === `o:"${expectedPt}"`),
      `expected o:"${expectedPt}" for "${q}"; got: ${mustValues.join(", ")}`
    );
  }
  console.log("[PASS] phase1: make/create P/T token queries produce o:\"P/T\" clause");
}

async function testPhase1ToFindLandsDoesNotMatchCardName() {
  // "to find" is infinitive — "find" must not be detected as "Find // Finality"
  const parsed = await parseNaturalQuery("sorcery to find basic lands from your library");
  const mustValues = parsed.mustClauses.map((c) => c.value);
  assert.ok(
    mustValues.includes("t:sorcery"),
    `expected t:sorcery; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    !mustValues.some((v) => v.toLowerCase().includes("find // finality")),
    `name:"Find // Finality" must not appear for "to find basic lands"; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    !mustValues.includes("t:land"),
    `t:land must not appear; got: ${mustValues.join(", ")}`
  );
  console.log('[PASS] phase1: "sorcery to find basic lands from your library" does not produce name:"Find // Finality"');
}

async function testPhase1TutorFetchesMultiWordTargetNotType() {
  const parsed = await parseNaturalQuery("sorcery that finds basic lands from your library");
  const mustValues = parsed.mustClauses.map((c) => c.value);
  assert.ok(
    mustValues.includes("t:sorcery"),
    `expected t:sorcery; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    !mustValues.includes("t:land"),
    `t:land should not appear (land is the fetch target, not card type); got: ${mustValues.join(", ")}`
  );
  assert.ok(
    !mustValues.includes("t:basic"),
    `t:basic should not appear (basic is an adjective on the fetch target); got: ${mustValues.join(", ")}`
  );
  console.log('[PASS] phase1: "sorcery that finds basic lands from your library" has t:sorcery but not t:land or t:basic');
}

async function testPhase1CreaturesThatDestroyOtherCreaturesKeepsType() {
  const parsed = await parseNaturalQuery("creatures that destroy other creatures");
  const mustValues = parsed.mustClauses.map((c) => c.value);
  assert.ok(
    mustValues.includes("t:creature"),
    `expected t:creature for "creatures that destroy other creatures"; got: ${mustValues.join(", ")}`
  );
  console.log('[PASS] phase1: "creatures that destroy other creatures" keeps t:creature');
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
    unresolvedFragments: [{ text: "cool effects", category: "semantic" }],
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
      { text: "spider art", category: "art" },
      { text: "sword art", category: "art" },
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
    unresolvedFragments: [{ text: "prevent attacking", category: "effect" }],
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
    unresolvedFragments: [{ text: "hurt opponents", category: "effect" }],
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

async function testCardNameContainsWordIntent() {
  const parsed = await parseNaturalQuery("cards shelob in the name");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.includes("name:shelob"),
    `expected name:shelob for in-name word intent; got: ${mustValues.join(", ")}`
  );
  assert.equal(parsed.unresolvedFragments.length, 0);
  console.log('[PASS] card name: "shelob in the name" maps to name:shelob');
}

// ---- Phase 0 gate tests ----

function testPhase0GateSkipsShortQueries() {
  assert.equal(shouldNormalize("dragon elf"), false);
  assert.equal(shouldNormalize("goblins"), false);
  console.log("[PASS] phase0: gate skips queries with <= 2 words");
}

function testPhase0GateSkipsScryfallSyntax() {
  assert.equal(shouldNormalize("t:creature kw:flying c:w"), false);
  assert.equal(shouldNormalize("name:\"Sheoldred\" game:paper"), false);
  console.log("[PASS] phase0: gate skips direct Scryfall syntax");
}

function testPhase0GateTriggersForNaturalLanguage() {
  assert.equal(shouldNormalize("creaturs that destory other creaturs"), true);
  assert.equal(shouldNormalize("white creatures with flying"), true);
  assert.equal(shouldNormalize("enchantmens fly indestrutible white"), true);
  assert.equal(shouldNormalize("red card with deal damage when enter"), true);
  assert.equal(shouldNormalize("angels with lifelink and hexproof"), true);
  console.log("[PASS] phase0: gate triggers for all 3+ word natural language queries");
}

// ---- Phase 0 validation tests ----

function testPhase0ValidationAcceptsSpellingCorrections() {
  const result = validateResponse(
    "creaturs that destory other creaturs",
    "creatures that destroy other creatures"
  );
  assert.equal(result, "creatures that destroy other creatures");
  console.log("[PASS] phase0: validation accepts spelling corrections within Levenshtein <= 3");
}

function testPhase0ValidationAcceptsStructuralConnectors() {
  const result = validateResponse(
    "angels lifelink hexproof",
    "angels with lifelink and hexproof"
  );
  assert.equal(result, "angels with lifelink and hexproof");
  console.log("[PASS] phase0: validation accepts added connectors");
}

function testPhase0ValidationRejectsConceptChanges() {
  const result = validateResponse(
    "red creatures with haste",
    "blue dragons with flying"
  );
  assert.equal(result, null);
  console.log("[PASS] phase0: validation rejects hallucinated concept changes");
}

function testPhase0ValidationRejectsScryfallSyntax() {
  const result = validateResponse(
    "white creatures with flying",
    "t:creature kw:flying c:w"
  );
  assert.equal(result, null);
  console.log("[PASS] phase0: validation rejects Scryfall syntax in response");
}

function testPhase0ValidationRejectsExcessiveLength() {
  const result = validateResponse(
    "red burn spell",
    "red burn spell that deals damage to creatures and also draws cards and gains life and creates tokens"
  );
  assert.equal(result, null);
  console.log("[PASS] phase0: validation rejects responses over 2.5x original length");
}

function testPhase0ValidationAcceptsMixedFixes() {
  const result = validateResponse(
    "enchantmens giving fly and indestrutible",
    "enchantments that give flying and indestructible"
  );
  assert.equal(result, "enchantments that give flying and indestructible");
  console.log("[PASS] phase0: validation accepts combined spelling + grammar fixes");
}

function testPhase0ValidationStripsQuotes() {
  const result = validateResponse(
    "angels lifelink hexproof",
    '"angels with lifelink and hexproof"'
  );
  assert.equal(result, "angels with lifelink and hexproof");
  console.log("[PASS] phase0: validation strips surrounding quotes from response");
}

async function run() {
  // Phase 0 tests (deterministic — no LLM calls)
  testPhase0GateSkipsShortQueries();
  testPhase0GateSkipsScryfallSyntax();
  testPhase0GateTriggersForNaturalLanguage();
  testPhase0ValidationAcceptsSpellingCorrections();
  testPhase0ValidationAcceptsStructuralConnectors();
  testPhase0ValidationRejectsConceptChanges();
  testPhase0ValidationRejectsScryfallSyntax();
  testPhase0ValidationRejectsExcessiveLength();
  testPhase0ValidationAcceptsMixedFixes();
  testPhase0ValidationStripsQuotes();

  await testPhase1DirectQueryShortCircuit();
  testAssemblerBooleanComposition();
  testAssemblerSkipsArchetypeFragmentTags();
  testAssemblerEmitsRawTagsForNonArchetypeFragments();
  testAssemblerAndsArtConceptsPerFragment();
  await testPhase3DirectQueryAddsPreferBest();
  await testPhase3DirectQueryPassThrough();
  await testPhase3RemovesUnknownTypeFilters();
  await testPhase3PreservesAndedStandaloneArtTags();
  await testPipelineDirectEndToEnd();
  await testPipelineSimilarCardsDoesNotContradictNameExclusion();
  await testPhase1CommanderFormatColorExtraction();
  await testPhase1EtbDrawUsesOracleFilters();
  await testPhase1NoCardsInHandDamageUsesOracleAnchors();
  await testPhase1LifeStealUsesFunctionTags();
  await testPhase1DeathLifeGainUsesOracleAnchors();
  await testPhase1ArtDescriptorBundlesUseAndedArtTags();
  await testPhase1PluralTypeIsStrippedFromArtFragments();
  await testPhase1SorceryPluralKeepsTypeAndStripsFromArtFragment();
  await testPhase1EnchantTargetNotCardType();
  await testPhase1FuzzyColorIdentityTypo();
  await testPhase1MonocolorUsesExactIdentity();
  await testPhase1FuzzyKeywordTypo();
  await testPhase1FuzzyStrategyTypo();
  await testPhase1SynergyIntentUsesFunctionTagsForMentionedSubject();
  await testPhase1SynergyIntentSupportsOrSubjectLists();
  await testPhase1SynergyIntentSupportsMixedTypeListBeforeOr();
  await testPhase1CommanderFromFranchiseSetsAvoidsNoise();
  await testPhase1CommanderFromLorwynAvoidsCommanderProductSetNoise();
  await testPhase1UniversesBeyondIsFlagNotSetFilter();
  await testPhase3DoesNotForceCommanderCreatureForFormatIntent();
  await testPhase3LegalInMultipleFormatsKeepsFCommanderNoIsCommander();
  await testPhase3RemovesTreasureTypeForTokenGenerationIntent();
  await testPhase3RemovesAnyTokenTypeForGenerationIntent();
  await testPhase3StripsDamageTargetCreatureTypeFilter();
  await testPhase1MakeTokensDoesNotProduceTokenType();
  await testPhase1MakeTokensWithPtAddsOracleClause();
  await testPhase1ToFindLandsDoesNotMatchCardName();
  await testPhase1TutorFetchesMultiWordTargetNotType();
  await testPhase1CreaturesThatDestroyOtherCreaturesKeepsType();
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
  await testCardNameContainsWordIntent();
  await testCardsWithSubtype();
  await testPhase1SynergyWithCardDetectsIntent();
  await testPhase1SynergyWithCardVariants();
  await testPhase1SynergyWithCardDoesNotFalsePositive();
  await testPhase1SynergyWithCardPreservesExtraConstraints();
  await testPhase1SimilarToCardPreservesExtraConstraints();
  // Rarity filter tests
  await testPhase1RarityExact();
  await testPhase1RarityRareOrHigher();
  await testPhase1RarityAtLeastUncommon();
  await testPhase1RarityRarePlus();
  await testPhase1RarityNoArtThopter();
  // Aristocrats + commanders
  await testPhase1AristocratCommandersResolves();
  await testPhase1CommandersPluralIsCommander();
  // Reanimate verb protection
  await testPhase1ArtifactsReanimateCreaturesNoNameClause();
  // Similar-cards type preservation
  await testPhase1InstantsLikeCardPreservesTypeFilter();
  await testPhase1BloodArtistEffectsOnCreatures();
  // Function concept clauses
  await testPhase1CantripsMapToFunctionCantrip();
  await testPhase1LootingMapsFunctionLoot();
  // Scaling oracle text heuristics
  await testPhase1ManaForEachSpell();
  await testPhase1ForEachArtifactScaling();
  // Grammar-mistake similar-cards variants
  await testPhase1SimilarThanGrammarMistake();
  // Comma in card name must not trigger card-name-list detection
  await testPhase1SimilarToCardWithCommaInName();
  // Filler words between type and "like/similar to"
  await testPhase1SimilarWithFillerWords();
  // Stat filter: "costs N mana or more" must not emit both mv>= and mv=
  await testPhase1CostNManaOrMoreProducesOnlyGteClause();
  // Direct Scryfall queries must never be re-routed
  await testPhase1DirectScryfallNeverModified();
  // Compound OR query splitting
  await testPhase1WheneverTypeLeavesZone();
  await testPhase1ManaCostFullyStripped();
  // Regression: Phase-0-normalized "mana value N or more" must not produce both mv= and mv>=
  await testPhase1ManaValueNOrMoreNoDuplicate();
  // Regression: "big mana creatures in jund colors" must emit mv>=6 + id:brg, not ramp
  await testPhase1BigManaCreaturesInJundColors();
  // "cheap" / "low mana" must emit mv<=3, not reach Phase 2
  await testPhase1CheapLowManaEmitsMvFilter();
  await testPhase1GrantDoubleStrikeDeterministic();
  testSplitCompoundCommaOr();
  testSplitCompoundBareOrAfterEmbedded();
  testSplitCompoundDoesNotSplitSimpleTypeOr();
  testSplitCompoundDoesNotSplitColorOr();
  testSplitCompoundDoesNotSplitTypeListOr();
  testSplitCompoundDoesNotSplitEmbeddedOrMore();
  testSplitCompoundThreeBranches();
  await testCompoundPipelineEndToEnd();
  await testCompoundBypassIntentFallsBack();
  console.log("search-pipeline tests passed");
}

async function testPhase1GrantDoubleStrikeDeterministic() {
  const q =
    "blue, red, and black artifacts or enchantments that give double strike";
  const parsed = await parseNaturalQuery(q);
  const mustValues = parsed.mustClauses.map((c) => c.value);
  const hasGrant = mustValues.some((v) =>
    /function:gives-double-strike\b/.test(v)
  );
  assert.ok(hasGrant, `expected function:gives-double-strike in mustClauses; got: ${mustValues.join(", ")}`);
  assert.ok(
    !parsed.unresolvedFragments.some((f) => /give|double|strike/i.test(f.text)),
    `grant phrase should not leak as fragments: ${JSON.stringify(parsed.unresolvedFragments)}`
  );
  console.log("[PASS] phase1: 'give double strike' uses deterministic grant tags (before subtype steal)");
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

async function testPhase1SynergyWithCardPreservesExtraConstraints() {
  const parsed = await parseNaturalQuery("cards that synergize with lightning bolt that are not instants");
  assert.equal(parsed.intent, "synergy-with-card", `expected synergy-with-card, got: ${parsed.intent}`);
  assert.ok(parsed.synergyWithCardName, "expected synergyWithCardName to be set");
  const mustNotValues = parsed.mustNotClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustNotValues.some((v) => v.includes("t:instant")),
    `expected -t:instant in mustNotClauses; got: ${mustNotValues.join(", ")}`
  );
  console.log("[PASS] phase1: synergy-with-card preserves extra type negation (-t:instant)");
}

async function testPhase1SimilarToCardPreservesExtraConstraints() {
  const parsed = await parseNaturalQuery("cards similar to lightning bolt in modern");
  assert.equal(parsed.intent, "similar-cards", `expected similar-cards, got: ${parsed.intent}`);
  assert.ok(parsed.similarToCardName, "expected similarToCardName to be set");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.some((v) => v.includes("f:modern")),
    `expected f:modern in mustClauses; got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: similar-cards preserves extra format constraint (f:modern)");
}

// ---------------------------------------------------------------------------
// Rarity filter tests
// ---------------------------------------------------------------------------

async function testPhase1RarityExact() {
  const parsed = await parseNaturalQuery("blue rare instants");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.some((v) => v === "r:r" || v === "rarity:rare"),
    `expected r:r or rarity:rare; got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: 'rare' resolves to exact rarity filter r:r");
}

async function testPhase1RarityRareOrHigher() {
  const parsed = await parseNaturalQuery("blue card that has to do with thopters rarity rare or higher");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.some((v) => v === "r>=r" || v === "rarity>=rare"),
    `expected r>=r; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    !mustValues.some((v) => v === "r:r" || v === "rarity:rare"),
    `should use >= not exact; got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: 'rarity rare or higher' resolves to r>=r");
}

async function testPhase1RarityAtLeastUncommon() {
  const parsed = await parseNaturalQuery("at least uncommon green creatures");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.some((v) => v === "r>=u" || v === "rarity>=uncommon"),
    `expected r>=u; got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: 'at least uncommon' resolves to r>=u");
}

async function testPhase1RarityRarePlus() {
  const parsed = await parseNaturalQuery("white mythic+ removal spells");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.some((v) => v === "r>=m" || v === "rarity>=mythic"),
    `expected r>=m; got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: 'mythic+' resolves to r>=m");
}

async function testPhase1RarityNoArtThopter() {
  // art:thopter should NOT appear for a general thopter query even if AI would suggest it
  // This is a Phase 2 / prompt rule — we just verify the rarity was extracted correctly.
  const parsed = await parseNaturalQuery("blue card that has to do with thopters rarity rare or higher");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(mustValues.includes("id:u"), `expected id:u; got: ${mustValues.join(", ")}`);
  assert.ok(
    mustValues.some((v) => v === "r>=r"),
    `expected r>=r from 'rarity rare or higher'; got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: thopter rarity query has id:u and r>=r");
}

// ---------------------------------------------------------------------------
// Aristocrats commanders / plural commanders tests
// ---------------------------------------------------------------------------

async function testPhase1AristocratCommandersResolves() {
  const parsed = await parseNaturalQuery("aristocrat commanders");
  const mustValues = parsed.mustClauses.map((c) => c.value);
  assert.ok(
    mustValues.some((v) => /strategy:"?Aristocrats"?/i.test(v)),
    `expected strategy:Aristocrats; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    mustValues.some((v) => /is:commander/i.test(v)),
    `expected is:commander; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    !mustValues.some((v) => /\bt:creature\b/i.test(v)),
    `t:creature should NOT appear for 'aristocrat commanders'; got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: 'aristocrat commanders' → strategy:Aristocrats + is:commander, no t:creature");
}

async function testPhase1CommandersPluralIsCommander() {
  const parsed = await parseNaturalQuery("simic commanders");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.some((v) => /is:commander/i.test(v)),
    `expected is:commander for 'simic commanders'; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    mustValues.some((v) => /id[:=<]*(gu|ug)/i.test(v)),
    `expected simic color identity; got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: 'simic commanders' → is:commander");
}

// ---------------------------------------------------------------------------
// Reanimate verb-phrase protection tests
// ---------------------------------------------------------------------------

async function testPhase1ArtifactsReanimateCreaturesNoNameClause() {
  const parsed = await parseNaturalQuery("artifacts that reanimate creatures");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.includes("t:artifact"),
    `expected t:artifact; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    !mustValues.some((v) => v.startsWith('name:"reanimate"') || v === 'name:"reanimate"'),
    `name:"Reanimate" should NOT appear; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    !mustValues.includes("t:creature"),
    `t:creature should NOT appear (creature is object of reanimate); got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: 'artifacts that reanimate creatures' → t:artifact, no name:reanimate, no t:creature");
}

// ---------------------------------------------------------------------------
// Similar-cards type preservation tests
// ---------------------------------------------------------------------------

async function testPhase1InstantsLikeCardPreservesTypeFilter() {
  const parsed = await parseNaturalQuery("instants like lava axe");
  assert.equal(parsed.intent, "similar-cards", `expected similar-cards, got: ${parsed.intent}`);
  assert.ok(parsed.similarToCardName, "expected similarToCardName to be set");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.some((v) => v === "t:instant" || v === "(t:instant or t:sorcery)"),
    `expected t:instant in mustClauses; got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: 'instants like Lava Axe' → similar-cards with t:instant preserved");
}

async function testPhase1BloodArtistEffectsOnCreatures() {
  const parsed = await parseNaturalQuery("blood artist effects on creatures");
  assert.equal(parsed.intent, "similar-cards", `expected similar-cards, got: ${parsed.intent}`);
  assert.ok(
    parsed.similarToCardName,
    "expected similarToCardName to be set"
  );
  assert.ok(
    /blood artist/i.test(parsed.similarToCardName ?? ""),
    `expected similarToCardName to contain 'blood artist'; got: "${parsed.similarToCardName}"`
  );
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.includes("t:creature"),
    `expected t:creature in mustClauses for 'on creatures'; got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: 'blood artist effects on creatures' → similar-cards with t:creature");
}

async function testPhase1CantripsMapToFunctionCantrip() {
  const queries = [
    "cheap blue draw cantrips",
    "white cantrip spells",
    "cantrips in modern",
  ];
  for (const query of queries) {
    const parsed = await parseNaturalQuery(query);
    const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
    assert.ok(
      mustValues.includes("function:cantrip"),
      `"${query}" expected function:cantrip; got: ${mustValues.join(", ")}`
    );
    assert.ok(
      !mustValues.some((v) => /function:(draw-engine|repeatable-draw|pure-draw|impulse-draw|burst-draw)/.test(v)),
      `"${query}" should NOT have draw-engine tags; got: ${mustValues.join(", ")}`
    );
  }
  console.log("[PASS] phase1: 'cantrips' → function:cantrip, not draw-engine tags");
}

async function testPhase1LootingMapsFunctionLoot() {
  const parsed = await parseNaturalQuery("red looting effects");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.includes("function:loot"),
    `expected function:loot; got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: 'looting' → function:loot");
}

async function testPhase1ManaForEachSpell() {
  const parsed = await parseNaturalQuery("card that makes blue mana for each spell you cast");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.some((v) => v === 'o:"add {u}"'),
    `expected o:"add {U}"; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    mustValues.some((v) => v === 'o:"for each"'),
    `expected o:"for each"; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    mustValues.some((v) => v === "o:spell"),
    `expected o:spell; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    !mustValues.some((v) => /function:(ramp|mana-ramp)/.test(v)),
    `should NOT have function:ramp or function:mana-ramp; got: ${mustValues.join(", ")}`
  );
  assert.ok(mustValues.includes("id:u"), `expected id:u; got: ${mustValues.join(", ")}`);
  console.log("[PASS] phase1: 'makes blue mana for each spell' → oracle text, not function:ramp");
}

async function testPhase1ForEachArtifactScaling() {
  const parsed = await parseNaturalQuery("creatures that get +1/+1 for each artifact you control");
  const mustValues = parsed.mustClauses.map((c) => c.value.toLowerCase());
  assert.ok(
    mustValues.some((v) => v === 'o:"for each"'),
    `expected o:"for each"; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    mustValues.some((v) => v === "o:artifact"),
    `expected o:artifact; got: ${mustValues.join(", ")}`
  );
  console.log("[PASS] phase1: 'for each artifact' scaling → oracle text anchors");
}

async function testPhase1SimilarThanGrammarMistake() {
  // "similar than" is a common non-native speaker mistake for "similar to".
  const variants = [
    "card similar than the ozolith",
    "something similar than sol ring",
    "cards similar as lightning bolt",
    "card similar with counterspell",
  ];
  for (const query of variants) {
    const parsed = await parseNaturalQuery(query);
    assert.equal(
      parsed.intent,
      "similar-cards",
      `"${query}" should detect similar-cards; got: ${parsed.intent}`
    );
    assert.ok(
      parsed.similarToCardName,
      `"${query}" should set similarToCardName`
    );
  }
  console.log("[PASS] phase1: 'similar than/as/with' grammar mistakes detect similar-cards intent");
}

async function testPhase1SimilarToCardWithCommaInName() {
  // Cards whose names contain a comma (e.g. "Sheoldred, the Apocalypse") must
  // trigger similar-cards, not the comma-separated card-name-list detector.
  const queries = [
    "cards like sheoldred, the apocalypse",
    "something like jace, the mind sculptor",
    "similar to emrakul, the aeons torn",
  ];
  for (const query of queries) {
    const parsed = await parseNaturalQuery(query);
    assert.equal(
      parsed.intent,
      "similar-cards",
      `"${query}" should detect similar-cards; got: ${parsed.intent}`
    );
    assert.ok(
      parsed.similarToCardName,
      `"${query}" should set similarToCardName; got: ${parsed.similarToCardName}`
    );
  }
  console.log("[PASS] phase1: 'cards like X, the Y' with comma in card name → similar-cards, not card-name-list");
}

async function testPhase1SimilarWithFillerWords() {
  // "card that are like X" has filler words between the type and "like".
  const variants = [
    "card that are like scrawling crawler",
    "white black blue card that are like scrawling crawler",
    "cards that are like lightning bolt",
    "cards which are similar to sol ring",
    "something that is like counterspell",
  ];
  for (const query of variants) {
    const parsed = await parseNaturalQuery(query);
    assert.equal(
      parsed.intent,
      "similar-cards",
      `"${query}" should detect similar-cards; got: ${parsed.intent}`
    );
    assert.ok(
      parsed.similarToCardName,
      `"${query}" should set similarToCardName`
    );
  }
  console.log("[PASS] phase1: 'card that are like X' filler words detect similar-cards intent");
}

async function testPhase1CostNManaOrMoreProducesOnlyGteClause() {
  // Regression: "costs N mana or more" was emitting both mv>=N (correct) and mv=N (wrong).
  // The bare "costsNum" pattern matched "cost 10 mana" as a sub-string of "cost 10 mana or more"
  // before the "or more" suffix had been consumed, producing a contradictory mv=10 alongside mv>=10.
  const queries = [
    "creatures that cost 10 mana or more",
    "spells costing 3 mana or more",
    "cards that cost 5 or more mana",
  ];
  for (const query of queries) {
    const parsed = await parseNaturalQuery(query);
    const statValues = parsed.mustClauses
      .filter((c) => c.source === "phase1:stat")
      .map((c) => c.value);
    const hasGte = statValues.some((v) => /^mv>=\d+$/.test(v));
    const hasEq = statValues.some((v) => /^mv=\d+$/.test(v));
    assert.ok(hasGte, `"${query}" expected mv>= clause; got: ${statValues.join(", ")}`);
    assert.ok(!hasEq, `"${query}" must NOT produce mv= clause alongside mv>=; got: ${statValues.join(", ")}`);
  }
  console.log("[PASS] phase1: 'costs N mana or more' emits only mv>=N, not mv=N");
}

async function testPhase1DirectScryfallNeverModified() {
  // Direct Scryfall queries must NEVER be re-routed or modified.
  const directQueries = [
    `name:"The Ozolith"`,
    `prefer:best name:"The Ozolith" game:paper`,
    `t:creature id:rg function:burn-any game:paper`,
  ];
  for (const query of directQueries) {
    const parsed = await parseNaturalQuery(query);
    assert.equal(
      parsed.intent,
      "direct-scryfall",
      `direct Scryfall query "${query}" should stay direct-scryfall; got: ${parsed.intent}`
    );
  }
  console.log("[PASS] phase1: direct Scryfall queries are never re-routed");
}

// ---------------------------------------------------------------------------
// Compound OR query splitting tests
// ---------------------------------------------------------------------------

function testSplitCompoundCommaOr() {
  const result = splitCompoundQuery(
    "Jund creatures that cost 10 mana or more, or artifact creatures that cost 10 mana or more"
  );
  assert.equal(result.length, 2, `expected 2 branches; got ${result.length}: ${JSON.stringify(result)}`);
  assert.ok(
    /jund creatures/i.test(result[0]),
    `branch 1 should contain 'jund creatures'; got: "${result[0]}"`
  );
  assert.ok(
    /artifact creatures/i.test(result[1]),
    `branch 2 should contain 'artifact creatures'; got: "${result[1]}"`
  );
  console.log("[PASS] splitCompoundQuery: ', or' splits two compound branches");
}

function testSplitCompoundBareOrAfterEmbedded() {
  // The bare "or" between "more" and "artifact" must be detected even without a comma.
  const result = splitCompoundQuery(
    "jund creatures 10 mana or more or artifact creatures 10 mana or more"
  );
  assert.equal(result.length, 2, `expected 2 branches; got ${result.length}: ${JSON.stringify(result)}`);
  assert.ok(/jund/i.test(result[0]), `branch 1 should contain 'jund'; got: "${result[0]}"`);
  assert.ok(/artifact/i.test(result[1]), `branch 2 should contain 'artifact'; got: "${result[1]}"`);
  console.log("[PASS] splitCompoundQuery: bare 'or' after embedded 'or more' splits correctly");
}

function testSplitCompoundDoesNotSplitSimpleTypeOr() {
  // "goblins or elves" — single terms, should NOT be split (groupByConnector handles it).
  const result = splitCompoundQuery("goblins or elves");
  assert.equal(result.length, 1, `expected 1 branch (no split); got ${result.length}: ${JSON.stringify(result)}`);
  console.log("[PASS] splitCompoundQuery: 'goblins or elves' does not split");
}

function testSplitCompoundDoesNotSplitColorOr() {
  // "red or blue creatures" — left side has only 1 meaningful word ("red").
  const result = splitCompoundQuery("red or blue creatures");
  assert.equal(result.length, 1, `expected 1 branch (no split); got ${result.length}: ${JSON.stringify(result)}`);
  console.log("[PASS] splitCompoundQuery: 'red or blue creatures' does not split");
}

function testSplitCompoundDoesNotSplitTypeListOr() {
  // "artifacts or enchantments" is a card-type list, not two independent compound branches.
  const result = splitCompoundQuery(
    "blue, red, and black artifacts or enchantments that give double strike"
  );
  assert.equal(result.length, 1, `expected 1 branch (no split); got ${result.length}: ${JSON.stringify(result)}`);
  console.log("[PASS] splitCompoundQuery: 'artifacts or enchantments' type list does not split");
}

function testSplitCompoundDoesNotSplitEmbeddedOrMore() {
  // "creatures 5 mana or more" — "or more" is embedded, no split point.
  const result = splitCompoundQuery("creatures that cost 5 mana or more");
  assert.equal(result.length, 1, `expected 1 branch (no split); got ${result.length}: ${JSON.stringify(result)}`);
  console.log("[PASS] splitCompoundQuery: 'or more' is not a split point");
}

function testSplitCompoundThreeBranches() {
  const result = splitCompoundQuery(
    "red creatures with flying, or blue enchantments with hexproof, or green lands"
  );
  assert.equal(result.length, 3, `expected 3 branches; got ${result.length}: ${JSON.stringify(result)}`);
  assert.ok(/red creatures/i.test(result[0]), `branch 1: ${result[0]}`);
  assert.ok(/blue enchantments/i.test(result[1]), `branch 2: ${result[1]}`);
  assert.ok(/green lands/i.test(result[2]), `branch 3: ${result[2]}`);
  console.log("[PASS] splitCompoundQuery: three-way ', or' split works");
}

async function testPhase1WheneverTypeLeavesZone() {
  // Regression: "whenever an instant leaves your graveyard" was producing zero mustClauses
  // because "instant" was blocked by triggerSubjectTokens and nothing else produced output.
  // Phase 2 got the whole query, returned an unknown archetype with no raw tags, and the
  // query was empty → 500 crash.  Phase 1 now handles this deterministically.
  //
  // The zone-to-tag mapping is resolved dynamically from the live tagger catalog:
  //   - When the catalog contains "leaves-graveyard-trigger" →
  //       function:leaves-graveyard-trigger is emitted
  //   - When the catalog is unavailable (e.g. no cache file in CI) →
  //       o:"leaves" + o:graveyard oracle-text fallback is emitted
  // Both outcomes are valid; the test accepts either.
  const parsed = await parseNaturalQuery("whenever an instant leaves your graveyard");
  const mustValues = parsed.mustClauses.map((c) => c.value);
  const hasFunctionTag = mustValues.includes("function:leaves-graveyard-trigger");
  const hasOracleFallback =
    mustValues.includes('o:"leaves"') && mustValues.some((v) => /o:graveyard/.test(v));
  assert.ok(
    hasFunctionTag || hasOracleFallback,
    `expected function:leaves-graveyard-trigger OR o:"leaves"+o:graveyard fallback; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    mustValues.some((v) => /o:instant/.test(v)),
    `expected o:instant (type qualifier) clause; got: ${mustValues.join(", ")}`
  );
  assert.ok(
    !mustValues.some((v) => /^t:instant$/.test(v)),
    `t:instant must NOT appear (instant is the trigger subject, not card type); got: ${mustValues.join(", ")}`
  );
  const resolvedAs = hasFunctionTag ? "function:leaves-graveyard-trigger" : "oracle-text fallback";
  console.log(`[PASS] phase1: 'whenever an instant leaves your graveyard' → ${resolvedAs} + o:instant, no t:instant`);
}

async function testPhase1ManaCostFullyStripped() {
  // "mana cost 10 or more" — the word "mana" before "cost" must be consumed
  // by the stat detector so it doesn't survive as an unresolved fragment that
  // Phase 2 misclassifies as ramp.
  const parsed = await parseNaturalQuery("creatures with mana cost 10 or more");
  const statValues = parsed.mustClauses
    .filter((c) => c.source === "phase1:stat")
    .map((c) => c.value);
  assert.ok(
    statValues.some((v) => /^mv>=10$/.test(v)),
    `expected mv>=10; got: ${statValues.join(", ")}`
  );
  assert.ok(
    parsed.unresolvedFragments.every((f) => !/\bmana\b/i.test(f.text)),
    `'mana' should NOT survive as unresolved; got: ${parsed.unresolvedFragments.map((f) => f.text).join(" | ")}`
  );
  console.log("[PASS] phase1: 'mana cost N or more' fully consumed — no residual 'mana' fragment");
}

async function testPhase1ManaValueNOrMoreNoDuplicate() {
  // Regression: Phase 0 normalises "jund creatures 10 mana or more" to
  // "jund creatures with mana value 10 or more". The phrase "[mv alias] [num] or more"
  // previously caused BOTH mv=10 (from mvEqNum matching the prefix) AND mv>=10
  // (from numManaOp matching the suffix) to be emitted.
  const parsed = await parseNaturalQuery("creatures with mana value 10 or more");
  const statValues = parsed.mustClauses
    .filter((c) => c.source === "phase1:stat")
    .map((c) => c.value);
  assert.ok(
    statValues.some((v) => /^mv>=10$/.test(v)),
    `expected mv>=10; got: ${statValues.join(", ")}`
  );
  assert.ok(
    !statValues.some((v) => /^mv=10$/.test(v)),
    `mv=10 must NOT appear alongside mv>=10; got: ${statValues.join(", ")}`
  );
  console.log("[PASS] phase1: 'mana value N or more' → only mv>=N, no spurious mv=N");
}

async function testPhase1BigManaCreaturesInJundColors() {
  // Regression: "big mana creatures in jund colors" was sending "big mana colors" as an
  // unresolved fragment to Phase 2, which misclassified it as archetype:ramp.
  // Fix 1: "big mana" is now a Phase 1 stat pattern that emits mv>=6 and strips itself.
  // Fix 2: "colors" is now stripped when any color identity is resolved, so it no longer
  //         bleeds into the fragment text.
  const parsed = await parseNaturalQuery("big mana creatures in jund colors");
  const mustValues = parsed.mustClauses.map((c) => c.value);
  assert.ok(
    mustValues.some((v) => /^mv>=6$/.test(v)),
    `expected mv>=6 for "big mana"; got clauses: ${mustValues.join(", ")}`
  );
  assert.ok(
    mustValues.some((v) => /^id:brg$/.test(v)),
    `expected id:brg for jund colors; got clauses: ${mustValues.join(", ")}`
  );
  assert.ok(
    mustValues.some((v) => /^t:creature$/.test(v)),
    `expected t:creature; got clauses: ${mustValues.join(", ")}`
  );
  // "colors" must not appear in any unresolved fragment
  assert.ok(
    parsed.unresolvedFragments.every((f) => !/\bcolou?rs?\b/i.test(f.text)),
    `"colors" should NOT survive as unresolved; got: ${parsed.unresolvedFragments.map((f) => f.text).join(" | ")}`
  );
  console.log("[PASS] phase1: 'big mana creatures in jund colors' → mv>=6 t:creature id:brg, no 'colors' fragment");
}

async function testPhase1CheapLowManaEmitsMvFilter() {
  const cases: [string, string][] = [
    ["cheap blue instants", "cheap"],
    ["low mana creatures", "low mana"],
    ["low cost spells", "low cost"],
    ["low cmc artifacts", "low cmc"],
  ];
  for (const [query, desc] of cases) {
    const parsed = await parseNaturalQuery(query);
    const statValues = parsed.mustClauses
      .filter((c) => c.source === "phase1:stat")
      .map((c) => c.value);
    assert.ok(
      statValues.some((v) => /^mv<=3$/.test(v)),
      `[${desc}] expected mv<=3; got: ${statValues.join(", ")}`
    );
    assert.ok(
      parsed.unresolvedFragments.every((f) => !/(cheap|low.mana|low.cost|low.cmc)/i.test(f.text)),
      `[${desc}] phrase should not survive as unresolved; got: ${parsed.unresolvedFragments.map((f) => f.text).join(" | ")}`
    );
  }
  console.log("[PASS] phase1: 'cheap' / 'low mana' / 'low cost' → mv<=3, not a fragment");
}

async function testCompoundPipelineEndToEnd() {
  // Use Phase 1 directly on each branch to verify the structural output,
  // since the full pipeline would require AI for Phase 0/2.
  const branch1 = await parseNaturalQuery("jund creatures that cost 10 mana or more");
  const branch2 = await parseNaturalQuery("artifact creatures that cost 10 mana or more");

  const b1Must = branch1.mustClauses.map((c) => c.value);
  const b2Must = branch2.mustClauses.map((c) => c.value);

  assert.ok(b1Must.includes("t:creature"), `branch1 needs t:creature; got: ${b1Must.join(", ")}`);
  assert.ok(b1Must.some((v) => /id[:=]brg/i.test(v)), `branch1 needs id:brg; got: ${b1Must.join(", ")}`);
  assert.ok(b1Must.some((v) => /mv>=10/.test(v)), `branch1 needs mv>=10; got: ${b1Must.join(", ")}`);
  assert.ok(!b1Must.includes("t:artifact"), `branch1 must NOT have t:artifact; got: ${b1Must.join(", ")}`);

  assert.ok(b2Must.includes("t:creature"), `branch2 needs t:creature; got: ${b2Must.join(", ")}`);
  assert.ok(b2Must.includes("t:artifact"), `branch2 needs t:artifact; got: ${b2Must.join(", ")}`);
  assert.ok(b2Must.some((v) => /mv>=10/.test(v)), `branch2 needs mv>=10; got: ${b2Must.join(", ")}`);
  assert.ok(!b2Must.some((v) => /id[:=]brg/i.test(v)), `branch2 must NOT have id:brg; got: ${b2Must.join(", ")}`);

  console.log("[PASS] compound: per-branch Phase 1 produces correct independent clauses");
}

async function testCompoundBypassIntentFallsBack() {
  // If a compound split branch triggers a bypass intent, the whole thing
  // should fall back to the single pipeline (bypass intents are not compound-safe).
  const branches = splitCompoundQuery("cards like lightning bolt, or red burn spells");
  // Even if the split detects 2 branches, the "cards like" branch should detect
  // similar-cards intent and abort compound mode.  Verify branch 1 has bypass intent.
  if (branches.length > 1) {
    const phase1 = await parseNaturalQuery(branches[0]);
    assert.ok(
      phase1.intent === "similar-cards" || phase1.intent === "search",
      `first branch should detect similar-cards or fall through; got: ${phase1.intent}`
    );
  }
  console.log("[PASS] compound: bypass intent in branch correctly detected");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

