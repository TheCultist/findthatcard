export type ClauseSource =
  | "phase1:format"
  | "phase1:color"
  | "phase1:commander"
  | "phase1:type"
  | "phase1:set"
  | "phase1:keyword"
  | "phase1:strategy"
  | "phase1:oracle"
  | "phase1:direct"
  | "phase2:resolver"
  | "phase3:sanitize";

export type QueryIntent =
  | "search"
  | "commander-deck"
  | "commander-creature"
  | "direct-scryfall";

export type QueryClause = {
  value: string;
  source: ClauseSource;
};

export type ResolverCategory = "effect" | "art" | "mechanic" | "semantic";

export type UnresolvedFragment = {
  text: string;
  category: ResolverCategory;
};

export type ResolvedFragment = {
  fragment: string;
  tags: string[];
  confidence: number;
  category: ResolverCategory;
};

export type SearchPipelineIR = {
  naturalQuery: string;
  intent: QueryIntent;
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

