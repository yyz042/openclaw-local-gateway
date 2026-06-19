# OpenClaw Local Gateway

[中文](README.zh-CN.md)

A lightweight local gateway for OpenClaw: routes requests to different models by complexity, with session-level routing, long-context handling, and lightweight session memory.

Requires **Node.js >= 20**.

## Why it's useful

- **Multi-model routing**: picks SIMPLE / MEDIUM / COMPLEX / REASONING tiers and maps them to backends; tiering uses weighted scoring and override rules from `@blockrun/clawrouter` `route()`.
- **Session-level routing**: pins tier across turns, upgrades on complexity, escalates after three similar requests; simple follow-ups can use a lighter model without downgrading session memory.
- **Long-context handling**: truncates oversized message lists and compresses large requests so routing and upstream inputs stay aligned.
- **Lightweight session memory**: injects a session journal for recap/summary prompts and extracts key actions from assistant replies.
- **OpenClaw input handling**: cleans OpenClaw metadata before routing and forwarding to avoid input mismatch.
- **Routing logs**: logs tier, confidence, weighted-score reasoning, and stream/tool-call outputs.
- **JSON config + hot reload**: `router.config.json` holds tier→backend mapping, keywords, and thresholds; `POST /reload` without restart.
- **Fallback backends**: primary + fallback chains with automatic retry on configurable HTTP status codes.
- **Duplicate guard**: blocks duplicate requests in a short window to reduce accidental repeated execution.

## Quick start

```bash
cd openclaw-local-gateway
npm install
cp router.config.example.json router.config.json   # fill backends.apiKey
cp env.example .env                                # required for npm run start:env
npm run start:env
```

Without a `.env` file, use `npm run start` instead (built-in defaults apply).

OpenClaw provider `baseUrl`:

`http://127.0.0.1:38080/v1`

## Features

### Multi-model routing

Calls `route()` on the last user message to derive a `proposed_tier` via weighted scoring and override rules, then maps it to the backend defined in `router.config.json`. Tier boundaries follow `SIMPLE → MEDIUM → COMPLEX → REASONING`; logs include `score`, boundary values, and escalation reasons.

### Session-level routing

Applies in-memory session rules on top of `proposed_tier`. Session ID comes from `x-session-id` or `x-clawrouter-session-id` when present; otherwise a hash of the first user message is used.

| Rule | Description |
|------|-------------|
| session-pinned | Keep session tier when the new tier is not higher |
| session-upgrade | Adopt and store a higher proposed tier |
| simple-follow-up | Route to SIMPLE without downgrading stored session tier |
| three-strike-escalation | Bump tier one step after the same request fingerprint appears 3 times (prompt text plus last assistant tool-call names) |

State lives in memory and expires after `GATEWAY_SESSION_TTL_MS` (default 30 minutes). Observability: `x-route-tier`, `x-route-reason`, `x-route-session-id`; dry-run JSON includes `proposed_tier`, `tier`, `route_reason`.

### Long-context handling

Two steps before forwarding upstream:

1. **Truncate**: when messages exceed `GATEWAY_MAX_MESSAGES` (default 60), keep all system/developer messages and only the most recent conversation turns.
2. **Compress** (on demand): when the body exceeds `GATEWAY_COMPRESSION_THRESHOLD_KB` (default 180 KB) or total characters > 5000, skip duplicate long messages and minify JSON text.

Observability: `x-route-messages-truncated`, `x-route-messages-compressed`.

### Lightweight session memory

An in-memory session journal (same TTL as sessions, not persisted):

- **Record**: after a successful upstream response, extract key actions from assistant text (English patterns such as `created`, `fixed`, `implemented`); capped at 20 entries per session.
- **Inject**: when the last user message matches recap/summary/progress triggers, prepend the latest 8 journal entries into the system/developer message.

Observability: `x-route-session-journal-injected`.

### JSON-driven config

```bash
cp router.config.example.json router.config.json
# edit backends / tiers / scoring, then hot-reload:
curl -X POST http://127.0.0.1:38080/reload
```

`router.config.json` controls tier→backend mapping, scoring keywords and thresholds, backend URL/model/API keys, and fallback chains with `retryStatuses`.

## Request flow

1. Accept request at `POST /v1/chat/completions`
2. Clean OpenClaw user text
3. Govern long context (truncate / compress)
4. Route the last user message (`route()` via ClawRouter logic)
5. Apply session-level rules (pin, upgrade, simple follow-up, three-strike escalation)
6. Inject session journal when needed
7. Resolve upstream target and forward (SSE and tool-call chunks preserved)
8. Record key actions and emit routing/upstream logs

## Runtime knobs (env)

`.env` tunes gateway behavior only; model upstreams live in `router.config.json` `backends`.

| Variable | Description | Default |
|----------|-------------|---------|
| `GATEWAY_PORT` | Local gateway port | `38080` |
| `GATEWAY_DRY_RUN` | If `1/true`, return routing result without upstream calls | off (`0`) |
| `GATEWAY_DEDUP_WINDOW_MS` | Duplicate-request guard window (ms) | `5000` |
| `GATEWAY_SESSION_TTL_MS` | In-memory session TTL | `1800000` (30 min) |
| `GATEWAY_MAX_MESSAGES` | Message list cap | `60` |
| `GATEWAY_COMPRESSION_THRESHOLD_KB` | Compress when body exceeds this size (KB) | `180` |
| `GATEWAY_REQUEST_LOG_FILE` | Request log path | `./logs/gateway-requests.json` |
| `GATEWAY_CONFIG_PATH` / `ROUTER_CONFIG_PATH` | Config file path | `./router.config.json` |

## Endpoints

- `GET /health`: check gateway and backend connectivity; return config source and health status
- `GET /v1/models`: list configured backend models (OpenAI-compatible)
- `POST /reload`: hot-reload config; clear in-memory sessions and journals
- `POST /v1/chat/completions`: accept chat requests, route by tier, and forward upstream
