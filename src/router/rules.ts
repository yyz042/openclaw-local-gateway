import type { RoutingConfig, ScoringResult, ScoringConfig, Tier } from "./types.js";

type DimensionScore = { name: string; score: number; signal: string | null };

// 按估算 token 数量给长度打分：短偏简单，长偏复杂。
function scoreTokenCount(
  estimatedTokens: number,
  thresholds: { simple: number; complex: number },
): DimensionScore {
  if (estimatedTokens < thresholds.simple) {
    return { name: "tokenCount", score: -1.0, signal: `short (${estimatedTokens} tokens)` };
  }
  if (estimatedTokens > thresholds.complex) {
    return { name: "tokenCount", score: 1.0, signal: `long (${estimatedTokens} tokens)` };
  }
  return { name: "tokenCount", score: 0, signal: null };
}

function scoreKeywordMatch(
  text: string,
  keywords: string[],
  name: string,
  signalLabel: string,
  thresholds: { low: number; high: number },
  scores: { none: number; low: number; high: number },
): DimensionScore {
  // 统一用包含匹配，所有语种关键词都走同一套逻辑。
  const matches = keywords.filter((kw) => text.includes(kw.toLowerCase()));
  if (matches.length >= thresholds.high) {
    return {
      name,
      score: scores.high,
      signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})`,
    };
  }
  if (matches.length >= thresholds.low) {
    return {
      name,
      score: scores.low,
      signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})`,
    };
  }
  return { name, score: scores.none, signal: null };
}

function scoreMultiStep(text: string): DimensionScore {
  // 出现分步描述时，通常任务复杂度会更高。
  const patterns = [/first.*then/i, /step \d/i, /\d\.\s/];
  const hits = patterns.filter((p) => p.test(text));
  if (hits.length > 0) {
    return { name: "multiStepPatterns", score: 0.5, signal: "multi-step" };
  }
  return { name: "multiStepPatterns", score: 0, signal: null };
}

function scoreQuestionComplexity(prompt: string): DimensionScore {
  // 问号越多，通常问题拆分越细，这里做一个轻量信号。
  const count = (prompt.match(/\?/g) || []).length;
  if (count > 3) {
    return { name: "questionComplexity", score: 0.5, signal: `${count} questions` };
  }
  return { name: "questionComplexity", score: 0, signal: null };
}

function scoreAgenticTask(
  text: string,
  keywords: string[],
): { dimensionScore: DimensionScore; agenticScore: number } {
  let matchCount = 0;
  const signals: string[] = [];

  for (const keyword of keywords) {
    if (text.includes(keyword.toLowerCase())) {
      matchCount++;
      if (signals.length < 3) signals.push(keyword);
    }
  }

  // 按命中数量分段，避免单次命中把分数抬得太高。
  if (matchCount >= 4) {
    return {
      dimensionScore: { name: "agenticTask", score: 1.0, signal: `agentic (${signals.join(", ")})` },
      agenticScore: 1.0,
    };
  }
  if (matchCount >= 3) {
    return {
      dimensionScore: { name: "agenticTask", score: 0.6, signal: `agentic (${signals.join(", ")})` },
      agenticScore: 0.6,
    };
  }
  if (matchCount >= 1) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 0.2,
        signal: `agentic-light (${signals.join(", ")})`,
      },
      agenticScore: 0.2,
    };
  }

  return {
    dimensionScore: { name: "agenticTask", score: 0, signal: null },
    agenticScore: 0,
  };
}

export function classifyByRules(
  prompt: string,
  systemPrompt: string | undefined,
  estimatedTokens: number,
  scoring: ScoringConfig,
): ScoringResult {
  // 只看用户输入做评分，避免 system prompt 干扰结果。
  const userText = prompt.toLowerCase();
  void systemPrompt;

  const dimensions: DimensionScore[] = [
    scoreTokenCount(estimatedTokens, scoring.tokenCountThresholds),
    scoreKeywordMatch(
      userText,
      scoring.codeKeywords,
      "codePresence",
      "code",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 1.0 },
    ),
    scoreKeywordMatch(
      userText,
      scoring.reasoningKeywords,
      "reasoningMarkers",
      "reasoning",
      { low: 1, high: 2 },
      { none: 0, low: 0.7, high: 1.0 },
    ),
    scoreKeywordMatch(
      userText,
      scoring.technicalKeywords,
      "technicalTerms",
      "technical",
      { low: 2, high: 4 },
      { none: 0, low: 0.5, high: 1.0 },
    ),
    scoreKeywordMatch(
      userText,
      scoring.creativeKeywords,
      "creativeMarkers",
      "creative",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 0.7 },
    ),
    scoreKeywordMatch(
      userText,
      scoring.simpleKeywords,
      "simpleIndicators",
      "simple",
      { low: 1, high: 2 },
      { none: 0, low: -1.0, high: -1.0 },
    ),
    scoreMultiStep(userText),
    scoreQuestionComplexity(prompt),
    scoreKeywordMatch(
      userText,
      scoring.imperativeVerbs,
      "imperativeVerbs",
      "imperative",
      { low: 1, high: 2 },
      { none: 0, low: 0.3, high: 0.5 },
    ),
    scoreKeywordMatch(
      userText,
      scoring.constraintIndicators,
      "constraintCount",
      "constraints",
      { low: 1, high: 3 },
      { none: 0, low: 0.3, high: 0.7 },
    ),
    scoreKeywordMatch(
      userText,
      scoring.outputFormatKeywords,
      "outputFormat",
      "format",
      { low: 1, high: 2 },
      { none: 0, low: 0.4, high: 0.7 },
    ),
    scoreKeywordMatch(
      userText,
      scoring.referenceKeywords,
      "referenceComplexity",
      "references",
      { low: 1, high: 2 },
      { none: 0, low: 0.3, high: 0.5 },
    ),
    scoreKeywordMatch(
      userText,
      scoring.negationKeywords,
      "negationComplexity",
      "negation",
      { low: 2, high: 3 },
      { none: 0, low: 0.3, high: 0.5 },
    ),
    scoreKeywordMatch(
      userText,
      scoring.domainSpecificKeywords,
      "domainSpecificity",
      "domain-specific",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 0.8 },
    ),
  ];

  const agenticResult = scoreAgenticTask(userText, scoring.agenticTaskKeywords);
  dimensions.push(agenticResult.dimensionScore);
  const agenticScore = agenticResult.agenticScore;

  const signals = dimensions.filter((d) => d.signal !== null).map((d) => d.signal!);
  const weights = scoring.dimensionWeights;
  let weightedScore = 0;
  // 各维度分数乘权重后累加，得到最终总分。
  for (const d of dimensions) {
    const w = weights[d.name] ?? 0;
    weightedScore += d.score * w;
  }

  const reasoningHits = scoring.reasoningKeywords.filter((k) => userText.includes(k.toLowerCase()));
  if (reasoningHits.length >= 2) {
    // 推理关键词命中明显时，直接判到 REASONING，并提高最低置信度。
    const confidence = calibrateConfidence(Math.max(weightedScore, 0.3), scoring.confidenceSteepness);
    return {
      score: weightedScore,
      tier: "REASONING",
      confidence: Math.max(confidence, 0.85),
      signals,
      agenticScore,
      dimensions,
    };
  }

  let tier: Tier;
  let distanceFromBoundary: number;
  const { simpleMedium, mediumComplex, complexReasoning } = scoring.tierBoundaries;
  // 记录与分档边界的距离，用来衡量当前档位稳不稳。
  if (weightedScore < simpleMedium) {
    tier = "SIMPLE";
    distanceFromBoundary = simpleMedium - weightedScore;
  } else if (weightedScore < mediumComplex) {
    tier = "MEDIUM";
    distanceFromBoundary = Math.min(weightedScore - simpleMedium, mediumComplex - weightedScore);
  } else if (weightedScore < complexReasoning) {
    tier = "COMPLEX";
    distanceFromBoundary = Math.min(
      weightedScore - mediumComplex,
      complexReasoning - weightedScore,
    );
  } else {
    tier = "REASONING";
    distanceFromBoundary = weightedScore - complexReasoning;
  }

  const confidence = calibrateConfidence(distanceFromBoundary, scoring.confidenceSteepness);
  if (confidence < scoring.confidenceThreshold) {
    // 置信度偏低时先返回空档位，再由上层做兜底。
    return { score: weightedScore, tier: null, confidence, signals, agenticScore, dimensions };
  }
  return { score: weightedScore, tier, confidence, signals, agenticScore, dimensions };
}

export function routeByRules(
  prompt: string,
  systemPrompt: string | undefined,
  maxOutputTokens: number,
  hasTools: boolean,
  config: RoutingConfig,
) {
  // 用字符长度近似 token 数，成本低且对分层够用。
  const estimatedTokens = Math.ceil(`${systemPrompt ?? ""} ${prompt}`.length / 4);
  const result = classifyByRules(prompt, systemPrompt, estimatedTokens, config.scoring);

  let tier: Tier;
  let confidence: number;
  let reasoning = `score=${result.score.toFixed(2)} | ${result.signals.join(", ")}`;

  if (result.tier === null) {
    tier = config.overrides.ambiguousDefaultTier;
    confidence = 0.5;
    reasoning += ` | ambiguous -> default: ${tier}`;
  } else {
    tier = result.tier;
    confidence = result.confidence;
  }

  if (systemPrompt && /json|structured|schema/i.test(systemPrompt)) {
    // 如果要求结构化输出，必要时抬高最低档位。
    const rank: Record<Tier, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
    const minTier = config.overrides.structuredOutputMinTier;
    if (rank[tier] < rank[minTier]) {
      tier = minTier;
      reasoning += ` | upgraded to ${minTier} (structured output)`;
    }
  }

  // 工具调用通常至少需要 MEDIUM 档的稳定性。
  if (hasTools && tier === "SIMPLE") {
    tier = "MEDIUM";
    reasoning += " | upgraded to MEDIUM (tools)";
  }

  return { tier, confidence, reasoning, estimatedTokens, rule: result };
}

function calibrateConfidence(distance: number, steepness: number): number {
  // 用 Sigmoid 做映射：离边界越远，置信度越高。
  return 1 / (1 + Math.exp(-steepness * distance));
}
