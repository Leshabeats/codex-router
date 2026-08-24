import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-dashboard-safe-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
writeFileSync(
  path.join(stateDir, "enabled-providers.json"),
  JSON.stringify({ version: 1, providers: ["deepseek"] }),
  { mode: 0o600 },
);

const { routerDashboardState } = await import("../src/router-dashboard.mjs");

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

test("dashboard snapshot contains only validated route metadata", () => {
  const snapshot = routerDashboardState({
    models: [{
      slug: "deepseek/v4",
      displayName: "DeepSeek V4",
      provider: "deepseek",
      endpoint: "https://provider.invalid/v1",
      credentialRef: "secret-account-id",
      visible: false,
    }],
  });

  const deepseek = snapshot.providers.find((provider) => provider.id === "deepseek");
  assert.equal(deepseek?.enabled, true);
  assert.deepEqual(snapshot.models, [{
    slug: "deepseek/v4",
    displayName: "DeepSeek V4",
    provider: "deepseek",
    enabled: true,
    visible: false,
  }]);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /provider\.invalid|secret-account-id|credential|endpoint|session|account/i);
});

test("dashboard provider rows do not expose protocol variants as extra routes", () => {
  const snapshot = routerDashboardState({ models: [] });
  const ids = snapshot.providers.map((provider) => provider.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(snapshot.providers.every((provider) => provider.kind && provider.displayName));
  assert.deepEqual(snapshot.enabledProviders, ["deepseek"]);
});
