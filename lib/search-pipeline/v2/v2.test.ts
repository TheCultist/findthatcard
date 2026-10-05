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
import { finalizeQuery } from "@/lib/search-pipeline/phase3/finalizeQuery";
import { buildIRFromExtraction } from "@/lib/search-pipeline/v2/buildIR";
import { recognizeCardNames, runPrePass } from "@/lib/search-pipeline/v2/prePass";
import { buildDirectIR } from "@/lib/search-pipeline/v2/runV2";
import type { V2Extraction } from "@/lib/search-pipeline/v2/schema";
import { extractTaggerTags, validateTaggerTags } from "@/lib/tagger/validation";

function baseExtraction(overrides: Partial<V2Extraction>): V2Extraction {
  return {
    intent: "search",
    cardName: null,
    colors: null,
    negatedColors: null,
    typesAll: [],
    typesAny: [],
    negatedTypes: [],
    subtypes: [],
    supertypes: [],
    stats: [],
    rarity: null,
    year: null,
    keywords: [],
    negatedKeywords: [],
    format: null,
    commanderEligible: false,
    sets: [],
    negatedSets: [],
    artist: null,
    artSubjects: [],
    functionTags: [],
    archetypes: [],
    oraclePhrases: [],
    negatedOraclePhrases: [],
    triggeredEffects: [],
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

    // Identity alternatives must survive finalize: the id-hoisting normalizer used to
    // strip every id: token when more than one was present, leaving "( or or )".
    const orIdentity = await buildIRFromExtraction(
      baseExtraction({ colors: { mode: "identity", op: ":", letters: "wub", combine: "or" }, functionTags: ["draw"] }),
      "white, blue, or black cards that draw cards"
    );
    const orIdQ = (await finalizeQuery(orIdentity)).queryForLogs;
    check("identity alternatives kept through finalize", orIdQ.includes("(id:w or id:u or id:b)"), orIdQ);
    check("no empty OR group left behind", !/\(\s*or/.test(orIdQ), orIdQ);

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

    const numeric = await buildIRFromExtraction(
      baseExtraction({ oraclePhrases: ["tap", "two", "3"] }),
      "mana rocks that tap for two"
    );
    const numQ = assembleQueryFromIR(numeric);
    check("bare number oracle tokens dropped", numQ.includes('o:"tap"') && !numQ.includes('o:"two"') && !numQ.includes('o:"3"'), numQ);

    const negated = await buildIRFromExtraction(
      baseExtraction({ negatedOraclePhrases: ["gains life"] }),
      "cards that don't gain life"
    );
    const nq = assembleQueryFromIR(negated);
    check("negated verb phrase split", nq.includes('-o:"gain"') && nq.includes('-o:"life"'), nq);

    // Linked trigger→effect stays one ordered same-sentence regex, not two
    // independent o: tokens (o:"dies" o:"draw" matched Aclazotz).
    const open = assembleQueryFromIR(
      await buildIRFromExtraction(
        baseExtraction({ triggeredEffects: [{ subject: null, trigger: "dies", effect: "draws 2 cards" }] }),
        "death triggers that draw"
      )
    );
    check("triggered effect → ordered regex", open.includes("o:/die[^.]*draw[^.]*cards/") && !open.includes('o:"draw'), open);

    // Subject "~" (or a pronoun) = the card itself; a noun = another object, so
    // "this creature enters" (self-ETB) must not satisfy "a creature enters".
    const self = assembleQueryFromIR(
      await buildIRFromExtraction(
        baseExtraction({ triggeredEffects: [{ subject: "it", trigger: "dies", effect: "draw" }] }),
        "draw when it dies"
      )
    );
    check("self subject → ~", self.includes("o:/~[^.]*die[^.]*draw/"), self);
    const otherIR = await buildIRFromExtraction(
      // Claude sometimes returns nested values as JSON text.
      baseExtraction({
        triggeredEffects: '[{"subject":"creature","trigger":"enters","effect":"draw"}]' as unknown as V2Extraction["triggeredEffects"],
      }),
      "draw when a creature enters"
    );
    const other = assembleQueryFromIR(otherIR);
    check("JSON-text triggers decoded; other subject excludes self", other.includes("o:/(?<!this )creature[^.]*enter[^.]*draw/"), other);
    const otherFinal = (await finalizeQuery(otherIR)).queryForScryfall;
    check("finalize leaves regex clause intact", otherFinal.includes("o:/(?<!this )creature[^.]*enter[^.]*draw/"), otherFinal);
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

  // 4b. Excluded keywords and colours come from the extraction, not a regex over the text.
  {
    const ir = await buildIRFromExtraction(
      baseExtraction({ keywords: ["flying"], negatedKeywords: ["trample", "notakeyword"], negatedColors: "u" }),
      "flying creatures that aren't blue without trample"
    );
    const q = assembleQueryFromIR(ir);
    check("negated keyword becomes -kw:", q.includes("-kw:trample"), q);
    check("unknown negated keyword dropped", !q.includes("notakeyword"), q);
    check("positive keyword unaffected by an exclusion", q.includes("kw:flying") && !q.includes("-kw:flying"), q);
    check("negated colour becomes -c:", q.includes("-c:u"), q);

    const identity = await buildIRFromExtraction(
      baseExtraction({ colors: { mode: "identity", op: ":", letters: "g", combine: "and" }, negatedColors: "r" }),
      "non-red green commander cards"
    );
    const iq = assembleQueryFromIR(identity);
    // -id:r would also drop colourless cards (id:r = "fits in mono-red").
    check("negated identity colour uses id>=", iq.includes("-id>=r"), iq);
  }

  // 4c. Sets resolve against the set index for every intent; exclusions are negated.
  {
    const byName = assembleQueryFromIR(await buildIRFromExtraction(baseExtraction({ sets: ["Bloomburrow"] }), "from bloomburrow"));
    check("set name → set:blb", byName.includes("set:blb"), byName);
    const byCode = assembleQueryFromIR(await buildIRFromExtraction(baseExtraction({ sets: ["BLB"] }), "from blb"));
    check("set code → set:blb", byCode.includes("set:blb"), byCode);
    // The schema's pre-array `set` key is still accepted.
    const legacy = assembleQueryFromIR(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await buildIRFromExtraction({ intent: "search", set: "Bloomburrow" } as any, "from bloomburrow")
    );
    check("legacy scalar set key accepted", legacy.includes("set:blb"), legacy);
    const excluded = assembleQueryFromIR(await buildIRFromExtraction(baseExtraction({ negatedSets: ["Kaladesh"] }), "not from kaladesh"));
    check("negated set → -set:", excluded.includes("-set:kld"), excluded);
    const franchise = assembleQueryFromIR(await buildIRFromExtraction(baseExtraction({ sets: ["final fantasy"] }), "final fantasy cards"));
    check("set name shared by several sets → OR group incl. main set", /\(set:\w+( or set:\w+)+\)/.test(franchise) && franchise.includes("set:fin"), franchise);
    const bogus = assembleQueryFromIR(await buildIRFromExtraction(baseExtraction({ sets: ["Zzqx Nonexistent"] }), "zzqx"));
    check("unknown set dropped", !bogus.includes("set:"), bogus);
    const generic = assembleQueryFromIR(await buildIRFromExtraction(baseExtraction({ sets: ["commander"] }), "commander cards"));
    check("generic word matching many sets dropped", !generic.includes("set:"), generic);

    const named = await buildIRFromExtraction(
      baseExtraction({ intent: "similar-cards", cardName: "Lightning Bolt", sets: ["Dominaria United"] }),
      "cards like lightning bolt from dominaria united"
    );
    check("named intent keeps its set", assembleQueryFromIR(named).includes("set:dmu"), assembleQueryFromIR(named));

    // Finalize no longer re-derives sets from the raw text: a card name containing a
    // set name ("…the Apocalypse") must not become set:apc.
    const card = await buildIRFromExtraction(baseExtraction({ cardName: "Sheoldred, the Apocalypse" }), "Sheoldred, the Apocalypse");
    const cq = (await finalizeQuery(card)).queryForLogs;
    check("card name is not turned into a set filter", !cq.includes("set:"), cq);
  }

  // 4d. Commander eligibility → the format's is: flag; deck context is just format + identity.
  {
    const plain = assembleQueryFromIR(await buildIRFromExtraction(baseExtraction({ commanderEligible: true, keywords: ["flying"] }), "commanders with flying"));
    check("commanderEligible → is:commander", plain.includes("is:commander"), plain);
    const pdh = assembleQueryFromIR(
      await buildIRFromExtraction(baseExtraction({ commanderEligible: true, format: "pauper edh" }), "pdh commanders")
    );
    check("PDH commanders → is:paupercommander", pdh.includes("is:paupercommander") && pdh.includes("f:paupercommander"), pdh);
    check("PDH commanders: no is:commander", !/\bis:commander\b/.test(pdh), pdh);
    const brawl = assembleQueryFromIR(await buildIRFromExtraction(baseExtraction({ commanderEligible: true, format: "brawl" }), "brawl commanders"));
    check("brawl commanders → is:brawler", brawl.includes("is:brawler"), brawl);
    const deck = assembleQueryFromIR(await buildIRFromExtraction(baseExtraction({ format: "commander" }), "removal for my commander deck"));
    check("deck context: no eligibility flag", !deck.includes("is:"), deck);

    const typed = await buildIRFromExtraction(
      baseExtraction({ commanderEligible: true, typesAll: ["creature"], supertypes: ["legendary"] }),
      "legendary creatures that can be commanders"
    );
    const tq = (await finalizeQuery(typed)).queryForLogs;
    check("eligibility flag drops redundant creature/legendary types", tq.includes("is:commander") && !/\bt:(creature|legendary)\b/.test(tq), tq);
  }

  // 4e. An archetype qualifier names the effect's target: a matching type/subtype is dropped
  // (removal/damage/reanimator), and for tokens only a matching subtype.
  {
    const removal = assembleQueryFromIR(
      await buildIRFromExtraction(
        baseExtraction({ typesAll: ["creature"], archetypes: [{ name: "removal", qualifier: "creature" }] }),
        "creature removal"
      )
    );
    check("removal target type not a card filter", !/\bt:creature\b/.test(removal), removal);
    const damage = assembleQueryFromIR(
      await buildIRFromExtraction(
        baseExtraction({ typesAny: ["instant", "planeswalker"], archetypes: [{ name: "damage", qualifier: "planeswalker" }] }),
        "instants that damage planeswalkers"
      )
    );
    check("damage target type dropped, other types kept", damage.includes("t:instant") && !damage.includes("t:planeswalker"), damage);
    const zombies = assembleQueryFromIR(
      await buildIRFromExtraction(
        baseExtraction({ subtypes: ["zombie"], archetypes: [{ name: "tokens", qualifier: "zombie" }] }),
        "cards that make zombie tokens"
      )
    );
    check("token kind not a subtype filter", !zombies.includes("t:zombie"), zombies);
    check("specific token kind required in rules text", zombies.includes('o:"zombie"'), zombies);
    const creatureTokens = assembleQueryFromIR(
      await buildIRFromExtraction(
        baseExtraction({ typesAll: ["creature"], archetypes: [{ name: "tokens", qualifier: "creature" }] }),
        "creatures that make creature tokens"
      )
    );
    check("tokens qualifier keeps the card's base type", creatureTokens.includes("t:creature"), creatureTokens);
    check("broad token class adds no oracle filter", !creatureTokens.includes("o:"), creatureTokens);
  }

  // 4f. A keyword that names a chosen archetype is the same concept: it joins the archetype's
  // OR family instead of AND-ing a second, narrower clause.
  {
    const infectIR = await buildIRFromExtraction(
      baseExtraction({ typesAll: ["creature"], keywords: ["infect"], archetypes: [{ name: "infect", qualifier: null }] }),
      "infect creatures"
    );
    const infect = (await finalizeQuery(infectIR)).queryForLogs;
    const orGroup = /\(([^()]*\bkw:infect\b[^()]*)\)/.exec(infect)?.[1] ?? "";
    check("archetype keyword OR-ed into the archetype family", orGroup.includes(" or "), infect);
    check("archetype keyword not AND-ed on its own", !/(^|\s)kw:infect\b/.test(infect.replace(/\([^()]*\)/g, "")), infect);
    const other = assembleQueryFromIR(
      await buildIRFromExtraction(
        baseExtraction({ keywords: ["flying"], archetypes: [{ name: "removal", qualifier: null }] }),
        "removal with flying"
      )
    );
    check("unrelated keyword kept beside an archetype", other.includes("kw:flying"), other);
  }

  // 4g. Strategy archetypes (former strategy: expansion) inject their family, full tokens included.
  {
    const ir = await buildIRFromExtraction(
      baseExtraction({ archetypes: [{ name: "spellslinger", qualifier: null }] }),
      "spellslinger cards"
    );
    const q = (await finalizeQuery(ir)).queryForLogs;
    check("strategy archetype injects function tags", q.includes("function:copy-spell"), q);
    check("strategy archetype keeps full oracle tokens", q.includes('o:"whenever you cast a spell"') && !q.includes('function:o:'), q);
    check("strategy archetype keeps kw tokens", q.includes("kw:prowess") && !q.includes("function:kw:"), q);
  }

  // 4h. No invalid Tagger tag survives finalize, even when the second finalize pass (run
  // after invalid-tag removal) re-injects tags of its own: with no art tags in the query's
  // tag context, the art normalizer injects art:<word> unchecked on both passes.
  {
    const ir = await buildIRFromExtraction(baseExtraction({ typesAll: ["creature"] }), "qqzzx art");
    const p3 = await finalizeQuery(ir);
    const removedArt = p3.removedInvalidTags.filter((t) => t === "art:qqzzx").length;
    check("fixture re-injects on the second pass", removedArt === 2, p3.removedInvalidTags.join(","));
    const leftover = (await validateTaggerTags(p3.queryForLogs)).map((t) => `${t.type}:${t.tag}`);
    check("no invalid tags after finalize", leftover.length === 0, `${leftover.join(",")} | ${p3.queryForLogs}`);
  }

  // 5. Named-card intent routes the card name for the intent resolver — and keeps
  // every other constraint the user appended (the resolver is not a bypass).
  {
    const ir = await buildIRFromExtraction(
      baseExtraction({ intent: "similar-cards", cardName: "Lightning Bolt", negatedTypes: ["instant"], format: "modern" }),
      "cards like lightning bolt that aren't instants in modern"
    );
    check("similar-cards intent set", ir.intent === "similar-cards");
    check("similar card name resolved", ir.similarToCardName === "Lightning Bolt", ir.similarToCardName);
    const q = assembleQueryFromIR(ir);
    check("named intent keeps negated type", q.includes("-t:instant"), q);
    check("named intent keeps format", q.includes("f:modern"), q);
    check("named intent emits no literal name clause", !q.includes("name:"), q);
  }

  // 5b. The schema only requires `intent`: a partial / malformed object must not crash the builder.
  {
    const ir = await buildIRFromExtraction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { intent: "search", typesAll: "creature", keywords: null, stats: { field: "mv", op: "<", value: 3 } } as any,
      "cheap creatures"
    );
    const q = assembleQueryFromIR(ir);
    check("partial extraction: scalar type coerced", q.includes("t:creature"), q);
    check("partial extraction: scalar stat coerced", q.includes("mv<3"), q);
  }

  // 5c. Function tags emitted alongside an archetype fold into the archetype's OR
  // family instead of AND-ing a second function clause (Haiku emits both routinely).
  {
    const ir = await buildIRFromExtraction(
      baseExtraction({ functionTags: ["removal"], archetypes: [{ name: "removal", qualifier: null }] }),
      "red removal"
    );
    check("fn tag folded into archetype fragment", ir.resolvedFragments[0]?.tags.includes("function:removal"));
    check("no standalone function must-clause", !ir.mustClauses.some((c) => c.value.startsWith("function:")));
    const p3 = await finalizeQuery(ir);
    const standalone = p3.queryForLogs.replace(/\([^)]*\)/g, "");
    check("finalized query has no AND-ed function tag", !/function:/.test(standalone), p3.queryForLogs);

    const noArch = await buildIRFromExtraction(baseExtraction({ functionTags: ["removal"] }), "removal");
    check("fn tag without archetype still a must-clause", assembleQueryFromIR(noArch).includes("function:removal"));
  }

  // 5d. Keywords and artists are validated against catalogs, not emitted verbatim.
  {
    const ir = await buildIRFromExtraction(
      baseExtraction({ keywords: ["flying", "notakeyword"], artist: "Guay" }),
      "flying cards by guay"
    );
    const q = assembleQueryFromIR(ir);
    check("known keyword kept", q.includes("kw:flying"), q);
    check("unknown keyword dropped", !q.includes("notakeyword"), q);
    check("partial artist name kept (Scryfall a: is substring)", q.includes('a:"Guay"'), q);
    const bogus = await buildIRFromExtraction(baseExtraction({ artist: "Zzqxnotanartist" }), "art by nobody");
    check("unknown artist dropped", !assembleQueryFromIR(bogus).includes("a:"), assembleQueryFromIR(bogus));
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

  // 7. Direct Scryfall syntax is detected by the pre-pass and passed through as typed:
  //    prefer:best is a default for generated queries only, never forced onto raw input.
  {
    const pp = runPrePass('name:"Lightning Bolt" game:paper');
    check("pre-pass flags direct scryfall", pp.direct === true);

    const bare = (await finalizeQuery(buildDirectIR("t:artifact cmc=1 game:paper"))).queryForScryfall;
    check("direct query: prefer:best not re-added", bare === "t:artifact cmc=1 game:paper", bare);

    const kept = (await finalizeQuery(buildDirectIR("prefer:best t:artifact game:paper"))).queryForScryfall;
    check("direct query: user's prefer:best kept", kept === "prefer:best t:artifact game:paper", kept);

    const swapped = (await finalizeQuery(buildDirectIR("prefer:usd-low t:artifact game:paper"))).queryForScryfall;
    check("direct query: other prefer: left alone", swapped === "prefer:usd-low t:artifact game:paper", swapped);

    const generated = await buildIRFromExtraction(baseExtraction({ typesAll: ["artifact"] }), "artifacts");
    const gen = (await finalizeQuery(generated)).queryForScryfall;
    check("generated query: prefer:best still added", /^prefer:best /.test(gen), gen);
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
