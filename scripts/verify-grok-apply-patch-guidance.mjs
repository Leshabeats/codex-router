import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import {
  APPLY_PATCH_TOOL_NAME,
  GROK_APPLY_PATCH_CREATE_EXAMPLE,
  GROK_APPLY_PATCH_GUIDANCE_MARKER,
  GROK_APPLY_PATCH_UPDATE_EXAMPLE,
} from "../src/grok-apply-patch-guidance.mjs";
import { spawnableCommand } from "../src/spawnable-command.mjs";

const python = process.argv[2] || process.env.LITELLM_PYTHON;
if (!python) {
  throw new Error(
    "usage: node scripts/verify-grok-apply-patch-guidance.mjs <venv-python>",
  );
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const LITELLM_HEALTH_MS = 300_000;
const SERVICE_HEALTH_MS = 15_000;

const V4A_GRAMMAR = [
  "start: begin_patch hunk+ end_patch",
  'begin_patch: "*** Begin Patch" LF',
  'end_patch: "*** End Patch" LF?',
  "",
  "hunk: add_hunk | delete_hunk | update_hunk",
  'add_hunk: "*** Add File: " filename LF add_line+',
  "%import common.LF",
].join("\n");

const HISTORY_PATCH = [
  "*** Begin Patch",
  "*** Add File: seed.txt",
  "+before",
  "*** End Patch",
].join("\n");

const UNICODE_PATCH = [
  "*** Begin Patch",
  '*** Add File: café "quotes".txt',
  "+hello “unicode”",
  "*** End Patch",
].join("\n");

const MALFORMED_PATCH = "*** Begin Patch\nnot-a-json-object";

const children = [];
const workspace = mkdtempSync(path.join(os.tmpdir(), "grok-apply-patch-guidance-"));
const capturedGrok = [];

function redact(text) {
  return String(text || "")
    .replaceAll(CALLER_KEY, "[caller-key]")
    .replaceAll(INTERNAL_KEY, "[internal-key]")
    .replaceAll("fake-access", "[session-key]");
}

function sse(events) {
  return `${events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
}

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function spawnChild(command, args, env, { detached = false } = {}) {
  const spawnable = spawnableCommand(command, args);
  const child = spawn(spawnable.command, spawnable.args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached,
    ...spawnable.options,
  });
  let output = "";
  const collect = (chunk) => {
    output += redact(chunk.toString("utf8"));
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.testOutput = () => output;
  children.push(child);
  return child;
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once("exit", done);
    if (process.platform === "win32") {
      spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 5_000).unref();
  });
}

async function waitHttp(url, child, { headers = {}, timeoutMs = SERVICE_HEALTH_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`exited before ${url}: ${child.testOutput()}`);
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // not bound yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${url}: ${child?.testOutput?.() || ""}`);
}

function itemsByCallId(sseBody) {
  const byCallId = new Map();
  for (const line of sseBody.split(/\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    const item = event.item;
    if (item?.call_id) byCallId.set(item.call_id, item);
  }
  return byCallId;
}

function larkFence(description) {
  const match = String(description || "").match(/Format:\n```lark\n([\s\S]*?)\n```/);
  return match ? match[1] : undefined;
}

function applyPatchRequest({ historyInput, historyId }) {
  return {
    model: "grok-oauth/grok-4.6",
    stream: true,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "patch notes" }] },
      {
        type: "custom_tool_call",
        id: historyId,
        call_id: "call_history",
        name: APPLY_PATCH_TOOL_NAME,
        input: historyInput,
      },
      { type: "custom_tool_call_output", call_id: "call_history", output: "Done!" },
    ],
    tools: [
      {
        type: "custom",
        name: APPLY_PATCH_TOOL_NAME,
        description: "Apply a patch.",
        format: { type: "grammar", syntax: "lark", definition: V4A_GRAMMAR },
      },
      {
        type: "function",
        name: APPLY_PATCH_TOOL_NAME,
        description: "ordinary same-name function",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        type: "function",
        name: "read_file",
        description: "unrelated ordinary function",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  };
}

function mockFunctionCall(callId, argumentsText) {
  return sse([
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name: APPLY_PATCH_TOOL_NAME,
      },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: `fc_${callId}`,
      delta: argumentsText,
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name: APPLY_PATCH_TOOL_NAME,
        arguments: argumentsText,
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 9 } } },
  ]);
}

const mockXai = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  capturedGrok.push({
    authorizationPresent: Boolean(request.headers.authorization),
    body,
  });
  const history = (body.input || []).find(
    (item) => item?.type === "function_call" && item.name === APPLY_PATCH_TOOL_NAME,
  );
  const historyArgs = typeof history?.arguments === "string" ? history.arguments : "";
  const malformed = historyArgs.includes("not-a-json-object");
  const outgoingArgs = malformed ? historyArgs : JSON.stringify({ content: UNICODE_PATCH });
  const callId = malformed ? "call_malformed" : "call_unicode";
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(mockFunctionCall(callId, outgoingArgs));
});

await new Promise((resolve, reject) => {
  mockXai.once("error", reject);
  mockXai.listen(0, "127.0.0.1", resolve);
});
const xaiPort = mockXai.address().port;

const grokPort = await openPort();
const gatewayPort = await openPort();
const routerPort = await openPort();
const pythonDir = path.dirname(python);
const litellmBin = path.join(
  pythonDir,
  process.platform === "win32" ? "litellm.exe" : "litellm",
);
assert.ok(existsSync(python), `venv python missing: ${python}`);
assert.ok(existsSync(litellmBin), `litellm entry point missing: ${litellmBin}`);

const authPath = path.join(workspace, "auth.json");
writeFileSync(
  authPath,
  JSON.stringify({ "https://auth.x.ai::test-client-id": { key: "fake-access" } }),
  { mode: 0o600 },
);
const litellmConfig = path.join(workspace, "litellm.yaml");
writeFileSync(
  litellmConfig,
  [
    "model_list:",
    '  - model_name: "grok-oauth-grok-4-6"',
    "    litellm_params:",
    '      model: "openai/grok-4.6"',
    "      api_base: os.environ/GROK_OAUTH_FORWARD_BASE_URL",
    '      api_key: "os.environ/CODEX_ROUTER_INTERNAL_KEY"',
    "      use_chat_completions_api: true",
    "      num_retries: 0",
    "",
    "litellm_settings:",
    "  drop_params: true",
    "  request_timeout: 60",
    "",
    "router_settings:",
    "  disable_cooldowns: true",
    "",
    "general_settings:",
    "  disable_spend_logs: true",
    "",
  ].join("\n"),
  { mode: 0o600 },
);

const sharedEnv = {
  MODEL_ROUTER_TARGET: "codex",
  MODEL_ROUTER_QUIET: "1",
  MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
  CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
  CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
  CODEX_ROUTER_GROK_PROGRESS_ONLY_RETRY: "0",
  LITELLM_MASTER_KEY: INTERNAL_KEY,
  LITELLM_LOG: "ERROR",
  LITELLM_TELEMETRY: "False",
  LITELLM_LOCAL_MODEL_COST_MAP: "True",
  NO_COLOR: "1",
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
  PATH: `${pythonDir}${path.delimiter}${process.env.PATH || ""}`,
};

const grokChild = spawnChild(
  process.execPath,
  [path.join(root, "src", "grok-oauth-forwarder.mjs")],
  {
    ...sharedEnv,
    MODEL_ROUTER_GROK_OAUTH_PORT: String(grokPort),
    GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${xaiPort}`,
    GROK_CLI: path.join(root, "test", "fixtures", "missing-grok-cli"),
    GROK_AUTH_PATH: authPath,
  },
);
await waitHttp(`http://127.0.0.1:${grokPort}/health`, grokChild, {
  headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
});

const litellmChild = spawnChild(
  litellmBin,
  ["--config", litellmConfig, "--host", "127.0.0.1", "--port", String(gatewayPort)],
  {
    ...sharedEnv,
    GROK_OAUTH_FORWARD_BASE_URL: `http://127.0.0.1:${grokPort}/v1`,
  },
  { detached: process.platform !== "win32" },
);
await waitHttp(`http://127.0.0.1:${gatewayPort}/health/liveliness`, litellmChild, {
  timeoutMs: LITELLM_HEALTH_MS,
});

const stateDir = path.join(workspace, "state");
const codexHome = path.join(workspace, "codex-home");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(stateDir, "enabled-providers.json"),
  `${JSON.stringify({ version: 1, providers: ["grok-oauth"] }, null, 2)}\n`,
  { mode: 0o600 },
);
const routerChild = spawnChild(process.execPath, [path.join(root, "src", "router.mjs")], {
  ...sharedEnv,
  MODEL_ROUTER_STATE_DIR: stateDir,
  CODEX_ROUTER_STATE_DIR: stateDir,
  CODEX_HOME: codexHome,
  CODEX_ROUTER_PORT: String(routerPort),
  CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
  CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health/liveliness`,
  CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${grokPort}/health`,
  MODEL_ROUTER_GROK_OAUTH_PORT: String(grokPort),
});
await waitHttp(`http://127.0.0.1:${routerPort}/health`, routerChild);

const routerUrl = `${callerBaseUrl(routerPort, CALLER_KEY)}/responses`;

async function postTurn(payload) {
  const response = await fetch(routerUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CALLER_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  assert.equal(response.status, 200, redact(body));
  return body;
}

try {
  const unicodeBody = await postTurn(
    applyPatchRequest({ historyInput: HISTORY_PATCH, historyId: "ctc_history" }),
  );
  assert.equal(capturedGrok.length, 1);
  const grokRequest = capturedGrok[0].body;
  const grokTools = grokRequest.tools || [];
  const grokApply = grokTools.filter((tool) => tool.type === "function" && tool.name === APPLY_PATCH_TOOL_NAME);
  assert.equal(grokApply.length, 1);
  assert.equal(grokApply[0].description.includes("Apply a patch."), true);
  assert.equal(grokApply[0].description.includes(GROK_APPLY_PATCH_GUIDANCE_MARKER), true);
  assert.equal(grokApply[0].description.includes(GROK_APPLY_PATCH_CREATE_EXAMPLE), true);
  assert.equal(grokApply[0].description.includes(GROK_APPLY_PATCH_UPDATE_EXAMPLE), true);
  assert.equal(larkFence(grokApply[0].description), V4A_GRAMMAR);
  assert.deepEqual(grokApply[0].parameters?.required, ["content"]);
  assert.equal(grokApply[0].parameters?.properties?.path, undefined);
  const readFile = grokTools.find((tool) => tool.type === "function" && tool.name === "read_file");
  assert.equal(readFile?.description, "unrelated ordinary function");
  assert.equal(String(readFile?.description || "").includes(GROK_APPLY_PATCH_GUIDANCE_MARKER), false);

  const historyCall = (grokRequest.input || []).find(
    (item) => item?.type === "function_call" && item.call_id === "call_history",
  );
  assert.ok(historyCall, "history call_id must survive LiteLLM and the Grok forwarder");
  assert.equal(historyCall.name, APPLY_PATCH_TOOL_NAME);
  assert.deepEqual(JSON.parse(historyCall.arguments), { content: HISTORY_PATCH });
  const historyResult = (grokRequest.input || []).find(
    (item) => item?.type === "function_call_output" && item.call_id === "call_history",
  );
  assert.equal(historyResult?.output, "Done!");

  const unicodeItem = itemsByCallId(unicodeBody).get("call_unicode");
  assert.equal(unicodeItem?.type, "custom_tool_call");
  assert.equal(unicodeItem.input, UNICODE_PATCH);

  const malformedBody = await postTurn(
    applyPatchRequest({ historyInput: MALFORMED_PATCH, historyId: "ctc_malformed" }),
  );
  assert.equal(capturedGrok.length, 2);
  const malformedHistory = (capturedGrok[1].body.input || []).find(
    (item) => item?.type === "function_call" && item.call_id === "call_history",
  );
  assert.deepEqual(JSON.parse(malformedHistory.arguments), { content: MALFORMED_PATCH });
  const malformedItem = itemsByCallId(malformedBody).get("call_malformed");
  assert.equal(malformedItem?.type, "custom_tool_call");
  assert.equal(malformedItem.input, MALFORMED_PATCH);
} finally {
  await Promise.all(children.map((child) => stopChild(child)));
  await new Promise((resolve) => mockXai.close(resolve));
  rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write("ok grok apply_patch guidance through Router, LiteLLM, Grok forwarder, and mock xAI\n");
