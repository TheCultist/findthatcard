/**
 * Which printing represents each card (Scryfall's `prefer:`). Like the sort, it is not part of the
 * query text: the Printings selector holds it, the URL carries it as `?prefer=` (left out for the
 * default), and the server puts it in front of `q` only when it calls Scryfall.
 *
 * A `prefer:` the user types in the query still works: Scryfall honours the LAST prefer: token, and
 * ours always comes first.
 */

export type PreferOption = {
  /** Scryfall prefer: value; "none" sends no prefer: clause (Scryfall's own default). */
  value: string;
  label: string;
  group: "Default" | "Age" | "Price" | "Style";
};

export const DEFAULT_PREFER = "best";
const NO_PREFER = "none";

export const PREFER_OPTIONS: ReadonlyArray<PreferOption> = [
  { value: "best", label: "Best printing (default)", group: "Default" },
  { value: NO_PREFER, label: "No preference (Scryfall default)", group: "Default" },
  { value: "oldest", label: "Oldest printing", group: "Age" },
  { value: "newest", label: "Newest printing", group: "Age" },
  { value: "usd-low", label: "Cheapest (USD)", group: "Price" },
  { value: "usd-high", label: "Most expensive (USD)", group: "Price" },
  { value: "eur-low", label: "Cheapest (EUR)", group: "Price" },
  { value: "eur-high", label: "Most expensive (EUR)", group: "Price" },
  { value: "tix-low", label: "Cheapest (MTGO tix)", group: "Price" },
  { value: "tix-high", label: "Most expensive (MTGO tix)", group: "Price" },
  { value: "promo", label: "Promo printings", group: "Style" },
  { value: "default", label: "Default Magic frame", group: "Style" },
  { value: "atypical", label: "Atypical frames", group: "Style" },
  { value: "universesbeyond", label: "Universes Beyond", group: "Style" },
  { value: "notuniversesbeyond", label: "Not Universes Beyond", group: "Style" },
];

export const PREFER_ALIASES: Record<string, string> = {
  ub: "universesbeyond",
  notub: "notuniversesbeyond",
};

/** The longest prefix applyPrefer can add, so query length budgets leave room for any choice. */
export const MAX_PREFER_PREFIX_LENGTH = Math.max(...PREFER_OPTIONS.map((o) => `prefer:${o.value} `.length));

/**
 * Lenient parse of untrusted input (request body, hand-edited URL): aliases become their long form,
 * anything that is not a known option means the default rather than an error.
 */
export function parsePreferInput(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_PREFER;
  const lower = value.toLowerCase();
  const canonical = PREFER_ALIASES[lower] ?? lower;
  return PREFER_OPTIONS.some((o) => o.value === canonical) ? canonical : DEFAULT_PREFER;
}

/** `?prefer=oldest` → "oldest"; missing or unusable → the default. */
export function preferFromParams(params: { get(name: string): string | null }): string {
  return parsePreferInput(params.get("prefer"));
}

/** The query Scryfall receives for this choice. */
export function applyPrefer(query: string, prefer: string): string {
  return prefer === NO_PREFER ? query : `prefer:${prefer} ${query}`;
}
