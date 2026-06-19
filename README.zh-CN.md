# OpenClaw Local Gateway

[English](README.md)

面向 OpenClaw 的轻量本地网关：按请求复杂度分流到不同模型，并提供会话级路由、长上下文处理与轻量会话记忆。

需要 **Node.js >= 20**。

## 项目优势

- **多模型分流**：按复杂度选择 SIMPLE / MEDIUM / COMPLEX / REASONING 档位并映射到不同后端；分档沿用 `@blockrun/clawrouter` 中 `route()` 的加权评分与规则升档。
- **会话级路由**：多轮固定档位、复杂任务升档、相似请求三次升档；简单追问可走轻量模型且不降级会话记忆。
- **长上下文处理**：超长消息截断、大请求压缩，保证路由与上游输入一致。
- **轻量会话记忆**：识别总结/回顾类 prompt 注入 session journal，从 assistant 回复提取关键动作。
- **OpenClaw 友好**：路由前清洗 OpenClaw 元信息，避免分档输入与转发输入不一致。
- **路由日志**：记录 tier、confidence、weighted score 推理依据及流式/tool-call 输出。
- **JSON 配置 + 热重载**：`router.config.json` 统一管理 tier→backend、关键词与阈值；`POST /reload` 无需重启。
- **主备回退**：primary + fallback 链，上游失败时按 `retryStatuses` 自动切换后端。
- **本地防误触**：短时间窗口拦截重复请求，减少误触发重复执行。

## 快速启动

```bash
cd openclaw-local-gateway
npm install
cp router.config.example.json router.config.json   # 填写 backends.apiKey
cp env.example .env                                # npm run start:env 需要此文件
npm run start:env
```

不建 `.env` 时可直接 `npm run start`（使用代码内默认值）。

OpenClaw provider 的 `baseUrl` 设置为：

`http://127.0.0.1:38080/v1`

## 特色功能

### 多模型分流

对最后一条 user 消息调用 `route()`，按加权评分与覆盖规则得出 `proposed_tier`，再映射到 `router.config.json` 中对应的后端模型。档位边界为 `SIMPLE → MEDIUM → COMPLEX → REASONING`，日志中保留 `score`、边界值与升档原因。

### 会话级路由

在 `proposed_tier` 基础上做二次决策。会话 ID 优先取请求头 `x-session-id` / `x-clawrouter-session-id`；若无请求头，则用首条 user 消息的哈希值。

| 规则 | 说明 |
|------|------|
| session-pinned | 新分档不高于会话档位时沿用会话档位 |
| session-upgrade | 新分档更高时升档并更新会话 |
| simple-follow-up | 本次 proposed 为 SIMPLE 时走轻量模型，不降级已存会话档位 |
| three-strike-escalation | 相同请求指纹累计 3 次再升一档（含 prompt 文本与上一条 assistant 的 tool-call 名称） |

状态驻留内存，超过 `GATEWAY_SESSION_TTL_MS`（默认 30 分钟）过期。可观测：`x-route-tier`、`x-route-reason`、`x-route-session-id`；dry-run JSON 含 `proposed_tier`、`tier`、`route_reason`。

### 长上下文处理

转发上游前对 `messages` 做两步处理：

1. **截断**：超过 `GATEWAY_MAX_MESSAGES`（默认 60）时保留全部 system/developer，对话区只保留最近若干条。
2. **压缩**（按需）：请求体超过 `GATEWAY_COMPRESSION_THRESHOLD_KB`（默认 180 KB）或总字符数 > 5000 时，跳过重复长消息并 minify JSON 文本。

可观测：`x-route-messages-truncated`、`x-route-messages-compressed`。

### 轻量会话记忆

内存维护 session journal（与会话 TTL 同生命周期，不持久化）：

- **记录**：上游成功返回后从 assistant 文本提取关键动作（目前仅匹配英文动词，如 `created`、`fixed`、`implemented`），每会话最多 20 条。
- **注入**：最后一条 user 命中「总结/回顾/进展」类关键词时，将最近 8 条 journal 注入 system/developer 消息。

可观测：`x-route-session-journal-injected`。

### JSON 配置驱动

```bash
cp router.config.example.json router.config.json
# 编辑 backends / tiers / scoring 后热重载：
curl -X POST http://127.0.0.1:38080/reload
```

`router.config.json` 控制 tier→backend 映射、分档关键词与阈值、后端 URL/模型/API Key，以及 fallback 链与 `retryStatuses`。

## 请求处理流程

1. 接收 `POST /v1/chat/completions` 请求
2. 清洗 OpenClaw 用户文本
3. 长上下文处理（截断 / 压缩）
4. 对最后一条 user 消息分档（ClawRouter `route()`）
5. 应用会话级规则（固定、升档、SIMPLE 追问、三次升档）
6. 按需注入 session journal
7. 解析上游目标并转发（保留 SSE 与 tool-call）
8. 记录关键动作并输出路由/上游日志

## 运行时环境变量

`.env` 仅用于网关行为调优；模型连接统一在 `router.config.json` 的 `backends` 中配置。

| 变量 | 说明 | 默认 |
|------|------|------|
| `GATEWAY_PORT` | 网关端口 | `38080` |
| `GATEWAY_DRY_RUN` | `1/true` 时仅返回路由结果 | 关闭（`0`） |
| `GATEWAY_DEDUP_WINDOW_MS` | 重复请求拦截窗口（毫秒） | `5000` |
| `GATEWAY_SESSION_TTL_MS` | 内存会话 TTL | `1800000`（30 分钟） |
| `GATEWAY_MAX_MESSAGES` | 消息列表上限 | `60` |
| `GATEWAY_COMPRESSION_THRESHOLD_KB` | 触发压缩的请求体阈值（KB） | `180` |
| `GATEWAY_REQUEST_LOG_FILE` | 请求日志路径 | `./logs/gateway-requests.json` |
| `GATEWAY_CONFIG_PATH` / `ROUTER_CONFIG_PATH` | 配置文件路径 | `./router.config.json` |

## 接口

- `GET /health`：检查网关与后端连通性，返回配置来源与健康状态
- `GET /v1/models`：列出已配置的后端模型（OpenAI 兼容格式）
- `POST /reload`：热重载配置，清空内存会话与 journal
- `POST /v1/chat/completions`：接收聊天请求，分档路由并转发上游
