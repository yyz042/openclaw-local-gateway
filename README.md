# OpenClaw Local Gateway

A lightweight local gateway for OpenClaw that borrows the routing core of `@blockrun/clawrouter` and keeps only what is needed for practical multi-model dispatch.

## Why it's useful

- **Focused architecture**: keeps the routing intelligence, removes payment/proxy ecosystem complexity.
- **OpenClaw-first input handling**: cleans OpenClaw metadata from user messages before both routing and upstream forwarding to avoid mismatch.
- **Actionable observability**: logs routing tier, confidence, weighted-score reasoning, and stream/tool-call outputs for postmortem analysis.
- **Safer local usage**: blocks duplicate requests in a short window to reduce accidental repeated execution.
- **Session-aware routing**: keeps tier stable across turns, upgrades when complexity rises, and escalates after repeated similar prompts.
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

## Session-level intelligent routing

After ClawRouter proposes a tier for the **last user message**, the gateway applies in-memory session rules (per HTTP request, not per message inside one request):

1. **Session identity**
   - Prefer `x-session-id` or `x-clawrouter-session-id`.
   - Otherwise derive a stable ID from the **first** user message in the request.

2. **Session pinning**
   - If the new proposed tier is not higher than the session’s stored tier, keep the session tier (`session-pinned`), except for the SIMPLE follow-up case below.

3. **Session upgrade**
   - If the proposed tier is higher than the stored tier, adopt it and update the session (`session-upgrade`).

4. **SIMPLE follow-up**
   - If the proposed tier is `SIMPLE` but the session remembers a higher tier, route this request to `SIMPLE` without downgrading the stored session tier (`simple-follow-up`).

5. **Three-strike escalation**
   - Within the same session, if the same prompt fingerprint (last user text + recent assistant tool names) appears **3 times**, bump the tier one step (`three-strike-escalation`).

Session state lives in memory and expires after `GATEWAY_SESSION_TTL_MS` (default 30 minutes). Routing still uses only the **last user message** for `route()`; multi-turn context inside a single JSON body does not change the classifier input.

**Response signals**

- JSON (dry-run): `proposed_tier`, `tier`, `route_reason`, `session_id`
- Headers: `x-route-tier`, `x-route-reason`, `x-route-session-id`, `x-route-confidence`, `x-upstream-model`
- Logs: `scoring_detail.session` and `explanations_zh` for session decisions

**Quick dry-run check**

```bash
# Terminal 1
GATEWAY_DRY_RUN=1 GATEWAY_DEDUP_WINDOW_MS=0 npm run start:env

# Terminal 2 — same session, two requests
SESSION=demo-1
BASE=http://127.0.0.1:38080/v1/chat/completions

curl -s "$BASE" -H "x-session-id: $SESSION" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Prove a distributed consensus protocol with formal step-by-step derivation."}]}'

curl -s "$BASE" -H "x-session-id: $SESSION" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Explain the first step again."}]}'
```

Expect the first call `route_reason=new-session` and the second `simple-follow-up` or `session-pinned` depending on the proposed tier.

## What it removes

- x402 payments
- wallet/auth lifecycle
- partner/provider plugin system
- durable session store / session journal (only lightweight in-memory session routing is kept)

## Request flow

1. Accept OpenAI-compatible request at `POST /v1/chat/completions`.
2. Clean OpenClaw user text (`[message_id: ...]`, timestamp wrappers).
3. Route the last user message to a proposed tier (`SIMPLE/MEDIUM/COMPLEX/REASONING`) using ClawRouter logic.
4. Apply session-level rules (pin, upgrade, SIMPLE follow-up, three-strike escalation).
5. Resolve upstream target (`VLLM_<TIER>_*` or default fallback).
6. Forward request and stream response back (SSE and tool-call chunks preserved).
7. Emit request/routing/upstream completion logs (including `route_reason` and session fields).

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
- `GATEWAY_SESSION_TTL_MS`: in-memory session routing TTL (default `1800000`, 30 minutes)
- `VLLM_SIMPLE_BASE` / `VLLM_SIMPLE_MODEL`: SIMPLE-tier target
- `VLLM_DEFAULT_BASE` / `VLLM_DEFAULT_MODEL` / `VLLM_DEFAULT_API_KEY`: fallback target/auth for non-SIMPLE tiers (unless tier-specific key/base is set)

## Endpoints

- `GET /health`
- `POST /v1/chat/completions`
