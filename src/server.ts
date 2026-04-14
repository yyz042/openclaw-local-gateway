import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { DEFAULT_ROUTING_CONFIG } from "./router/config.js";
import { routeByRules } from "./router/rules.js";
import type { Tier } from "./router/types.js";

const DEDUP_WINDOW_MS = Number(process.env.GATEWAY_DEDUP_WINDOW_MS ?? "5000");
const recentRequests = new Map<string, number>();

type ChatMessage = { role?: string; content?: unknown };

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
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
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
  const system = messages.find((m) => m.role === "system");
  const systemPrompt = normalizeContentToText(system?.content) || undefined;
  return { prompt, systemPrompt };
}

function sanitizeMessagesForUpstream(messages: ChatMessage[]): ChatMessage[] {
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
  const mt = body.max_tokens ?? body.max_completion_tokens;
  if (typeof mt === "number" && mt > 0) return Math.min(mt, 128_000);
  return 4096;
}

function tierTarget(tier: Tier): { baseUrl: string; model: string } {
  const defBase = (process.env.VLLM_DEFAULT_BASE ?? "").replace(/\/$/, "");
  const defModel = process.env.VLLM_DEFAULT_MODEL ?? "default";
  const envBase = (process.env[`VLLM_${tier}_BASE`] ?? "").replace(/\/$/, "");
  const envModel = process.env[`VLLM_${tier}_MODEL`] ?? defModel;
  const baseUrl = envBase || defBase;
  if (!baseUrl) throw new Error(`No base for ${tier}; set VLLM_${tier}_BASE or VLLM_DEFAULT_BASE.`);
  return { baseUrl, model: envModel };
}

function authorizationForTier(tier: Tier, req: IncomingMessage): string | undefined {
  const tierKey = process.env[`VLLM_${tier}_API_KEY`]?.trim();
  if (tierKey) return tierKey.startsWith("Bearer ") ? tierKey : `Bearer ${tierKey}`;
  if (tier !== "SIMPLE") {
    const defKey = process.env.VLLM_DEFAULT_API_KEY?.trim();
    if (defKey) return defKey.startsWith("Bearer ") ? defKey : `Bearer ${defKey}`;
  }
  return req.headers.authorization ? String(req.headers.authorization) : undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
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

  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  const { prompt, systemPrompt } = extractPromptAndSystem(messages);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const maxTokens = maxOutputTokens(body);
  const routed = routeByRules(prompt, systemPrompt, maxTokens, hasTools, DEFAULT_ROUTING_CONFIG);

  const promptLog = prompt.replace(/\s+/g, " ").trim();
  console.log(
    `[gateway] scoring caller=${caller} prompt=${JSON.stringify(promptLog)} score=${routed.rule.score.toFixed(3)} raw_tier=${routed.rule.tier ?? "AMBIGUOUS"} final_tier=${routed.tier} confidence=${routed.confidence.toFixed(3)} signals=${JSON.stringify(routed.rule.signals.join(" | "))} reason=${JSON.stringify(routed.reasoning)}`,
  );

  const dryRun = isGatewayDryRun();
  const target = dryRun ? { baseUrl: "(unset)", model: "(unset)" } : tierTarget(routed.tier);
  if (dryRun) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "chat.completion",
        dry_run: true,
        tier: routed.tier,
        confidence: routed.confidence,
        reasoning: routed.reasoning,
        upstream: target,
      }),
    );
    return;
  }

  const stream = body.stream === true;
  console.log(
    `[gateway] caller=${caller} prompt=${JSON.stringify(promptLog)} tier=${routed.tier} target=${target.model} base=${target.baseUrl} stream=${stream}`,
  );

  const forwardBody = {
    ...body,
    ...(Array.isArray(body.messages) ? { messages: sanitizeMessagesForUpstream(messages) } : {}),
    model: target.model,
  };
  const auth = authorizationForTier(routed.tier, req);
  const upstream = await fetch(`${target.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(forwardBody),
  });

  if (stream && upstream.ok && upstream.body) {
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let fullContent = "";
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
    console.log(
      `[gateway] upstream_done caller=${caller} tier=${routed.tier} model=${target.model} status=${upstream.status} content=${JSON.stringify(fullContent || "(empty)")} tool_calls=${JSON.stringify(toolCalls)}`,
    );
    return;
  }

  const text = await upstream.text();
  res.writeHead(upstream.status, { "Content-Type": "application/json" });
  res.end(text);
  console.log(
    `[gateway] upstream_done caller=${caller} tier=${routed.tier} model=${target.model} status=${upstream.status} body=${JSON.stringify(text)}`,
  );
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url?.startsWith("/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "openclaw-local-gateway" }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const raw = await readBody(req);
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
  console.log(`[openclaw-local-gateway] listening http://127.0.0.1:${port}/v1/chat/completions`);
});
