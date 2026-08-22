import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { validateV2AgentApplications } = await import("../scripts/check-v2-agent-applications.mjs");

function application(root, proof, markdown = "# Proof\n\n## Evidence\n\nSummary only.\n") {
  const folder = path.join(root, proof.provider, proof.model);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "proof.md"), markdown);
  writeFileSync(path.join(folder, "proof.json"), JSON.stringify(proof, null, 2));
}

function acceptedProof() {
  const now = "2026-08-22T00:00:00.000Z";
  return {
    version: 1,
    provider: "example",
    model: "alpha",
    slug: "example/alpha",
    status: "accepted",
    officialSources: ["https://docs.example.test/models/alpha"],
    testedAt: now,
    routerVersion: "0.4.0-beta.4",
    checks: Object.fromEntries(
      ["streaming", "toolCall", "encryptedRelay", "markerReturn", "sameThreadFollowUp"]
        .map((name) => [name, { outcome: "pass", status: 200, observedAt: now }]),
    ),
  };
}

test("an accepted application requires all native collaboration evidence", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "v2-agent-application-test-"));
  application(root, acceptedProof());
  assert.deepEqual(validateV2AgentApplications(root), [{
    provider: "example", model: "alpha", slug: "example/alpha", status: "accepted",
  }]);
});

test("a draft may be submitted before live evidence exists", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "v2-agent-draft-test-"));
  application(root, {
    version: 1,
    provider: "example",
    model: "beta",
    slug: "example/beta",
    status: "draft",
  });
  assert.equal(validateV2AgentApplications(root)[0].status, "draft");
});

test("proofs fail closed on missing checks, identity drift, and credential-shaped content", () => {
  const missing = mkdtempSync(path.join(os.tmpdir(), "v2-agent-missing-test-"));
  const incomplete = acceptedProof();
  delete incomplete.checks.markerReturn;
  application(missing, incomplete);
  assert.throws(() => validateV2AgentApplications(missing), /markerReturn/);

  const secret = mkdtempSync(path.join(os.tmpdir(), "v2-agent-secret-test-"));
  application(secret, acceptedProof(), "# Proof\n\n## Evidence\n\nBearer token_abcdefghijklmnop\n");
  assert.throws(() => validateV2AgentApplications(secret), /credentials or bearer/);
});
