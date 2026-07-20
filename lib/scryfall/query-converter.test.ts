import assert from "node:assert/strict";
import type { TaggerTagContext } from "@/lib/tagger/context";
import {
  HATE_MAGNET_FUNCTION_TAGS,
  finalizeScryfallQuery,
  hateMagnetFunctionTagsExcluding,
  isScryfallQuery,
  truncateScryfallQuery,
} from "@/lib/scryfall/query-converter";

type FinalizeTestCase = {
  name: string;
  naturalQuery: string;
  rawQuery: string;
  expected: string;
  tagContext?: TaggerTagContext;
  maxLength?: number;
};

const finalizeCases: FinalizeTestCase[] = [
  {
    name: "strips markdown fences",
    naturalQuery: "counterspells",
    rawQuery: "```\nfunction:counterspell\n```",
    expected: "function:counterspell",
  },
  {
    name: "preserves queries without edits",
    naturalQuery: "red dragons",
    rawQuery: "c:r t:dragon",
    expected: "c:r t:dragon",
  },
  {
    name: "strips o:casual (playgroup meta, not oracle search axis)",
    naturalQuery: "zz",
    rawQuery: "o:casual t:creature",
    expected: "t:creature",
  },
  {
    name: "strips o:fun and o:play when query is casual playgroup talk",
    naturalQuery: "casual commander pod zz",
    rawQuery: "o:casual o:fun o:play t:creature",
    expected: "t:creature is:commander",
  },
  {
    name: "strips o:combo and o:\"combo with\" for colloquial synergy phrasing",
    naturalQuery: "untap shenanigans stuff that combos with mana dorks zz",
    rawQuery: "o:untap o:combo o:\"combo with\" t:creature",
    expected: "o:untap t:creature",
  },
  {
    name: "strips rogue parenthetical (or) between function groups",
    naturalQuery: "zz",
    rawQuery:
      "f:commander (function:boardwipe or function:wrath-of-god) (or) (function:removal-exile or function:removal-destroy) game:paper",
    expected:
      "f:commander (function:boardwipe or function:wrath-of-god) (function:removal-exile or function:removal-destroy) game:paper",
  },
  {
    name: "unwraps redundant single-member group after OR sibling stripped",
    naturalQuery: "best lords and anthems for zombie in commander",
    rawQuery: "t:zombie f:commander (function:zombie-lord or function:anthem or function:lord)",
    expected: "t:zombie f:commander function:zombie-lord function:anthem function:lord",
  },
  {
    name: "appends and expands strategy tags",
    naturalQuery: "Orzhov aristocrats",
    rawQuery: "id=wb",
    expected:
      "id=wb (function:sacrifice-outlet or function:sac-outlet or function:death-trigger or function:death-trigger-self or function:synergy-sacrifice or function:blood-artist-ability)",
  },
  {
    name: "normalizes format function tags",
    naturalQuery: "legacy counterspells",
    rawQuery: "function:legacy function:counterspell",
    expected: "f:legacy function:counterspell",
  },
  {
    name: "replaces tutor with land-specific tag",
    naturalQuery: "tutor for lands",
    rawQuery: "function:tutor",
    expected: "function:tutor-land",
    tagContext: {
      art: [],
      function: ["tutor-land", "tutor-to-hand"],
    },
  },
  {
    name: "adds tutor-to-hand tag when requested",
    naturalQuery: "tutor a land to hand",
    rawQuery: "function:tutor",
    expected: "function:tutor-land",
    tagContext: {
      art: [],
      function: ["tutor-land", "tutor-to-hand"],
    },
  },
  {
    name: "adds tutor-to-battlefield tag when requested",
    naturalQuery: "tutor a land onto the battlefield",
    rawQuery: "function:tutor",
    expected: "function:tutor-land function:tutor-to-battlefield",
    tagContext: {
      art: [],
      function: ["tutor-land", "tutor-to-battlefield"],
    },
  },
  {
    name: "fixes missing closing paren",
    naturalQuery: "flying creatures",
    rawQuery: "t:creature (kw:flying",
    expected: "t:creature (kw:flying)",
  },
  {
    name: "normalizes instant and sorcery type filters to OR chain",
    naturalQuery: "prefer:best t:instant t:sorcery id:rw function:opponent-loses-life game:paper",
    rawQuery: "t:instant t:sorcery id:rw function:opponent-loses-life game:paper",
    expected: "(t:instant or t:sorcery) id:rw function:opponent-loses-life game:paper",
  },
  {
    name: "adds burn and opponent damage function tags in OR chain",
    naturalQuery: "boros instants and sorceries that damage opponents",
    rawQuery: "t:instant t:sorcery id:rw",
    expected:
      "(t:instant or t:sorcery) id:rw (function:burn-player or function:burn-player-each or function:burn-any or function:opponent-loses-life or function:life-drain or function:drain-life or function:lifegain-to-damage)",
  },
  {
    name: "adds creature burn tags for damage creature intent",
    naturalQuery: "boros instants and sorceries that damage target creature",
    rawQuery: "t:instant t:sorcery id:rw",
    expected:
      "(t:instant or t:sorcery) id:rw (function:burn-creature or function:burn-any or function:removal-creature-burn or function:removal-burn)",
  },
  {
    name: "adds any-target burn tags for damage any target intent",
    naturalQuery: "red spells that deal damage to any target",
    rawQuery: "c:r",
    expected:
      "c:r (function:burn-any or function:burn-creature or function:burn-player or function:burn-planeswalker or function:removal-burn or function:opponent-loses-life)",
  },
  {
    name: "adds creature removal tags for creature removal intent",
    naturalQuery: "white creature removal spells",
    rawQuery: "c:w",
    expected:
      "c:w (function:removal-creature or function:removal-creature-burn or function:removal-creature-fight or function:removal-exile or function:removal-destroy or function:spot-removal)",
  },
  {
    name: "exile-for-delayed-use does not trigger removal archetype",
    naturalQuery: "cards that exile and can be used later",
    rawQuery:
      "(function:exile-on-resolution or function:castable-from-exile or function:unexile)",
    expected:
      "(function:exile-on-resolution or function:castable-from-exile or function:unexile)",
  },
  {
    name: "delayed-cast mechanic name does not trigger removal archetype",
    naturalQuery: "creatures with warp that exile themselves",
    rawQuery: "t:creature kw:warp",
    expected: "t:creature kw:warp",
  },
  {
    name: "plain exile removal still triggers removal archetype",
    naturalQuery: "white spells that exile creatures",
    rawQuery: "c:w",
    expected:
      "c:w (function:removal-creature or function:removal-creature-burn or function:removal-creature-fight or function:removal-exile or function:removal-destroy or function:spot-removal)",
  },
  {
    name: "adds ramp tags for ramp intent",
    naturalQuery: "green mana ramp for commander",
    rawQuery: "c:g f:commander",
    expected:
      "c:g f:commander (function:ramp or function:mana-ramp)",
  },
  {
    name: "adds mill-opponent tags for mill opponent intent",
    naturalQuery: "dimir cards that mill opponents",
    rawQuery: "id:ub",
    expected:
      "id:ub (function:mill-opponent or function:mill or function:mill-any)",
  },
  {
    name: "replaces kw:mill with self-mill function tags when self-mill qualifier matches",
    naturalQuery: "self mill cards in blue black red",
    rawQuery: "prefer:best id:ubr kw:mill game:paper",
    expected:
      "prefer:best id:ubr game:paper (function:mill-self or function:self-mill or function:mill)",
  },
  {
    name: "adds blink tags for blink intent",
    naturalQuery: "azorius blink effects",
    rawQuery: "id:wu",
    expected:
      "id:wu (function:blink or function:flicker or function:flicker-creature or function:flicker-permanent)",
  },
  {
    name: "adds card draw tags for card draw intent",
    naturalQuery: "blue card draw engines",
    rawQuery: "c:u",
    expected:
      "c:u (function:draw-engine or function:repeatable-draw or function:pure-draw or function:impulse-draw or function:burst-draw or function:card-advantage)",
  },
  {
    name: "adds infect tags for infect intent",
    naturalQuery: "green infect creatures",
    rawQuery: "c:g t:creature",
    expected:
      "c:g t:creature (function:infect or function:poison or function:poison-opponents or function:gives-infect or function:synergy-infect or function:synergy-poison)",
  },
  {
    name: "adds extra combat tags for extra combat intent",
    naturalQuery: "red creatures with extra combat",
    rawQuery: "c:r t:creature",
    expected:
      "c:r t:creature (function:extra-combat or function:extra-combat-phase)",
  },
  {
    name: "adds stax tags for stax intent",
    naturalQuery: "white stax pieces for commander",
    rawQuery: "c:w f:commander",
    expected:
      "c:w f:commander (function:tax or function:tax-attack or function:tax-block or function:cast-tax or function:kismet-effect)",
  },
  {
    name: "adds landfall tags for landfall intent",
    naturalQuery: "green landfall creatures",
    rawQuery: "c:g t:creature",
    expected:
      "c:g t:creature (function:landfall or function:landfall-other)",
  },
  {
    name: "adds reanimator tags for reanimate intent",
    naturalQuery: "black reanimate spells",
    rawQuery: "c:b",
    expected:
      "c:b (function:reanimate or function:reanimate-creature or function:reanimate-permanent or function:reanimate-from-any)",
  },
  {
    name: "adds fog tags for fog intent",
    naturalQuery: "green fog effects",
    rawQuery: "c:g",
    expected:
      "c:g (function:fog or function:fog-limited or function:fog-selective or function:pseudo-fog)",
  },
  {
    name: "adds wheel tag for wheel intent",
    naturalQuery: "red wheel effects",
    rawQuery: "c:r",
    expected: "c:r function:wheel",
  },
  {
    name: "adds brainstorm tag for brainstorm intent",
    naturalQuery: "blue brainstorm effects",
    rawQuery: "c:u",
    expected: "c:u function:brainstorm",
  },
  {
    name: "adds curiosity tags for curiosity intent",
    naturalQuery: "curiosity effects on creatures",
    rawQuery: "t:creature",
    expected: "t:creature (function:curiosity or function:curiosity-like)",
  },
  {
    name: "adds impact-tremors tag for ETB damage intent",
    naturalQuery: "damage when a creature enters",
    rawQuery: "",
    expected: "function:impact-effect",
  },
  {
    name: "truncates overly long query",
    naturalQuery: "long query",
    rawQuery: "a".repeat(30),
    expected: "a".repeat(10),
    maxLength: 10,
  },
];

type IsQueryCase = {
  name: string;
  query: string;
  expected: boolean;
};

const isQueryCases: IsQueryCase[] = [
  { name: "detects scryfall operator", query: "t:dragon", expected: true },
  {
    name: "rejects non-operator colon",
    query: "function tag: removal",
    expected: false,
  },
  {
    name: "accepts function tag operator",
    query: "function:removal",
    expected: true,
  },
  {
    name: "accepts id operator",
    query: "id=ub",
    expected: true,
  },
  {
    name: "rejects label with colon",
    query: "type tag: is my favorite",
    expected: false,
  },
];

function runFinalizeTests() {
  let passed = 0;
  for (const testCase of finalizeCases) {
    try {
      const result = finalizeScryfallQuery({
        naturalQuery: testCase.naturalQuery,
        rawQuery: testCase.rawQuery,
        tagContext: testCase.tagContext,
        maxLength: testCase.maxLength,
      });
      assert.equal(result, testCase.expected);
      console.log(`[PASS] finalize: ${testCase.name}`);
      passed += 1;
    } catch (error) {
      console.error(`[FAIL] finalize: ${testCase.name}`);
      console.error(error);
      throw error;
    }
  }
  return passed;
}

function runIsQueryTests() {
  let passed = 0;
  for (const testCase of isQueryCases) {
    try {
      const result = isScryfallQuery(testCase.query);
      assert.equal(result, testCase.expected);
      console.log(`[PASS] isScryfallQuery: ${testCase.name}`);
      passed += 1;
    } catch (error) {
      console.error(`[FAIL] isScryfallQuery: ${testCase.name}`);
      console.error(error);
      throw error;
    }
  }
  return passed;
}

function runHateMagnetTagHelperTests() {
  let passed = 0;
  try {
    const full = hateMagnetFunctionTagsExcluding();
    assert.deepEqual(full, [...HATE_MAGNET_FUNCTION_TAGS]);
    const withoutExtraTurn = hateMagnetFunctionTagsExcluding("extra-turn");
    assert.ok(!withoutExtraTurn.includes("extra-turn"));
    assert.equal(
      withoutExtraTurn.length,
      HATE_MAGNET_FUNCTION_TAGS.length - 1,
      "excluding one tag should shorten list by 1"
    );
    const withoutTwo = hateMagnetFunctionTagsExcluding(["extra-turn", "storm"]);
    assert.ok(!withoutTwo.includes("extra-turn") && !withoutTwo.includes("storm"));
    assert.equal(withoutTwo.length, HATE_MAGNET_FUNCTION_TAGS.length - 2);
    console.log("[PASS] hateMagnetFunctionTagsExcluding: full set, single omit, multi omit");
    passed += 1;
  } catch (error) {
    console.error("[FAIL] hateMagnetFunctionTagsExcluding tests");
    console.error(error);
    throw error;
  }
  return passed;
}

function runTruncateTests() {
  let passed = 0;
  try {
    const result = truncateScryfallQuery("abcdefg", 5);
    assert.equal(result, "abcde");
    console.log("[PASS] truncate: trims length");
    passed += 1;

    const noChange = truncateScryfallQuery("short", 10);
    assert.equal(noChange, "short");
    console.log("[PASS] truncate: no-op");
    passed += 1;
  } catch (error) {
    console.error("[FAIL] truncate tests");
    console.error(error);
    throw error;
  }
  return passed;
}

function run() {
  const passed =
    runFinalizeTests() +
    runIsQueryTests() +
    runHateMagnetTagHelperTests() +
    runTruncateTests();
  console.log(`query-converter tests passed (${passed} total)`);
}

run();
