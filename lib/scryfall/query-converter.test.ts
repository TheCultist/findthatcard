import assert from "node:assert/strict";
import type { TaggerTagContext } from "@/lib/tagger/context";
import {
  finalizeScryfallQuery,
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
    name: "appends and expands strategy tags",
    naturalQuery: "Orzhov aristocrats",
    rawQuery: "id=wb",
    expected:
      "id=wb (oracletag:sacrifice-outlet or oracletag:death-trigger or oracletag:death-trigger-self or oracletag:sacrifice-self or oracletag:alternate-cost-sacrifice)",
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
    expected: "function:land-tutor",
    tagContext: {
      art: [],
      function: ["land-tutor", "tutor-to-hand"],
    },
  },
  {
    name: "adds tutor-to-hand tag when requested",
    naturalQuery: "tutor a land to hand",
    rawQuery: "function:tutor",
    expected: "function:land-tutor function:tutor-to-hand",
    tagContext: {
      art: [],
      function: ["land-tutor", "tutor-to-hand"],
    },
  },
  {
    name: "adds tutor-to-battlefield tag when requested",
    naturalQuery: "tutor a land onto the battlefield",
    rawQuery: "function:tutor",
    expected: "function:land-tutor function:tutor-to-battlefield",
    tagContext: {
      art: [],
      function: ["land-tutor", "tutor-to-battlefield"],
    },
  },
  {
    name: "fixes missing closing paren",
    naturalQuery: "flying creatures",
    rawQuery: "t:creature (kw:flying",
    expected: "t:creature (kw:flying)",
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
    runFinalizeTests() + runIsQueryTests() + runTruncateTests();
  console.log(`query-converter tests passed (${passed} total)`);
}

run();
