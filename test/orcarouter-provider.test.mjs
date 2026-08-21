import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { freeModelIds, modelIds } from "../src/model-discovery.mjs";
import { LISTED_MODELS, PROVIDERS } from "../src/model-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function catalogFixture() {
  return {
    data: [
      {
        id: "orcarouter/free",
        supported_endpoint_types: ["openai", "openai-response", "anthropic"],
      },
      {
        id: "qwen/qwen3.8-27b-free",
        supported_endpoint_types: ["openai", "openai-response"],
        context_length: 65_536,
        pricing: { request: "0.000000" },
      },
      {
        id: "vendor/zero-token-price",
        supported_endpoint_types: ["openai"],
        context_length: 200_000,
        pricing: { prompt: "0", completion: 0 },
      },
      {
        id: "vendor/paid",
        supported_endpoint_types: ["openai"],
        pricing: { prompt: "0.000001", completion: "0.000002" },
      },
      {
        id: "vendor/image-only-free",
        supported_endpoint_types: ["image"],
        pricing: { request: "0" },
      },
      {
        id: "vendor/unspecified-surface-free",
        supported_endpoint_types: null,
        pricing: { request: "0" },
      },
      {
        id: "vendor/unspecified-paid",
        supported_endpoint_types: null,
        pricing: { prompt: "0.000001", completion: "0.000002" },
      },
    ],
  };
}

test("OrcaRouter is a credentialed catalog-only OpenAI provider", () => {
  const provider = PROVIDERS.get("orcarouter");
  assert.equal(provider.displayName, "OrcaRouter");
  assert.equal(provider.baseUrl, "https://api.orcarouter.ai/v1");
  assert.equal(provider.baseUrlEnv, "ORCAROUTER_BASE_URL");
  assert.deepEqual(provider.credential.environment, ["ORCAROUTER_API_KEY"]);
  assert.equal(provider.credential.file, "orcarouter-api-key.secret");
  assert.deepEqual(provider.credential.keychainServices, ["codex-router-orcarouter"]);
  assert.equal(LISTED_MODELS.some(({ provider: id }) => id === "orcarouter"), false);
});

test("OrcaRouter discovery keeps callable chat models and identifies the free subset", () => {
  const provider = PROVIDERS.get("orcarouter");
  const payload = catalogFixture();
  assert.deepEqual(modelIds(payload, provider), [
    "orcarouter/free",
    "qwen/qwen3.8-27b-free",
    "vendor/paid",
    "vendor/unspecified-surface-free",
    "vendor/zero-token-price",
  ]);
  assert.deepEqual(freeModelIds(payload, provider), [
    "orcarouter/free",
    "qwen/qwen3.8-27b-free",
    "vendor/unspecified-surface-free",
    "vendor/zero-token-price",
  ]);
});

test("--free-only additively curates the live free OrcaRouter catalog", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "orcarouter-curation-test-"));
  try {
    const fixture = path.join(testRoot, "models.json");
    const userModels = path.join(testRoot, "user-models.json");
    writeFileSync(fixture, JSON.stringify(catalogFixture()));
    writeFileSync(userModels, JSON.stringify({
      version: 1,
      models: [{
        provider: "orcarouter",
        upstreamModel: "vendor/existing-paid",
        slug: "orcarouter/vendor-existing-paid",
        gatewayModel: "orcarouter-vendor-existing-paid",
        displayName: "vendor/existing-paid (OrcaRouter)",
        description: "Locally curated OrcaRouter model",
        contextWindow: 131072,
        autoCompact: 111411,
        inputModalities: ["text"],
        priority: 99,
        compHash: "orcarouter-vendor-existing-paid-user-v1"
      }],
    }));
    const result = spawnSync(process.execPath, [
      path.join(root, "src", "curate-models.mjs"),
      "orcarouter",
      "--fixture",
      fixture,
      "--free-only",
      "--no-apply",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_ROUTER_USER_MODELS: userModels,
        MODEL_ROUTER_STATE_DIR: testRoot,
        ORCAROUTER_API_KEY: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const stored = JSON.parse(readFileSync(userModels, "utf8"));
    assert.deepEqual(
      stored.models.map((model) => model.upstreamModel),
      [
        "vendor/existing-paid",
        "orcarouter/free",
        "qwen/qwen3.8-27b-free",
        "vendor/unspecified-surface-free",
        "vendor/zero-token-price",
      ],
    );
    const qwen = stored.models.find((model) => model.upstreamModel === "qwen/qwen3.8-27b-free");
    assert.equal(qwen.contextWindow, 65_536);
    assert.equal(qwen.autoCompact, 55_705);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
