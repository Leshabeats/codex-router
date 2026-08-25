// Runs the five live checks from v2_agent/README.md against one route.
//
// The router already refuses to promote a route on anything less than all five
// (see `verifiedForRoute`), so this module's only job is to produce an honest
// result for each one. Every check is evidence a reviewer would reproduce by
// hand: two cheap HTTP turns, then the delegation itself through a real Codex
// parent, then a same-thread follow-up to that same child.
//
// The decision logic is deliberately separated from the live calls so the part
// that decides whether a route is promotable can be tested without spending a
// provider's quota.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { routedAgentDefinition } from "./codex-agent-catalog.mjs";
import { spawnableCommand } from "./codex-binary.mjs";
import { VERIFICATION_CHECKS } from "./subagent-proofs.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CHECK_LABELS = Object.freeze({
  streaming: "streamed reply",
  toolCall: "tool call",
  encryptedRelay: "subagent delegation",
  markerReturn: "subagent reply",
  sameThreadFollowUp: "second subagent turn",
});

function pending() {
  const checks = {};
  for (const name of VERIFICATION_CHECKS) checks[name] = { outcome: "pending" };
  return checks;
}

function pass(status, at = new Date().toISOString()) {
  return { outcome: "pass", ...(status ? { status } : {}), observedAt: at };
}

function fail(detail, at = new Date().toISOString()) {
  return { outcome: "fail", ...(detail ? { detail: String(detail).slice(0, 300) } : {}), observedAt: at };
}

// These answer about the account or the moment, never about the route: rate
// limits, exhausted quota and outages clear on their own, and a missing
// credential or plan entitlement clears when the operator fixes it. Recording
// them as a refusal tells the operator their model cannot host subagents when
// all that happened was a 429.
const STATUS_ABOUT_THE_ACCOUNT = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504]);

function deferred(status, detail, at = new Date().toISOString()) {
  return {
    outcome: "deferred",
    ...(status ? { status } : {}),
    ...(detail ? { detail: String(detail).slice(0, 300) } : {}),
    observedAt: at,
  };
}

function httpOutcome(status, detail) {
  return STATUS_ABOUT_THE_ACCOUNT.has(status) ? deferred(status, detail) : fail(detail);
}

export function runDeferred(checks) {
  return VERIFICATION_CHECKS.some((name) => checks?.[name]?.outcome === "deferred");
}

// The first check that did not pass, in reviewer order. A run stops there, so
// this is also the reason the route was not promoted.
export function firstFailure(checks) {
  const name = VERIFICATION_CHECKS.find((check) => checks?.[check]?.outcome !== "pass");
  if (!name) return undefined;
  return { check: name, label: CHECK_LABELS[name], detail: checks?.[name]?.detail };
}

export function checksComplete(checks) {
  return VERIFICATION_CHECKS.every((name) => checks?.[name]?.outcome === "pass");
}

// A marker is generated per run and never reused. A route that echoes a
// previous run's marker, or that a cached transcript happens to contain,
// must not be able to pass on that.
export function newMarker(prefix = "CRV") {
  return `${prefix}-${randomBytes(9).toString("hex").toUpperCase()}`;
}

// What the JSONL event stream has to show for the delegation checks to hold:
// a child actually started on the agent this route owns, and the marker came
// back. A marker in the parent's own text proves nothing -- the parent can
// read the marker out of its own prompt -- so it only counts inside a child
// event, or after a child on that agent has started.
export function readDelegation(events, { agentName, marker }) {
  let childStarted = false;
  let markerReturned = false;
  for (const event of Array.isArray(events) ? events : []) {
    const text = typeof event === "string" ? event : JSON.stringify(event ?? "");
    if (!text) continue;
    if (!childStarted && text.includes(agentName)) childStarted = true;
    if (childStarted && marker && text.includes(marker)) markerReturned = true;
  }
  return { childStarted, markerReturned };
}

export function parseEventLines(stdout) {
  return String(stdout || "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return line;
      }
    });
}

function runCodex(args, { codexBin, codexHome, timeoutMs, cwd }) {
  return new Promise((resolve) => {
    const target = spawnableCommand(codexBin, args);
    const child = spawn(target.command, target.args, {
      ...target.options,
      cwd,
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: codexHome, MODEL_ROUTER_TARGET: "codex" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: signal === "SIGTERM" });
    });
  });
}

// `--ignore-user-config` means the run starts with no providers at all, so the
// child's `model_provider = "codex-router"` has to be declared here or no child
// can ever start -- which is what "no child ran on this route" was really
// reporting, for every route, regardless of the route.
function routerConfigArgs({ baseUrl, catalogPath }) {
  const args = [
    "--config",
    'model_providers.codex-router.name="Codex Router"',
    "--config",
    `model_providers.codex-router.base_url=${JSON.stringify(baseUrl)}`,
    "--config",
    'model_providers.codex-router.wire_api="responses"',
    "--config",
    "model_providers.codex-router.requires_openai_auth=true",
    "--config",
    "model_providers.codex-router.supports_websockets=false",
  ];
  if (catalogPath) args.push("--config", `model_catalog_json=${JSON.stringify(catalogPath)}`);
  return args;
}

function execArgs({ model, prompt, cwd, extra = [] }) {
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--json",
    "--model",
    model,
    "--config",
    "disable_response_storage=true",
    ...extra,
    "--cd",
    cwd,
    prompt,
  ];
}

// Checks 1-2. These run against the router's own authenticated endpoint rather
// than through Codex: a forced tool call with asserted arguments is the point
// of the check, and driving that through an agent turn would test the agent's
// judgement instead of the route's tool handling.
async function runHttpChecks({ slug, baseUrl, secret, timeoutMs }) {
  const results = {};
  // The caller endpoint speaks the Responses API and takes the caller key as a
  // bearer. `chat/completions` is not served here at all, so calling it
  // reported a 404 as though the route had failed the check.
  const url = `${baseUrl}/responses`;
  const headers = {
    "content-type": "application/json",
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: slug,
        input: "Reply with the single word: ready",
        stream: true,
        max_output_tokens: 64,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    results.streaming = response.ok && text.includes("data:")
      ? pass(response.status)
      : httpOutcome(response.status, `streamed turn returned HTTP ${response.status}`);
  } catch (error) {
    // A request that never got an answer -- an abort, a timeout, a socket the
    // router closed while restarting -- proved nothing about the route. Only a
    // reply the provider actually sent can refuse one.
    results.streaming = deferred(undefined, error?.message || "the streamed turn got no answer");
  }
  if (results.streaming.outcome !== "pass") return results;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: slug,
        input: 'Call codex_router_probe with token "ok".',
        max_output_tokens: 128,
        tools: [
          {
            type: "function",
            name: "codex_router_probe",
            description: "Return the supplied token.",
            parameters: {
              type: "object",
              properties: { token: { type: "string" } },
              required: ["token"],
              additionalProperties: false,
            },
          },
        ],
        tool_choice: { type: "function", name: "codex_router_probe" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => undefined);
    const call = (payload?.output || []).find((item) => item?.type === "function_call");
    const argumentsValid = (() => {
      try {
        return typeof JSON.parse(call?.arguments ?? "").token === "string";
      } catch {
        return false;
      }
    })();
    results.toolCall = response.ok && call?.name === "codex_router_probe" && argumentsValid
      ? pass(response.status)
      : httpOutcome(
        response.status,
        call
          ? "the forced call did not return valid JSON arguments"
          : `no tool call in the reply (HTTP ${response.status})`,
      );
  } catch (error) {
    results.toolCall = deferred(undefined, error?.message || "the forced tool call got no answer");
  }
  return results;
}

// Checks 3-5. A native parent is asked to delegate to the agent this route
// owns; the child has to return a marker only this run knows, and then a
// second marker on a follow-up in the same session.
async function runDelegationChecks({
  slug,
  parentModel,
  codexBin,
  codexHome,
  baseUrl,
  catalogPath,
  workDir,
  timeoutMs,
}) {
  const results = {};
  const definition = routedAgentDefinition({ slug, displayName: slug });
  // The parent is a native model signing in with this machine's ChatGPT
  // session, so the run has to use the real CODEX_HOME. A throwaway home has
  // no credentials, and an unauthenticated parent cannot delegate anything.
  const agentsDir = path.join(codexHome, "agents");
  const agentFile = path.join(agentsDir, definition.fileName);
  const preExisting = existsSync(agentFile);
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  if (!preExisting) {
    // The route is not v2 yet, so the catalog has not written its definition.
    // The check needs the child spawnable without promoting anything first,
    // and the file goes away again below unless it was already there.
    writeFileSync(agentFile, definition.contents, { encoding: "utf8", mode: 0o600 });
  }

  const config = routerConfigArgs({ baseUrl, catalogPath });
  try {
    const marker = newMarker();
    const first = await runCodex(
      execArgs({
        model: parentModel,
        cwd: workDir,
        extra: config,
        prompt:
          `Delegate to the agent named ${definition.agentName}. Instruct that agent to reply with exactly ${marker}. ` +
          "Do not answer yourself and do not repeat the token in your own message; report only what the agent returned.",
      }),
      { codexBin, codexHome, timeoutMs, cwd: workDir },
    );
    const firstDelegation = readDelegation(parseEventLines(first.stdout), {
      agentName: definition.agentName,
      marker,
    });
    results.encryptedRelay = firstDelegation.childStarted
      ? pass(200)
      // A parent killed at the ceiling never finished asking. That is the run
      // running out of time, not the route refusing to host a child.
      : first.timedOut
        ? deferred(undefined, "the parent did not finish delegating before the timeout")
        : fail("no child ran on this route");
    if (!firstDelegation.childStarted) return { results, agentName: definition.agentName };

    results.markerReturn = firstDelegation.markerReturned
      ? pass(200)
      : fail("the child ran but did not return the marker");
    if (!firstDelegation.markerReturned) return { results, agentName: definition.agentName };

    const followUpMarker = newMarker("CRV2");
    const second = await runCodex(
      [
        "exec",
        "resume",
        "--last",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--json",
        "--config",
        "disable_response_storage=true",
        ...config,
        "--cd",
        workDir,
        `Ask the same ${definition.agentName} agent, in this same thread, to reply with exactly ${followUpMarker}.`,
      ],
      { codexBin, codexHome, timeoutMs, cwd: workDir },
    );
    const secondDelegation = readDelegation(parseEventLines(second.stdout), {
      agentName: definition.agentName,
      marker: followUpMarker,
    });
    results.sameThreadFollowUp = secondDelegation.markerReturned
      ? pass(200)
      : fail("the child did not answer a second turn in the same thread");
    return { results, agentName: definition.agentName };
  } finally {
    // Leave the agents directory exactly as it was found. A definition left
    // behind would keep an uncertified route spawnable by name.
    if (!preExisting) rmSync(agentFile, { force: true });
  }
}

// One route, all five checks, stopping at the first failure so a route that
// cannot stream never spends quota on a delegation.
export async function verifySubagentRoute(
  slug,
  {
    baseUrl,
    secret,
    codexBin,
    codexHome,
    parentModel = "gpt-5.6-sol",
    catalogPath,
    routerVersion,
    timeoutMs = 120_000,
  } = {},
) {
  const checks = pending();
  const started = Date.now();
  const http = await runHttpChecks({ slug, baseUrl, secret, timeoutMs });
  Object.assign(checks, http);
  if (checks.streaming.outcome !== "pass" || checks.toolCall.outcome !== "pass") {
    return { slug, checks, ok: false, routerVersion, durationMs: Date.now() - started };
  }

  // Only the working directory is disposable. The Codex home stays real so the
  // parent can authenticate.
  const workDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-certify-"));
  try {
    const { results } = await runDelegationChecks({
      slug,
      parentModel,
      codexBin,
      codexHome,
      baseUrl,
      catalogPath,
      workDir,
      timeoutMs,
    });
    Object.assign(checks, results);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return {
    slug,
    checks,
    ok: checksComplete(checks),
    routerVersion,
    durationMs: Date.now() - started,
  };
}
