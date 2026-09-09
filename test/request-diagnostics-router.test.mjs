import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import {
  measureIngressContextBytes,
  utf8JsonBytes,
} from "../src/request-diagnostics.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

function routerBase(port) {
  return callerBaseUrl(port, CALLER_KEY);
}

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function run(env) {
  const stateDir =
    env?.MODEL_ROUTER_STATE_DIR ||
    mkdtempSync(path.join(os.tmpdir(), "request-diagnostics-state-"));
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  child.stateDir = stateDir;
  return child;
}

async function waitFor(url, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines.at(-1) !== "") lines.pop();
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForUsageEvents(stateDir, count, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = usageEvents(stateDir);
    if (events.length >= count) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} usage events: ${child.testErrors()}`);
}

const GROK_PAYLOAD = {
  model: "grok-oauth/grok-4.6",
  instructions: "Stay concise.",
  tools: [{ type: "function", name: "read_file" }],
  input: [{ type: "message", role: "user", content: "hello" }],
};

const EXPECTED_CONTEXT = measureIngressContextBytes(GROK_PAYLOAD);

test("Grok 4.6 usage rows correlate with activity id across success, failure, and cancel", async () => {
  let hang;
  let turns = 0;
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true, credential_present: true });
      return;
    }
    await bodyJson(request);
    turns += 1;
    if (turns === 3) {
      hang = new Promise((resolve) => {
        request.once("close", resolve);
        response.once("close", resolve);
      });
      return;
    }
    if (turns === 2) {
      json(response, 502, { error: { message: "upstream refused" } });
      return;
    }
    json(response, 200, {
      id: "resp_grok",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: {
        input_tokens: 11,
        output_tokens: 4,
        output_tokens_details: { reasoning_tokens: 3 },
      },
    });
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "request-diagnostics-router-"));
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });
  const headers = { "Content-Type": "application/json" };

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);

    const ok = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(GROK_PAYLOAD),
    });
    assert.equal(ok.status, 200, await ok.text());
    const [success] = await waitForUsageEvents(stateDir, 1, router);
    assert.equal(success.model, "grok-oauth/grok-4.6");
    assert.equal(success.provider, "grok-oauth");
    assert.equal(success.status, 200);
    assert.equal(success.reasoningTokens, 3);
    assert.equal(success.inputTokens, 11);
    assert.equal(success.outputTokens, 4);
    assert.match(success.requestId, /^[a-f0-9-]+:[0-9]+$/);
    const completedActivity = await (await fetch(`${routerBase(routerPort)}/activity`)).json();
    assert.ok(completedActivity.recent.some((entry) => entry.requestId === success.requestId && entry.status === 200));
    assert.deepEqual(success.contextBytes, EXPECTED_CONTEXT);
    assert.equal(success.contextBytes.instructionsBytes, utf8JsonBytes("Stay concise."));
    assert.equal("reasoningOutputTokens" in success, false);

    const failed = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(GROK_PAYLOAD),
    });
    assert.equal(failed.status, 502);
    const events = await waitForUsageEvents(stateDir, 2, router);
    const failure = events.at(-1);
    assert.equal(failure.status, 502);
    assert.notEqual(failure.requestId, success.requestId);
    const failedActivity = await (await fetch(`${routerBase(routerPort)}/activity`)).json();
    assert.ok(failedActivity.recent.some((entry) => entry.requestId === failure.requestId && entry.status === 502));
    assert.deepEqual(failure.contextBytes, EXPECTED_CONTEXT);
    assert.equal("reasoningTokens" in failure, false);

    const canceler = new AbortController();
    const held = fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(GROK_PAYLOAD),
      signal: canceler.signal,
    }).catch(() => undefined);
    const deadline = Date.now() + 3_000;
    let activityId;
    while (!activityId && Date.now() < deadline) {
      const activity = await fetch(`${routerBase(routerPort)}/activity`);
      const payload = await activity.json();
      const active = payload.active?.find(
        (entry) => entry.model === "grok-oauth/grok-4.6",
      );
      activityId = active?.requestId || active?.id;
      if (!activityId) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(activityId, "in-flight activity did not publish a request id");
    canceler.abort();
    await held;
    if (hang) await hang;
    const afterCancel = await waitForUsageEvents(stateDir, 3, router);
    const canceled = afterCancel.at(-1);
    assert.equal(canceled.status, 0);
    assert.equal(canceled.requestId, activityId);
    assert.deepEqual(canceled.contextBytes, EXPECTED_CONTEXT);

    const raw = readFileSync(path.join(stateDir, "usage-events.jsonl"), "utf8");
    assert.equal(raw.includes("Stay concise."), false);
    assert.equal(raw.includes("read_file"), false);
    assert.equal(raw.includes("hello"), false);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a non-Grok-4.6 turn still records requestId and omits contextBytes", async () => {
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true, credential_present: true });
      return;
    }
    await bodyJson(request);
    json(response, 200, {
      id: "resp_ds",
      usage: { input_tokens: 2, output_tokens: 1 },
    });
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "request-diagnostics-other-"));
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-pro",
        instructions: "should not be measured",
        input: "go",
      }),
    });
    assert.equal(response.status, 200, await response.text());
    const [event] = await waitForUsageEvents(stateDir, 1, router);
    assert.match(event.requestId, /^[a-f0-9-]+:[0-9]+$/);
    assert.equal("contextBytes" in event, false);
    const raw = readFileSync(path.join(stateDir, "usage-events.jsonl"), "utf8");
    assert.equal(raw.includes("should not be measured"), false);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
