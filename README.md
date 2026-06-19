# OpenClaw Local Gateway

A lightweight local gateway for OpenClaw that borrows the routing core of `@blockrun/clawrouter` and keeps only what is needed for practical multi-model dispatch.

## Why it's useful

- **Focused architecture**: keeps the routing intelligence, removes payment/proxy ecosystem complexity.
- **OpenClaw-first input handling**: cleans OpenClaw metadata from user messages before both routing and upstream forwarding to avoid mismatch.
- **Actionable observability**: logs routing tier, confidence, weighted-score reasoning, and stream/tool-call outputs for postmortem analysis.
- **Safer local usage**: blocks duplicate requests in a short window to reduce accidental repeated execution.
- **Production-friendly fallback behavior**: tier-specific endpoint/model/api-key mapping with sensible default fallbacks.

## ClawRouter routing ideas used here

This project does not embed ClawRouter's full proxy stack. It reuses and extends the local `route()` decision model:

1. **Rule-based tiering with confidence**
   - Uses `route(prompt, systemPrompt, maxTokens, { config, modelPricing })`.
   - Consumes `tier/confidence/reasoning/method/profile` from `RoutingDecision`.

2. **Tier boundaries from weighted score**
   - Keeps the `SIMPLE -> MEDIUM -> COMPLEX -> REASONING` boundary mapping logic.
   - Preserves score-based explainability in logs (`score=...`, boundaries, score-only tier).

3. **Override-style escalation rules**
   - Mirrors ClawRouter-style override reasoning such as:
     - force `COMPLEX` on large estimated context,
     - upgrade paths for structured-output-like prompts,
     - ambiguous fallback tier when confidence is below threshold.

4. **Config-level adaptation for local deployment**
   - Overrides `scoring.confidenceThreshold` to `0.55` for this gateway profile.
   - Keeps compatibility with `DEFAULT_ROUTING_CONFIG` and its scoring/override concepts.

## What it removes

- x402 payments
- wallet/auth lifecycle
- partner/provider plugin system
- session persistence

## Request flow

1. Accept OpenAI-compatible request at `POST /v1/chat/completions`.
2. Clean OpenClaw user text (`[message_id: ...]`, timestamp wrappers).
3. Route to one tier (`SIMPLE/MEDIUM/COMPLEX/REASONING`) using ClawRouter logic.
4. Resolve upstream target (`VLLM_<TIER>_*` or default fallback).
5. Forward request and stream response back (SSE and tool-call chunks preserved).
6. Emit request/routing/upstream completion logs.

## Quick start

```bash
cd openclaw-local-gateway
npm install
cp env.example .env
npm run start:env
```

OpenClaw provider `baseUrl`:

`http://127.0.0.1:38080/v1`

## Runtime knobs (env)

- `GATEWAY_PORT`: local gateway port (default `38080`)
- `GATEWAY_DRY_RUN`: if `1/true`, return routing result without upstream calls
- `GATEWAY_DEDUP_WINDOW_MS`: duplicate-request guard window
- `VLLM_SIMPLE_BASE` / `VLLM_SIMPLE_MODEL`: SIMPLE-tier target
- `VLLM_DEFAULT_BASE` / `VLLM_DEFAULT_MODEL` / `VLLM_DEFAULT_API_KEY`: fallback target/auth for non-SIMPLE tiers (unless tier-specific key/base is set)

## Endpoints

- `GET /health`
- `POST /v1/chat/completions`
