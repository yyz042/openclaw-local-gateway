# OpenClaw Local Gateway

Standalone local gateway extracted from ClawRouter routing ideas, dedicated to OpenClaw.

## What it keeps

- Local rule-based tier scoring (`SIMPLE/MEDIUM/COMPLEX/REASONING`)
- OpenClaw message cleanup (`[Mon ... GMT+X]` and `[message_id: ...]`)
- Tier -> endpoint/model routing
- Duplicate-request blocking in a short time window
- Request/response logs (caller, prompt, tier, target model, full streamed content/tool calls)

## What it removes

- x402 payments
- wallet/auth lifecycle
- partner services, provider plugin integration, session persistence

## Quick start

```bash
cd openclaw-local-gateway
npm install
cp env.example .env
npm run start:env
```

OpenClaw provider `baseUrl` should point to:

`http://127.0.0.1:38080/v1`

## Endpoints

- `GET /health`
- `POST /v1/chat/completions`
