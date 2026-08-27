import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openPort } from "./port-pool.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-api-key-diagnostics-"));
const stateDir = path.join(testRoot, "state");
const credentialStorePath = path.join(stateDir, "provider-credentials.json");
const poolStatePath = path.join(stateDir, "provider-api-key-pools.json");
const internalKey = "test-provider-pool-diagnostics-internal-key";
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_TARGET = "codex";
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = credentialStorePath;
process.env.MODEL_ROUTER_API_KEY_POOL_PATH = poolStatePath;
delete process.env.OPENCODE_API_KEY;
delete process.env.OPENCODE_GO_API_KEY;

const { addEnvironmentCredentialToPool } = await import("../src/provider-api-key-control.mjs");
await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_API_KEY", {
  credentialStorePath,
  poolStatePath,
});

test.after(() => rmSync(testRoot, { recursive: true, force: true }));

test("doctor fails an authoritative pool whose active reference cannot resolve", { timeout: 30_000 }, () => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "src", "doctor.mjs"), "--json"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_BIN: path.join(testRoot, "missing-codex"),
    },
    encoding: "utf8",
    timeout: 25_000,
  });
  assert.notEqual(result.error?.code, "ETIMEDOUT", result.error?.message);
  const report = JSON.parse(result.stdout);
  const pool = report.checks.find((check) => check.name === "Provider API-key pools");
  assert.equal(pool.status, "fail");
  assert.match(pool.detail, /opencode-go \(unresolvable_credentials\)/);
  assert.doesNotMatch(JSON.stringify(pool), /OPENCODE_API_KEY|Bearer /);
});

test("API health returns 503 with sanitized readiness for an unusable authoritative pool", async () => {
  const port = await openPort();
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "api-forwarder.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(port),
      MODEL_ROUTER_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const deadline = Date.now() + 8_000;
    let response;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`forwarder exited: ${stderr}`);
      try {
        response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { Authorization: `Bearer ${internalKey}` },
        });
        break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(response, `forwarder never answered: ${stderr}`);
    assert.equal(response.status, 503);
    const health = await response.json();
    assert.equal(health.ok, false);
    assert.deepEqual(health.providers["opencode-go"].api_key_pool, {
      configured: true,
      valid: true,
      usable: false,
      reason: "unresolvable_credentials",
      credential_count: 1,
      eligible_credential_count: 1,
      resolvable_credential_count: 0,
    });
    assert.doesNotMatch(JSON.stringify(health), /OPENCODE_API_KEY|Bearer /);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
});
