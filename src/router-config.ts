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

/** Single upstream backend (URL, model, auth, request param overrides). */
export type BackendConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  requestParams?: Record<string, unknown>;
  removeParams?: string[];
  inputPrice?: number;
  outputPrice?: number;
};

/** Tier → primary backend plus optional fallback chain. */
export type TierBackendConfig = {
  primary: string;
  fallback?: string[];
};

export type RouterPolicy = {
  defaultTier: Tier;
  maxFallbackAttempts: number;
  retryStatuses: number[];
};

/** Top-level router.config.json shape. */
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

/** Shallow recursive merge; arrays and scalars are replaced by patch values. */
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

/** Map the routing section from JSON to @blockrun/clawrouter RoutingConfig. */
function buildRoutingConfigFromRaw(routing?: RawRouterConfig["routing"]): RoutingConfig {
  const config = structuredClone(DEFAULT_ROUTING_CONFIG);
  // Lower default confidence threshold than clawrouter (better for local deployments)
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

  // Sync tier→backend chains so backend IDs and custom pricing feed route() cost estimates.
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

/** Merge BLOCKRUN_MODELS default pricing with per-backend overrides. */
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

/** Build an equivalent config from VLLM_* env vars when router.config.json is missing. */
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
    throw new Error(`Config file not found: ${fullPath}`);
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

/** Hot reload: re-read config file or env snapshot. */
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

/** Keep tier when configured; otherwise fall back to policy.defaultTier. */
export function normalizeTier(tier: unknown): Tier {
  if (isTier(tier) && getTierBackendConfig(tier)) return tier;
  return getPolicy().defaultTier;
}

export function getBackend(id: string): BackendConfig {
  const backend = state.raw.backends?.[id];
  if (!backend) throw new Error(`Backend not found in config: ${id}`);
  return backend;
}

/** Read-only snapshot of all configured backends. */
export function getConfiguredBackends(): Record<string, BackendConfig> {
  return state.raw.backends ?? {};
}

/** Auth header for health probes (matches example-router: Bearer EMPTY when no key). */
export function authorizationHeaderForProbe(backend: BackendConfig): Record<string, string> {
  const key = backend.apiKey?.trim();
  if (key && key !== "EMPTY") {
    const auth = key.startsWith("Bearer ") ? key : `Bearer ${key}`;
    return { Authorization: auth };
  }
  return { Authorization: "Bearer EMPTY" };
}

/** OpenAI-compatible model list: each backend maps to local-router/{backendId}. */
export function listGatewayModels(): Array<{
  id: string;
  object: "model";
  owned_by: string;
  metadata: { upstream_model: string; upstream_base_url: string };
}> {
  return Object.entries(getConfiguredBackends()).map(([backendId, backend]) => ({
    id: `local-router/${backendId}`,
    object: "model",
    owned_by: "openclaw-local-gateway",
    metadata: {
      upstream_model: backend.model,
      upstream_base_url: backend.baseUrl,
    },
  }));
}

export type BackendHealthCheck = {
  backendId: string;
  ok: boolean;
  status: number;
  baseUrl: string;
  model: string;
  error?: string;
};

/** Probe each backend with GET /models to check upstream connectivity. */
export async function probeAllBackends(): Promise<BackendHealthCheck[]> {
  return Promise.all(
    Object.entries(getConfiguredBackends()).map(async ([backendId, backend]) => {
      const baseUrl = backend.baseUrl.replace(/\/$/, "");
      try {
        const response = await fetch(`${baseUrl}/models`, {
          headers: authorizationHeaderForProbe(backend),
        });
        return {
          backendId,
          ok: response.ok,
          status: response.status,
          baseUrl: backend.baseUrl,
          model: backend.model,
        };
      } catch (error) {
        return {
          backendId,
          ok: false,
          status: 0,
          baseUrl: backend.baseUrl,
          model: backend.model,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

/** Resolve primary + fallback chain for a tier, capped by maxFallbackAttempts. */
export function resolveBackendIdsForTier(tier: Tier): string[] {
  const { maxFallbackAttempts } = getPolicy();
  const tierConfig = getTierBackendConfig(tier);
  if (!tierConfig?.primary) {
    throw new Error(`Missing routing.tiers.${tier}.primary in config`);
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

/** Merge backend requestParams, override model, and apply removeParams deletions. */
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

/** Prefer backend apiKey; SIMPLE tier may reuse request Authorization when unset. */
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
