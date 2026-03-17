export type ClauseSource =
  | "phase1:format"
  | "phase1:color"
  | "phase1:commander"
  | "phase1:type"
  | "phase1:subtype"
  | "phase1:art"
  | "phase1:artist"
  | "phase1:function"
  | "phase1:set"
  | "phase1:keyword"
  | "phase1:strategy"
  | "phase1:oracle"
  | "phase1:stat"
  | "phase1:rarity"
  | "phase1:cardname"
  | "phase1:is-flag"
  | "phase1:removal-target"
  | "phase1:direct"
  | "phase1:intent"   // clauses injected by the intent resolver (similar-cards, art-like-cards, synergy-with-card)
  | "phase2:resolver"
  | "phase3:sanitize";

export type QueryIntent =
  | "search"
  | "commander-deck"
  | "commander-creature"
  | "direct-scryfall"
  | "similar-cards"
  | "art-like-cards"
  | "synergy-with-card";

export type QueryClause = {
  value: string;
  source: ClauseSource;
};

export type ResolverCategory = "effect" | "art" | "mechanic" | "semantic";

export type UnresolvedFragment = {
  text: string;
  category: ResolverCategory;
  /** True when this fragment was preceded by "or" in the original query,
   *  meaning its resolved tags should be OR-ed with the previous fragment's tags. */
  orConnected?: boolean;
};

export type ResolvedFragment = {
  fragment: string;
  tags: string[];
  confidence: number;
  category: ResolverCategory;
  archetype?: string;
  qualifier?: string;
  /** Carried from UnresolvedFragment — if true, OR-merge with the previous fragment in assembly. */
  orConnected?: boolean;
};

export type SearchPipelineIR = {
  naturalQuery: string;
  intent: QueryIntent;
  /** Present when intent is "similar-cards" — the resolved canonical card name. */
  similarToCardName?: string;
  /** Present when intent is "art-like-cards" — the resolved canonical card name. */
  artLikeCardName?: string;
  /** Present when intent is "synergy-with-card" — the resolved canonical card name. */
  synergyWithCardName?: string;
  tokenizedQuery: string[];
  noiseTokens: string[];
  mustClauses: QueryClause[];
  shouldClauses: QueryClause[];
  mustNotClauses: QueryClause[];
  unresolvedFragments: UnresolvedFragment[];
  resolvedFragments: ResolvedFragment[];
  debug: {
    strippedTerms: string[];
    aiBatchCalls: number;
    aiSequentialCalls: number;
    invalidTagsRemoved: number;
    phase0Normalized: boolean;
  };
};

export type Phase1Result = SearchPipelineIR;

export type Phase2Result = {
  ir: SearchPipelineIR;
  batchCalls: number;
  sequentialCalls: number;
};

export type Phase3Result = {
  queryForScryfall: string;
  queryForLogs: string;
  removedInvalidTags: string[];
};

