import assert from "node:assert/strict";
import test from "node:test";

import { CHECKED_IN_MODELS } from "../src/model-registry.mjs";
import {
  MAX_SUBAGENT_ATTEMPTS,
  MAX_SUBAGENT_WEIGHT,
  normalizeSubagentChain,
  rankSubagentCandidates,
  selectWeightedSubagentTarget,
  subagentEligibility,
  subagentFallbackPlan,
  subagentTargetDiagnostic,
  verifiedSubagentTargets,
} from "../src/subagent-routing.mjs";

const SETTINGS = { mode: "proven", enabled: [], disabled: [] };
const AUTHORITY = [
  {
    slug: "shared/model",
    provider: "provider-a",
    multiAgentVersion: "v2",
    inputModalities: ["text"],
    contextWindow: 100_000,
  },
  {
    slug: "shared/model",
    provider: "provider-b",
    multiAgentVersion: "v2",
    inputModalities: ["text", "image"],
    contextWindow: 100_000,
  },
  {
    slug: "other/model",
    provider: "provider-c",
    multiAgentVersion: "v2",
    inputModalities: ["text"],
    contextWindow: 100_000,
  },
  {
    slug: "old/model",
    provider: "provider-old",
    multiAgentVersion: "v1",
    inputModalities: ["text", "image"],
    contextWindow: 100_000,
  },
  {
    slug: "fourth/model",
    provider: "provider-d",
    multiAgentVersion: "v2",
    inputModalities: ["text"],
    contextWindow: 100_000,
  },
];

test("only checked-in v2 records can authorize a target", () => {
  assert.equal(
    subagentEligibility(
      {
        slug: "old/model",
        provider: "provider-old",
        multiAgentVersion: "v2",
      },
      { authority: AUTHORITY, settings: SETTINGS },
    ),
    "unverified-model",
  );
  assert.equal(
    subagentEligibility(
      {
        slug: "shared/model",
        provider: "provider-a",
        multiAgentVersion: "v2",
        supportsVision: true,
      },
      { authority: AUTHORITY, settings: SETTINGS, requiredCapabilities: ["vision"] },
    ),
    "missing-capability:vision",
  );
  assert.equal(
    subagentEligibility(
      { slug: "shared/model", provider: "provider-b", multiAgentVersion: "v1" },
      { authority: AUTHORITY, settings: SETTINGS, requiredCapabilities: ["vision"] },
    ),
    undefined,
  );
});

test("chain normalization requires a model and bounds duplicate weights", () => {
  assert.deepEqual(
    normalizeSubagentChain([
      { provider: "provider-a", weight: 2 },
      { model: "shared/model", provider: "provider-a", weight: MAX_SUBAGENT_WEIGHT + 9 },
      { model: "shared/model", provider: "provider-a", weight: 2 },
      { model: "shared/model", weight: 0 },
    ]),
    [
      { model: "shared/model", provider: "provider-a", weight: MAX_SUBAGENT_WEIGHT },
      { model: "shared/model", weight: 1 },
    ],
  );
});

test("rank preserves provider identity and ignores caller capability claims", () => {
  const ranked = rankSubagentCandidates(
    [
      { ...AUTHORITY[0], supportsVision: true },
      { ...AUTHORITY[0], supportsVision: true },
      { ...AUTHORITY[1], multiAgentVersion: "v1" },
      { ...AUTHORITY[2] },
      { slug: "invented/model", provider: "provider-x", multiAgentVersion: "v2" },
    ],
    {
      authority: AUTHORITY,
      settings: SETTINGS,
      chain: [
        { model: "shared/model", provider: "provider-b", weight: 2 },
        "shared/model",
        "other/model",
      ],
    },
  );
  assert.deepEqual(
    ranked.map((entry) => `${entry.slug}@${entry.provider}`),
    ["shared/model@provider-b", "other/model@provider-c"],
  );
  assert.equal(ranked[0].model.supportsVision, undefined);
  assert.equal(ranked[0].weight, 2);
});

test("ambiguous bare model names do not lose provider identity", () => {
  const ranked = rankSubagentCandidates(
    [AUTHORITY[0], AUTHORITY[1]],
    { authority: AUTHORITY, settings: SETTINGS, chain: ["shared/model"] },
  );
  assert.deepEqual(ranked, []);
});

test("weighted selection is deterministic without expanding the cycle", () => {
  const ranked = rankSubagentCandidates(
    [AUTHORITY[0], AUTHORITY[2]],
    {
      authority: AUTHORITY,
      settings: SETTINGS,
      chain: [
        { model: "shared/model", provider: "provider-a", weight: 2 },
        { model: "other/model", provider: "provider-c", weight: 1 },
      ],
    },
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((selectionIndex) => selectWeightedSubagentTarget(ranked, { selectionIndex }).provider),
    ["provider-a", "provider-a", "provider-c", "provider-a"],
  );
});

test("fallback is bounded, pre-response, and excludes only the exact failed identity", () => {
  const ranked = rankSubagentCandidates(
    [AUTHORITY[0], AUTHORITY[1], AUTHORITY[2], AUTHORITY[4]],
    { authority: AUTHORITY, settings: SETTINGS },
  );
  assert.equal(
    subagentFallbackPlan(ranked, { committed: true, failureKind: "timeout" }),
    undefined,
  );
  assert.equal(
    subagentFallbackPlan(ranked, { failureKind: "invalid-request" }),
    undefined,
  );
  const plan = subagentFallbackPlan(ranked, {
    failureKind: "connection",
    failedTarget: { slug: "shared/model", provider: "provider-a" },
    maxAttempts: 99,
  });
  assert.equal(plan.target.provider, "provider-b");
  assert.deepEqual(plan.fallbacks.map((entry) => entry.provider), ["provider-c", "provider-d"]);
  assert.equal(plan.maxAttempts, MAX_SUBAGENT_ATTEMPTS);
  assert.equal(plan.attempts.length, MAX_SUBAGENT_ATTEMPTS);
});

test("verified target list follows the actual checked-in v2 delegation contract", () => {
  const targets = verifiedSubagentTargets({
    authority: CHECKED_IN_MODELS,
    settings: SETTINGS,
  });
  assert.ok(targets.length > 0);
  assert.ok(targets.every((entry) => entry.model.multiAgentVersion === "v2"));
  assert.ok(targets.every((entry) => CHECKED_IN_MODELS.includes(entry.model)));
});

test("target diagnostics contain only identity and bounded attempt metadata", () => {
  assert.deepEqual(
    subagentTargetDiagnostic({
      agentId: "P11",
      target: { model: { slug: "shared/model", provider: "provider-b" } },
      attempt: 1,
      source: "chain",
    }),
    {
      agentId: "P11",
      target: "shared/model",
      provider: "provider-b",
      attempt: 1,
      source: "chain",
    },
  );
});
