/**
 * Fixture cards for the fake Scryfall server.
 *
 * Every object follows the shape of a Scryfall card object (the fields this app reads plus the
 * ones the card-detail panel expects). Card names are real cards so the UI looks natural, but the
 * printings are ILLUSTRATIVE — e.g. which sets a card appears in and whether two printings share
 * an oracle_id is chosen to exercise a code path, not copied from Scryfall. Each scenario card
 * documents the path it models; check those assumptions against live data before relying on them.
 *
 * Image URIs are relative (`/img/...`); the server rewrites them to absolute URLs and serves SVG
 * placeholders so the grid renders offline.
 */

export interface FixtureFace {
  object: "card_face";
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  artist?: string;
  image_uris?: Record<string, string>;
}

export interface FixtureCard {
  object: "card";
  id: string;
  oracle_id: string;
  name: string;
  lang: string;
  layout: string;
  released_at: string;
  scryfall_uri: string;
  mana_cost?: string;
  cmc: number;
  type_line: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  colors: string[];
  color_identity: string[];
  keywords: string[];
  legalities: Record<string, string>;
  games: string[];
  digital: boolean;
  set: string;
  set_name: string;
  set_type: string;
  collector_number: string;
  rarity: string;
  artist: string;
  image_uris?: Record<string, string>;
  card_faces?: FixtureFace[];
  all_parts?: Array<{ object: "related_card"; id: string; component: string; name: string; type_line: string; uri: string }>;
  tcgplayer_id?: number;
  purchase_uris?: { tcgplayer?: string };
  prices: { usd: string | null; usd_foil: string | null; eur: string | null; eur_foil: string | null; tix: string | null };
}

type CardInput = Partial<FixtureCard> & Pick<FixtureCard, "id" | "oracle_id" | "name" | "type_line" | "set" | "set_name" | "set_type">;

const SET_RELEASE: Record<string, string> = {
  lea: "1993-08-05",
  m14: "2013-07-19",
  khm: "2021-02-05",
  "2x2": "2022-07-08",
  vma: "2014-06-16",
  ymid: "2021-12-09",
  isd: "2011-09-30",
  apc: "2001-06-04",
  c21: "2021-04-23",
};

function images(id: string, face?: number): Record<string, string> {
  const base = face === undefined ? `/img/${id}` : `/img/${id}/${face}`;
  return { small: `${base}/small.svg`, normal: `${base}/normal.svg`, large: `${base}/large.svg` };
}

function card(input: CardInput): FixtureCard {
  const multiFaced = (input.card_faces?.length ?? 0) > 1;
  return {
    object: "card",
    lang: "en",
    layout: "normal",
    released_at: SET_RELEASE[input.set] ?? "2020-01-01",
    scryfall_uri: `https://scryfall.com/card/${input.set}/${input.collector_number ?? "1"}`,
    cmc: 1,
    colors: [],
    color_identity: [],
    keywords: [],
    legalities: { standard: "not_legal", modern: "legal", legacy: "legal", vintage: "legal", commander: "legal" },
    games: input.digital ? ["arena"] : ["paper", "mtgo", "arena"],
    digital: false,
    collector_number: "1",
    rarity: "common",
    artist: "Fixture Artist",
    prices: { usd: "0.25", usd_foil: "1.00", eur: "0.20", eur_foil: "0.80", tix: "0.02" },
    // Single-faced cards carry top-level images; transform/modal DFCs carry them per face.
    ...(multiFaced && input.layout !== "split" ? {} : { image_uris: images(input.id) }),
    ...input,
  };
}

// ---------------------------------------------------------------------------------------------
// Scenario cards
// ---------------------------------------------------------------------------------------------

/** A. Plain paper card: passes through the transformer untouched. */
const lightningBolt = card({
  id: "a1000000-0000-4000-8000-000000000001",
  oracle_id: "a1000000-0000-4000-8000-00000000000a",
  name: "Lightning Bolt",
  mana_cost: "{R}",
  type_line: "Instant",
  oracle_text: "Lightning Bolt deals 3 damage to any target.",
  colors: ["R"],
  color_identity: ["R"],
  set: "2x2",
  set_name: "Double Masters 2022",
  set_type: "masters",
  collector_number: "117",
  rarity: "uncommon",
  tcgplayer_id: 276110,
  purchase_uris: { tcgplayer: "https://www.tcgplayer.com/product/276110" },
  prices: { usd: "1.50", usd_foil: "4.00", eur: "1.20", eur_foil: "3.50", tix: "0.50" },
});

/**
 * B. Alchemy-set printing that SHARES an oracle_id with a paper printing. Listed first so
 * `unique=cards` picks it as the representative print, which is what triggers the swap.
 * Expected: the paper printing is returned in its place.
 */
const YOUNG_PYROMANCER_ORACLE = "b2000000-0000-4000-8000-00000000000b";
const youngPyromancerAlchemy = card({
  id: "b2000000-0000-4000-8000-000000000001",
  oracle_id: YOUNG_PYROMANCER_ORACLE,
  name: "Young Pyromancer",
  mana_cost: "{1}{R}",
  cmc: 2,
  type_line: "Creature — Human Shaman",
  oracle_text: "Whenever you cast an instant or sorcery spell, create a 1/1 red Elemental creature token.",
  power: "2",
  toughness: "1",
  colors: ["R"],
  color_identity: ["R"],
  set: "ymid",
  set_name: "Alchemy: Innistrad",
  set_type: "alchemy",
  digital: true,
  collector_number: "A-40",
  prices: { usd: null, usd_foil: null, eur: null, eur_foil: null, tix: null },
});
const youngPyromancerPaper = card({
  id: "b2000000-0000-4000-8000-000000000002",
  oracle_id: YOUNG_PYROMANCER_ORACLE,
  name: "Young Pyromancer",
  mana_cost: "{1}{R}",
  cmc: 2,
  type_line: "Creature — Human Shaman",
  oracle_text: "Whenever you cast an instant or sorcery spell, create a 1/1 red Elemental creature token.",
  power: "2",
  toughness: "1",
  colors: ["R"],
  color_identity: ["R"],
  set: "m14",
  set_name: "Magic 2014",
  set_type: "core",
  collector_number: "163",
  rarity: "uncommon",
  tcgplayer_id: 69993,
  purchase_uris: { tcgplayer: "https://www.tcgplayer.com/product/69993" },
  prices: { usd: "0.80", usd_foil: "6.00", eur: "0.60", eur_foil: "5.00", tix: "0.05" },
});

/**
 * C. Rebalanced "A-" card with its OWN oracle_id (its text differs from the paper card) and an
 * `all_parts` link to the paper card. The oracle_id lookup finds no paper printing.
 * Expected: dropped from results unless the query asks for alchemy, in which case it is kept
 * and only its display name is taken from `all_parts`.
 */
const goldspanDragonPaper = card({
  id: "c3000000-0000-4000-8000-000000000001",
  oracle_id: "c3000000-0000-4000-8000-00000000000c",
  name: "Goldspan Dragon",
  mana_cost: "{3}{R}{R}",
  cmc: 5,
  type_line: "Legendary Creature — Dragon",
  oracle_text: "Flying, haste\nWhenever Goldspan Dragon attacks or becomes the target of a spell, create a Treasure token.\nTreasures you control have \"{T}, Sacrifice this artifact: Add two mana of any one color.\"",
  power: "4",
  toughness: "4",
  colors: ["R"],
  color_identity: ["R"],
  keywords: ["Flying", "Haste"],
  set: "khm",
  set_name: "Kaldheim",
  set_type: "expansion",
  collector_number: "139",
  rarity: "mythic",
  tcgplayer_id: 230394,
  purchase_uris: { tcgplayer: "https://www.tcgplayer.com/product/230394" },
  prices: { usd: "9.00", usd_foil: "14.00", eur: "8.00", eur_foil: "12.00", tix: "1.00" },
});
const goldspanDragonRebalanced = card({
  id: "c3000000-0000-4000-8000-000000000002",
  oracle_id: "c3000000-0000-4000-8000-00000000000d",
  name: "A-Goldspan Dragon",
  mana_cost: "{3}{R}{R}",
  cmc: 5,
  type_line: "Legendary Creature — Dragon",
  oracle_text: "Flying, haste\nWhenever A-Goldspan Dragon attacks or becomes the target of a spell, create a Treasure token.\nTreasures you control have \"{T}, Sacrifice this artifact: Add one mana of any color.\"",
  power: "4",
  toughness: "4",
  colors: ["R"],
  color_identity: ["R"],
  keywords: ["Flying", "Haste"],
  set: "ymid",
  set_name: "Alchemy: Innistrad",
  set_type: "alchemy",
  digital: true,
  collector_number: "A-139",
  rarity: "mythic",
  all_parts: [
    {
      object: "related_card",
      id: goldspanDragonPaper.id,
      component: "combo_piece",
      name: "Goldspan Dragon",
      type_line: "Legendary Creature — Dragon",
      uri: `https://api.scryfall.com/cards/${goldspanDragonPaper.id}`,
    },
  ],
  prices: { usd: null, usd_foil: null, eur: null, eur_foil: null, tix: null },
});

/**
 * D. Digital-only printing from a non-Alchemy set (Magic Online masters set), sharing an
 * oracle_id with a paper printing. Listed first so `unique=cards` returns it.
 * Expected: only set_name/set_type are taken from the paper printing; id, set code, collector
 * number, prices and TCGPlayer link still describe the digital printing.
 */
const ANCESTRAL_RECALL_ORACLE = "d4000000-0000-4000-8000-00000000000d";
const ancestralRecallDigital = card({
  id: "d4000000-0000-4000-8000-000000000001",
  oracle_id: ANCESTRAL_RECALL_ORACLE,
  name: "Ancestral Recall",
  mana_cost: "{U}",
  type_line: "Instant",
  oracle_text: "Target player draws three cards.",
  colors: ["U"],
  color_identity: ["U"],
  legalities: { standard: "not_legal", modern: "not_legal", legacy: "banned", vintage: "restricted", commander: "banned" },
  set: "vma",
  set_name: "Vintage Masters",
  set_type: "masters",
  digital: true,
  games: ["mtgo"],
  collector_number: "1",
  rarity: "special",
  prices: { usd: null, usd_foil: null, eur: null, eur_foil: null, tix: "35.00" },
});
const ancestralRecallPaper = card({
  id: "d4000000-0000-4000-8000-000000000002",
  oracle_id: ANCESTRAL_RECALL_ORACLE,
  name: "Ancestral Recall",
  mana_cost: "{U}",
  type_line: "Instant",
  oracle_text: "Target player draws three cards.",
  colors: ["U"],
  color_identity: ["U"],
  legalities: { standard: "not_legal", modern: "not_legal", legacy: "banned", vintage: "restricted", commander: "banned" },
  set: "lea",
  set_name: "Limited Edition Alpha",
  set_type: "core",
  games: ["paper"],
  collector_number: "48",
  rarity: "rare",
  tcgplayer_id: 1004,
  purchase_uris: { tcgplayer: "https://www.tcgplayer.com/product/1004" },
  prices: { usd: "9500.00", usd_foil: null, eur: "8000.00", eur_foil: null, tix: null },
});

/** E. Transform DFC: no top-level image_uris, each face carries its own; only the front has a cost. */
const delverOfSecrets = card({
  id: "e5000000-0000-4000-8000-000000000001",
  oracle_id: "e5000000-0000-4000-8000-00000000000e",
  name: "Delver of Secrets // Insectile Aberration",
  layout: "transform",
  type_line: "Creature — Human Wizard // Creature — Human Insect",
  colors: ["U"],
  color_identity: ["U"],
  set: "isd",
  set_name: "Innistrad",
  set_type: "expansion",
  collector_number: "51",
  tcgplayer_id: 52176,
  purchase_uris: { tcgplayer: "https://www.tcgplayer.com/product/52176" },
  card_faces: [
    {
      object: "card_face",
      name: "Delver of Secrets",
      mana_cost: "{U}",
      type_line: "Creature — Human Wizard",
      oracle_text: "At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.",
      power: "1",
      toughness: "1",
      artist: "Fixture Artist",
      image_uris: images("e5000000-0000-4000-8000-000000000001", 0),
    },
    {
      object: "card_face",
      name: "Insectile Aberration",
      mana_cost: "",
      type_line: "Creature — Human Insect",
      oracle_text: "Flying",
      power: "3",
      toughness: "2",
      artist: "Fixture Artist",
      image_uris: images("e5000000-0000-4000-8000-000000000001", 1),
    },
  ],
});

/** F. Split card: top-level image, per-face mana costs that the UI joins with " / ". */
const fireIce = card({
  id: "f6000000-0000-4000-8000-000000000001",
  oracle_id: "f6000000-0000-4000-8000-00000000000f",
  name: "Fire // Ice",
  layout: "split",
  mana_cost: "{1}{R} // {1}{U}",
  cmc: 4,
  type_line: "Instant // Instant",
  colors: ["R", "U"],
  color_identity: ["R", "U"],
  set: "apc",
  set_name: "Apocalypse",
  set_type: "expansion",
  collector_number: "128",
  rarity: "uncommon",
  tcgplayer_id: 2822,
  purchase_uris: { tcgplayer: "https://www.tcgplayer.com/product/2822" },
  card_faces: [
    {
      object: "card_face",
      name: "Fire",
      mana_cost: "{1}{R}",
      type_line: "Instant",
      oracle_text: "Fire deals 2 damage divided as you choose among one or two targets.",
      artist: "Fixture Artist",
    },
    {
      object: "card_face",
      name: "Ice",
      mana_cost: "{1}{U}",
      type_line: "Instant",
      oracle_text: "Tap target permanent.\nDraw a card.",
      artist: "Fixture Artist",
    },
  ],
});

/** G. Foil-only listing (no non-foil price) and no TCGPlayer product. */
const solRing = card({
  id: "a7000000-0000-4000-8000-000000000001",
  oracle_id: "a7000000-0000-4000-8000-00000000000a",
  name: "Sol Ring",
  mana_cost: "{1}",
  type_line: "Artifact",
  oracle_text: "{T}: Add {C}{C}.",
  set: "c21",
  set_name: "Commander 2021",
  set_type: "commander",
  collector_number: "263",
  rarity: "uncommon",
  prices: { usd: null, usd_foil: "12.00", eur: null, eur_foil: "10.00", tix: null },
});

/**
 * H. Same-day printings. Observed on the real API: for 28 of 286 cards `prefer:oldest` picked a
 * different printing than `order=released dir=asc` — one with the same date but a higher collector
 * number (extended art, oversized…), changing the price and sometimes losing the buy link.
 * Expected: the lowest set code / collector number of the oldest date, as the original query gave.
 */
const ABOMINATION_ORACLE = "ab000000-0000-4000-8000-0000000000ab";
const abominationShared = {
  oracle_id: ABOMINATION_ORACLE,
  name: "Abomination of Llanowar",
  mana_cost: "{1}{B}{G}",
  cmc: 3,
  type_line: "Legendary Creature — Elf Horror",
  oracle_text: "Vigilance, menace\nAbomination of Llanowar's power and toughness are each equal to the number of Elves you control plus the number of Elf cards in your graveyard.",
  power: "*",
  toughness: "*",
  colors: ["B", "G"],
  color_identity: ["B", "G"],
  keywords: ["Vigilance", "Menace"],
  rarity: "uncommon",
};
const abominationAlchemy = card({
  ...abominationShared,
  id: "ab000000-0000-4000-8000-000000000001",
  set: "ymid",
  set_name: "Alchemy: Innistrad",
  set_type: "alchemy",
  digital: true,
  collector_number: "A-265",
  prices: { usd: null, usd_foil: null, eur: null, eur_foil: null, tix: null },
});
const abominationRegular = card({
  ...abominationShared,
  id: "ab000000-0000-4000-8000-000000000265",
  set: "cmr",
  set_name: "Commander Legends",
  set_type: "draft_innovation",
  released_at: "2020-11-20",
  collector_number: "265",
  tcgplayer_id: 225916,
  purchase_uris: { tcgplayer: "https://www.tcgplayer.com/product/225916" },
  prices: { usd: "0.50", usd_foil: "2.00", eur: "0.40", eur_foil: "1.50", tix: "0.02" },
});
const abominationExtended = card({
  ...abominationShared,
  id: "ab000000-0000-4000-8000-000000000585",
  set: "cmr",
  set_name: "Commander Legends",
  set_type: "draft_innovation",
  released_at: "2020-11-20",
  collector_number: "585",
  tcgplayer_id: 226471,
  purchase_uris: { tcgplayer: "https://www.tcgplayer.com/product/226471" },
  prices: { usd: "1.20", usd_foil: "5.00", eur: "1.00", eur_foil: "4.00", tix: "0.05" },
});

const ADRIX_ORACLE = "ad000000-0000-4000-8000-0000000000ad";
const adrixShared = {
  oracle_id: ADRIX_ORACLE,
  name: "Adrix and Nev, Twincasters",
  mana_cost: "{2}{G}{U}",
  cmc: 4,
  type_line: "Legendary Creature — Merfolk Wizard",
  oracle_text: "Ward {2}\nIf one or more tokens would be created under your control, twice that many of those tokens are created instead.",
  power: "2",
  toughness: "2",
  colors: ["G", "U"],
  color_identity: ["G", "U"],
  keywords: ["Ward"],
  rarity: "mythic",
};
const adrixAlchemy = card({
  ...adrixShared,
  id: "ad000000-0000-4000-8000-000000000001",
  set: "ymid",
  set_name: "Alchemy: Innistrad",
  set_type: "alchemy",
  digital: true,
  collector_number: "A-9",
  prices: { usd: null, usd_foil: null, eur: null, eur_foil: null, tix: null },
});
const adrixRegular = card({
  ...adrixShared,
  id: "ad000000-0000-4000-8000-000000000009",
  set: "c21",
  set_name: "Commander 2021",
  set_type: "commander",
  released_at: "2021-04-23",
  collector_number: "9",
  tcgplayer_id: 236276,
  purchase_uris: { tcgplayer: "https://www.tcgplayer.com/product/236276" },
  prices: { usd: "3.00", usd_foil: null, eur: "2.50", eur_foil: null, tix: null },
});
const adrixOversized = card({
  ...adrixShared,
  id: "ad000000-0000-4000-8000-000000000109",
  set: "oc21",
  set_name: "Commander 2021 Oversized",
  set_type: "memorabilia",
  released_at: "2021-04-23",
  collector_number: "9",
  prices: { usd: null, usd_foil: null, eur: null, eur_foil: null, tix: null },
});

/** Bulk: enough plain creatures to span two Scryfall result pages (175 per page). */
const BULK_COUNT = 200;
const COLORS = ["W", "U", "B", "R", "G"];
const bulk: FixtureCard[] = Array.from({ length: BULK_COUNT }, (_, i) => {
  const n = String(i + 1).padStart(3, "0");
  const color = COLORS[i % COLORS.length];
  return card({
    id: `00000000-0000-4000-8000-000000000${n}`,
    oracle_id: `00000000-0000-4000-8000-00000000f${n}`,
    name: `Fixture Creature ${n}`,
    mana_cost: `{${(i % 4) + 1}}{${color}}`,
    cmc: (i % 4) + 2,
    type_line: "Creature — Fixture",
    oracle_text: `Fixture Creature ${n} is a placeholder card served by the fake Scryfall server.`,
    power: String((i % 5) + 1),
    toughness: String((i % 3) + 1),
    colors: [color],
    color_identity: [color],
    released_at: `2020-01-${String((i % 28) + 1).padStart(2, "0")}`,
    set: "fix",
    set_name: "Fixture Set",
    set_type: "expansion",
    collector_number: String(i + 1),
    tcgplayer_id: 900000 + i,
    purchase_uris: { tcgplayer: `https://www.tcgplayer.com/product/${900000 + i}` },
    prices: { usd: (0.1 + (i % 10) * 0.5).toFixed(2), usd_foil: null, eur: null, eur_foil: null, tix: null },
  });
});

/**
 * Bulk digital: a full page of Alchemy printings, each sharing an oracle_id with a paper printing
 * listed after it (so `unique=cards` returns the Alchemy one). Exercises the batched lookup.
 */
const DIGITAL_COUNT = 60;
const digitalBulk: FixtureCard[] = [];
for (let i = 0; i < DIGITAL_COUNT; i++) {
  const n = String(i + 1).padStart(3, "0");
  const shared = {
    oracle_id: `dd000000-0000-4000-8000-00000000f${n}`,
    name: `Digital Fixture ${n}`,
    mana_cost: `{${(i % 3) + 1}}{B}`,
    cmc: (i % 3) + 2,
    type_line: "Sorcery",
    oracle_text: `Digital Fixture ${n} has an Alchemy printing and a paper printing.`,
    colors: ["B"],
    color_identity: ["B"],
  };
  digitalBulk.push(
    card({
      ...shared,
      id: `dd000000-0000-4000-8000-0000000a0${n}`,
      set: "ymid",
      set_name: "Alchemy: Innistrad",
      set_type: "alchemy",
      digital: true,
      collector_number: `A-${i + 1}`,
      prices: { usd: null, usd_foil: null, eur: null, eur_foil: null, tix: null },
    }),
    card({
      ...shared,
      id: `dd000000-0000-4000-8000-0000000b0${n}`,
      set: "fix",
      set_name: "Fixture Set",
      set_type: "expansion",
      collector_number: String(300 + i),
      tcgplayer_id: 910000 + i,
      purchase_uris: { tcgplayer: `https://www.tcgplayer.com/product/${910000 + i}` },
      prices: { usd: (1 + i * 0.25).toFixed(2), usd_foil: null, eur: null, eur_foil: null, tix: null },
    })
  );
}

/**
 * Basic lands: a digital-only printing listed first, then many paper printings going back to
 * 1993 — and Wastes, first printed in 2016. Models `is:digital t:basic`, where walking printings
 * in release order to find each card's oldest paper one has to pass every older basic first.
 */
const BASIC_PRINTS_EACH = 50;
const BASICS = ["Plains", "Island", "Swamp", "Mountain", "Forest"];
const basicLands: FixtureCard[] = [];
const basicLandOf = (name: string, i: number, input: Partial<FixtureCard> & Pick<FixtureCard, "id" | "set" | "set_name" | "set_type">) =>
  card({
    oracle_id: `ba000000-0000-4000-8000-00000000000${i}`,
    name,
    type_line: `Basic Land — ${name === "Wastes" ? "" : name}`.trimEnd(),
    oracle_text: name === "Wastes" ? "({T}: Add {C}.)" : `({T}: Add {${"WUBRG"[i] ?? "C"}}.)`,
    cmc: 0,
    rarity: "common",
    tcgplayer_id: undefined,
    prices: { usd: "0.10", usd_foil: null, eur: "0.05", eur_foil: null, tix: null },
    ...input,
  });
for (const [i, name] of [...BASICS, "Wastes"].entries()) {
  basicLands.push(
    basicLandOf(name, i, {
      id: `ba000000-0000-4000-8000-0000000d000${i}`,
      set: "j21",
      set_name: "Jumpstart: Historic Horizons",
      set_type: "draft_innovation",
      digital: true,
      collector_number: String(700 + i),
      prices: { usd: null, usd_foil: null, eur: null, eur_foil: null, tix: null },
    })
  );
  const firstYear = name === "Wastes" ? 2016 : 1993;
  const count = name === "Wastes" ? 1 : BASIC_PRINTS_EACH;
  for (let p = 0; p < count; p++) {
    const year = firstYear + Math.floor(p / 2);
    basicLands.push(
      basicLandOf(name, i, {
        id: `ba000000-0000-4000-8000-0000${String(i)}${String(p).padStart(5, "0")}`,
        set: name === "Wastes" ? "ogw" : p === 0 ? "lea" : "fix",
        set_name: name === "Wastes" ? "Oath of the Gatewatch" : p === 0 ? "Limited Edition Alpha" : "Fixture Set",
        set_type: p === 0 && name !== "Wastes" ? "core" : "expansion",
        released_at: `${year}-${p % 2 ? "09" : "03"}-01`,
        collector_number: String(400 + p),
      })
    );
  }
}

/** Ordered like a Scryfall result set: position decides which printing `unique=cards` keeps. */
export const FIXTURE_CARDS: readonly FixtureCard[] = [
  lightningBolt,
  youngPyromancerAlchemy,
  youngPyromancerPaper,
  goldspanDragonPaper,
  goldspanDragonRebalanced,
  ancestralRecallDigital,
  ancestralRecallPaper,
  delverOfSecrets,
  fireIce,
  solRing,
  abominationAlchemy,
  abominationRegular,
  abominationExtended,
  adrixAlchemy,
  adrixRegular,
  adrixOversized,
  ...bulk,
  ...digitalBulk,
  ...basicLands,
];

/** Handles for tests, keyed by scenario. */
export const fixtures = {
  lightningBolt,
  youngPyromancerAlchemy,
  youngPyromancerPaper,
  goldspanDragonPaper,
  goldspanDragonRebalanced,
  ancestralRecallDigital,
  ancestralRecallPaper,
  delverOfSecrets,
  fireIce,
  solRing,
  abominationRegular,
  abominationExtended,
  adrixRegular,
  adrixOversized,
  bulk,
  BULK_COUNT,
  digitalBulk,
  DIGITAL_COUNT,
  basicLands,
  BASIC_PRINTS_EACH,
  /** Builds a fixture card with defaults filled in (for test-local scenarios). */
  card,
};
