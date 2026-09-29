/**
 * Search Pipeline V2 — extraction schema.
 *
 * A single AI call maps a natural-language query to this structured shape. Every
 * field is later validated against local Scryfall catalogs / the Tagger tag
 * vocabulary before it becomes a query clause — the model proposes, the catalogs
 * dispose. Nothing here is fuzzy-corrected.
 */

export type NumericOp = "<" | "<=" | "=" | ">=" | ">";
export type RarityOp = ":" | "<=" | ">=";
export type ColorOp = ":" | "=" | ">=" | "<=";

export type V2Intent =
  | "search"
  | "similar-cards"
  | "art-like-cards"
  | "synergy-with-card"
  | "direct-scryfall";

/**
 * Fully-populated extraction. The model is allowed to OMIT any field except
 * `intent` (see `V2_EXTRACTION_SCHEMA`), so what actually arrives from the AI
 * is `Partial<V2Extraction>` — `buildIRFromExtraction` normalizes it.
 */
export interface V2Extraction {
  /** High-level query intent. `direct-scryfall` is set by the pre-pass, never the AI. */
  intent: V2Intent;
  /** For named-card intents: the card the user referenced (validated against the catalog). */
  cardName: string | null;
  /**
   * Color / color-identity constraint. `letters` uses w u b r g c.
   * `combine` "and" = card must have all the letters (guilds, "red and green");
   * "or" = the letters are alternatives ("red or green" → any one qualifies).
   */
  colors: { mode: "identity" | "color"; op: ColorOp; letters: string; combine: "and" | "or" } | null;
  /** Types the card must have ALL of — compound types like "artifact creature". */
  typesAll: string[];
  /** Types where ANY one qualifies — enumerated alternatives like "instants or sorceries". */
  typesAny: string[];
  /** Excluded card types. */
  negatedTypes: string[];
  /** Subtypes (e.g. dragon, goblin, equipment). Validated against subtype catalogs. */
  subtypes: string[];
  /** Supertypes (e.g. legendary, snow). */
  supertypes: string[];
  /** Numeric stat filters. */
  stats: Array<{ field: "mv" | "pow" | "tou" | "loy"; op: NumericOp; value: number }>;
  /** Rarity filter. `codes` may list several ("common and uncommon" → ["c","u"]). */
  rarity: { op: RarityOp; codes: Array<"c" | "u" | "r" | "m"> } | null;
  /** Printed-year filter. */
  year: { op: NumericOp; year: number } | null;
  /** Ability keywords the card itself has (flying, lifelink…). Validated against keyword catalog. */
  keywords: string[];
  /** Format legality (standard, modern, commander…). */
  format: string | null;
  /** Set name or code the user constrained to. */
  set: string | null;
  /** Illustrator name. */
  artist: string | null;
  /** Visual subjects depicted in the art (dragon, forest…) → art: tags. */
  artSubjects: string[];
  /** Tagger function tag slugs (e.g. sacrifice-outlet, boardwipe). Validated against the vocabulary. */
  functionTags: string[];
  /** Named archetypes from the menu, with optional qualifier. */
  archetypes: Array<{ name: string; qualifier: string | null }>;
  /** Literal oracle-text phrases the card must contain → o:"…". */
  oraclePhrases: string[];
  /** Oracle-text phrases the card must NOT contain → -o:"…". */
  negatedOraclePhrases: string[];
}

/**
 * JSON Schema for Claude tool use. Only `intent` is required: Claude honours
 * `required` literally, so listing every key made Haiku emit ~300 tokens of
 * `[]` / `null` scaffolding per call (most of the latency). Omitted fields are
 * defaulted in `buildIRFromExtraction`.
 */
export const V2_EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["intent"],
  properties: {
    intent: {
      type: "string",
      enum: ["search", "similar-cards", "art-like-cards", "synergy-with-card"],
    },
    cardName: { type: ["string", "null"] },
    colors: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["mode", "op", "letters", "combine"],
      properties: {
        mode: { type: "string", enum: ["identity", "color"] },
        op: { type: "string", enum: [":", "=", ">=", "<="] },
        letters: { type: "string" },
        combine: { type: "string", enum: ["and", "or"] },
      },
    },
    typesAll: { type: "array", items: { type: "string" } },
    typesAny: { type: "array", items: { type: "string" } },
    negatedTypes: { type: "array", items: { type: "string" } },
    subtypes: { type: "array", items: { type: "string" } },
    supertypes: { type: "array", items: { type: "string" } },
    stats: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "op", "value"],
        properties: {
          field: { type: "string", enum: ["mv", "pow", "tou", "loy"] },
          op: { type: "string", enum: ["<", "<=", "=", ">=", ">"] },
          value: { type: "number" },
        },
      },
    },
    rarity: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["op", "codes"],
      properties: {
        op: { type: "string", enum: [":", "<=", ">="] },
        codes: { type: "array", items: { type: "string", enum: ["c", "u", "r", "m"] } },
      },
    },
    year: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["op", "year"],
      properties: {
        op: { type: "string", enum: ["<", "<=", "=", ">=", ">"] },
        year: { type: "number" },
      },
    },
    keywords: { type: "array", items: { type: "string" } },
    format: { type: ["string", "null"] },
    set: { type: ["string", "null"] },
    artist: { type: ["string", "null"] },
    artSubjects: { type: "array", items: { type: "string" } },
    functionTags: { type: "array", items: { type: "string" } },
    archetypes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "qualifier"],
        properties: {
          name: { type: "string" },
          qualifier: { type: ["string", "null"] },
        },
      },
    },
    oraclePhrases: { type: "array", items: { type: "string" } },
    negatedOraclePhrases: { type: "array", items: { type: "string" } },
  },
};

/**
 * OpenAI json_schema strict mode rejects optional properties: every key must be
 * listed in `required` (optionality via nullable unions only).
 */
export const V2_EXTRACTION_SCHEMA_STRICT: Record<string, unknown> = {
  ...V2_EXTRACTION_SCHEMA,
  required: Object.keys(V2_EXTRACTION_SCHEMA.properties as Record<string, unknown>),
};

export const V2_SCHEMA_NAME = "mtg_query_extraction";
