import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BLOCKRUN_MODELS,
  DEFAULT_ROUTING_CONFIG,
  route,
  type RoutingConfig,
  type RoutingDecision,
} from "@blockrun/clawrouter";

/** 覆盖 @blockrun/clawrouter 默认的 scoring.confidenceThreshold（包内约 0.7）。 */
const GATEWAY_ROUTING_CONFIG: RoutingConfig = {
  ...DEFAULT_ROUTING_CONFIG,
  scoring: {
    ...DEFAULT_ROUTING_CONFIG.scoring,
    confidenceThreshold:0.55,
  },
};

type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";

const DEDUP_WINDOW_MS = Number(process.env.GATEWAY_DEDUP_WINDOW_MS ?? "5000");
const SESSION_TTL_MS = Number(process.env.GATEWAY_SESSION_TTL_MS ?? String(30 * 60 * 1000));
const REQUEST_LOG_FILE = resolve(process.env.GATEWAY_REQUEST_LOG_FILE ?? "./logs/gateway-requests.json");
const VALID_TIERS: Tier[] = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
const TIER_ORDER: Tier[] = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];

type SessionRouteReason =
  | "no-session"
  | "new-session"
  | "session-pinned"
  | "session-upgrade"
  | "simple-follow-up"
  | "three-strike-escalation";

type SessionState = {
  tier: Tier;
  requestHashes: Map<string, number>;
  createdAt: number;
  updatedAt: number;
};

/** 会话级路由状态：固定档位、复杂升档、三次相似请求升档。 */
const sessions = new Map<string, SessionState>();

const SCORING_LOG_PROMPT_MAX = 480;

function truncateForLog(text: string, maxChars: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}…(共 ${t.length} 字)`;
}

function formatReasoningForLog(reasoning: string): string {
  return reasoning.length > 4000 ? `${reasoning.slice(0, 4000)}…(已截断)` : reasoning;
}

/** 与 clawrouter 规则路由一致：从 reasoning 前缀解析加权分。 */
function parseWeightedScoreFromReasoning(reasoning: string): number | undefined {
  const m = reasoning.match(/^score=(-?\d+(?:\.\d+)?)/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** 与 classifyByRules 一致：仅对用户 prompt 小写文本匹配推理关键词。 */
function collectReasoningKeywordMatches(prompt: string, keywords: readonly string[]): string[] {
  const userText = prompt.toLowerCase();
  return keywords.filter((kw) => userText.includes(kw.toLowerCase()));
}

/** 仅按加权分与 tierBoundaries 映射档位（不含「≥2 推理词」等覆盖规则）。 */
function tierFromWeightedScoreOnly(score: number): Tier {
  const { simpleMedium, mediumComplex, complexReasoning } = GATEWAY_ROUTING_CONFIG.scoring.tierBoundaries;
  if (score < simpleMedium) return "SIMPLE";
  if (score < mediumComplex) return "MEDIUM";
  if (score < complexReasoning) return "COMPLEX";
  return "REASONING";
}

function estimateRouterInputTokens(prompt: string, systemPrompt: string): number {
  const fullText = `${systemPrompt ?? ""} ${prompt}`;
  return Math.ceil(fullText.length / 4);
}

function buildScoringDetailLog(params: {
  caller: string;
  promptPreview: string;
  prompt: string;
  systemPrompt: string;
  maxOutputTokens: number;
  decision: RoutingDecision;
  proposedTier: Tier;
  routedTier: Tier;
  usedDefaultTier: boolean;
  sessionId: string | null;
  routeReason: SessionRouteReason;
}): Record<string, unknown> {
  const { decision, proposedTier, routedTier, usedDefaultTier, prompt, systemPrompt, maxOutputTokens, sessionId, routeReason } =
    params;
  const reasoning = decision.reasoning;
  const weightedScore = parseWeightedScoreFromReasoning(reasoning);
  const boundaries = GATEWAY_ROUTING_CONFIG.scoring.tierBoundaries;
  const overrides = GATEWAY_ROUTING_CONFIG.overrides;
  const reasoningKw = collectReasoningKeywordMatches(prompt, GATEWAY_ROUTING_CONFIG.scoring.reasoningKeywords);
  const estimatedTokens = estimateRouterInputTokens(prompt, systemPrompt);
  const forcedComplexByTokens = estimatedTokens > overrides.maxTokensForceComplex;
  const ambiguousBranch = reasoning.includes("ambiguous ->");
  const structuredUpgrade = reasoning.includes("upgraded to") && reasoning.includes("structured output");
  const hasStructuredSystemHint = /json|structured|schema/i.test(systemPrompt);
  const scoreOnlyTier = weightedScore !== undefined ? tierFromWeightedScoreOnly(weightedScore) : undefined;
  const reasoningKeywordTierBoost = reasoningKw.length >= 2;

  const explanations: string[] = [];
  if (usedDefaultTier) {
    explanations.push(
      `网关将路由层返回的档位「${String(decision.tier ?? "undefined")}」视为无效，已回退为环境变量 VLLM_DEFAULT_TIER（当前生效：${routedTier}）。`,
    );
  }
  if (forcedComplexByTokens) {
    explanations.push(
      `估算输入约 ${estimatedTokens} tokens（超过 maxTokensForceComplex=${overrides.maxTokensForceComplex}），与 @blockrun/clawrouter 一致：强制 COMPLEX。`,
    );
  }
  if (!forcedComplexByTokens && reasoningKeywordTierBoost && decision.tier === "REASONING") {
    explanations.push(
      `命中 ${reasoningKw.length} 个推理类关键词（≥2 即强制 REASONING），可覆盖仅凭分数轴得到的档位；若加权分仍低于 complexReasoning(${boundaries.complexReasoning})，属于预期行为。`,
    );
  }
  if (ambiguousBranch) {
    explanations.push(
      `规则置信度低于 confidenceThreshold=${GATEWAY_ROUTING_CONFIG.scoring.confidenceThreshold}，档位视为模糊，采用 ambiguousDefaultTier=${overrides.ambiguousDefaultTier}。`,
    );
  }
  if (weightedScore !== undefined && scoreOnlyTier !== undefined) {
    explanations.push(
      `加权分 ${weightedScore.toFixed(3)} 与阈值 simpleMedium=${boundaries.simpleMedium}、mediumComplex=${boundaries.mediumComplex}、complexReasoning=${boundaries.complexReasoning} 对比 → 纯分数轴为 ${scoreOnlyTier}；clawrouter 最终 tier=${decision.tier}。`,
    );
    if (decision.tier !== scoreOnlyTier && !reasoningKeywordTierBoost && !ambiguousBranch && !forcedComplexByTokens) {
      explanations.push("若档位与分数轴不一致，请核对 reasoning 后缀（例如 structured output 升档）。");
    }
  }
  if (structuredUpgrade) {
    explanations.push("已触发 structured output 升档（reasoning 中含 upgraded … structured output）。");
  } else if (hasStructuredSystemHint) {
    explanations.push(
      `系统提示含 json/structured/schema 线索；未出现升档说明当前 tier 已不低于 structuredOutputMinTier=${overrides.structuredOutputMinTier}。`,
    );
  }
  if (routeReason === "session-pinned") {
    explanations.push(`会话 ${sessionId} 已固定档位 ${routedTier}，本次路由分档 ${proposedTier} 未超过已固定档位，沿用会话档位。`);
  } else if (routeReason === "session-upgrade") {
    explanations.push(`会话 ${sessionId} 检测到更高复杂度（${proposedTier} > 已固定档位），升档至 ${routedTier}。`);
  } else if (routeReason === "simple-follow-up") {
    explanations.push(`会话 ${sessionId} 的简单追问走 SIMPLE 档，但会话记忆档位保持 ${routedTier}。`);
  } else if (routeReason === "three-strike-escalation") {
    explanations.push(`会话 ${sessionId} 内相似请求累计 ≥3 次，升档至 ${routedTier}。`);
  }

  return {
    caller: params.caller,
    prompt_preview: params.promptPreview,
    estimated_input_tokens: estimatedTokens,
    max_output_tokens: maxOutputTokens,
    tier_boundaries: boundaries,
    weighted_score: weightedScore ?? null,
    tier_from_weighted_score_only: scoreOnlyTier ?? null,
    reasoning_keyword_hits: reasoningKw.length,
    reasoning_keywords_matched: reasoningKw.slice(0, 30),
    session: {
      session_id: sessionId,
      route_reason: routeReason,
      proposed_tier: proposedTier,
    },
    routing: {
      raw_tier: decision.tier,
      proposed_tier: proposedTier,
      final_tier: routedTier,
      gateway_normalized_tier: usedDefaultTier,
      confidence: decision.confidence,
      method: decision.method,
      profile: decision.profile ?? null,
      model: decision.model,
      agentic_score: decision.agenticScore ?? null,
      cost_estimate: decision.costEstimate,
      baseline_cost: decision.baselineCost,
      savings: decision.savings,
    },
    flags: {
      forced_complex_large_context: forcedComplexByTokens,
      reasoning_keywords_force_reasoning: reasoningKeywordTierBoost,
      ambiguous_low_confidence: ambiguousBranch,
      structured_output_upgrade: structuredUpgrade,
      system_has_structured_hint: hasStructuredSystemHint,
    },
    explanations_zh: explanations,
    reasoning_full: formatReasoningForLog(reasoning),
  };
}
// 只保留短时间内的请求指纹，用来拦截重复请求。
const recentRequests = new Map<string, number>();
let requestLogWriteQueue: Promise<void> = Promise.resolve();
const modelPricing = new Map(
  BLOCKRUN_MODELS.map((model) => [
    model.id,
    { inputPrice: model.inputPrice, outputPrice: model.outputPrice },
  ]),
);

type ChatMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string } }>;
};

function hashText(text: string, length = 12): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

function getRequestHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function getTierRank(tier: Tier): number {
  const idx = TIER_ORDER.indexOf(tier);
  return idx >= 0 ? idx : TIER_ORDER.indexOf("MEDIUM");
}

function nextTier(tier: Tier): Tier {
  const currentRank = getTierRank(tier);
  return TIER_ORDER[Math.min(TIER_ORDER.length - 1, currentRank + 1)] ?? tier;
}

/** 从请求头或首条用户消息推导会话 ID。 */
function getSessionId(req: IncomingMessage, messages: ChatMessage[]): string | null {
  const explicit = getRequestHeader(req, "x-session-id") ?? getRequestHeader(req, "x-clawrouter-session-id");
  if (explicit?.trim()) return explicit.trim();

  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return null;
  return hashText(cleanOpenClawUserText(normalizeContentToText(firstUser.content)), 16);
}

/** 对 prompt + 最近 assistant tool_calls 做指纹，用于三次相似请求升档。 */
function hashRequestContent(prompt: string, body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const toolNames = Array.isArray(lastAssistant?.tool_calls)
    ? lastAssistant.tool_calls
        .map((tc) => tc.function?.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0)
        .sort()
        .join(",")
    : "";
  return hashText(`${prompt.replace(/\s+/g, " ").trim().slice(0, 500)}|tools:${toolNames}`, 12);
}

function cleanupSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, session] of sessions.entries()) {
    if (session.updatedAt < cutoff) sessions.delete(sessionId);
  }
}

setInterval(cleanupSessions, Math.min(5 * 60 * 1000, SESSION_TTL_MS)).unref();

/**
 * 会话级智能路由：
 * - 同会话固定档位（pinning），避免多轮对话频繁换模型；
 * - 后续请求更复杂时升档；
 * - SIMPLE 追问可走轻量档但不降低会话记忆档位；
 * - 同会话内相似请求累计 3 次则再升一档。
 */
function applySessionRouting(
  sessionId: string | null,
  proposedTier: Tier,
  prompt: string,
  body: Record<string, unknown>,
): { tier: Tier; routeReason: SessionRouteReason } {
  if (!sessionId) {
    return { tier: proposedTier, routeReason: "no-session" };
  }

  const now = Date.now();
  const existing = sessions.get(sessionId);
  let selectedTier = proposedTier;
  let storedTier = proposedTier;
  let routeReason: SessionRouteReason = "new-session";

  if (existing) {
    const proposedRank = getTierRank(proposedTier);
    const pinnedRank = getTierRank(existing.tier);

    if (proposedRank > pinnedRank) {
      selectedTier = proposedTier;
      storedTier = proposedTier;
      routeReason = "session-upgrade";
    } else if (proposedTier === "SIMPLE") {
      selectedTier = proposedTier;
      storedTier = existing.tier;
      routeReason = "simple-follow-up";
    } else {
      selectedTier = existing.tier;
      storedTier = existing.tier;
      routeReason = "session-pinned";
    }
  }

  const session: SessionState = existing ?? {
    tier: selectedTier,
    requestHashes: new Map(),
    createdAt: now,
    updatedAt: now,
  };

  const requestHash = hashRequestContent(prompt, body);
  const hashCount = (session.requestHashes.get(requestHash) ?? 0) + 1;
  session.requestHashes.set(requestHash, hashCount);

  if (session.requestHashes.size > 20) {
    const oldest = session.requestHashes.keys().next().value;
    if (oldest !== undefined) session.requestHashes.delete(oldest);
  }

  if (hashCount >= 3) {
    const escalatedTier = nextTier(selectedTier);
    if (getTierRank(escalatedTier) > getTierRank(selectedTier)) {
      selectedTier = escalatedTier;
      storedTier = escalatedTier;
      routeReason = "three-strike-escalation";
      session.requestHashes.set(requestHash, 0);
    }
  }

  session.tier = storedTier;
  session.updatedAt = now;
  sessions.set(sessionId, session);

  return { tier: selectedTier, routeReason };
}

function setRouteResponseHeaders(
  res: ServerResponse,
  params: {
    routedTier: Tier;
    routedConfidence: number;
    decision: RoutingDecision;
    routeReason: SessionRouteReason;
    sessionId: string | null;
    targetModel: string;
  },
): void {
  res.setHeader("x-route-tier", params.routedTier);
  res.setHeader("x-route-confidence", params.routedConfidence.toFixed(3));
  res.setHeader("x-route-method", String(params.decision.method ?? ""));
  res.setHeader("x-route-reason", params.routeReason);
  res.setHeader("x-upstream-model", params.targetModel);
  if (params.sessionId) res.setHeader("x-route-session-id", params.sessionId);
}

function isGatewayDryRun(): boolean {
  return process.env.GATEWAY_DRY_RUN === "1" || process.env.GATEWAY_DRY_RUN === "true";
}

function inferCaller(req: IncomingMessage): string {
  const ua = String(req.headers["user-agent"] ?? "").toLowerCase();
  const referer = String(req.headers.referer ?? "").toLowerCase();
  const client = String(req.headers["x-client-name"] ?? "").toLowerCase();
  if (ua.includes("openclaw") || referer.includes("openclaw") || client.includes("openclaw")) {
    return "openclaw";
  }
  return ua || "unknown-client";
}

function hashRequest(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

function isDuplicateWithinWindow(requestHash: string): boolean {
  const now = Date.now();
  for (const [k, ts] of recentRequests) if (now - ts > DEDUP_WINDOW_MS) recentRequests.delete(k);
  const lastSeen = recentRequests.get(requestHash);
  if (lastSeen !== undefined && now - lastSeen <= DEDUP_WINDOW_MS) return true;
  recentRequests.set(requestHash, now);
  return false;
}

function cleanOpenClawUserText(text: string): string {
  // 去掉 OpenClaw 附带的元信息，尽量保留用户原始问题。
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^\[message_id:\s*[^\]]+\]$/i.test(line))
    .map((line) => {
      const m = line.match(/^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d{1,2}\]\s*(.*)$/);
      return m ? m[1] ?? "" : line;
    })
    .join("\n")
    .trim();
}

function normalizeContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return (content as Array<{ type?: string; text?: string }>)
    // 只取文本块，其他类型内容不参与路由文本拼接。
    .filter((b) => {
      if (typeof b?.text !== "string" || b.text.length === 0) return false;
      const t = String(b.type ?? "").toLowerCase();
      return t === "" || t === "text" || t === "input_text" || t === "output_text";
    })
    .map((b) => b.text ?? "")
    .join(" ");
}

function extractPromptAndSystem(messages: ChatMessage[]) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = cleanOpenClawUserText(normalizeContentToText(lastUser?.content));
  const systemPrompt = messages
    .filter((m) => m.role === "system")
    .map((m) => normalizeContentToText(m.content))
    .filter((text) => text.length > 0)
    .join("\n\n");
  return { prompt, systemPrompt };
}

function sanitizeMessagesForUpstream(messages: ChatMessage[]): ChatMessage[] {
  // 转发给上游前也做同样清洗，避免路由输入和实际输入不一致。
  return messages.map((m) => {
    if (m.role !== "user") return m;
    if (typeof m.content === "string") return { ...m, content: cleanOpenClawUserText(m.content) };
    if (!Array.isArray(m.content)) return m;
    return {
      ...m,
      content: (m.content as Array<{ type?: string; text?: string }>).map((part) =>
        typeof part?.text === "string" ? { ...part, text: cleanOpenClawUserText(part.text) } : part,
      ),
    };
  });
}

function maxOutputTokens(body: Record<string, unknown>): number {
  // 保持与 router 输入字段一致：优先 max_completion_tokens，再回退 max_tokens。
  const mt = body.max_completion_tokens ?? body.max_tokens;
  if (typeof mt === "number" && mt > 0) return mt;
  return 1024;
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && VALID_TIERS.includes(value as Tier);
}

function defaultTier(): Tier {
  const envTier = String(process.env.VLLM_DEFAULT_TIER ?? "MEDIUM").toUpperCase();
  return isTier(envTier) ? envTier : "MEDIUM";
}

function tierTarget(tier: Tier): { baseUrl: string; model: string } {
  // 先读当前档位配置，没配再回退到默认配置。
  const defBase = (process.env.VLLM_DEFAULT_BASE ?? "").replace(/\/$/, "");
  const defModel = process.env.VLLM_DEFAULT_MODEL ?? "default";
  const envBase = (process.env[`VLLM_${tier}_BASE`] ?? "").replace(/\/$/, "");
  const envModel = process.env[`VLLM_${tier}_MODEL`] ?? defModel;
  const baseUrl = envBase || defBase;
  if (!baseUrl) throw new Error(`No base for ${tier}; set VLLM_${tier}_BASE or VLLM_DEFAULT_BASE.`);
  return { baseUrl, model: envModel };
}

function authorizationForTier(tier: Tier, req: IncomingMessage): string | undefined {
  // 非 SIMPLE 档可回退默认密钥；SIMPLE 优先沿用请求头凭据。
  const tierKey = process.env[`VLLM_${tier}_API_KEY`]?.trim();
  if (tierKey) return tierKey.startsWith("Bearer ") ? tierKey : `Bearer ${tierKey}`;
  if (tier !== "SIMPLE") {
    const defKey = process.env.VLLM_DEFAULT_API_KEY?.trim();
    if (defKey) return defKey.startsWith("Bearer ") ? defKey : `Bearer ${defKey}`;
  }
  return req.headers.authorization ? String(req.headers.authorization) : undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function tryParseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

function queueRequestLogWrite(req: IncomingMessage, rawBody: string): void {
  const requestSnapshot = {
    timestamp: new Date().toISOString(),
    method: req.method ?? "",
    url: req.url ?? "",
    httpVersion: req.httpVersion,
    remoteAddress: req.socket.remoteAddress ?? "",
    headers: req.headers,
    rawBody,
    parsedBody: tryParseJson(rawBody),
  };
  const serialized = `${JSON.stringify(requestSnapshot)}\n`;

  requestLogWriteQueue = requestLogWriteQueue
    .then(async () => {
      await mkdir(dirname(REQUEST_LOG_FILE), { recursive: true });
      await appendFile(REQUEST_LOG_FILE, serialized, "utf8");
    })
    .catch((error) => {
      console.error("[gateway] request_log_write_failed", error);
    });
}

async function handleChat(req: IncomingMessage, res: ServerResponse, rawBody: string): Promise<void> {
  const hash = hashRequest(rawBody);
  const caller = inferCaller(req);
  if (isDuplicateWithinWindow(hash)) {
    console.warn(`[gateway] duplicate_blocked caller=${caller} hash=${hash.slice(0, 12)}`);
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Duplicate request blocked", type: "duplicate" } }));
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
    return;
  }

  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  const { prompt, systemPrompt } = extractPromptAndSystem(messages);
  const maxTokens = maxOutputTokens(body);
  const decision = route(prompt, systemPrompt || undefined, maxTokens, {
    config: GATEWAY_ROUTING_CONFIG,
    modelPricing,
  });
  const proposedTier = isTier(decision.tier) ? decision.tier : defaultTier();
  const usedDefaultTier = !isTier(decision.tier);
  const sessionId = getSessionId(req, messages);
  const sessionRoute = applySessionRouting(sessionId, proposedTier, prompt, body);
  const routedTier = sessionRoute.tier;
  const routeReason = sessionRoute.routeReason;
  const routedConfidence = typeof decision.confidence === "number" ? decision.confidence : 0.5;
  const reasoningOneLine = formatReasoningForLog(decision.reasoning).replace(/\s+/g, " ").trim();

  const promptLog = prompt.replace(/\s+/g, " ").trim();
  console.log(
    `[gateway] scoring caller=${caller} prompt=${JSON.stringify(promptLog)} raw_tier=${decision.tier ?? "AMBIGUOUS"} proposed_tier=${proposedTier} final_tier=${routedTier} route_reason=${routeReason} session=${sessionId ?? "none"} confidence=${routedConfidence.toFixed(3)} reason=${JSON.stringify(reasoningOneLine)}`,
  );
  const scoringDetail = buildScoringDetailLog({
    caller,
    promptPreview: truncateForLog(promptLog, SCORING_LOG_PROMPT_MAX),
    prompt,
    systemPrompt,
    maxOutputTokens: maxTokens,
    decision,
    proposedTier,
    routedTier,
    usedDefaultTier,
    sessionId,
    routeReason,
  });
  console.log("[gateway] scoring_detail", JSON.stringify(scoringDetail, null, 2));

  const dryRun = isGatewayDryRun();
  const target = dryRun ? { baseUrl: "(unset)", model: "(unset)" } : tierTarget(routedTier);
  if (dryRun) {
    // dry-run 只返回路由结果，不访问上游服务。
    setRouteResponseHeaders(res, {
      routedTier,
      routedConfidence,
      decision,
      routeReason,
      sessionId,
      targetModel: target.model,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "chat.completion",
        dry_run: true,
        tier: routedTier,
        proposed_tier: proposedTier,
        route_reason: routeReason,
        session_id: sessionId,
        confidence: routedConfidence,
        reasoning: decision.reasoning,
        upstream: target,
      }),
    );
    return;
  }

  const stream = body.stream === true;
  console.log(
    `[gateway] caller=${caller} prompt=${JSON.stringify(promptLog)} tier=${routedTier} route_reason=${routeReason} session=${sessionId ?? "none"} target=${target.model} base=${target.baseUrl} stream=${stream}`,
  );

  const forwardBody = {
    ...body,
    ...(Array.isArray(body.messages) ? { messages: sanitizeMessagesForUpstream(messages) } : {}),
    model: target.model,
  };
  const auth = authorizationForTier(routedTier, req);
  const upstream = await fetch(`${target.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(forwardBody),
  });

  if (stream && upstream.ok && upstream.body) {
    setRouteResponseHeaders(res, {
      routedTier,
      routedConfidence,
      decision,
      routeReason,
      sessionId,
      targetModel: target.model,
    });
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let fullContent = "";
    // 聚合流式内容，结束时可以打完整日志。
    const toolCalls: Array<{ id?: string; name?: string; arguments?: string }> = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunkText = decoder.decode(value, { stream: true });
      sseBuffer += chunkText;
      let lineEnd = sseBuffer.indexOf("\n");
      while (lineEnd !== -1) {
        const line = sseBuffer.slice(0, lineEnd).trim();
        sseBuffer = sseBuffer.slice(lineEnd + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload !== "[DONE]") {
            try {
              const parsed = JSON.parse(payload) as {
                choices?: Array<{
                  delta?: {
                    content?: string;
                    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
                  };
                }>;
              };
              const delta = parsed.choices?.[0]?.delta;
              if (typeof delta?.content === "string") fullContent += delta.content;
              if (Array.isArray(delta?.tool_calls)) {
                for (const t of delta.tool_calls) {
                  toolCalls.push({
                    id: t.id,
                    name: t.function?.name,
                    arguments: t.function?.arguments,
                  });
                }
              }
            } catch {}
          }
        }
        lineEnd = sseBuffer.indexOf("\n");
      }
      res.write(Buffer.from(value));
    }
    res.end();
    console.log(
      `[gateway] upstream_done caller=${caller} tier=${routedTier} model=${target.model} status=${upstream.status} content=${JSON.stringify(fullContent || "(empty)")} tool_calls=${JSON.stringify(toolCalls)}`,
    );
    return;
  }

  const text = await upstream.text();
  setRouteResponseHeaders(res, {
    routedTier,
    routedConfidence,
    decision,
    routeReason,
    sessionId,
    targetModel: target.model,
  });
  res.writeHead(upstream.status, { "Content-Type": "application/json" });
  res.end(text);
  console.log(
    `[gateway] upstream_done caller=${caller} tier=${routedTier} model=${target.model} status=${upstream.status} body=${JSON.stringify(text)}`,
  );
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url?.startsWith("/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "openclaw-local-gateway" }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const raw = await readBody(req);
      queueRequestLogWrite(req, raw);
      await handleChat(req, res, raw);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found" } }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: e instanceof Error ? e.message : String(e) } }));
  }
});

const port = Number(process.env.GATEWAY_PORT ?? "38080");
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[openclaw-local-gateway] Port ${port} already in use.`);
  } else {
    console.error("[openclaw-local-gateway] server error", err);
  }
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`[openclaw-local-gateway] listening http://127.0.0.1:${port}/v1/chat/completions`);
});
