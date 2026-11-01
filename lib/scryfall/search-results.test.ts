/**
 * Search-results path self-check (no network): `searchResultsPage`, driven through the real
 * `scryfallFetch` against the fake Scryfall in test/fake-scryfall.
 * This is the same call that /api/search and the pre-built SEO pages run.
 *
 * Run: tsx lib/scryfall/search-results.test.ts
 *
 * Several checks pin down CURRENT behaviour that looks wrong (marked "pinned:" below) so that
 * fixing it later is a deliberate, visible change rather than an accident.
 */

import assert from "node:assert/strict";
import { SCRYFALL_MAX_QUERY_CHARS, startFakeScryfall, type FakeScryfall } from "@/test/fake-scryfall/server";
import { fixtures } from "@/test/fake-scryfall/fixtures";

async function run() {
  // A burst of 3 on the search-class bucket: a page needing lookups (5 search requests) only gets
  // through if the app really paces them at 2/s. The default burst of 15 would hide a regression.
  const fake = await startFakeScryfall({ rateLimit: { searchBurst: 3 } });
  // SCRYFALL_BASE_URL is read when lib/scryfall/http loads, so set it before importing the code under test.
  process.env.SCRYFALL_BASE_URL = fake.baseUrl;
  process.env.TCG_PLAYER_PARTNER_LINK = "https://partner.example/fixture";
  const { ScryfallResponseError, CARDS_PER_PAGE } = await import("@/lib/scryfall/client");
  const { scryfallFetch } = await import("@/lib/scryfall/http");
  const { searchResultsPage } = await import("@/lib/scryfall/response-transformer");

  /** One page of results, exactly as the API route and SEO pages produce it. */
  const search = async (query: string, page = 1) => {
    fake.reset();
    return searchResultsPage(query, page);
  };
  /** An Alchemy card with no paper printing, which the app hides. */
  const hiddenCard = (name: string, i: number) =>
    fixtures.card({
      id: `cc000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      oracle_id: `dd000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name,
      type_line: "Creature — Fixture",
      set: "ymid",
      set_name: "Alchemy: Innistrad",
      set_type: "alchemy",
      digital: true,
    });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const searchRequests = (f: FakeScryfall) =>
    f.requests.filter((r) => r.path === "/cards/search").map((r) => r.params);
  const names = (r: { cards: Array<{ name: string }> }) => r.cards.map((c) => c.name);

  let checks = 0;
  const pass = (label: string) => {
    checks++;
    console.log(`[PASS] ${label}`);
  };

  // ---- Request shape -------------------------------------------------------------------------

  {
    const result = await search("t:fixture");
    assert.deepEqual(searchRequests(fake), [{ q: "t:fixture", unique: "cards", page: "1" }]);
    for (const r of fake.requests) {
      assert.equal(r.headers["user-agent"], "find-that-card/1.0 (+https://findthatcard.net)");
      assert.equal(r.headers["accept"], "application/json");
    }
    assert.equal(result.scryfallQuery, "t:fixture");
    assert.equal(result.per_page, CARDS_PER_PAGE);
    pass("one request per page: q + unique=cards + page, Scryfall's required headers");
  }

  {
    await search("is:dfc t:creature");
    assert.equal(searchRequests(fake)[0].q, "is:dfc t:creature -is:art", "art-series excluded for DFC searches");
    await search("is:dfc t:artifact");
    assert.equal(searchRequests(fake)[0].q, "is:dfc t:artifact -is:art", "'t:artifact' is not 't:art'");
    await search("is:dfc t:art");
    assert.equal(searchRequests(fake)[0].q, "is:dfc t:art", "a query that addresses art keeps it");
    pass("is:dfc appends -is:art unless the query addresses art");
  }

  // ---- Pagination across Scryfall's 175-card pages -----------------------------------------

  {
    const page1 = await search("t:fixture", 1);
    assert.equal(page1.total, fixtures.BULK_COUNT);
    assert.equal(page1.cards.length, 60);
    assert.deepEqual([names(page1)[0], names(page1)[59]], ["Fixture Creature 001", "Fixture Creature 060"]);
    assert.deepEqual([page1.page, page1.has_more], [1, true]);

    const page3 = await search("t:fixture", 3);
    assert.deepEqual(
      searchRequests(fake).map((p) => p.page),
      ["1", "2"],
      "page 3 straddles the Scryfall page boundary, so both upstream pages are fetched"
    );
    assert.deepEqual([names(page3)[0], names(page3)[59]], ["Fixture Creature 121", "Fixture Creature 180"]);
    assert.equal(page3.has_more, true);

    const page4 = await search("t:fixture", 4);
    assert.deepEqual(searchRequests(fake).map((p) => p.page), ["2"]);
    assert.deepEqual([names(page4)[0], names(page4).at(-1), page4.cards.length], ["Fixture Creature 181", "Fixture Creature 200", 20]);
    assert.equal(page4.has_more, false, "last page");

    const page5 = await search("t:fixture", 5);
    assert.deepEqual([page5.cards.length, page5.has_more], [0, false], "past the end but still on Scryfall page 2: empty");
    pass("60-card pages are cut from 175-card Scryfall pages, fetching a second page when needed");
  }

  {
    // Our page 7 maps to Scryfall page 3, which does not exist for 200 cards. Scryfall answers
    // 422, which is not the query's fault (a stale link or an edited URL gets here).
    const page7 = await search("t:fixture", 7);
    assert.deepEqual([page7.cards.length, page7.has_more], [0, false]);
    assert.deepEqual(searchRequests(fake).map((p) => p.page), ["3"]);
    pass("a page beyond Scryfall's last page is an empty page, not a query error");
  }

  {
    // 175 cards: page 3 is Scryfall page 1 offset 120 → 55 cards, one of which is hidden. Page 4
    // would be Scryfall page 2, which does not exist.
    fake.setCards([...fixtures.bulk.slice(0, 174), hiddenCard("Hidden Fixture", 1)]);
    try {
      const page3 = await search("t:creature", 3);
      assert.deepEqual([page3.total, page3.cards.length, page3.excluded], [175, 54, 1]);
      assert.equal(page3.has_more, false, "nothing left, so no Next");
    } finally {
      fake.setCards();
    }
    pass("a hidden card on the last page does not leave a Next that leads nowhere");
  }

  {
    // 60 shown cards then one hidden one: only a lookup can tell page 2 would be empty.
    fake.setCards([...fixtures.bulk.slice(0, 60), hiddenCard("Hidden Fixture", 1)]);
    try {
      const page1 = await search("t:creature", 1);
      assert.deepEqual([page1.cards.length, page1.has_more], [60, false]);
      assert.equal(fake.requests.length, 2, "one lookup for the card past the end of the page");
    } finally {
      fake.setCards();
    }
    pass("hidden cards past the end of a page are checked before offering Next");
  }

  {
    // Walking every page with Next, with hidden cards scattered through a list that crosses
    // Scryfall's page boundary, shows each card exactly once and never an empty page.
    const shown = fixtures.bulk.slice(0, 170);
    const hidden = [10, 70, 130, 169, 169.5].map((n, i) => hiddenCard(`${shown[Math.floor(n)].name} hidden`, i));
    fake.setCards([...shown, ...hidden]);
    try {
      const seen: string[] = [];
      let page = 1;
      for (;;) {
        const result = await search("t:creature", page);
        assert.ok(result.cards.length > 0, `page ${page} is not empty`);
        seen.push(...result.cards.map((c) => c.id));
        if (!result.has_more) break;
        page = result.page + 1;
      }
      assert.deepEqual(seen, shown.map((c) => c.id), "every card once, in order");
      assert.equal(page, 3);
    } finally {
      fake.setCards();
    }
    pass("Next walks the whole list: no card skipped or repeated, no empty page");
  }

  {
    // A full page of hidden cards before the shown ones: page 1 has nothing to show.
    const hidden = Array.from({ length: 60 }, (_, i) => hiddenCard(`Aardvark Fixture ${String(i).padStart(2, "0")}`, i));
    fake.setCards([...hidden, ...fixtures.bulk.slice(0, 60)]);
    try {
      const result = await search("t:creature", 1);
      assert.deepEqual([result.page, result.from_page, result.excluded], [2, 1, 60]);
      assert.deepEqual([names(result)[0], result.cards.length], ["Fixture Creature 001", 60]);
    } finally {
      fake.setCards();
    }
    pass("a page with nothing to show is skipped, and the response says which page was asked for");
  }

  {
    // All hidden: stop after a couple of pages rather than spending a minute of lookups.
    const hidden = Array.from({ length: 300 }, (_, i) => hiddenCard(`Aardvark Fixture ${String(i).padStart(3, "0")}`, i));
    fake.setCards(hidden);
    try {
      const result = await search("t:creature", 1);
      assert.deepEqual([result.page, result.cards.length, result.excluded, result.has_more], [3, 0, 180, true]);
    } finally {
      fake.setCards();
    }
    pass("skipping is bounded: an all-hidden result stops after three pages and still offers Next");
  }

  {
    // Scryfall keeps only the first 1024 characters of q. Generated queries are cut to fit before
    // they get here; a query that arrives longer loses its tail — here the "-t:fixture" exclusion —
    // without any error.
    const head = `t:creature ${"game:paper ".repeat(92)}`.padEnd(SCRYFALL_MAX_QUERY_CHARS, " ");
    const long = `${head}-t:fixture`;
    assert.ok(long.length > SCRYFALL_MAX_QUERY_CHARS, `query is ${long.length} chars`);
    assert.equal((await search("t:creature game:paper -t:fixture")).total, 5, "same filters under the limit");
    const result = await search(long);
    assert.equal(searchRequests(fake)[0].q, long, "the app sends the whole query");
    assert.equal(result.total, 205, "pinned: the cut drops '-t:fixture', so the 200 fixture creatures come back too");
    pass("pinned: queries over 1024 chars are silently truncated upstream");
  }

  {
    // When the closing parenthesis of a query falls past the cut, Scryfall rejects it outright.
    const grouped = `(t:creature ${"game:paper ".repeat(93)}or t:instant) -t:fixture`;
    assert.ok(grouped.length > SCRYFALL_MAX_QUERY_CHARS, `query is ${grouped.length} chars`);
    await assert.rejects(search(grouped), (e: unknown) => {
      assert.ok(e instanceof ScryfallResponseError);
      assert.deepEqual([e.status, e.message], [400, "Your query has an unclosed parenthesis."]);
      return true;
    });
    pass("pinned: a parenthesised query over 1024 chars is a 400 (unclosed parenthesis)");
  }

  // ---- Field mapping -------------------------------------------------------------------------

  {
    const [bolt] = (await search("name:\"Lightning Bolt\"")).cards;
    assert.equal(fake.requests.length, 1, "a paper card costs no extra requests");
    assert.deepEqual(bolt, {
      id: fixtures.lightningBolt.id,
      name: "Lightning Bolt",
      mana_cost: "{R}",
      type_line: "Instant",
      oracle_text: "Lightning Bolt deals 3 damage to any target.",
      image_uris: {
        normal: `${fake.baseUrl}/img/${fixtures.lightningBolt.id}/normal.svg`,
        small: `${fake.baseUrl}/img/${fixtures.lightningBolt.id}/small.svg`,
      },
      card_faces: undefined,
      scryfall_uri: fixtures.lightningBolt.scryfall_uri,
      set_name: "Double Masters 2022",
      set_type: "masters",
      oracle_id: fixtures.lightningBolt.oracle_id,
      cardtrader_blueprint_ids: null,
      collector_number: "117",
      set_code: "2x2",
      tcgplayer_id: 276110,
      tcgplayer_link: "https://partner.example/fixture?u=" + encodeURIComponent("https://www.tcgplayer.com/product/276110"),
      prices: { usd: "1.50", eur: "1.20" },
    });
    pass("paper card: every CardResult field mapped from the Scryfall card");
  }

  {
    const [delver] = (await search("name:\"Delver of Secrets\"")).cards;
    assert.equal(delver.image_uris.normal, `${fake.baseUrl}/img/${fixtures.delverOfSecrets.id}/0/normal.svg`, "front face image");
    assert.equal(delver.mana_cost, "{U}", "only the front face has a cost");
    assert.deepEqual(delver.card_faces?.map((f) => f.name), ["Delver of Secrets", "Insectile Aberration"]);

    const [fire] = (await search("name:\"Fire // Ice\"")).cards;
    assert.equal(fire.mana_cost, "{1}{R} / {1}{U}", "split card costs joined with ' / '");
    assert.equal(fire.image_uris.normal, `${fake.baseUrl}/img/${fixtures.fireIce.id}/normal.svg`);

    const [solRing] = (await search("name:\"Sol Ring\"")).cards;
    assert.deepEqual(solRing.prices, { usd: "12.00", eur: "10.00" }, "foil price when there is no non-foil listing");
    assert.equal(solRing.tcgplayer_id, null);
    assert.equal(
      solRing.tcgplayer_link,
      "https://partner.example/fixture?u=" + encodeURIComponent("https://www.tcgplayer.com"),
      "no product → partner link to the TCGPlayer homepage"
    );
    pass("double-faced, split, and foil-only cards");
  }

  // ---- Digital → paper substitution ----------------------------------------------------------

  {
    const result = await search("name:\"Young Pyromancer\"");
    assert.deepEqual(names(result), ["Young Pyromancer"]);
    const [card] = result.cards;
    assert.equal(card.id, fixtures.youngPyromancerPaper.id, "the whole card is replaced by the paper printing");
    assert.deepEqual([card.set_name, card.set_type, card.set_code, card.collector_number], ["Magic 2014", "core", "m14", "163"]);
    assert.deepEqual([card.tcgplayer_id, card.prices.usd], [69993, "0.80"]);
    const oid = fixtures.youngPyromancerPaper.oracle_id;
    assert.deepEqual(searchRequests(fake)[1], {
      q: `prefer:oldest (oracle_id:${oid}) -is:alchemy -is:digital -is:rebalanced`,
      unique: "cards",
    });
    assert.deepEqual(searchRequests(fake)[2], {
      q: `prefer:best ((date=2013-07-19 oracle_id:${oid})) -is:alchemy -is:digital -is:rebalanced`,
      unique: "prints",
      order: "released",
      dir: "asc",
      page: "1",
    });
    assert.equal(fake.requests.length, 3, "two lookup requests for the page: oldest date, then that day's printings");
    pass("alchemy printing sharing an oracle_id is swapped for the paper printing");
  }

  {
    fake.reset();
    fake.failOnce(/oracle_id:[^&]*-is:alchemy/, 400);
    const result = await searchResultsPage("name:\"Young Pyromancer\"", 1);
    const [card] = result.cards;
    assert.equal(card.id, fixtures.youngPyromancerPaper.id);
    assert.equal(searchRequests(fake)[2].q, `prefer:oldest (oracle_id:${fixtures.youngPyromancerPaper.oracle_id})`);
    assert.equal(searchRequests(fake)[2].unique, "cards");
    assert.equal(fake.requests.length, 4, "search, rejected step 1, unfiltered step 1, step 2");
    assert.equal(result.incomplete, false);
    pass("when Scryfall rejects the filtered lookup, the unfiltered oldest printing is used if it is paper");
  }

  {
    // The unfiltered oldest printing is digital: that says nothing about whether a paper one exists.
    const digitalFirst = { ...fixtures.youngPyromancerAlchemy, released_at: "2001-01-01" };
    fake.setCards([digitalFirst, fixtures.youngPyromancerPaper]);
    try {
      fake.reset();
      fake.failOnce(/oracle_id:[^&]*-is:alchemy/, 400);
      const result = await searchResultsPage("name:\"Young Pyromancer\"", 1);
      assert.deepEqual([result.cards[0]?.id, result.excluded, result.incomplete], [digitalFirst.id, 0, true]);
    } finally {
      fake.setCards();
    }
    pass("a card the unfiltered lookup can't settle is kept and reported, not treated as digital-only");
  }

  {
    fake.reset();
    fake.failOnce(/oracle_id:/, "disconnect");
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      const result = await searchResultsPage("name:\"Young Pyromancer\"", 1);
      assert.equal(result.cards[0].id, fixtures.youngPyromancerAlchemy.id, "kept as it is, not lost");
      assert.deepEqual([result.excluded, result.incomplete], [0, true]);
    } finally {
      console.warn = realWarn;
    }
    assert.match(warnings.join("\n"), /Paper-printing lookup stopped with 1 card/);
    pass("swap lookup network failure keeps the card and marks the page incomplete");
  }

  {
    fake.reset();
    fake.failOnce(/oracle_id:/, 500);
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const result = await searchResultsPage("t:sorcery", 1);
      assert.deepEqual([result.cards.length, result.incomplete], [60, true]);
    } finally {
      console.warn = realWarn;
    }
    assert.equal(fake.requests.length, 2, "a 5xx stops the lookups: no unfiltered retry, no later batches");
    pass("a failing Scryfall gets no further lookups");
  }

  {
    const result = await search("goldspan");
    assert.deepEqual(names(result), ["Goldspan Dragon"], "rebalanced A- card with its own oracle_id has no paper print → dropped");
    assert.equal(result.cards[0].id, fixtures.goldspanDragonPaper.id);
    assert.equal(fake.requests.length, 2, "the filtered lookup's 404 means 'no paper printing' — no fallback needed");
    assert.deepEqual([result.total, result.excluded, result.has_more], [2, 1, false], "total is Scryfall's, excluded says what's hidden");
    pass("rebalanced card without a paper printing is hidden and counted");
  }

  {
    const result = await search("goldspan is:alchemy");
    assert.deepEqual(names(result), ["Goldspan Dragon"], "display name taken from all_parts");
    const [card] = result.cards;
    assert.deepEqual([card.id, card.set_type, card.set_code], [fixtures.goldspanDragonRebalanced.id, "alchemy", "ymid"], "the card itself is kept");
    assert.equal(fake.requests.length, 2, "step 1 finds nothing (404), so no step 2; the lookup still runs even though all_parts already resolved the name");
    pass("explicit is:alchemy keeps the A- card and renames it to the paper name");
  }

  {
    const result = await search("name:\"Ancestral Recall\"");
    const [card] = result.cards;
    const paper = fixtures.ancestralRecallPaper;
    assert.deepEqual(
      [card.id, card.set_name, card.set_type, card.set_code, card.collector_number, card.tcgplayer_id, card.scryfall_uri],
      [paper.id, "Limited Edition Alpha", "core", paper.set, paper.collector_number, paper.tcgplayer_id ?? null, paper.scryfall_uri],
      "set, buy link and image all describe the paper printing"
    );
    assert.equal(searchRequests(fake)[1].q, `prefer:oldest (oracle_id:${fixtures.ancestralRecallDigital.oracle_id}) -is:alchemy -is:digital -is:rebalanced`);
    pass("digital printing with a paper version: the whole card is replaced, like an Alchemy one");
  }

  {
    // No paper printing to swap to: unlike an Alchemy card it stays, with its own data.
    const digitalOnly = fixtures.card({
      id: "cc000000-0000-4000-8000-00000000d001",
      oracle_id: "dd000000-0000-4000-8000-00000000d001",
      name: "Digital Only Fixture",
      type_line: "Instant",
      set: "vma",
      set_name: "Vintage Masters",
      set_type: "masters",
      digital: true,
    });
    fake.setCards([digitalOnly]);
    try {
      const result = await search("digital only fixture");
      assert.deepEqual([result.cards[0]?.id, result.cards[0]?.set_name, result.excluded, result.incomplete], [digitalOnly.id, "Vintage Masters", 0, false]);
    } finally {
      fake.setCards();
    }
    pass("a digital printing with no paper version stays as it is");
  }

  {
    fake.setCards([fixtures.ancestralRecallDigital, fixtures.ancestralRecallPaper].map((c) => ({ ...c, games: ["arena"] })));
    try {
      const [card] = (await search("game:arena name:\"Ancestral Recall\"")).cards;
      assert.deepEqual([card.set_code, fake.requests.length], [fixtures.ancestralRecallDigital.set, 1], "no lookup, nothing borrowed");
    } finally {
      fake.setCards();
    }
    pass("explicit is:alchemy / game:arena keeps a digital printing with its own data");
  }

  {
    const result = await search("game:arena name:\"Young Pyromancer\"");
    assert.equal(result.cards[0].id, fixtures.youngPyromancerAlchemy.id, "game:arena disables the swap");
    assert.equal(fake.requests.length, 3, "but the base-name lookup still runs");
    pass("is:alchemy / game:arena in the query keeps digital printings");
  }

  // ---- Batched lookups -----------------------------------------------------------------------

  {
    const result = await search("t:sorcery");
    assert.deepEqual([result.total, result.cards.length], [fixtures.DIGITAL_COUNT, 60]);
    assert.deepEqual(
      result.cards.map((c) => c.id).sort(),
      fixtures.digitalBulk.filter((c) => !c.digital).map((c) => c.id).sort(),
      "every card on the page is its paper printing"
    );
    assert.ok(result.cards.every((c) => c.set_code === "fix" && c.prices.usd !== null && c.tcgplayer_id !== null));
    const lookups = searchRequests(fake).slice(1);
    const step1 = lookups.filter((l) => l.unique === "cards");
    const step2 = lookups.filter((l) => l.unique === "prints");
    assert.deepEqual([step1.length, step2.length], [4, 5], "60 digital cards → 4 oldest-date requests + 5 same-day requests, not 60–120");
    assert.equal(fake.requests.length, 10);
    const gaps = fake.requests.slice(1).map((r, i) => r.at - fake.requests[i].at);
    assert.ok(gaps.every((g) => g >= 480), `search-class requests are ≥500 ms apart (2/s): ${gaps.join(", ")} ms`);
    for (const l of lookups) assert.ok(l.q.length < 1024, `lookup q stays under Scryfall's cut (${l.q.length} chars)`);
    for (const l of step1) assert.match(l.q, /^prefer:oldest \((oracle_id:[0-9a-f-]+( or )?)+\) -is:alchemy -is:digital -is:rebalanced$/);
    for (const l of step2) assert.match(l.q, /^prefer:best \((\(date=\d{4}-\d\d-\d\d oracle_id:[0-9a-f-]+\)( or )?)+\) -is:alchemy -is:digital -is:rebalanced$/);
    pass("a full page of digital cards is resolved in a handful of batched requests, paced at 2/s");
  }

  {
    // Mixed page: alchemy swap, digital-only set borrow, and paper cards share one lookup.
    const result = await search("t:instant");
    assert.deepEqual(names(result), ["Ancestral Recall", "Fire // Ice", "Lightning Bolt"]);
    assert.equal(result.cards[0].set_name, "Limited Edition Alpha");
    assert.equal(fake.requests.length, 3, "one search + two lookup requests for the page");
    pass("mixed page: paper cards cost nothing extra, digital ones share one lookup");
  }

  {
    // Basic lands: 5 × 50 paper printings back to 1993 plus Wastes (2016). Walking printings in
    // release order would page through all the older basics before reaching Wastes; asking for
    // the oldest printing per card (`unique=cards prefer:oldest`) is a single request.
    const result = await search("is:digital t:basic");
    assert.deepEqual(names(result).sort(), ["Forest", "Island", "Mountain", "Plains", "Swamp", "Wastes"]);
    assert.equal(fake.requests.length, 3, "one search + two lookups, regardless of how many printings exist");
    const bySet = Object.fromEntries(result.cards.map((c) => [c.name, [c.set_name, c.collector_number]]));
    assert.deepEqual(bySet.Wastes, ["Oath of the Gatewatch", "400"], "recent card: its paper printing");
    assert.deepEqual(bySet.Plains, ["Limited Edition Alpha", "400"], "oldest paper printing, not the newest");
    const prints = fixtures.basicLands.filter((c) => !c.digital).length;
    assert.ok(prints > 175, `${prints} paper printings would need more than one page to walk`);
    pass("lookups never walk all printings: oldest date per card, then only that day's printings");
  }

  {
    // Same-day printings: prefer:oldest alone returns the extended-art / oversized printing
    // (different price, sometimes no buy link). The app must return the one order=released puts first.
    const result = await search("t:legendary");
    const byName = Object.fromEntries(result.cards.map((c) => [c.name, c]));
    const abomination = byName["Abomination of Llanowar"];
    assert.deepEqual(
      [abomination.id, abomination.set_code, abomination.collector_number, abomination.prices.usd, abomination.tcgplayer_id],
      [fixtures.abominationRegular.id, "cmr", "265", "0.50", 225916],
      "cmr 265, not the same-day extended art cmr 585"
    );
    const adrix = byName["Adrix and Nev, Twincasters"];
    assert.deepEqual(
      [adrix.id, adrix.set_code, adrix.collector_number, adrix.prices.usd, adrix.tcgplayer_id],
      [fixtures.adrixRegular.id, "c21", "9", "3.00", 236276],
      "c21 9 with its buy link, not the same-day oversized oc21 9 without one"
    );
    assert.equal(byName["Goldspan Dragon"].id, fixtures.goldspanDragonPaper.id);
    const step2 = searchRequests(fake).filter((l) => l.unique === "prints");
    assert.equal(step2.length, 1, "both cards' same-day printings in one request");
    assert.match(step2[0].q, /\(date=2020-11-20 oracle_id:ab000000[^)]*\) or \(date=2021-04-23 oracle_id:ad000000/);
    assert.equal(fake.requests.length, 3);
    pass("same-day printings: the lowest set code / collector number wins, as the old per-card query gave");
  }

  {
    // If step 2 fails, step 1's printing (a paper one, possibly not the same) is still used.
    fake.reset();
    fake.failOnce(/date=2020-11-20/, 500);
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    let result;
    try {
      result = await searchResultsPage("name:\"Abomination of Llanowar\"", 1);
    } finally {
      console.warn = realWarn;
    }
    assert.equal(result.cards[0].id, fixtures.abominationExtended.id, "degrades to Scryfall's preferred same-day printing");
    assert.match(warnings.join("\n"), /Same-day printings lookup failed/);
    pass("a failed same-day lookup degrades to step 1's printing with a warning");
  }

  // ---- Rate limits ---------------------------------------------------------------------------

  {
    fake.reset();
    const id = fixtures.lightningBolt.id;
    for (let i = 0; i < 4; i++) assert.equal((await scryfallFetch(`${fake.baseUrl}/cards/${id}`)).status, 200);
    const gaps = fake.requests.slice(1).map((r, i) => r.at - fake.requests[i].at);
    assert.ok(gaps.every((g) => g >= 95 && g < 400), `other routes only need 100 ms (10/s): ${gaps.join(", ")} ms`);
    pass("pacing is per endpoint class: 2/s for search, 10/s for the rest");
  }

  {
    // What the fake does to a client that ignores the limit (burst 3 here, 15 by default).
    fake.reset();
    const statuses = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${fake.baseUrl}/cards/search?q=t:instant`).then((r) => r.status))
    );
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    await sleep(600); // long enough to refill a token: only the lockout can still answer 429
    assert.equal((await fetch(`${fake.baseUrl}/cards/${fixtures.lightningBolt.id}`)).status, 429);
    pass("the fake answers 429 (without Retry-After) once a burst is spent, then locks the whole API");
  }

  // ---- Upstream errors -----------------------------------------------------------------------

  {
    const result = await search("no-such-card-xyz");
    assert.deepEqual([result.total, result.cards, result.has_more], [0, [], false]);
    pass("Scryfall's 404 'no cards matched' becomes an empty page");
  }

  {
    await assert.rejects(search("fixture:400"), (e: unknown) => {
      assert.ok(e instanceof ScryfallResponseError);
      assert.deepEqual([e.status, e.message], [400, "The fake Scryfall rejected this query (fixture:400)."]);
      return true;
    });
    await assert.rejects(search("fixture:500"), (e: unknown) => e instanceof ScryfallResponseError && e.status === 500);
    pass("4xx/5xx surface as ScryfallResponseError with Scryfall's explanation");
  }

  {
    const result = await search("fixture:429 t:fixture");
    assert.equal(result.cards.length, 60);
    assert.equal(searchRequests(fake).length, 2, "retried once after a short Retry-After");
    await assert.rejects(search("fixture:429-long t:fixture"), (e: unknown) => e instanceof ScryfallResponseError && e.status === 429);
    assert.equal(searchRequests(fake).length, 1, "a long Retry-After is not retried");
    pass("429: retried once when Retry-After ≤ 2s, otherwise returned as an error");
  }

  // ---- Partial failures ----------------------------------------------------------------------
  // Each 429 below locks the app out for its Retry-After, so these run last and wait it out.

  {
    // Still locked out by the 5-second Retry-After of fixture:429-long just above.
    await assert.rejects(search("t:fixture"), (e: unknown) => e instanceof ScryfallResponseError && e.status === 429);
    assert.equal((await scryfallFetch(`${fake.baseUrl}/cards/${fixtures.lightningBolt.id}`)).status, 429);
    assert.equal(fake.requests.length, 0, "not one request reaches Scryfall during a lockout");
    await sleep(5_000);
    assert.equal((await search("t:fixture")).cards.length, 60, "and searching works again afterwards");
    pass("after a 429 no request is sent until its Retry-After has passed");
  }

  {
    fake.reset();
    fake.failOnce(/oracle_id:/, 429, 3);
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const result = await searchResultsPage("t:sorcery", 1);
      assert.equal(fake.requests.length, 2, "the first failed lookup is the last request");
      assert.deepEqual([result.cards.length, result.excluded, result.incomplete], [60, 0, true]);
      assert.ok(result.cards.every((c) => c.set_type === "alchemy"), "shown as the digital printings Scryfall returned");
    } finally {
      console.warn = realWarn;
    }
    await sleep(3_000);
    pass("a 429 during lookups stops them, keeps every card and marks the page incomplete");
  }

  {
    // Our page 3 needs Scryfall pages 1 and 2. Without the second it is short, and says so.
    fake.reset();
    fake.failOnce(/page=2/, 500);
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const result = await searchResultsPage("t:fixture", 3);
      assert.deepEqual([result.cards.length, result.has_more, result.incomplete], [55, true, true]);
    } finally {
      console.warn = realWarn;
    }
    pass("a failed second Scryfall page gives a short page marked incomplete, with Next still offered");
  }

  {
    // Last, because a 429 with no Retry-After locks the app out for a full minute.
    fake.reset();
    fake.failOnce(/q=/, 429);
    await assert.rejects(searchResultsPage("t:fixture", 1), (e: unknown) => e instanceof ScryfallResponseError && e.status === 429);
    assert.equal((await scryfallFetch(`${fake.baseUrl}/cards/search?q=t:instant`)).status, 429);
    assert.equal(fake.requests.length, 1, "the second call never left the app");
    pass("a 429 with no Retry-After still locks the app out");
  }

  await fake.close();
  console.log(`\nAll ${checks} search-results self-checks passed.`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
