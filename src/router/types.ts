export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";

export type ScoringResult = {
  score: number;
  tier: Tier | null;
  confidence: number;
  signals: string[];
  agenticScore?: number;
  dimensions?: Array<{ name: string; score: number; signal: string | null }>;
};

export type RoutingDecision = {
  tier: Tier;
  confidence: number;
  reasoning: string;
};

export type ScoringConfig = {
  tokenCountThresholds: { simple: number; complex: number };
  codeKeywords: string[];
  reasoningKeywords: string[];
  simpleKeywords: string[];
  technicalKeywords: string[];
  creativeKeywords: string[];
  imperativeVerbs: string[];
  constraintIndicators: string[];
  outputFormatKeywords: string[];
  referenceKeywords: string[];
  negationKeywords: string[];
  domainSpecificKeywords: string[];
  agenticTaskKeywords: string[];
  dimensionWeights: Record<string, number>;
  tierBoundaries: {
    simpleMedium: number;
    mediumComplex: number;
    complexReasoning: number;
  };
  confidenceSteepness: number;
  confidenceThreshold: number;
};

export type OverridesConfig = {
  ambiguousDefaultTier: Tier;
  structuredOutputMinTier: Tier;
};

export type RoutingConfig = {
  scoring: ScoringConfig;
  overrides: OverridesConfig;
};
