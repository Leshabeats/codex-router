import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// paths.mjs resolves the state directory once at load, so the environment has
// to be in place before the cache module is imported at all.
const stateRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-cache-"));
process.env.MODEL_ROUTER_STATE_DIR = stateRoot;
process.env.CODEX_ROUTER_STATE_DIR = stateRoot;
const cachePath = path.join(stateRoot, "provider-catalog-cache.json");
const {
  catalogEntryIsStale,
  forgetProviderCatalogCache,
  readProviderCatalogCache,
  writeProviderCatalogCache,
} = await import("../src/model-catalog-cache.mjs");

test.after(() => rmSync(stateRoot, { recursive: true, force: true }));

test("a provider's published list survives for the next visit", () => {
  assert.equal(readProviderCatalogCache("deepseek"), undefined);
  writeProviderCatalogCache("deepseek", {
    discovered: ["deepseek-v5", "deepseek-v4-flash"],
    free: ["deepseek-v5"],
    contextLengths: { "deepseek-v5": 262_144, unlisted: 4096 },
    fetchedAt: "2020-01-01T00:00:00.000Z",
  });
  const entry = readProviderCatalogCache("deepseek");
  // Age is derived on every read and never persisted, so a stored document can
  // never assert its own freshness.
  assert.equal(entry.stale, true);
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).providers.deepseek.stale, undefined);
  assert.equal(catalogEntryIsStale(new Date().toISOString()), false);
  assert.equal(catalogEntryIsStale("not a timestamp"), true);
  // A list written now is trusted; the boundary is exercised from both sides
  // against a fixed clock so neither case can drift with the calendar.
  const fixedNow = Date.parse("2026-08-21T00:00:00.000Z");
  assert.equal(catalogEntryIsStale("2026-08-20T23:00:00.000Z", fixedNow), false);
  assert.equal(catalogEntryIsStale("2026-08-19T23:00:00.000Z", fixedNow), true);
  writeProviderCatalogCache("fresh-provider", { discovered: ["only"] });
  assert.equal(readProviderCatalogCache("fresh-provider").stale, false);
  assert.deepEqual(entry.discovered, ["deepseek-v5", "deepseek-v4-flash"]);
  assert.deepEqual(entry.free, ["deepseek-v5"]);
  // Sizes for models the provider did not list are not part of its answer.
  assert.deepEqual(entry.contextLengths, { "deepseek-v5": 262_144 });
  assert.equal(entry.fetchedAt, "2020-01-01T00:00:00.000Z");

  if (process.platform !== "win32") {
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(readFileSync(cachePath, "utf8"), /Bearer|api[_-]?key/i);

  assert.equal(forgetProviderCatalogCache("deepseek"), true);
  assert.equal(readProviderCatalogCache("deepseek"), undefined);
  assert.equal(forgetProviderCatalogCache("deepseek"), false);
});

test("a damaged or foreign cache document reads as a miss", () => {
  for (const contents of [
    "{",
    JSON.stringify({ version: 99, providers: { deepseek: { discovered: ["x"], fetchedAt: "now" } } }),
    JSON.stringify({ version: 1, providers: { deepseek: { discovered: [] } } }),
    JSON.stringify({ version: 1, providers: { deepseek: { discovered: ["x"] } } }),
  ]) {
    writeFileSync(cachePath, contents, "utf8");
    assert.equal(readProviderCatalogCache("deepseek"), undefined);
  }
  rmSync(cachePath, { force: true });
});

test("a provider id that is not one is never a cache key", () => {
  assert.equal(readProviderCatalogCache("../escape"), undefined);
  assert.equal(writeProviderCatalogCache("../escape", { discovered: ["x"] }), undefined);
  assert.equal(existsSync(cachePath), false);
});

test("a fixture comparison never becomes the stored answer", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-fixture-"));
  try {
    const fixture = path.join(fixtureRoot, "models.json");
    writeFileSync(fixture, JSON.stringify({ data: [{ id: "deepseek-v9-preview" }] }));
    const result = JSON.parse(execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "deepseek", "--fixture", fixture, "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MODEL_ROUTER_STATE_DIR: fixtureRoot,
          CODEX_ROUTER_STATE_DIR: fixtureRoot,
          DEEPSEEK_API_KEY: "",
        },
      },
    ));
    assert.equal(result.cached, false);
    assert.ok(result.fetchedAt);
    assert.equal(
      existsSync(path.join(fixtureRoot, "provider-catalog-cache.json")),
      false,
      "a fixture run compares against a supplied file, not against what the provider serves",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("curation with a fixture never becomes the stored answer either", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-curation-fixture-"));
  try {
    const fixture = path.join(fixtureRoot, "models.json");
    writeFileSync(fixture, JSON.stringify({ data: [{ id: "deepseek-v9-preview" }] }));
    execFileSync(
      process.execPath,
      [
        "src/curate-models.mjs",
        "deepseek",
        "--fixture",
        fixture,
        "--models",
        "deepseek-v9-preview",
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MODEL_ROUTER_STATE_DIR: fixtureRoot,
          CODEX_ROUTER_STATE_DIR: fixtureRoot,
          MODEL_ROUTER_USER_MODELS: path.join(fixtureRoot, "user-models.json"),
          DEEPSEEK_API_KEY: "",
        },
      },
    );
    assert.equal(existsSync(path.join(fixtureRoot, "provider-catalog-cache.json")), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("a stored list answers discovery without a credential or a network", () => {
  const offlineRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-offline-"));
  try {
    writeFileSync(
      path.join(offlineRoot, "provider-catalog-cache.json"),
      `${JSON.stringify({
        version: 1,
        providers: {
          deepseek: {
            fetchedAt: "2020-01-01T00:00:00.000Z",
            discovered: ["deepseek-v4-flash", "deepseek-v9-preview"],
            contextLengths: { "deepseek-v9-preview": 262_144 },
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    const environment = {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: offlineRoot,
      CODEX_ROUTER_STATE_DIR: offlineRoot,
      DEEPSEEK_API_KEY: "",
      // The state directory does not isolate the macOS Keychain or the legacy
      // state directories, so "no credential" is not something this test can
      // assert on a configured machine. Pinning the endpoint at a port nothing
      // listens on makes the refresh fail for every developer, credential or
      // not, while leaving the cached read untouched.
      DEEPSEEK_API_BASE_URL: "http://127.0.0.1:9",
      CODEX_ROUTER_NO_DISCOVERY: "1",
    };
    const cached = JSON.parse(execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "deepseek", "--json"],
      { cwd: root, encoding: "utf8", env: environment },
    ));
    assert.equal(cached.cached, true);
    assert.equal(cached.fetchedAt, "2020-01-01T00:00:00.000Z");
    // Old enough to want re-reading, and still served rather than withheld.
    assert.equal(cached.stale, true);
    assert.deepEqual(cached.unregistered, ["deepseek-v9-preview"]);
    // What is registered locally is always recomputed, never cached, so a
    // stored list can never claim a model is curated when it is not.
    assert.ok(cached.registered.includes("deepseek-v4-flash"));

    // Refreshing is the only path that reaches the provider, and when it
    // cannot be reached it must fail rather than quietly serve the stored list.
    assert.throws(() => execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "deepseek", "--json", "--refresh"],
      { cwd: root, encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"] },
    ));
  } finally {
    rmSync(offlineRoot, { recursive: true, force: true });
  }
});
