import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import {
  BLOCKRUN_MODELS,
  DEFAULT_ROUTING_CONFIG,
  type RoutingConfig,
} from "@blockrun/clawrouter";

export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";

export const VALID_TIERS: Tier[] = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];

/** 单个上游后端定义（URL / 模型 / 鉴权 / 请求参数覆盖）。 */
export type BackendConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  requestParams?: Record<string, unknown>;
  removeParams?: string[];
  inputPrice?: number;
  outputPrice?: number;
};

/** 档位到后端的 primary + fallback 链。 */
export type TierBackendConfig = {
  primary: string;
  fallback?: string[];
};

export type RouterPolicy = {
  defaultTier: Tier;
  maxFallbackAttempts: number;
  retryStatuses: number[];
};

/** router.config.json 顶层结构。 */
export type RawRouterConfig = {
  policy?: Partial<RouterPolicy>;
  routing?: {
    tiers?: Partial<Record<Tier, TierBackendConfig>>;
    scoring?: {
      reasoningKeywords?: string[];
      codeKeywords?: string[];
      simpleKeywords?: string[];
    };
    classifier?: {
      confidenceThreshold?: number;
      reasoningConfidence?: number;
    };
    overrides?: {
      largeContextTokens?: number;
      structuredOutput?: boolean;
    };
  };
  backends?: Record<string, BackendConfig>;
};

export type RouterConfigState = {
  raw: RawRouterConfig;
  routingConfig: RoutingConfig;
  modelPricing: Map<string, { inputPrice: number; outputPrice: number }>;
  configPath: string | null;
  source: "file" | "env";
};

const CONFIG_PATH = process.env.GATEWAY_CONFIG_PATH ?? process.env.ROUTER_CONFIG_PATH ?? "./router.config.json";

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && VALID_TIERS.includes(value as Tier);
}

/** 浅层递归合并，数组与标量以 patch 为准。 */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (
      value != null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing != null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** 将 JSON 中的 routing 段映射为 @blockrun/clawrouter 的 RoutingConfig。 */
function buildRoutingConfigFromRaw(routing?: RawRouterConfig["routing"]): RoutingConfig {
  const config = structuredClone(DEFAULT_ROUTING_CONFIG);
  // 网关默认置信度阈值（低于 clawrouter 包内默认值，便于本地部署）
  config.scoring.confidenceThreshold = 0.55;

  const scoring = routing?.scoring;
  if (scoring?.reasoningKeywords) config.scoring.reasoningKeywords = scoring.reasoningKeywords;
  if (scoring?.codeKeywords) config.scoring.codeKeywords = scoring.codeKeywords;
  if (scoring?.simpleKeywords) config.scoring.simpleKeywords = scoring.simpleKeywords;

  if (routing?.classifier?.confidenceThreshold != null) {
    config.scoring.confidenceThreshold = routing.classifier.confidenceThreshold;
  }

  if (routing?.overrides?.largeContextTokens != null) {
    config.overrides.maxTokensForceComplex = routing.overrides.largeContextTokens;
  }

  // 将 router.config.json 的 tier→backend 链同步到 clawrouter，使后端 ID 与自定义定价参与 route() 成本估算。
  const tiers = routing?.tiers;
  if (tiers) {
    for (const tier of VALID_TIERS) {
      const tierConfig = tiers[tier];
      if (!tierConfig?.primary) continue;
      config.tiers[tier] = {
        primary: tierConfig.primary,
        fallback: tierConfig.fallback ?? [],
      };
    }
  }

  return config;
}

/** 合并 BLOCKRUN_MODELS 默认定价与 backends 自定义定价。 */
function buildModelPricing(backends: Record<string, BackendConfig>): Map<string, { inputPrice: number; outputPrice: number }> {
  const modelPricing = new Map(
    BLOCKRUN_MODELS.map((model) => [
      model.id,
      { inputPrice: model.inputPrice, outputPrice: model.outputPrice },
    ]),
  );

  for (const [backendId, backend] of Object.entries(backends)) {
    modelPricing.set(backendId, {
      inputPrice: Number(backend.inputPrice ?? 0),
      outputPrice: Number(backend.outputPrice ?? 0),
    });
  }

  return modelPricing;
}

/** 无 router.config.json 时，从 VLLM_* 环境变量合成等价配置。 */
function buildConfigFromEnv(): RawRouterConfig {
  const defBase = (process.env.VLLM_DEFAULT_BASE ?? "").replace(/\/$/, "");
  const defModel = process.env.VLLM_DEFAULT_MODEL ?? "default";
  const defKey = process.env.VLLM_DEFAULT_API_KEY;
  const envDefaultTier = String(process.env.VLLM_DEFAULT_TIER ?? "MEDIUM").toUpperCase();

  const backends: Record<string, BackendConfig> = {};
  const tiers: Partial<Record<Tier, TierBackendConfig>> = {};

  for (const tier of VALID_TIERS) {
    const envBase = (process.env[`VLLM_${tier}_BASE`] ?? "").replace(/\/$/, "");
    const envModel = process.env[`VLLM_${tier}_MODEL`] ?? defModel;
    const envKey = process.env[`VLLM_${tier}_API_KEY`];
    const baseUrl = envBase || defBase;
    if (!baseUrl) continue;

    const backendId = `env_${tier.toLowerCase()}`;
    backends[backendId] = {
      baseUrl,
      model: envModel,
      apiKey: envKey || defKey,
    };
    tiers[tier] = { primary: backendId, fallback: [] };
  }

  return {
    policy: { defaultTier: isTier(envDefaultTier) ? envDefaultTier : "MEDIUM" },
    routing: { tiers },
    backends,
  };
}

function readConfigFile(filePath: string): RawRouterConfig {
  const fullPath = resolve(process.cwd(), filePath);
  if (!existsSync(fullPath)) {
    throw new Error(`配置文件不存在: ${fullPath}`);
  }
  return JSON.parse(readFileSync(fullPath, "utf-8")) as RawRouterConfig;
}

export function loadRouterConfig(): RouterConfigState {
  const resolvedPath = resolve(process.cwd(), CONFIG_PATH);
  let raw: RawRouterConfig;
  let source: "file" | "env";
  let configPath: string | null;

  if (existsSync(resolvedPath)) {
    raw = readConfigFile(CONFIG_PATH);
    source = "file";
    configPath = resolvedPath;
  } else {
    raw = buildConfigFromEnv();
    source = "env";
    configPath = null;
  }

  return {
    raw,
    routingConfig: buildRoutingConfigFromRaw(raw.routing),
    modelPricing: buildModelPricing(raw.backends ?? {}),
    configPath,
    source,
  };
}

let state = loadRouterConfig();

export function getRouterConfigState(): RouterConfigState {
  return state;
}

/** 热重载：重新读取配置文件或环境变量快照。 */
export function reloadRouterConfig(): RouterConfigState {
  state = loadRouterConfig();
  return state;
}

export function getPolicy(): RouterPolicy {
  const policy = state.raw.policy ?? {};
  const defaultTier = isTier(policy.defaultTier) ? policy.defaultTier : "MEDIUM";
  return {
    defaultTier,
    maxFallbackAttempts: Number(policy.maxFallbackAttempts ?? 3),
    retryStatuses: Array.isArray(policy.retryStatuses)
      ? policy.retryStatuses
      : [400, 401, 402, 403, 429, 500, 502, 503, 504],
  };
}

export function getTierBackendConfig(tier: Tier): TierBackendConfig | null {
  return state.raw.routing?.tiers?.[tier] ?? null;
}

/** 若档位在配置中有定义则保留，否则回退到 policy.defaultTier。 */
export function normalizeTier(tier: unknown): Tier {
  if (isTier(tier) && getTierBackendConfig(tier)) return tier;
  return getPolicy().defaultTier;
}

export function getBackend(id: string): BackendConfig {
  const backend = state.raw.backends?.[id];
  if (!backend) throw new Error(`配置中未找到后端: ${id}`);
  return backend;
}

/** 按 tier 解析 primary + fallback 链，受 maxFallbackAttempts 限制。 */
export function resolveBackendIdsForTier(tier: Tier): string[] {
  const { maxFallbackAttempts } = getPolicy();
  const tierConfig = getTierBackendConfig(tier);
  if (!tierConfig?.primary) {
    throw new Error(`缺少 routing.tiers.${tier}.primary 配置`);
  }
  return [tierConfig.primary, ...(tierConfig.fallback ?? [])]
    .filter(Boolean)
    .slice(0, Math.max(1, maxFallbackAttempts));
}

function deleteByPath(obj: Record<string, unknown>, dottedPath: string): void {
  const parts = String(dottedPath).split(".").filter(Boolean);
  if (!parts.length) return;
  let target: Record<string, unknown> | undefined = obj;
  for (const part of parts.slice(0, -1)) {
    if (!target || typeof target !== "object") return;
    target = target[part] as Record<string, unknown> | undefined;
  }
  if (target && typeof target === "object") {
    delete target[parts.at(-1)!];
  }
}

/** 合并后端 requestParams 并覆写 model，支持 removeParams 删除字段。 */
export function buildUpstreamBody(
  backend: BackendConfig,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const requestParams =
    backend.requestParams && typeof backend.requestParams === "object" ? backend.requestParams : {};
  const upstreamBody = deepMerge(structuredClone(body) as Record<string, unknown>, requestParams) as Record<
    string,
    unknown
  >;

  for (const paramPath of backend.removeParams ?? []) {
    deleteByPath(upstreamBody, paramPath);
  }

  return { ...upstreamBody, model: backend.model };
}

/** 优先使用后端 apiKey；SIMPLE 档可在未配置时沿用请求 Authorization。 */
export function authorizationForBackend(
  backend: BackendConfig,
  req: IncomingMessage,
  tier: Tier,
): string | undefined {
  const key = backend.apiKey?.trim();
  if (key && key !== "EMPTY") {
    return key.startsWith("Bearer ") ? key : `Bearer ${key}`;
  }
  if (tier === "SIMPLE" && req.headers.authorization) {
    return String(req.headers.authorization);
  }
  return undefined;
}
