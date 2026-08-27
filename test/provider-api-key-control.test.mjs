import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-api-key-control-"));
const stateDir = path.join(root, "state");
const credentialStorePath = path.join(stateDir, "provider-credentials.json");
const poolStatePath = path.join(stateDir, "provider-api-key-pools.json");
process.env.CODEX_HOME = path.join(root, "codex");
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = credentialStorePath;
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_MIGRATIONS = path.join(stateDir, "migrations", "provider-credentials");

const { addCredentialReference, readProviderCredentialStore } = await import("../src/provider-credential-store.mjs");
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
  assert.equal(storedCredentialPoolStatus("opencode-go", { poolStatePath }).credentials[0].paused, true);
  await setStoredCredentialPoolState("opencode-go", credential.id, false, { poolStatePath });

  const status = storedCredentialPoolStatus("opencode-go-messages", { poolStatePath });
  assert.equal(status.policy.strategy, "round-robin");
  assert.equal(status.credentials[0].paused, false);
  assert.equal(status.credentials[0].id, credential.id);
  assert.doesNotMatch(readFileSync(poolStatePath, "utf8"), /OPENCODE_GO_API_KEY|secretRef|Bearer/);
});

test("an allowed environment source can be registered and pooled in one operation", async () => {
  const options = {
    credentialStorePath,
    poolStatePath,
  };
  const result = await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_API_KEY", options);
  const repeated = await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_API_KEY", options);
  assert.match(result.credential.id, /^cred_/);
  assert.equal(result.credential.providerId, "opencode-go");
  assert.equal(repeated.credential.id, result.credential.id);
  const matching = readProviderCredentialStore(credentialStorePath).credentials.filter(
    (entry) => entry.providerId === "opencode-go" && entry.secretRef.name === "OPENCODE_API_KEY",
  );
  assert.equal(matching.length, 1);
  assert.equal(
    storedCredentialPoolStatus("opencode-go", { poolStatePath }).credentials
      .filter((entry) => entry.id === result.credential.id).length,
    1,
  );
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
