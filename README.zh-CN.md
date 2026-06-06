# OpenClaw Local Gateway

这是一个面向 OpenClaw 的轻量本地网关：复用 `@blockrun/clawrouter` 的路由核心，只保留其多模型分流所需的关键能力。

## 项目优势

- **架构聚焦**：保留路由智能，移除支付/代理生态复杂度。
- **OpenClaw 友好输入处理**：在路由与转发前清洗 OpenClaw 元信息，避免“路由输入”和“真实上游输入”不一致。
- **可运维可解释**：完整记录 tier、confidence、weighted score 推理依据，以及流式内容和 tool-call 片段。
- **本地使用优化**：短时间窗口内拦截重复请求，减少误触发重复执行。
- **会话级智能路由**：多轮对话固定档位、复杂任务升档、相似请求三次升档，简单追问可走轻量模型且不降级会话记忆。
- **长上下文治理**：超长消息列表截断（保留 system/developer + 最近对话）、大请求压缩（去重重复消息、压缩 JSON 文本）。
- **回退策略完善**：支持按 tier 的 endpoint/model/api-key 映射，并具备默认回退机制。

## ClawRouter routing 思想

本项目没有引入 ClawRouter 全量代理栈，而是复用了并扩展本地 `route()` 决策模型：

1. **基于规则的分档 + 置信度**
   - 使用 `route(prompt, systemPrompt, maxTokens, { config, modelPricing })`。
   - 消费 `RoutingDecision` 中的 `tier/confidence/reasoning/method/profile` 信息。

2. **基于加权分的 tier 边界**
   - 保留 `SIMPLE -> MEDIUM -> COMPLEX -> REASONING` 的边界映射逻辑。
   - 在日志中保留可解释性（`score=...`、边界值、仅分数轴对应档位）。

3. **覆盖式升档规则**
   - 延续 ClawRouter 风格的覆盖逻辑，例如：
     - 上下文估算过大时强制升到 `COMPLEX`；
     - structured output 相关线索触发升档路径；
     - 置信度低于阈值时走 ambiguous 默认档位。

4. **面向本地部署的配置适配**
   - 在网关里将 `scoring.confidenceThreshold` 覆盖为 `0.55`。
   - 保持与 `DEFAULT_ROUTING_CONFIG` 及其 scoring/override 思路兼容。

## 会话级智能路由

ClawRouter 对**最后一条 user 消息**给出 `proposed_tier` 后，网关再按**内存会话**（每个 HTTP 请求一轮，单次请求内的多条 message 不拆轮）做决策：

1. **会话 ID**：优先 `x-session-id` / `x-clawrouter-session-id`；否则用请求中**首条** user 消息内容哈希。
2. **档位固定（session-pinned）**：新分档不高于会话已记住的档位时，沿用会话档位（`proposed_tier` 为 `SIMPLE` 时走第 4 条）。
3. **会话升档（session-upgrade）**：新分档更高时升档并更新会话记忆。
4. **SIMPLE 追问（simple-follow-up）**：本次路由为 `SIMPLE` 但会话记忆更高档时，本次走 SIMPLE，**不降低**会话记忆档位。
5. **三次升档（three-strike-escalation）**：同会话内相同 prompt 指纹（最后 user 文本 + 最近 assistant 的 tool 名）累计 3 次，再升一档。

状态仅驻留内存，超过 `GATEWAY_SESSION_TTL_MS`（默认 30 分钟）过期。`route()` 仍只看**最后一条 user**，不会把整段 `messages` 历史拼进分档器。

**可观测字段**：dry-run JSON 的 `proposed_tier` / `tier` / `route_reason` / `session_id`；响应头 `x-route-tier`、`x-route-reason`、`x-route-session-id`；日志 `scoring_detail.session` 与 `explanations_zh`。

**dry-run 快速验证**（建议 `GATEWAY_DRY_RUN=1`、`GATEWAY_DEDUP_WINDOW_MS=0`）：

```bash
SESSION=demo-1
BASE=http://127.0.0.1:38080/v1/chat/completions

curl -s "$BASE" -H "x-session-id: $SESSION" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"请用形式化方法证明分布式共识算法的安全性，并给出完整推导。"}]}'

curl -s "$BASE" -H "x-session-id: $SESSION" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"刚才第一步再解释一下"}]}'
```

第二轮常见 `route_reason=simple-follow-up`（`proposed_tier=SIMPLE`、会话仍记住更高档）。

## 长上下文治理

转发上游前，网关会对 `messages` 做两步治理（逻辑与 `example-router` 一致）：

1. **截断**：超过 `GATEWAY_MAX_MESSAGES`（默认 60）时，保留全部 `system` / `developer`，对话区只保留最近若干条。
2. **压缩**（按需）：整包体积超过 `GATEWAY_COMPRESSION_THRESHOLD_KB`（默认 180 KB），或消息总字符数 > 5000 时：
   - 跳过重复的长消息（同 role + 内容哈希，且单条 > 200 字）；
   - 对 string 型 JSON 文本做 minify。

治理在 OpenClaw 文本清洗之后、路由分档之前执行，确保路由与上游输入一致。

**可观测字段**：响应头 `x-route-messages-truncated`、`x-route-messages-compressed`；日志 `[gateway] context_governance …`；dry-run JSON 的 `context_governance`。

## 明确移除的部分

- x402 支付
- 钱包/鉴权生命周期
- 合作方与 provider 插件体系
- 持久化会话库 / session journal（仅保留轻量内存会话路由）

## 请求处理流程

1. 通过 `POST /v1/chat/completions` 接收 OpenAI 兼容请求。
2. 清洗 OpenClaw 用户文本（如 `[message_id: ...]`、时间戳包装）。
3. 长上下文治理：截断超长消息列表、按需压缩大请求。
4. 对最后一条 user 消息用 ClawRouter 得出 `proposed_tier`。
5. 应用会话级规则（固定、升档、SIMPLE 追问、三次升档）。
6. 解析上游目标（优先 `VLLM_<TIER>_*`，否则使用默认回退）。
7. 转发并透传响应（保留 SSE 与 tool-call 数据）。
8. 输出请求、路由、上游完成日志（含 `route_reason` 与会话字段）。

## 快速启动

```bash
cd openclaw-local-gateway
npm install
cp env.example .env
npm run start:env
```

OpenClaw provider 的 `baseUrl` 设置为：

`http://127.0.0.1:38080/v1`

## 运行时环境变量

- `GATEWAY_PORT`：网关端口（默认 `38080`）
- `GATEWAY_DRY_RUN`：`1/true` 时仅返回路由结果，不请求上游
- `GATEWAY_DEDUP_WINDOW_MS`：重复请求拦截时间窗口
- `GATEWAY_SESSION_TTL_MS`：内存会话路由 TTL（默认 `1800000`，30 分钟）
- `GATEWAY_MAX_MESSAGES`：消息列表上限；保留全部 system/developer，对话区只保留最近 N 条（默认 `60`）
- `GATEWAY_COMPRESSION_THRESHOLD_KB`：请求体超过此大小（KB）时触发消息压缩（默认 `180`）
- `VLLM_SIMPLE_BASE` / `VLLM_SIMPLE_MODEL`：SIMPLE 档目标
- `VLLM_DEFAULT_BASE` / `VLLM_DEFAULT_MODEL` / `VLLM_DEFAULT_API_KEY`：非 SIMPLE 档默认回退目标与鉴权（若未配置档位专用项）

## 接口

- `GET /health`
- `POST /v1/chat/completions`
