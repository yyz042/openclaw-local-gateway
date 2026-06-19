import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

function fail(message: string): never {
  throw new Error(`[test:vllm-simple] ${message}`);
}

async function isGatewayHealthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isGatewayHealthy(baseUrl)) return;
    await sleep(200);
  }
  fail(`gateway did not become healthy within ${timeoutMs}ms`);
}

function startGatewayForTest(port: number): ChildProcess {
  const child = spawn("node", ["--import", "tsx", "src/server.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      GATEWAY_DRY_RUN: "0",
    },
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[gateway stdout] ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[gateway stderr] ${chunk}`);
  });

  return child;
}

async function main() {
  if (!process.env.VLLM_SIMPLE_BASE) fail("missing env: VLLM_SIMPLE_BASE");
  if (!process.env.VLLM_SIMPLE_MODEL) fail("missing env: VLLM_SIMPLE_MODEL");

  const testPort = Number(process.env.GATEWAY_TEST_PORT ?? "38081");
  const gatewayBaseUrl = `http://127.0.0.1:${testPort}`;
  const gateway = startGatewayForTest(testPort);

  try {
    await waitForHealth(gatewayBaseUrl, 15000);

    const prompt = `hello (${new Date().toISOString()})`;
    const response = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "ignored-by-gateway",
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const rawText = await response.text();
    if (!response.ok) {
      fail(`gateway returned ${response.status}: ${rawText}`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      fail(`gateway returned non-json payload: ${rawText}`);
    }

    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      fail(`no model content in response: ${rawText}`);
    }

    console.log(`[test:vllm-simple] success`);
    console.log(`[test:vllm-simple] routed SIMPLE model env=${process.env.VLLM_SIMPLE_MODEL}`);
    console.log(`[test:vllm-simple] prompt=${JSON.stringify(prompt)}`);
    console.log(`[test:vllm-simple] reply=${JSON.stringify(content.trim())}`);
  } finally {
    gateway.kill("SIGTERM");
    await sleep(300);
    if (!gateway.killed) gateway.kill("SIGKILL");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
