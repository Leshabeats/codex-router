import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-credential-store-"));
process.env.CODEX_HOME = path.join(root, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(root, "state");
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = path.join(root, "state", "provider-credentials.json");
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_MIGRATIONS = path.join(root, "state", "migrations", "provider-credentials");
for (const name of ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[name];

const {
  addCredentialReference,
  createCredentialReference,
  migrateProviderCredentialStore,
  PROVIDER_CREDENTIAL_SCHEMA_VERSION,
  readProviderCredentialStore,
  redactCredentialObject,
  redactCredentialText,
  removeCredentialReference,
  rollbackProviderCredentialStore,
  sanitizeCredentialStatus,
  sanitizedCredentialStore,
  writeProviderCredentialStore,
} = await import("../src/provider-credential-store.mjs");
const {
  credentialPaths,
  resolveProviderCredentialReference,
  writeProviderCredential,
} = await import("../src/provider-credentials.mjs");
const { PROVIDERS } = await import("../src/model-registry.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");

test.after(() => rmSync(root, { recursive: true, force: true }));

function ref(providerId = "deepseek") {
  return { type: "provider-file", providerId, target: "codex" };
}

test("credential references contain no secret and use protected metadata storage", () => {
  const filePath = path.join(root, "state", "references.json");
  const entry = addCredentialReference(
    {
      providerId: "deepseek",
      kind: "api_key",
      secretRef: ref(),
      label: "Primary DeepSeek",
      account: { alias: "main", plan: "api" },
    },
    filePath,
  );
  assert.match(entry.id, /^cred_[A-Za-z0-9_-]{16,64}$/);
  assert.equal(entry.secretRef.providerId, "deepseek");
  assert.equal(entry.secretRef.target, "codex");
  assert.equal("value" in entry, false);
  assert.equal(privateFileIsProtected(filePath), true);
  if (process.platform !== "win32") assert.equal(statSync(filePath).mode & 0o777, 0o600);
  const raw = readFileSync(filePath, "utf8");
  assert.doesNotMatch(raw, /api[_-]?key\s*[:=]/i);
  assert.deepEqual(sanitizedCredentialStore(filePath).credentials[0], sanitizeCredentialStatus(entry));
  assert.equal(removeCredentialReference(entry.id, filePath), true);
  assert.deepEqual(readProviderCredentialStore(filePath).credentials, []);
});

test("credential metadata parsing fails closed for unknown or secret-bearing fields", () => {
  assert.throws(
    () => createCredentialReference({
      providerId: "deepseek",
      kind: "api_key",
      secretRef: ref(),
      apiKey: "TEST_DO_NOT_STORE",
    }),
    /secret field apiKey/,
  );
  assert.throws(
    () => createCredentialReference({
      providerId: "deepseek",
      kind: "api_key",
      secretRef: { ...ref(), name: "NOT_ALLOWED" },
    }),
    /provider-file secretRef cannot include service or name/,
  );
  assert.throws(
    () => createCredentialReference({
      providerId: "deepseek",
      kind: "api_key",
      secretRef: { type: "environment", providerId: "deepseek", target: "codex", name: "UNRELATED_SECRET" },
    }),
    /not configured for this provider/,
  );
  assert.throws(
    () => writeProviderCredentialStore({ credentials: [], accessToken: "TEST_STORE_SECRET" }, path.join(root, "state", "unsafe.json")),
    /secret field accessToken/,
  );
});

test("redaction covers headers, URLs, errors, nested objects, and known secrets", () => {
  const text = [
    "Authorization: Bearer TEST_BEARER_TOKEN",
    "X-Api-Key: TEST_HEADER_KEY",
    "https://user:password@example.test/v1?api_key=QUERY_SECRET",
    "{\"access_token\":\"JSON_SECRET\",\"message\":\"TEST_KNOWN_SECRET\"}",
    "sk-test_secret_value",
  ].join(" ");
  const redacted = redactCredentialText(text, ["TEST_KNOWN_SECRET"]);
  assert.doesNotMatch(redacted, /TEST_BEARER_TOKEN|TEST_HEADER_KEY|password|QUERY_SECRET|JSON_SECRET|TEST_KNOWN_SECRET|sk-test_secret_value/);
  const object = redactCredentialObject({
    headers: { Authorization: "Bearer TEST_HEADER_SECRET", "X-Api-Key": "TEST_API_SECRET" },
    nested: { refreshToken: "TEST_REFRESH_SECRET", message: "TEST_KNOWN_SECRET" },
  }, ["TEST_KNOWN_SECRET"]);
  assert.equal(object.headers.Authorization, "[REDACTED]");
  assert.equal(object.headers["X-Api-Key"], "[REDACTED]");
  assert.equal(object.nested.refreshToken, "[REDACTED]");
  assert.equal(object.nested.message, "[REDACTED]");
});

test("migration discovers configured provider files without copying secret bytes", () => {
  const filePath = path.join(root, "state", "migrated.json");
  const migrationDirectory = path.join(root, "state", "migration-test");
  const providerPath = writeProviderCredential("deepseek", "TEST_MIGRATION_SECRET");
  const first = migrateProviderCredentialStore(filePath, { migrationDirectory });
  assert.equal(first.migrated, true);
  assert.equal(first.store.schemaVersion, PROVIDER_CREDENTIAL_SCHEMA_VERSION);
  assert.equal(first.store.credentials.some((entry) => entry.providerId === "deepseek"), true);
  assert.doesNotMatch(readFileSync(filePath, "utf8"), /TEST_MIGRATION_SECRET/);
  assert.equal(privateFileIsProtected(first.manifestPath), true);
  const second = migrateProviderCredentialStore(filePath, { migrationDirectory });
  assert.equal(second.migrated, false, "the second run must be idempotent");

  rollbackProviderCredentialStore(first.manifestPath, { migrationDirectory, targetPath: filePath });
  assert.equal(existsSync(filePath), false);
  assert.equal(readFileSync(providerPath, "utf8"), "TEST_MIGRATION_SECRET\n");
});

test("legacy migration preserves exact bytes and rejects changed targets", () => {
  const filePath = path.join(root, "state", "legacy.json");
  const migrationDirectory = path.join(root, "state", "legacy-migration-test");
  const legacyBytes = Buffer.from(JSON.stringify({
    version: 1,
    credentials: [{
      id: "cred_legacy_reference_123456",
      providerId: "openrouter",
      kind: "api_key",
      secretRef: { type: "provider-file" },
      state: "active",
    }],
  }) + "\n", "utf8");
  writeFileSync(filePath, legacyBytes, { mode: 0o600 });
  const migration = migrateProviderCredentialStore(filePath, { migrationDirectory });
  assert.equal(migration.legacy, true);
  assert.equal(JSON.parse(readFileSync(filePath, "utf8")).schemaVersion, PROVIDER_CREDENTIAL_SCHEMA_VERSION);
  const snapshotPath = path.join(path.dirname(migration.manifestPath), "provider-credentials.before-migration.json");
  assert.deepEqual(readFileSync(snapshotPath), legacyBytes);
  writeFileSync(filePath, Buffer.from("changed\n"));
  assert.throws(
    () => rollbackProviderCredentialStore(migration.manifestPath, { migrationDirectory, targetPath: filePath }),
    /changed after migration/,
  );
  assert.equal(readFileSync(filePath, "utf8"), "changed\n");
  writeFileSync(filePath, Buffer.from(JSON.stringify({
    schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION,
    credentials: migration.store.credentials,
  }, null, 2) + "\n"));
  rollbackProviderCredentialStore(undefined, { migrationDirectory, targetPath: filePath });
  assert.deepEqual(readFileSync(filePath), legacyBytes);
});

test("migration rejects unknown legacy fields and confined paths", () => {
  const filePath = path.join(root, "state", "bad-legacy.json");
  writeFileSync(filePath, `${JSON.stringify({ version: 1, credentials: [], opaque: "TEST_SECRET" })}\n`, { mode: 0o600 });
  assert.throws(
    () => migrateProviderCredentialStore(filePath, { migrationDirectory: path.join(root, "state", "bad-migration") }),
    /unsupported field opaque/,
  );
  assert.throws(
    () => migrateProviderCredentialStore(path.join(root, "outside", "store.json")),
    /inside the router state directory/,
  );
  const link = path.join(root, "state", "linked.json");
  symlinkSync(path.join(root, "state", "target.json"), link);
  assert.throws(
    () => addCredentialReference({ providerId: "deepseek", kind: "api_key", secretRef: ref() }, link),
    /symbolic link/,
  );
});

test("credential references are target- and provider-bound at resolution time", () => {
  const providerPath = writeProviderCredential("deepseek", "TEST_BOUND_SECRET");
  const configured = resolveProviderCredentialReference("deepseek", ref());
  assert.equal(configured?.value, "TEST_BOUND_SECRET");
  assert.equal(resolveProviderCredentialReference("deepseek", { ...ref(), target: "gemini" }), undefined);
  assert.equal(resolveProviderCredentialReference("openrouter", ref("deepseek")), undefined);
  assert.equal(resolveProviderCredentialReference("deepseek", { ...ref(), path: "/tmp/outside" }), undefined);
  assert.equal(resolveProviderCredentialReference("deepseek", {
    type: "environment",
    providerId: "deepseek",
    target: "codex",
    name: "UNRELATED_SECRET",
  }), undefined);
  assert.equal(resolveProviderCredentialReference("deepseek", {
    type: "keychain",
    providerId: "deepseek",
    target: "codex",
    service: "arbitrary-service",
  }), undefined);

  const external = path.join(root, "outside-secret.txt");
  writeFileSync(external, "TEST_SYMLINK_SECRET\n", { mode: 0o600 });
  rmSync(providerPath);
  symlinkSync(external, providerPath);
  assert.equal(resolveProviderCredentialReference("deepseek", ref()), undefined);
  assert.deepEqual(credentialPaths(PROVIDERS.get("deepseek")).filter((candidate) => candidate === providerPath), [providerPath]);
});
