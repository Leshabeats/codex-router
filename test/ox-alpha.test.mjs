import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// These assertions describe the checked-in registry and synthetic account
// fixtures, so the machine's own models, credentials, and quota history must
// not leak in; the imports are dynamic for that reason.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "ox-alpha-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { clampModelEfforts, codexEffortVocabulary } = await import("../src/catalog.mjs");
const { MODEL_BY_SLUG, PROVIDERS } = await import("../src/model-registry.mjs");
const { officialModelDisplayName, userModelEntry } = await import("../src/user-models.mjs");
const {
  openRouterCreditsMetrics,
  openRouterKeyMetrics,
  providerAccountUsageSnapshot,
  veniceBalanceMetrics,
} = await import("../src/provider-account-usage.mjs");

// One model, six routes, and each route names it differently. Every id here was
// read from that provider's own live catalog. These assertions keep the local
// registry from drifting; only a fresh catalog read or inference probe can
// detect a later upstream rename or withdrawal.
//
// The ladder is the model's, not the reseller's: its upstream answers an
// off-ladder rung with "[1210] This model always engages in thinking and cannot
// be disabled; please use low, high, or max", and OpenRouter's and Nous's live
// catalogs agree. Venice is the one route whose catalog disagrees -- it
// advertises none/low/medium/high for this id, which is its generic shape
// rather than a model-specific one (it publishes low/high/max for GLM-5.3), and
// it contains a rung the model refuses by name. The model wins.
const ROUTES = [
  ["opencode-free/ox-alpha", "x-preview-f-free"],
  ["opencode-go/ox-alpha", "ox-alpha-free"],
  ["openrouter/ox-alpha", "stealth/ox-alpha"],
  ["commandcode/ox-alpha", "stealth/ox-alpha"],
  ["nousresearch/ox-alpha", "stealth/ox-alpha"],
  ["venice/ox-alpha", "stealth-ox-alpha"],
];

test("every Ox Alpha route records the upstream id, window and ladder the model accepts", () => {
  for (const [slug, upstreamModel] of ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    assert.equal(model.isFree, true);
    assert.deepEqual(model.reasoningLevels.map((level) => level.effort), ["low", "high", "max"]);
    assert.equal(model.defaultEffort, "max");
    // 1,048,576 tokens with 131,072 of output is what every one of these
    // catalogs advertises. autoCompact is derived from the window, and an
    // understated window makes Codex compact a session that had the room.
    assert.equal(model.contextWindow, 1_048_576);
    assert.equal(model.autoCompact, 900_000);
    assert.deepEqual(model.inputModalities, ["text", "image"]);
    // Codex can send a rung this ladder does not have -- most importantly the
    // `xhigh` an installation older than 0.143 is given in place of `max` --
    // and the upstream answers those with a 400 rather than ignoring them.
    assert.equal(model.requestProfile, "ox-alpha");
    // Native Codex collaboration has not been proven for this model.
    assert.equal(model.multiAgentVersion, undefined);
  }
});

test("only the credential-free Ox Alpha route ships announcement copy", () => {
  // Every installer sees curated `availabilityNux`, so it belongs on the one
  // route a reader can act on without first buying or connecting anything. The
  // other five still self-announce, but only once they are actually routable.
  const announced = ROUTES
    .map(([slug]) => slug)
    .filter((slug) => MODEL_BY_SLUG.get(slug).availabilityNux !== undefined);
  assert.deepEqual(announced, ["opencode-free/ox-alpha"]);
});

test("the anonymous Ox Alpha route stays inside the documented free-model rule", () => {
  // opencode-free carries no credential at all, so the registry only lets it
  // name ids the free tier documents. `x-preview-f-free` earns its place by
  // that rule and not by being checked in.
  const provider = PROVIDERS.get("opencode-free");
  assert.equal(provider.authMode, "anonymous");
  assert.equal(MODEL_BY_SLUG.get("opencode-free/ox-alpha").upstreamModel.endsWith("-free"), true);
});

test("a checked-in fragment names itself, and the official-name table only fills curated gaps", () => {
  // `officialModelDisplayName` exists because curation reads an opaque id off a
  // provider catalog and has nothing better to show. Six routes now carry the
  // same upstream ids, so letting that table overwrite a checked-in fragment
  // would flatten "Ox Alpha (OpenCode Free)" back to the curated label and lose
  // the only thing distinguishing the routes in the picker.
  assert.equal(
    MODEL_BY_SLUG.get("opencode-free/ox-alpha").displayName,
    "Ox Alpha (OpenCode Free)",
  );
  assert.equal(officialModelDisplayName("opencode-free", "x-preview-f-free"), "Ox Alpha Free");
  assert.equal(
    userModelEntry({ providerId: "opencode-free", upstreamId: "x-preview-f-free", priority: 100 })
      .displayName,
    "Ox Alpha Free",
  );
});

test("an older Codex clamps Ox Alpha to xhigh, which the forwarder must undo", () => {
  // This is the coupling that makes the request profile load-bearing rather
  // than defensive: Codex gained the `max` effort variant in 0.143.0, so on
  // anything older the catalog rewrites this model's default down to `xhigh`
  // -- a rung every Ox Alpha route answers with HTTP 400. The forwarder's
  // ox-alpha profile is what maps it back to the model's own top rung.
  const model = MODEL_BY_SLUG.get("opencode-go/ox-alpha");
  const [clamped] = clampModelEfforts([model], codexEffortVocabulary("0.142.5"));
  assert.equal(clamped.defaultEffort, "xhigh");
  assert.deepEqual(clamped.reasoningLevels.map((level) => level.effort), ["low", "high", "xhigh"]);

  const [current] = clampModelEfforts([model], codexEffortVocabulary("0.143.0"));
  assert.equal(current.defaultEffort, "max");
  assert.deepEqual(current.reasoningLevels.map((level) => level.effort), ["low", "high", "max"]);
});

test("Venice reports every pool that can fund a request", () => {
  // Venice spends whichever of the three pools has room, so showing only USD
  // would report a zero to somebody with a full VCU balance.
  assert.deepEqual(veniceBalanceMetrics({
    accessPermitted: true,
    apiTier: { id: "explorer", isCharged: false },
    balances: { USD: 12.5, VCU: 340, DIEM: 8.25 },
  }), [
    { kind: "balance", label: "USD balance", value: 12.5, currency: "USD", detail: "Funded USD credits", available: true },
    { kind: "balance", label: "VCU balance", value: 340, currency: "VCU", detail: "Venice Compute Units from staked VVV", available: true },
    { kind: "balance", label: "DIEM balance", value: 8.25, currency: "DIEM", detail: "Daily DIEM allowance", available: true },
  ]);
  // A key whose tier or spend limit blocks it still reports balances; the flag
  // is what tells the tray the money is not spendable.
  const blocked = veniceBalanceMetrics({ accessPermitted: false, balances: { USD: 3 } });
  assert.deepEqual(blocked.map((metric) => metric.available), [false]);
  assert.deepEqual(veniceBalanceMetrics({}), []);
});

test("Venice usage reads the rate-limits API and names the tier", async () => {
  const saved = process.env.VENICE_API_KEY;
  process.env.VENICE_API_KEY = "TEST_VENICE_USAGE_KEY";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["venice"],
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://api.venice.ai/api/v1/api_keys/rate_limits");
        assert.equal(options.headers.Authorization, "Bearer TEST_VENICE_USAGE_KEY");
        return new Response(JSON.stringify({
          data: {
            accessPermitted: true,
            apiTier: { id: "paid", isCharged: true },
            balances: { USD: 20, VCU: 0, DIEM: 1 },
          },
        }));
      },
    });
    assert.equal(snapshot.venice.status, "available");
    assert.equal(snapshot.venice.plan, "paid");
    assert.equal(snapshot.venice.dashboardUrl, "https://venice.ai/settings/api");
    assert.equal(snapshot.venice.metrics.length, 3);
    assert.doesNotMatch(JSON.stringify(snapshot), /TEST_VENICE_USAGE_KEY/);
  } finally {
    if (saved === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = saved;
  }
});

test("Venice usage avoids the account API for a custom endpoint", async () => {
  const savedKey = process.env.VENICE_API_KEY;
  const savedBase = process.env.VENICE_API_BASE_URL;
  process.env.VENICE_API_KEY = "TEST_VENICE_CUSTOM_KEY";
  process.env.VENICE_API_BASE_URL = "https://example.test/api/v1";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["venice"],
      fetchImpl: async () => {
        throw new Error("a custom Venice endpoint must not trigger an account API call");
      },
    });
    assert.equal(snapshot.venice.dashboardUrl, "https://venice.ai/settings/api");
    assert.match(snapshot.venice.message, /custom Venice endpoint/);
  } finally {
    if (savedKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.VENICE_API_BASE_URL;
    else process.env.VENICE_API_BASE_URL = savedBase;
  }
});

test("OpenRouter reports the key cap and, for a management key, the account pool", () => {
  assert.deepEqual(openRouterKeyMetrics({
    data: { limit: 40, usage: 10, limit_remaining: 30, limit_reset: "2026-09-01T00:00:00Z" },
  }), [{
    kind: "quota",
    label: "Key spend limit",
    usedPercent: 25,
    remainingPercent: 75,
    used: 10,
    limit: 40,
    remaining: 30,
    unit: "USD",
    resetAt: 1_788_220_800,
  }]);
  // `limit: null` is an uncapped key, which is not a quota and must not render
  // as a full one.
  assert.deepEqual(openRouterKeyMetrics({ data: { limit: null, usage: 10 } }), []);
  assert.deepEqual(openRouterCreditsMetrics({ data: { total_credits: 25, total_usage: 4 } }), [{
    kind: "balance",
    label: "Credit balance",
    value: 21,
    currency: "USD",
    detail: "Purchased 25.00 · Used 4.00",
    available: true,
  }]);
});

test("an OpenRouter inference key keeps its metrics when the credits route refuses it", async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "TEST_OPENROUTER_USAGE_KEY";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["openrouter"],
      fetchImpl: async (url) => {
        if (url.endsWith("/key")) {
          return new Response(JSON.stringify({
            data: { limit: 10, usage: 2, limit_remaining: 8, is_free_tier: false },
          }));
        }
        // OpenRouter serves /credits only to a management key.
        assert.equal(url, "https://openrouter.ai/api/v1/credits");
        return new Response("forbidden", { status: 403 });
      },
    });
    assert.equal(snapshot.openrouter.status, "available");
    assert.equal(snapshot.openrouter.plan, "Paid");
    assert.deepEqual(snapshot.openrouter.metrics.map((metric) => metric.label), ["Key spend limit"]);
    assert.doesNotMatch(JSON.stringify(snapshot), /TEST_OPENROUTER_USAGE_KEY/);
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  }
});

test("Nous Portal degrades to its dashboard because it publishes no credits route", async () => {
  const saved = process.env.NOUS_API_KEY;
  process.env.NOUS_API_KEY = "TEST_NOUS_USAGE_KEY";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["nousresearch"],
      fetchImpl: async (url) => {
        throw new Error(`Nous publishes no account API; nothing should have called ${url}`);
      },
    });
    assert.equal(
      snapshot.nousresearch.dashboardUrl,
      "https://portal.nousresearch.com/manage-subscription",
    );
    assert.deepEqual(snapshot.nousresearch.metrics, []);
    assert.match(snapshot.nousresearch.message, /only on the portal/);
    assert.doesNotMatch(JSON.stringify(snapshot), /TEST_NOUS_USAGE_KEY/);
  } finally {
    if (saved === undefined) delete process.env.NOUS_API_KEY;
    else process.env.NOUS_API_KEY = saved;
  }
});

test("an unconfigured Venice or Nous account reports setup rather than an error", async () => {
  const savedVenice = process.env.VENICE_API_KEY;
  const savedNous = process.env.NOUS_API_KEY;
  const savedDiscovery = process.env.CODEX_ROUTER_NO_DISCOVERY;
  delete process.env.VENICE_API_KEY;
  delete process.env.NOUS_API_KEY;
  process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["venice", "nousresearch"],
      fetchImpl: async () => {
        throw new Error("an unconfigured provider must not be queried");
      },
    });
    assert.equal(snapshot.venice.status, "not-configured");
    assert.equal(snapshot.nousresearch.status, "not-configured");
  } finally {
    if (savedVenice === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = savedVenice;
    if (savedNous === undefined) delete process.env.NOUS_API_KEY;
    else process.env.NOUS_API_KEY = savedNous;
    if (savedDiscovery === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    else process.env.CODEX_ROUTER_NO_DISCOVERY = savedDiscovery;
  }
});
