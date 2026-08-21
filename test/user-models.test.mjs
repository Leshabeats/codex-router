import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "user-models-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const { userModelEntry, readUserModels, writeUserModels, USER_MODELS_PATH } = await import(
  "../src/user-models.mjs"
);

test("userModelEntry fills conservative picker metadata", () => {
  const entry = userModelEntry({
    providerId: "ollama-cloud",
    upstreamId: "gpt-oss:120b",
    requestProfile: "ollama-cloud",
    priority: 101,
  });
  assert.equal(entry.slug, "ollama-cloud/gpt-oss:120b");
  assert.equal(entry.gatewayModel, "ollama-cloud-gpt-oss-120b");
  assert.equal(entry.upstreamModel, "gpt-oss:120b");
  assert.equal(entry.provider, "ollama-cloud");
  assert.equal(entry.listed, true);
  assert.equal(entry.priority, 101);
  assert.equal(entry.requestProfile, "ollama-cloud");
  assert.equal(entry.defaultEffort, "high");
  assert.ok(entry.reasoningLevels.some((level) => level.effort === "high"));
  assert.ok(Number.isInteger(entry.contextWindow) && entry.contextWindow >= 1);
  assert.ok(entry.autoCompact >= 1 && entry.autoCompact <= entry.contextWindow);
  assert.deepEqual(entry.inputModalities, ["text"]);
  assert.equal(entry.compHash, "ollama-cloud-gpt-oss-120b-user-v1");
  assert.equal(entry.requiresTrailingUserTurn, undefined);
  assert.ok(entry.displayName.includes("gpt-oss:120b"));
  assert.ok(entry.description.length > 0);
});

test("OpenCode's opaque free preview id is presented as Ox Alpha Free", () => {
  const entry = userModelEntry({
    providerId: "opencode-free",
    upstreamId: "x-preview-f-free",
    priority: 100,
  });
  assert.equal(entry.slug, "opencode-free/x-preview-f-free");
  assert.equal(entry.upstreamModel, "x-preview-f-free");
  assert.equal(entry.displayName, "Ox Alpha Free");
});

test("curation metadata can set sizing and the effort ladder", () => {
  const entry = userModelEntry({
    providerId: "deepseek",
    upstreamId: "deepseek-effort-test",
    priority: 100,
    metadata: {
      contextWindow: 262144,
      autoCompact: 222822,
      inputModalities: ["text", "image"],
      reasoningLevels: [
        { effort: "low", description: "Quick reasoning" },
        { effort: "medium", description: "Balanced reasoning" },
        { effort: "high", description: "Deep reasoning" },
      ],
      defaultEffort: "medium",
      serviceTiers: [{ id: "priority", name: "Fast" }],
      requiresTrailingUserTurn: true,
      isFree: true,
    },
  });
  assert.equal(entry.contextWindow, 262144);
  assert.deepEqual(entry.inputModalities, ["text", "image"]);
  assert.equal(entry.reasoningLevels.length, 3);
  assert.equal(entry.defaultEffort, "medium");
  assert.deepEqual(entry.serviceTiers, [{ id: "priority", name: "Fast" }]);
  assert.equal(entry.requiresTrailingUserTurn, true);
  assert.equal(entry.isFree, true);
});

test("curation metadata can expose provider-verified reasoning summaries", () => {
  const entry = userModelEntry({
    providerId: "chutes",
    upstreamId: "moonshotai/Kimi-K3-TEE",
    priority: 100,
    metadata: {
      supportsReasoningSummaries: true,
      defaultReasoningSummary: "auto",
    },
  });
  assert.equal(entry.supportsReasoningSummaries, true);
  assert.equal(entry.defaultReasoningSummary, "auto");
});

test("curation metadata cannot replace identity or routing fields", () => {
  const entry = userModelEntry({
    providerId: "deepseek",
    upstreamId: "deepseek-guard-test",
    priority: 100,
    metadata: {
      slug: "evil/override",
      gatewayModel: "evil-gateway",
      upstreamModel: "evil-upstream",
      provider: "evil",
      requestProfile: "evil-profile",
      contextWindow: 200000,
    },
  });
  assert.equal(entry.slug, "deepseek/deepseek-guard-test");
  assert.equal(entry.gatewayModel, "deepseek-deepseek-guard-test");
  assert.equal(entry.upstreamModel, "deepseek-guard-test");
  assert.equal(entry.provider, "deepseek");
  assert.equal(entry.requestProfile, undefined);
  assert.equal(entry.contextWindow, 200000);
});

test("userModelEntry omits requestProfile when the provider has none", () => {
  const entry = userModelEntry({
    providerId: "zai-coding",
    upstreamId: "glm-4.7",
    priority: 100,
  });
  assert.equal(entry.requestProfile, undefined);
});

test("user models round-trip through the protected state file", () => {
  const entries = [
    userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-vl-test", priority: 100 }),
  ];
  writeUserModels(entries);
  assert.deepEqual(readUserModels(), entries);
  assert.ok(USER_MODELS_PATH.startsWith(stateDir));
});

test("readUserModels returns an empty list when the file is absent or invalid", () => {
  writeFileSync(USER_MODELS_PATH, "not-json\n");
  assert.deepEqual(readUserModels(), []);
});

test("registry merges valid user models and skips collisions", async () => {
  const entries = [
    userModelEntry({
      providerId: "deepseek",
      upstreamId: "deepseek-user-test",
      priority: 100,
      metadata: { availabilityNux: "Now available through your DeepSeek key." },
    }),
    // Collides with a built-in slug and must be skipped, not fatal.
    { ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-v4-pro", priority: 101 }) },
    // Unknown provider must be skipped, not fatal.
    userModelEntry({ providerId: "no-such-provider", upstreamId: "x-model", priority: 102 }),
    // Announcement copy must be a non-empty string; a blank one is skipped.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-blank-nux", priority: 103 }),
      availabilityNux: "   ",
    },
    // Search modes are a closed set. Unknown modes must not advertise a
    // search path the request path cannot serve.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-bad-search", priority: 106 }),
      searchTool: { mode: "emulated" },
    },
    // Standalone search is Codex-side execution; it remains an explicit
    // per-model opt-in rather than a provider-wide default.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-standalone-search", priority: 110 }),
      searchTool: { mode: "standalone" },
    },
    // Capability toggles are booleans; a truthy string must not slip through.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-bad-detail", priority: 107 }),
      supportsImageDetailOriginal: "yes",
    },
    // Destructive trailing-turn handling is an explicit boolean capability.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-bad-trailing-turn", priority: 111 }),
      requiresTrailingUserTurn: "yes",
    },
    // Reasoning-summary capability fields must agree. A valid enum on its own
    // must not make the catalog claim summaries for a model that does not
    // explicitly support them.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-summary-without-support", priority: 108 }),
      defaultReasoningSummary: "auto",
    },
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-invalid-summary-support", priority: 109 }),
      supportsReasoningSummaries: "yes",
      defaultReasoningSummary: "auto",
    },
    // An upgrade prompt pointing at a slug the merged registry does not carry
    // can never render, so the entry is skipped.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-bad-upgrade", priority: 104 }),
      upgradeTo: { model: "no-such/model", markdown: "Switch now" },
    },
    // A prompt targeting a listed checked-in model is kept.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-good-upgrade", priority: 105 }),
      upgradeTo: { model: "deepseek/deepseek-v4-pro", markdown: "V4 Pro supersedes this preview." },
    },
  ];
  writeUserModels(entries);
  const registry = await import("../src/model-registry.mjs");
  const slugs = registry.MODELS.map((model) => model.slug);
  assert.ok(slugs.includes("deepseek/deepseek-user-test"));
  assert.equal(slugs.filter((slug) => slug === "deepseek/deepseek-v4-pro").length, 1);
  assert.ok(!slugs.includes("no-such-provider/x-model"));
  assert.ok(!slugs.includes("deepseek/deepseek-blank-nux"));
  assert.ok(!slugs.includes("deepseek/deepseek-bad-search"));
  assert.ok(slugs.includes("deepseek/deepseek-standalone-search"));
  assert.ok(!slugs.includes("deepseek/deepseek-bad-detail"));
  assert.ok(!slugs.includes("deepseek/deepseek-bad-trailing-turn"));
  assert.ok(!slugs.includes("deepseek/deepseek-summary-without-support"));
  assert.ok(!slugs.includes("deepseek/deepseek-invalid-summary-support"));
  assert.ok(!slugs.includes("deepseek/deepseek-bad-upgrade"));
  assert.deepEqual(
    registry.MODEL_BY_SLUG.get("deepseek/deepseek-good-upgrade").upgradeTo,
    { model: "deepseek/deepseek-v4-pro", markdown: "V4 Pro supersedes this preview." },
  );
  assert.ok(registry.MODEL_BY_GATEWAY_ID.has("deepseek-deepseek-user-test"));
  assert.ok(registry.USER_MODEL_WARNINGS.length >= 4);
  const merged = registry.MODEL_BY_SLUG.get("deepseek/deepseek-user-test");
  assert.equal(merged.listed, true);
  assert.equal(merged.availabilityNux, "Now available through your DeepSeek key.");
  assert.deepEqual(
    registry.MODEL_BY_SLUG.get("deepseek/deepseek-standalone-search").searchTool,
    { mode: "standalone" },
  );
});
