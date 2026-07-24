/**
 * V2 pipeline self-check (no AI, no network).
 *
 * Validates the deterministic guardrails: catalog-backed IR construction from a
 * fixed extraction fixture, assembly output, card-name recognition, and that
 * bogus function/art tags are dropped by vocabulary validation.
 *
 * Run: tsx lib/search-pipeline/v2/v2.test.ts
 */

import assert from "node:assert/strict";
import { ensureCatalogIndex } from "@/lib/scryfall/catalog-index";
import { assembleQueryFromIR } from "@/lib/search-pipeline/assembleQuery";
import { splitCompoundQuery } from "@/lib/search-pipeline/compound";
import { buildIRFromExtraction } from "@/lib/search-pipeline/v2/buildIR";
import { recognizeCardNames, runPrePass } from "@/lib/search-pipeline/v2/prePass";
import type { V2Extraction } from "@/lib/search-pipeline/v2/schema";
import { extractTaggerTags } from "@/lib/tagger/validation";

function baseExtraction(overrides: Partial<V2Extraction>): V2Extraction {
  return {
    intent: "search",
    cardName: null,
    colors: null,
    typesAll: [],
    typesAny: [],
    negatedTypes: [],
    subtypes: [],
    supertypes: [],
    stats: [],
    rarity: null,
    year: null,
    keywords: [],
    format: null,
    set: null,
    artist: null,
    artSubjects: [],
    functionTags: [],
    archetypes: [],
    oraclePhrases: [],
    negatedOraclePhrases: [],
    ...overrides,
  };
}

let passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed += 1;
  console.log(`[PASS] ${name}`);
}

async function main(): Promise<void> {
  await ensureCatalogIndex();

  // 1. Structural attributes map to validated clauses.
  {
    const ir = await buildIRFromExtraction(
      baseExtraction({
        colors: { mode: "color", op: ":", letters: "r", combine: "and" },
        typesAll: ["creatures"],
        subtypes: ["dragons"],
        supertypes: ["legendary"],
        stats: [{ field: "mv", op: "<", value: 5 }],
        keywords: ["flying"],
      }),
      "legendary red dragons with flying under 5 mana"
    );
    const q = assembleQueryFromIR(ir);
    check("emits color", q.includes("c:r"), q);
    check("emits base type", q.includes("t:creature"), q);
    check("emits subtype (singularized)", q.includes("t:dragon"), q);
    check("emits supertype", q.includes("t:legendary"), q);
    check("emits stat", q.includes("mv<5"), q);
    check("emits keyword", q.includes("kw:flying"), q);
  }

  // 1b. Compound types AND; enumerated types OR (the "artifact creatures" vs "instants or sorceries" distinction).
  {
    const compound = await buildIRFromExtraction(
      baseExtraction({ typesAll: ["artifact", "creature"] }),
      "artifact creatures"
    );
    const cq = assembleQueryFromIR(compound);
    check("compound types AND-ed", cq.includes("t:artifact") && cq.includes("t:creature") && !cq.includes(" or "), cq);

    const enumerated = await buildIRFromExtraction(
      baseExtraction({ typesAny: ["instant", "sorcery"] }),
      "instants or sorceries"
    );
    const eq = assembleQueryFromIR(enumerated);
    check("enumerated types OR-grouped", eq.includes("(t:instant or t:sorcery)"), eq);
  }

  // 1a2. Compound split leaves numeric ranges intact — "turn two or three" / "2 or 3"
  // is one range, not two branches. A real top-level "or" still splits.
  {
    check(
      "number-word range not split",
      splitCompoundQuery("gruul creatures I can play on turn two or three in commander").length === 1
    );
    check(
      "digit range not split",
      splitCompoundQuery("creatures I can play on turn 2 or 3 in commander").length === 1
    );
    check(
      "genuine compound still splits",
      splitCompoundQuery("cheap red removal or blue counterspells for modern").length === 2
    );
  }

  // 1b2. Color combine: "or" letters are alternatives; "and" stays one token; a
  // missing/garbage combine (Claude ignores enums) defaults to the AND token.
  {
    const orColors = await buildIRFromExtraction(
      baseExtraction({ colors: { mode: "color", op: ":", letters: "rg", combine: "or" } }),
      "red or green sacrifice ability"
    );
    check("color alternatives OR-grouped", assembleQueryFromIR(orColors).includes("(c:r or c:g)"), assembleQueryFromIR(orColors));

    const andColors = await buildIRFromExtraction(
      baseExtraction({ colors: { mode: "identity", op: ":", letters: "rg", combine: "and" } }),
      "gruul cards"
    );
    check("color AND stays combined", assembleQueryFromIR(andColors).includes("id:rg"), assembleQueryFromIR(andColors));

    const badCombine = await buildIRFromExtraction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseExtraction({ colors: { mode: "color", op: ":", letters: "wu", combine: "maybe" as any } }),
      "white blue cards"
    );
    check("garbage combine defaults to AND", assembleQueryFromIR(badCombine).includes("c:wu"), assembleQueryFromIR(badCombine));
  }

  // 1c. Rarity sets and malformed AI shapes (Claude ignores the schema) are handled defensively.
  {
    const multi = await buildIRFromExtraction(
      baseExtraction({ rarity: { op: ":", codes: ["c", "u"] } }),
      "common and uncommon cards"
    );
    check("multi-rarity OR-grouped", assembleQueryFromIR(multi).includes("(r:c or r:u)"), assembleQueryFromIR(multi));

    // Legacy/malformed: scalar `code` instead of `codes` array must still coerce.
    const legacy = await buildIRFromExtraction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseExtraction({ rarity: { op: ":", code: "m" } as any }),
      "mythics"
    );
    check("scalar rarity code coerced", assembleQueryFromIR(legacy).includes("r:m"), assembleQueryFromIR(legacy));

    // Out-of-enum / non-finite values are dropped, not emitted as garbage.
    const bad = await buildIRFromExtraction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseExtraction({ stats: [{ field: "mv", op: "~" as any, value: "x" as any }], rarity: { op: ":", codes: ["z" as any] } }),
      "garbage"
    );
    const bq = assembleQueryFromIR(bad);
    check("malformed stat/rarity dropped", !bq.includes("mv") && !/r[:<>]/.test(bq), bq);
  }

  // 1d. Verb-initial oracle phrases are split into stem + rest so quoted
  // substrings don't miss inflections ("lose all abilities" vs "loses…").
  {
    const ir = await buildIRFromExtraction(
      baseExtraction({ oraclePhrases: ["loses all abilities"] }),
      "strip creature of abilities"
    );
    const q = assembleQueryFromIR(ir);
    check("verb phrase split to stem", q.includes('o:"lose"') && q.includes('o:"all abilities"'), q);
    check("inflected quoted phrase gone", !q.includes('o:"loses all abilities"'), q);

    const trigger = await buildIRFromExtraction(
      baseExtraction({ oraclePhrases: ["whenever you cast"] }),
      "whenever you cast a spell"
    );
    const tq = assembleQueryFromIR(trigger);
    check("non-verb-initial phrase kept whole", tq.includes('o:"whenever you cast"'), tq);

    const negated = await buildIRFromExtraction(
      baseExtraction({ negatedOraclePhrases: ["gains life"] }),
      "cards that don't gain life"
    );
    const nq = assembleQueryFromIR(negated);
    check("negated verb phrase split", nq.includes('-o:"gain"') && nq.includes('-o:"life"'), nq);
  }

  // 1e. Format allowlist + aliases (pauper edh → paupercommander; unknown dropped).
  {
    const pdh = await buildIRFromExtraction(
      baseExtraction({ format: "pauper edh", keywords: ["double strike"] }),
      "pauper edh legal commanders with double strike"
    );
    const pq = assembleQueryFromIR(pdh);
    check("pauper edh → f:paupercommander", pq.includes("f:paupercommander"), pq);
    check("pauper edh does not emit f:pauper", !/\bf:pauper\b/.test(pq), pq);
    check("pauper edh does not emit f:commander", !/\bf:commander\b/.test(pq), pq);

    const alias = await buildIRFromExtraction(
      baseExtraction({ format: "pdh" }),
      "pdh legal cards"
    );
    check("pdh alias → f:paupercommander", assembleQueryFromIR(alias).includes("f:paupercommander"));

    const pedh = await buildIRFromExtraction(
      baseExtraction({ format: "pedh" }),
      "pedh legal cards"
    );
    check("pedh alias → f:paupercommander", assembleQueryFromIR(pedh).includes("f:paupercommander"));

    const typo = await buildIRFromExtraction(
      baseExtraction({ format: "paupermmander" }),
      "paupermmander cards"
    );
    check("paupermmander typo → f:paupercommander", assembleQueryFromIR(typo).includes("f:paupercommander"));

    const unknown = await buildIRFromExtraction(
      baseExtraction({ format: "notarealformat" }),
      "notarealformat cards"
    );
    check("unknown format dropped", !/\bf:/.test(assembleQueryFromIR(unknown)), assembleQueryFromIR(unknown));
  }

  // 2. Invalid types / subtypes are dropped, not fuzzy-corrected.
  {
    const ir = await buildIRFromExtraction(
      baseExtraction({ typesAll: ["notatype"], subtypes: ["zzznope"] }),
      "notatype zzznope"
    );
    const q = assembleQueryFromIR(ir);
    check("drops invalid type", !q.includes("notatype"), q);
    check("drops invalid subtype", !q.includes("zzznope"), q);
  }

  // 3. Bogus function/art tags fail vocabulary validation and are dropped.
  {
    const ir = await buildIRFromExtraction(
      baseExtraction({
        functionTags: ["totally-not-a-real-function-tag-xyz"],
        artSubjects: ["totally-not-a-real-art-tag-xyz"],
      }),
      "nonsense tags"
    );
    const q = assembleQueryFromIR(ir);
    check("drops bogus function tag", !q.includes("xyz"), q);
  }

  // 3b. Tag extraction sees tags behind an open paren — assembled queries emit
  // "((function:tag …", and validation used to require whitespace before the
  // operator, making every parenthesized (in particular every OR-grouped) tag
  // invisible to the invalid-tag backstop.
  {
    const tags = extractTaggerTags(
      '(((function:heroic-payoff t:creature) OR (function:card-draw-payoff o:"cast")) -name:"X") id:u'
    );
    const found = tags.map((t) => t.tag);
    check(
      "extracts parenthesized function tags",
      found.includes("heroic-payoff") && found.includes("card-draw-payoff"),
      found.join("|")
    );
  }

  // 4. Negations become mustNot clauses.
  {
    const ir = await buildIRFromExtraction(
      baseExtraction({
        typesAll: ["creature"],
        negatedTypes: ["artifact"],
        negatedOraclePhrases: ["can't block"],
      }),
      "creatures that are not artifacts and can't block"
    );
    const q = assembleQueryFromIR(ir);
    check("negated type becomes -t:", q.includes("-t:artifact"), q);
    check("negated oracle becomes -o:", q.includes('-o:"can\'t block"'), q);
  }

  // 5. Named-card intent routes the card name for the intent resolver.
  {
    const ir = await buildIRFromExtraction(
      baseExtraction({ intent: "similar-cards", cardName: "Lightning Bolt" }),
      "cards like lightning bolt"
    );
    check("similar-cards intent set", ir.intent === "similar-cards");
    check("similar card name resolved", ir.similarToCardName === "Lightning Bolt", ir.similarToCardName);
  }

  // 6. Card-name recognition finds multi-word catalog names (protecting them from filters).
  {
    const names = recognizeCardNames("cards similar to Sheoldred, the Apocalypse in modern");
    check(
      "recognizes multi-word card name",
      names.some((n) => n.toLowerCase().startsWith("sheoldred")),
      names.join("|")
    );
  }

  // 7. Direct Scryfall syntax is detected by the pre-pass.
  {
    const pp = runPrePass('name:"Lightning Bolt" game:paper');
    check("pre-pass flags direct scryfall", pp.direct === true);
  }

  // 8. Empty extraction still yields a non-empty IR (safety net) so Phase 3 never gets nothing.
  {
    const ir = await buildIRFromExtraction(baseExtraction({}), "asdfghjkl vague");
    check(
      "empty extraction yields safety-net fragment",
      ir.unresolvedFragments.length > 0 || ir.mustClauses.length > 0
    );
  }

  console.log(`\nAll ${passed} V2 self-checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
