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

// The first check that did not pass, in reviewer order. A run stops at its
// first failure, so this is also the reason the route was refused.
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

function execArgs({ model, prompt, agentsHome, extra = [] }) {
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
    agentsHome,
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
      : fail(`streamed turn returned HTTP ${response.status}`);
  } catch (error) {
    results.streaming = fail(error?.message || "streamed turn failed");
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
      : fail(
        call
          ? "the forced call did not return valid JSON arguments"
          : `no tool call in the reply (HTTP ${response.status})`,
      );
  } catch (error) {
    results.toolCall = fail(error?.message || "forced tool call failed");
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
  catalogPath,
  timeoutMs,
}) {
  const results = {};
  const definition = routedAgentDefinition({ slug, displayName: slug });
  const agentsDir = path.join(codexHome, "agents");
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  // The route is v1 today, so the catalog has not written its definition. The
  // check needs the child spawnable without promoting anything first.
  writeFileSync(path.join(agentsDir, definition.fileName), definition.contents, {
    encoding: "utf8",
    mode: 0o600,
  });

  const marker = newMarker();
  const first = await runCodex(
    execArgs({
      model: parentModel,
      agentsHome: codexHome,
      extra: catalogPath ? ["--config", `model_catalog_json=${JSON.stringify(catalogPath)}`] : [],
      prompt:
        `Delegate to the agent named ${definition.agentName}. Instruct that agent to reply with exactly ${marker}. ` +
        "Do not answer yourself and do not repeat the token in your own message; report only what the agent returned.",
    }),
    { codexBin, codexHome, timeoutMs, cwd: codexHome },
  );
  const firstEvents = parseEventLines(first.stdout);
  const firstDelegation = readDelegation(firstEvents, {
    agentName: definition.agentName,
    marker,
  });
  results.encryptedRelay = firstDelegation.childStarted
    ? pass(200)
    : fail(first.timedOut ? "the parent did not delegate before the timeout" : "no child ran on this route");
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
      "--cd",
      codexHome,
      `Ask the same ${definition.agentName} agent, in this same thread, to reply with exactly ${followUpMarker}.`,
    ],
    { codexBin, codexHome, timeoutMs, cwd: codexHome },
  );
  const secondDelegation = readDelegation(parseEventLines(second.stdout), {
    agentName: definition.agentName,
    marker: followUpMarker,
  });
  results.sameThreadFollowUp = secondDelegation.markerReturned
    ? pass(200)
    : fail("the child did not answer a second turn in the same thread");
  return { results, agentName: definition.agentName };
}

// A pass is worth more than one machine. The same five outcomes are what a
// v2_agent application carries, so record them there too: once that artifact
// is reviewed and its registry entry lands, every installer gets the route as
// v2 and nobody -- including this operator on their next machine -- pays to
// measure it again.
//
// Only outcomes, HTTP statuses, and timestamps are written. Prompts, response
// bodies, decrypted payloads, and anything credential-shaped stay out, which
// is both the README's rule and what CI refuses.
export function applicationPath(slug, root = REPO_ROOT) {
  const [provider, ...rest] = String(slug || "").split("/");
  const model = rest.join("/");
  if (!provider || !model) return undefined;
  const safe = /^[a-z0-9][a-z0-9._-]*$/i;
  if (!safe.test(provider) || !safe.test(model)) return undefined;
  return path.join(root, "v2_agent", provider, model);
}

export function recordApplicationEvidence(slug, { checks, routerVersion, at, root = REPO_ROOT }) {
  const directory = applicationPath(slug, root);
  if (!directory) return undefined;
  const target = path.join(directory, "proof.json");
  // An existing draft already carries the upstream model id and the official
  // sources a reviewer checked. Never overwrite those with a guess.
  let existing;
  if (existsSync(target)) {
    try {
      existing = JSON.parse(readFileSync(target, "utf8"));
    } catch {
      existing = undefined;
    }
  }
  const [provider, ...rest] = String(slug).split("/");
  const next = {
    version: 1,
    provider: existing?.provider || provider,
    model: existing?.model || rest.join("/"),
    slug: String(slug),
    // Only the pull request that also moves the registry entry may accept an
    // application, so a local pass never promotes itself past review.
    status: existing?.status === "accepted" ? "accepted" : "draft",
    officialSources: Array.isArray(existing?.officialSources) ? existing.officialSources : [],
    testedAt: at,
    routerVersion: String(routerVersion || ""),
    checks,
  };
  mkdirSync(directory, { recursive: true });
  writeFileSync(target, `${JSON.stringify(next, undefined, 2)}\n`, "utf8");
  return target;
}

// One route, all five checks, stopping at the first failure so a route that
// cannot stream never spends quota on a delegation.
export async function verifySubagentRoute(
  slug,
  {
    baseUrl,
    secret,
    codexBin,
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

  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-verify-"));
  try {
    const { results } = await runDelegationChecks({
      slug,
      parentModel,
      codexBin,
      codexHome,
      catalogPath,
      timeoutMs,
    });
    Object.assign(checks, results);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
  return {
    slug,
    checks,
    ok: checksComplete(checks),
    routerVersion,
    durationMs: Date.now() - started,
  };
}
