import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { route, type RoutingConfig, type RoutingDecision } from "@blockrun/clawrouter";
import { governMessages, type ContextGovernanceMeta } from "./context-governance.js";
import {
  clearAllSessionJournals,
  deleteSessionJournal,
  extractAssistantTextFromJson,
  injectSessionJournal,
  recordSessionJournal,
} from "./session-journal.js";
import {
  authorizationForBackend,
  buildUpstreamBody,
  getBackend,
  getPolicy,
  getRouterConfigState,
  listGatewayModels,
  normalizeTier,
  probeAllBackends,
  reloadRouterConfig,
  resolveBackendIdsForTier,
  type Tier,
  VALID_TIERS,
} from "./router-config.js";

const DEDUP_WINDOW_MS = Number(process.env.GATEWAY_DEDUP_WINDOW_MS ?? "5000");
const SESSION_TTL_MS = Number(process.env.GATEWAY_SESSION_TTL_MS ?? String(30 * 60 * 1000));
const REQUEST_LOG_FILE = resolve(process.env.GATEWAY_REQUEST_LOG_FILE ?? "./logs/gateway-requests.json");
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

/** In-memory session routing: tier pinning, complexity upgrades, three-strike escalation. */
const sessions = new Map<string, SessionState>();

const SCORING_LOG_PROMPT_MAX = 480;

function truncateForLog(text: string, maxChars: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}…(${t.length} chars total)`;
}

function formatReasoningForLog(reasoning: string): string {
  return reasoning.length > 4000 ? `${reasoning.slice(0, 4000)}…(truncated)` : reasoning;
}

/** Parse weighted score from the reasoning prefix (matches clawrouter rule routing). */
function parseWeightedScoreFromReasoning(reasoning: string): number | undefined {
  const m = reasoning.match(/^score=(-?\d+(?:\.\d+)?)/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Match reasoning keywords against the lowercased user prompt (same as classifyByRules). */
function collectReasoningKeywordMatches(prompt: string, keywords: readonly string[]): string[] {
  const userText = prompt.toLowerCase();
  return keywords.filter((kw) => userText.includes(kw.toLowerCase()));
}

/** Map tier from weighted score and tierBoundaries only (no override rules such as ≥2 reasoning keywords). */
function tierFromWeightedScoreOnly(score: number, routingConfig: RoutingConfig): Tier {
  const { simpleMedium, mediumComplex, complexReasoning } = routingConfig.scoring.tierBoundaries;
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
  routingConfig: RoutingConfig;
}): Record<string, unknown> {
  const {
    decision,
    proposedTier,
    routedTier,
    usedDefaultTier,
    prompt,
    systemPrompt,
    maxOutputTokens,
    sessionId,
    routeReason,
    routingConfig,
  } = params;
  const reasoning = decision.reasoning;
  const weightedScore = parseWeightedScoreFromReasoning(reasoning);
  const boundaries = routingConfig.scoring.tierBoundaries;
  const overrides = routingConfig.overrides;
  const reasoningKw = collectReasoningKeywordMatches(prompt, routingConfig.scoring.reasoningKeywords);
  const estimatedTokens = estimateRouterInputTokens(prompt, systemPrompt);
  const forcedComplexByTokens = estimatedTokens > overrides.maxTokensForceComplex;
  const ambiguousBranch = reasoning.includes("ambiguous ->");
  const structuredUpgrade = reasoning.includes("upgraded to") && reasoning.includes("structured output");
  const hasStructuredSystemHint = /json|structured|schema/i.test(systemPrompt);
  const scoreOnlyTier =
    weightedScore !== undefined ? tierFromWeightedScoreOnly(weightedScore, routingConfig) : undefined;
  const reasoningKeywordTierBoost = reasoningKw.length >= 2;

  const explanations: string[] = [];
  if (usedDefaultTier) {
    explanations.push(
      `Gateway normalized router tier "${String(decision.tier ?? "undefined")}" to policy.defaultTier (effective: ${proposedTier}).`,
    );
  }
  if (forcedComplexByTokens) {
    explanations.push(
      `Estimated input ~${estimatedTokens} tokens (exceeds maxTokensForceComplex=${overrides.maxTokensForceComplex}); forced COMPLEX per @blockrun/clawrouter.`,
    );
  }
  if (!forcedComplexByTokens && reasoningKeywordTierBoost && decision.tier === "REASONING") {
    explanations.push(
      `Matched ${reasoningKw.length} reasoning keywords (≥2 forces REASONING), overriding score-only tier; score below complexReasoning(${boundaries.complexReasoning}) is expected.`,
    );
  }
  if (ambiguousBranch) {
    explanations.push(
      `Rule confidence below confidenceThreshold=${routingConfig.scoring.confidenceThreshold}; tier treated as ambiguous, using ambiguousDefaultTier=${overrides.ambiguousDefaultTier}.`,
    );
  }
  if (weightedScore !== undefined && scoreOnlyTier !== undefined) {
    explanations.push(
      `Weighted score ${weightedScore.toFixed(3)} vs simpleMedium=${boundaries.simpleMedium}, mediumComplex=${boundaries.mediumComplex}, complexReasoning=${boundaries.complexReasoning} → score-only tier ${scoreOnlyTier}; clawrouter final tier=${decision.tier}.`,
    );
    if (decision.tier !== scoreOnlyTier && !reasoningKeywordTierBoost && !ambiguousBranch && !forcedComplexByTokens) {
      explanations.push("If tier differs from score-only tier, check the reasoning suffix (e.g. structured output upgrade).");
    }
  }
  if (structuredUpgrade) {
    explanations.push("Structured output upgrade triggered (reasoning contains upgraded … structured output).");
  } else if (hasStructuredSystemHint) {
    explanations.push(
      `System prompt hints at json/structured/schema; no upgrade means current tier is already ≥ structuredOutputMinTier=${overrides.structuredOutputMinTier}.`,
    );
  }
  if (routeReason === "session-pinned") {
    explanations.push(`Session ${sessionId} pinned at ${routedTier}; proposed ${proposedTier} did not exceed pinned tier.`);
  } else if (routeReason === "session-upgrade") {
    explanations.push(`Session ${sessionId} upgraded due to higher complexity (${proposedTier} > pinned tier) → ${routedTier}.`);
  } else if (routeReason === "simple-follow-up") {
    explanations.push(`Session ${sessionId} simple follow-up uses SIMPLE tier; session memory tier stays ${routedTier}.`);
  } else if (routeReason === "three-strike-escalation") {
    explanations.push(`Session ${sessionId} saw ≥3 similar requests; escalated to ${routedTier}.`);
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
    explanations,
    reasoning_full: formatReasoningForLog(reasoning),
  };
}
// Short-lived request fingerprints to block duplicate submissions.
const recentRequests = new Map<string, number>();
let requestLogWriteQueue: Promise<void> = Promise.resolve();

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

/** Derive session ID from headers or a hash of the first user message. */
function getSessionId(req: IncomingMessage, messages: ChatMessage[]): string | null {
  const explicit = getRequestHeader(req, "x-session-id") ?? getRequestHeader(req, "x-clawrouter-session-id");
  if (explicit?.trim()) return explicit.trim();

  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return null;
  return hashText(cleanOpenClawUserText(normalizeContentToText(firstUser.content)), 16);
}

/** Fingerprint prompt + recent assistant tool_calls for three-strike tier escalation. */
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
    if (session.updatedAt < cutoff) {
      sessions.delete(sessionId);
      deleteSessionJournal(sessionId);
    }
  }
}

setInterval(cleanupSessions, Math.min(5 * 60 * 1000, SESSION_TTL_MS)).unref();

/**
 * Session-aware routing:
 * - Pin tier per session to avoid model churn across turns;
 * - Upgrade when a later request is more complex;
 * - SIMPLE follow-ups may use the light tier without lowering session memory;
 * - Escalate one tier after 3 similar requests in the same session.
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
    const escalatedTier = normalizeTier(nextTier(selectedTier));
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
    selectedBackend?: string;
    hasTools?: boolean;
    contextGovernance?: ContextGovernanceMeta;
    sessionJournalInjected?: boolean;
  },
): void {
  res.setHeader("x-route-tier", params.routedTier);
  res.setHeader("x-route-confidence", params.routedConfidence.toFixed(3));
  res.setHeader("x-route-method", String(params.decision.method ?? ""));
  res.setHeader("x-route-reason", params.routeReason);
  res.setHeader("x-upstream-model", params.targetModel);
  if (params.hasTools !== undefined) res.setHeader("x-route-has-tools", params.hasTools ? "true" : "false");
  if (params.decision.model) res.setHeader("x-route-clawrouter-model", String(params.decision.model));
  if (params.selectedBackend) res.setHeader("x-route-selected-backend", params.selectedBackend);
  if (params.sessionId) res.setHeader("x-route-session-id", params.sessionId);
  if (params.contextGovernance?.wasTruncated) res.setHeader("x-route-messages-truncated", "true");
  if (params.contextGovernance?.wasCompressed) res.setHeader("x-route-messages-compressed", "true");
  if (params.sessionJournalInjected) res.setHeader("x-route-session-journal-injected", "true");
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
  // Strip OpenClaw metadata wrappers; keep the user's original question.
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
    // Keep text parts only; other content types are excluded from routing text.
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
  // Apply the same cleaning before upstream forwarding so routing input matches upstream input.
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
  // Match router input: prefer max_completion_tokens, then fall back to max_tokens.
  const mt = body.max_completion_tokens ?? body.max_tokens;
  if (typeof mt === "number" && mt > 0) return mt;
  return 1024;
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && VALID_TIERS.includes(value as Tier);
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

  const rawMessages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  const sanitizedMessages = sanitizeMessagesForUpstream(rawMessages);
  const { messages: governedMessages, meta: contextGovernance } = governMessages(sanitizedMessages);
  if (Array.isArray(body.messages)) body.messages = governedMessages;

  const messages = governedMessages as ChatMessage[];
  const { prompt, systemPrompt } = extractPromptAndSystem(messages);
  if (contextGovernance.wasTruncated) {
    console.log(
      `[gateway] context_governance truncated ${contextGovernance.originalCount} -> ${contextGovernance.truncatedCount}`,
    );
  }
  if (contextGovernance.wasCompressed) {
    console.log(`[gateway] context_governance compressed chars_saved=${contextGovernance.charsSaved}`);
  }
  const maxTokens = maxOutputTokens(body);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const { routingConfig, modelPricing } = getRouterConfigState();
  const decision = route(prompt, systemPrompt || undefined, maxTokens, {
    config: routingConfig,
    modelPricing,
    hasTools,
  });
  const proposedTier = normalizeTier(decision.tier);
  const usedDefaultTier = !isTier(decision.tier) || proposedTier !== decision.tier;
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
    routingConfig,
  });
  console.log("[gateway] scoring_detail", JSON.stringify(scoringDetail, null, 2));

  const dryRun = isGatewayDryRun();
  const backendIds = resolveBackendIdsForTier(routedTier);
  const primaryBackend = dryRun ? null : getBackend(backendIds[0]!);
  const target = dryRun
    ? { baseUrl: "(unset)", model: "(unset)", backendId: backendIds[0] ?? "(unset)" }
    : {
        baseUrl: primaryBackend!.baseUrl,
        model: primaryBackend!.model,
        backendId: backendIds[0]!,
      };
  if (dryRun) {
    // Dry-run returns routing metadata only; no upstream call.
    setRouteResponseHeaders(res, {
      routedTier,
      routedConfidence,
      decision,
      routeReason,
      sessionId,
      targetModel: target.model,
      hasTools,
      contextGovernance,
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
        has_tools: hasTools,
        reasoning: decision.reasoning,
        upstream: target,
        backend_ids: backendIds,
        context_governance: contextGovernance,
      }),
    );
    return;
  }

  const stream = body.stream === true;
  console.log(
    `[gateway] caller=${caller} prompt=${JSON.stringify(promptLog)} tier=${routedTier} route_reason=${routeReason} session=${sessionId ?? "none"} backends=${backendIds.join(">")} stream=${stream}`,
  );

  const journalInjection = injectSessionJournal(body, sessionId, prompt);
  const forwardBody = journalInjection.body;
  if (journalInjection.injected) {
    console.log(`[gateway] session_journal injected session=${sessionId}`);
  }

  const { retryStatuses } = getPolicy();
  let selectedBackendId = backendIds[0]!;
  let selectedBackend = getBackend(selectedBackendId);
  let upstream = await callUpstreamWithFallback({
    req,
    tier: routedTier,
    backendIds,
    body: forwardBody,
    retryStatuses,
    onFallback: (backendId, status) => {
      console.warn(`[gateway] fallback backend=${backendId} status=${status} -> try next`);
    },
    onSelected: (backendId, backend) => {
      selectedBackendId = backendId;
      selectedBackend = backend;
    },
  });

  if (stream && upstream.ok && upstream.body) {
    setRouteResponseHeaders(res, {
      routedTier,
      routedConfidence,
      decision,
      routeReason,
      sessionId,
      targetModel: selectedBackend.model,
      selectedBackend: selectedBackendId,
      hasTools,
      contextGovernance,
      sessionJournalInjected: journalInjection.injected,
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
    // Aggregate streamed content for a complete upstream_done log.
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
    if (upstream.ok) {
      recordSessionJournal(sessionId, selectedBackend.model, fullContent);
    }
    console.log(
      `[gateway] upstream_done caller=${caller} tier=${routedTier} backend=${selectedBackendId} model=${selectedBackend.model} status=${upstream.status} content=${JSON.stringify(fullContent || "(empty)")} tool_calls=${JSON.stringify(toolCalls)}`,
    );
    return;
  }

  const text = await upstream.text();
  if (upstream.ok) {
    recordSessionJournal(sessionId, selectedBackend.model, extractAssistantTextFromJson(text));
  }
  setRouteResponseHeaders(res, {
    routedTier,
    routedConfidence,
    decision,
    routeReason,
    sessionId,
    targetModel: selectedBackend.model,
    selectedBackend: selectedBackendId,
    hasTools,
    contextGovernance,
    sessionJournalInjected: journalInjection.injected,
  });
  res.writeHead(upstream.status, { "Content-Type": "application/json" });
  res.end(text);
  console.log(
    `[gateway] upstream_done caller=${caller} tier=${routedTier} backend=${selectedBackendId} model=${selectedBackend.model} status=${upstream.status} body=${JSON.stringify(text)}`,
  );
}

/** Try upstream backends in fallback order; switch on retryable status codes. */
async function callUpstreamWithFallback(params: {
  req: IncomingMessage;
  tier: Tier;
  backendIds: string[];
  body: Record<string, unknown>;
  retryStatuses: number[];
  onFallback: (backendId: string, status: number) => void;
  onSelected: (backendId: string, backend: ReturnType<typeof getBackend>) => void;
}): Promise<Response> {
  const { req, tier, backendIds, body, retryStatuses, onFallback, onSelected } = params;
  let lastResponse: Response | undefined;

  for (const backendId of backendIds) {
    const backend = getBackend(backendId);
    onSelected(backendId, backend);
    const auth = authorizationForBackend(backend, req, tier);
    const upstreamBody = buildUpstreamBody(backend, body);
    const targetUrl = `${backend.baseUrl.replace(/\/$/, "")}/chat/completions`;

    lastResponse = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify(upstreamBody),
    });

    if (lastResponse.ok || !retryStatuses.includes(lastResponse.status)) {
      return lastResponse;
    }
    onFallback(backendId, lastResponse.status);
  }

  if (!lastResponse) {
    throw new Error("No upstream backend response available");
  }
  return lastResponse;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url?.startsWith("/health")) {
      const configState = getRouterConfigState();
      const backends = await probeAllBackends();
      const allBackendsOk = backends.length > 0 && backends.every((check) => check.ok);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: allBackendsOk,
          status: allBackendsOk ? "ok" : "degraded",
          service: "openclaw-local-gateway",
          configPath: configState.configPath,
          configSource: configState.source,
          backends,
        }),
      );
      return;
    }
    if (req.method === "GET" && (req.url === "/v1/models" || req.url?.startsWith("/v1/models?"))) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: listGatewayModels() }));
      return;
    }
    if (req.method === "POST" && req.url === "/reload") {
      const configState = reloadRouterConfig();
      sessions.clear();
      clearAllSessionJournals();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          configPath: configState.configPath,
          configSource: configState.source,
        }),
      );
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
  const configState = getRouterConfigState();
  const configLabel =
    configState.source === "file"
      ? `router.config.json (${configState.configPath})`
      : "VLLM_* env vars (router.config.json not found)";
  console.log(`[openclaw-local-gateway] listening http://127.0.0.1:${port}/v1/chat/completions`);
  console.log(`[openclaw-local-gateway] observability: GET /health, GET /v1/models, POST /reload`);
  console.log(`[openclaw-local-gateway] config source: ${configLabel}`);
});
