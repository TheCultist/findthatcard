export type StrategyOracletagGroup = {
  strategy: string;
  oracletags: string[];
  aliases?: string[];
  notes?: string;
};

/**
 * Common MTG strategies mapped to Scryfall oracletag filters.
 * Use these tags directly in queries (they already include the "oracletag:" prefix).
 */
export const STRATEGY_ORACLETAGS: StrategyOracletagGroup[] = [
  {
    strategy: "Aristocrats",
    oracletags: [
      "oracletag:sacrifice-outlet",
      "oracletag:death-trigger",
      "oracletag:death-trigger-self",
      "oracletag:sacrifice-self",
      "oracletag:alternate-cost-sacrifice",
    ],
  },
  {
    strategy: "Sacrifice",
    oracletags: ["oracletag:sacrifice-outlet", "oracletag:sacrifice-payoff"],
    aliases: ["sacrifice matters"],
  },
  {
    strategy: "Lifegain",
    oracletags: ["oracletag:lifegain", "oracletag:lifegain-matters"],
    aliases: ["life gain"],
  },
  {
    strategy: "+1/+1 Counters",
    oracletags: ["oracletag:counters-matter", "oracletag:gives-pp-counters"],
    aliases: ["plus one counters", "plus-one counters", "pp-counters"],
  },
  {
    strategy: "Control",
    oracletags: [
      "oracletag:counterspell",
      "oracletag:removal",
      "oracletag:board-wipe",
    ],
  },
  {
    strategy: "Cost Reduction",
    oracletags: ["oracletag:discount-self", "oracletag:discount-tap-creature"],
    aliases: ["cost reduction", "discount", "cost reducer", "cost reducers"],
  },
];

export const STRATEGY_TAG_NAMES = STRATEGY_ORACLETAGS.map((entry) => entry.strategy);

function normalizeStrategyName(value: string): string {
  return value.trim().toLowerCase();
}

function buildStrategyTagMap(): Map<string, StrategyOracletagGroup> {
  const map = new Map<string, StrategyOracletagGroup>();
  for (const entry of STRATEGY_ORACLETAGS) {
    map.set(normalizeStrategyName(entry.strategy), entry);
    for (const alias of entry.aliases || []) {
      map.set(normalizeStrategyName(alias), entry);
    }
  }
  return map;
}

function buildOracletagReplacement(oracletags: string[]): string {
  if (oracletags.length === 1) {
    return oracletags[0];
  }
  return `(${oracletags.join(" or ")})`;
}

/**
 * Replaces strategy: tags with their corresponding oracletag groups.
 */
export function expandStrategyTags(query: string): string {
  const map = buildStrategyTagMap();
  const strategyPattern = /(^|\s)strategy:("([^"]+)"|[^\s()]+)/gi;

  return query.replace(strategyPattern, (match, leading, rawValue, quotedValue) => {
    const value = (quotedValue || rawValue || "").replace(/^"|"$/g, "");
    const entry = map.get(normalizeStrategyName(value));
    if (!entry) {
      return match;
    }
    const replacement = buildOracletagReplacement(entry.oracletags);
    console.log(
      `[Strategy Tags] Replacing strategy:${value} -> ${replacement}`
    );
    return `${leading}${replacement}`;
  });
}
