import assert from "node:assert/strict";
import type { TaggerTagContext } from "@/lib/tagger/context";
import {
  HATE_MAGNET_FUNCTION_TAGS,
  balanceScryfallQuery,
  finalizeScryfallQuery,
  quoteScryfallValue,
  hateMagnetFunctionTagsExcluding,
  isScryfallQuery,
  truncateScryfallQuery,
} from "@/lib/scryfall/query-converter";
import { normalizeWheneverCastTrigger } from "@/lib/search-pipeline/phase3/finalizeQuery";
import {
  COMMANDER_ELIGIBLE_IS_FLAGS,
  COMMANDER_FORMATS,
  COMMANDER_FORMAT_TO_ELIGIBLE_IS,
} from "@/lib/scryfall/formats";

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
    expected: "t:creature",
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
    naturalQuery: "zz",
    rawQuery: "t:zombie f:commander (function:zombie-lord)",
    expected: "t:zombie f:commander function:zombie-lord",
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
    expected: "function:tutor-land function:tutor-to-hand",
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
    name: "normalizes function:paupercommander to f:paupercommander",
    naturalQuery: "zz",
    rawQuery: "function:paupercommander kw:flying",
    expected: "f:paupercommander kw:flying",
  },
  {
    name: "strips redundant t:creature t:legendary when is:commander present",
    naturalQuery: "commanders with flying",
    rawQuery: "t:creature t:legendary kw:flying is:commander",
    expected: "kw:flying is:commander",
  },
  {
    name: "strips redundant types for is:paupercommander",
    naturalQuery: "pauper edh legal commanders with double strike",
    rawQuery: "t:creature t:legendary kw:double-strike f:paupercommander is:paupercommander",
    expected: "kw:double-strike f:paupercommander is:paupercommander",
  },
  {
    name: "strips redundant types for is:oathbreaker",
    naturalQuery: "zz",
    rawQuery: "t:creature t:legendary is:oathbreaker",
    expected: "is:oathbreaker",
  },
  {
    name: "strips redundant types for is:brawler",
    naturalQuery: "zz",
    rawQuery: "t:creature t:legendary is:brawler",
    expected: "is:brawler",
  },
  {
    name: "strips redundant types for is:duelcommander",
    naturalQuery: "zz",
    rawQuery: "t:creature t:legendary is:duelcommander",
    expected: "is:duelcommander",
  },
  {
    name: "keeps t:creature when no commander-eligible is: flag",
    naturalQuery: "flying creatures",
    rawQuery: "t:creature kw:flying",
    expected: "t:creature kw:flying",
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

    // Cutting inside a group drops the dangling "or" and closes the group within the limit.
    const grouped = truncateScryfallQuery("t:creature (c:r or c:g or c:b)", 23);
    assert.equal(grouped, "t:creature (c:r or c:g)");
    console.log("[PASS] truncate: closes the open group at a clause boundary");
    passed += 1;

    // A cut inside a quoted phrase or regex drops that whole clause rather than closing it early.
    const regexQuery = "t:creature (c:g or o:/(?<!this )creature[^.]*enters/)";
    assert.equal(truncateScryfallQuery(regexQuery, 40), "t:creature (c:g)");
    assert.equal(truncateScryfallQuery('t:creature o:"draw a card" c:u', 25), "t:creature");
    console.log("[PASS] truncate: never splits a quoted or regex value");
    passed += 1;

    const repaired = [
      ["(c:r) c:g)", "(c:r) c:g"], // stray ")" used to crash: ")".repeat(-1)
      ["(t:creature o:draw", "(t:creature o:draw)"],
      ['name:"B.F.M. (Big Furry Monster" t:creature', 'name:"B.F.M. (Big Furry Monster" t:creature'],
      ["o:/\\(.*\\)/ (c:r", "o:/\\(.*\\)/ (c:r)"],
      ["o:urza's (c:r", "o:urza's (c:r)"], // apostrophe outside a value is not a quote
      ['(o:"draw a', '(o:"draw a")'],
    ];
    for (const [input, expected] of repaired) assert.equal(balanceScryfallQuery(input), expected, input);
    console.log("[PASS] balance: parens inside values ignored, strays dropped, open groups closed");
    passed += 1;

    // Scryfall has no escape inside "…"; values holding a double quote switch to '…' (verified live).
    assert.equal(quoteScryfallValue("Urza's Saga"), `"Urza's Saga"`);
    assert.equal(quoteScryfallValue('Henzie "Toolbox" Torre'), `'Henzie "Toolbox" Torre'`);
    assert.equal(quoteScryfallValue(`it's "x"`), `"it's x"`);
    const quotedName = finalizeScryfallQuery({
      naturalQuery: "henzie",
      rawQuery: `name:${quoteScryfallValue('Henzie "Toolbox" Torre')} (t:creature`,
    });
    assert.equal(quotedName, `name:'Henzie "Toolbox" Torre' (t:creature)`);
    console.log("[PASS] quote: single-quote delimiter survives finalize");
    passed += 1;

    // The trigger's spell type is removed — and nothing after it (it used to eat the rest of the query).
    assert.equal(
      normalizeWheneverCastTrigger(
        "green cards that draw whenever you cast a creature spell in modern",
        "t:creature mv<=3 f:modern o:draw"
      ),
      'mv<=3 f:modern o:draw o:"whenever you cast a creature spell"'
    );
    assert.equal(
      normalizeWheneverCastTrigger(
        "whenever you cast an instant or sorcery spell, deal damage",
        "(t:instant or t:sorcery) c:r o:damage"
      ),
      'c:r o:damage o:"whenever you cast an instant or sorcery spell"'
    );
    console.log("[PASS] whenever-cast: removes only the trigger's type filter");
    passed += 1;
  } catch (error) {
    console.error("[FAIL] truncate tests");
    console.error(error);
    throw error;
  }
  return passed;
}

function runCommanderFormatCoverageTests() {
  let passed = 0;
  try {
    const expectedFormats = [
      "commander",
      "oathbreaker",
      "standardbrawl",
      "brawl",
      "competitivebrawl",
      "paupercommander",
      "duel",
      "predh",
      "tlr",
    ];
    assert.deepEqual([...COMMANDER_FORMATS].sort(), [...expectedFormats].sort());
    assert.deepEqual(
      [...COMMANDER_ELIGIBLE_IS_FLAGS].sort(),
      ["brawler", "commander", "duelcommander", "oathbreaker", "paupercommander"].sort()
    );
    for (const fmt of COMMANDER_FORMATS) {
      assert.ok(
        COMMANDER_ELIGIBLE_IS_FLAGS.includes(COMMANDER_FORMAT_TO_ELIGIBLE_IS[fmt]),
        `${fmt} maps to an is: flag in COMMANDER_ELIGIBLE_IS_FLAGS`
      );
    }
    console.log("[PASS] commander formats cover all command-zone formats + is: flags");
    passed += 1;
  } catch (error) {
    console.error("[FAIL] commander format coverage");
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
    runTruncateTests() +
    runCommanderFormatCoverageTests();
  console.log(`query-converter tests passed (${passed} total)`);
}

run();
