import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-api-key-control-"));
const stateDir = path.join(root, "state");
const credentialStorePath = path.join(stateDir, "provider-credentials.json");
const poolStatePath = path.join(stateDir, "provider-api-key-pools.json");
process.env.CODEX_HOME = path.join(root, "codex");
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = credentialStorePath;
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_MIGRATIONS = path.join(stateDir, "migrations", "provider-credentials");
process.env.MODEL_ROUTER_API_KEY_POOL_PATH = poolStatePath;

const { addCredentialReference, readProviderCredentialStore } = await import("../src/provider-credential-store.mjs");
const { upsertProviderApiKey } = await import("../src/provider-api-key-pool.mjs");
const { withModelOverlayLock } = await import("../src/model-overlay-lock.mjs");
const {
  addEnvironmentCredentialToPool,
  addStoredCredentialToPool,
  deleteStoredCredentialPool,
  removeStoredCredentialFromPool,
  setStoredCredentialPoolPolicy,
  setStoredCredentialPoolState,
  storedCredentialPoolStatus,
} = await import("../src/provider-api-key-control.mjs");

test.after(() => rmSync(root, { recursive: true, force: true }));

test("credential lifecycle control is provider-bound and never stores secret bytes", async () => {
  const credential = addCredentialReference({
    providerId: "opencode-go",
    kind: "api_key",
    secretRef: { type: "environment", name: "OPENCODE_GO_API_KEY" },
  }, credentialStorePath);

  await assert.rejects(
    addStoredCredentialToPool("openrouter", credential.id, { credentialStorePath, poolStatePath }),
    /not an API key for openrouter/,
  );
  await addStoredCredentialToPool("opencode-go-messages", credential.id, { credentialStorePath, poolStatePath });
  await setStoredCredentialPoolPolicy("opencode-go", "round-robin", { poolStatePath });
  await setStoredCredentialPoolState("opencode-go", credential.id, true, { poolStatePath });
  const paused = storedCredentialPoolStatus("opencode-go", { poolStatePath }).credentials[0];
  assert.equal(paused.paused, true);
  await addStoredCredentialToPool("opencode-go", credential.id, { credentialStorePath, poolStatePath });
  assert.deepEqual(
    storedCredentialPoolStatus("opencode-go", { poolStatePath }).credentials[0],
    paused,
    "re-adding an existing stored reference must not resume or reset it",
  );
  await setStoredCredentialPoolState("opencode-go", credential.id, false, { poolStatePath });

  const status = storedCredentialPoolStatus("opencode-go-messages", { poolStatePath });
  assert.equal(status.policy.strategy, "round-robin");
  assert.equal(status.credentials[0].paused, false);
  assert.equal(status.credentials[0].id, credential.id);
  assert.deepEqual(status.readiness, {
    usable: false,
    reason: "unresolvable_credentials",
    credentialCount: 1,
    eligibleCredentialCount: 1,
    resolvableCredentialCount: 0,
  });
  assert.doesNotMatch(readFileSync(poolStatePath, "utf8"), /OPENCODE_GO_API_KEY|secretRef|Bearer/);
  assert.doesNotMatch(JSON.stringify(status), /OPENCODE_GO_API_KEY|Bearer/);
});

test("an allowed environment source can be registered and pooled in one operation", async () => {
  const options = {
    credentialStorePath,
    poolStatePath,
  };
  const result = await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_API_KEY", options);
  await upsertProviderApiKey("opencode-go", {
    id: result.credential.id,
    priority: 73,
    quota: {
      limit: 1_000,
      remaining: 417,
      observedAt: "2026-08-27T12:00:00.000Z",
    },
    health: {
      state: "healthy",
      lastSuccessAt: "2026-08-27T12:00:00.000Z",
      lastStatus: 200,
    },
    requestCount: 29,
    tokenCount: 31_337,
  }, { filePath: poolStatePath });
  await setStoredCredentialPoolState("opencode-go", result.credential.id, true, { poolStatePath });
  const beforeRepeat = storedCredentialPoolStatus("opencode-go", { poolStatePath }).credentials
    .find((entry) => entry.id === result.credential.id);
  const repeated = await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_API_KEY", options);
  assert.match(result.credential.id, /^cred_/);
  assert.equal(result.credential.providerId, "opencode-go");
  assert.equal(repeated.credential.id, result.credential.id);
  assert.deepEqual(
    storedCredentialPoolStatus("opencode-go", { poolStatePath }).credentials
      .find((entry) => entry.id === result.credential.id),
    beforeRepeat,
    "idempotent add-env must preserve pause, health, quota, priority, and counters",
  );
  const matching = readProviderCredentialStore(credentialStorePath).credentials.filter(
    (entry) => entry.providerId === "opencode-go" && entry.secretRef.name === "OPENCODE_API_KEY",
  );
  assert.equal(matching.length, 1);
  assert.equal(
    storedCredentialPoolStatus("opencode-go", { poolStatePath }).credentials
      .filter((entry) => entry.id === result.credential.id).length,
    1,
  );
  process.env.OPENCODE_GO_API_KEY = "TEST_READY_POOL_KEY";
  try {
    assert.deepEqual(
      storedCredentialPoolStatus("opencode-go", options).readiness,
      {
        usable: true,
        reason: "ready",
        credentialCount: 2,
        eligibleCredentialCount: 1,
        resolvableCredentialCount: 1,
      },
    );
  } finally {
    delete process.env.OPENCODE_GO_API_KEY;
  }
  await assert.rejects(
    addEnvironmentCredentialToPool("opencode-go", "UNDECLARED_SECRET", {
      credentialStorePath,
      poolStatePath,
    }),
    /secretRef\.name is not configured for this provider/,
  );
  await removeStoredCredentialFromPool("opencode-go", result.credential.id, { poolStatePath });
  assert.equal(
    readProviderCredentialStore(credentialStorePath).credentials.some(
      (entry) => entry.id === result.credential.id,
    ),
    true,
    "removing a pool member must preserve its shared credential reference",
  );
  await deleteStoredCredentialPool("opencode-go", { poolStatePath });
  assert.equal(storedCredentialPoolStatus("opencode-go", { poolStatePath }).configured, false);
});

function runControl(arguments_) {
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "control.mjs"), ...arguments_], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      CODEX_HOME: process.env.CODEX_HOME,
      CODEX_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: credentialStorePath,
      MODEL_ROUTER_PROVIDER_CREDENTIAL_MIGRATIONS: process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_MIGRATIONS,
      MODEL_ROUTER_API_KEY_POOL_PATH: poolStatePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve) => {
    child.once("exit", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, completed };
}

test("key-pool status stays read-only while mutations wait for publication ownership", { timeout: 30_000 }, async () => {
  rmSync(poolStatePath, { force: true });
  let mutation;
  await withModelOverlayLock(async () => {
    const status = await runControl(["key-pool", "opencode-go", "status"]).completed;
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).readiness.reason, "pool_not_configured");
    assert.equal(existsSync(poolStatePath), false, "status must not create pool state");

    mutation = runControl(["key-pool", "opencode-go", "add-env", "OPENCODE_API_KEY"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(mutation.child.exitCode, null, "the mutation must wait for the model publication lock");
    assert.equal(existsSync(poolStatePath), false, "pool state must not change before publication ownership");
  });

  const result = await mutation.completed;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(poolStatePath), true);
});
