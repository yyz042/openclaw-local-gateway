# OpenClaw Local Gateway

这是一个面向 OpenClaw 的轻量本地网关：复用 `@blockrun/clawrouter` 的路由核心，只保留其多模型分流所需的关键能力。

## 项目优势

- **架构聚焦**：保留路由智能，移除支付/代理生态复杂度。
- **OpenClaw 友好输入处理**：在路由与转发前清洗 OpenClaw 元信息，避免“路由输入”和“真实上游输入”不一致。
- **可运维可解释**：完整记录 tier、confidence、weighted score 推理依据，以及流式内容和 tool-call 片段。
- **本地使用优化**：短时间窗口内拦截重复请求，减少误触发重复执行。
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

## 明确移除的部分

- x402 支付
- 钱包/鉴权生命周期
- 合作方与 provider 插件体系
- 会话持久化

## 请求处理流程

1. 通过 `POST /v1/chat/completions` 接收 OpenAI 兼容请求。
2. 清洗 OpenClaw 用户文本（如 `[message_id: ...]`、时间戳包装）。
3. 通过 ClawRouter 路由逻辑得出 `SIMPLE/MEDIUM/COMPLEX/REASONING`。
4. 解析上游目标（优先 `VLLM_<TIER>_*`，否则使用默认回退）。
5. 转发并透传响应（保留 SSE 与 tool-call 数据）。
6. 输出请求、路由、上游完成日志。

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
- `VLLM_SIMPLE_BASE` / `VLLM_SIMPLE_MODEL`：SIMPLE 档目标
- `VLLM_DEFAULT_BASE` / `VLLM_DEFAULT_MODEL` / `VLLM_DEFAULT_API_KEY`：非 SIMPLE 档默认回退目标与鉴权（若未配置档位专用项）

## 接口

- `GET /health`
- `POST /v1/chat/completions`
