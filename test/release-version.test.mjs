import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nextBetaVersion } from "../scripts/next-beta-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("automatic releases advance the current beta", () => {
  assert.equal(nextBetaVersion("0.4.0-beta.2"), "0.4.0-beta.3");
  assert.equal(nextBetaVersion("12.3.4-beta.99"), "12.3.4-beta.100");
});

test("a stable version starts the next patch beta series", () => {
  assert.equal(nextBetaVersion("1.2.3"), "1.2.4-beta.1");
});

test("unknown prerelease channels fail closed", () => {
  assert.throws(() => nextBetaVersion("1.2.3-rc.1"), /Cannot automatically advance/);
  assert.throws(() => nextBetaVersion("main"), /Cannot automatically advance/);
});

test("releases are tag-driven and validate every asset before publishing", () => {
  const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const release = readFileSync(
    path.join(root, ".github", "workflows", "release.yml"),
    "utf8",
  );

  // CI remains validation for main and pull requests. Publishing is a separate
  // tag-triggered workflow, so an ordinary main push cannot create a release.
  assert.match(ci, /push:\s*\n\s+branches: \[main\]/);
  assert.match(ci, /pull_request:\s*\{\}/);
  assert.doesNotMatch(ci, /uses:\s+\.\/\.github\/workflows\/release\.yml/);
  assert.match(release, /push:\s*\n\s+tags:\s*\n\s+- "v\*"/);
  assert.doesNotMatch(release, /workflow_call:/);
  assert.doesNotMatch(release, /branches:\s*\[?main/);
  assert.match(release, /Verify tag matches package version/);
  assert.match(release, /test "v\$package_version" = "\$GITHUB_REF_NAME"/);
  assert.ok(
    release.indexOf("- run: npm test") < release.indexOf("gh release create"),
    "the release must pass the full test suite before publishing assets",
  );
  assert.match(release, /git archive --format=tar\.gz/);
  assert.match(release, /git archive --format=zip/);
  assert.match(release, /sha256sum codex-router-\* > SHA256SUMS/);
  assert.match(release, /actions\/attest-build-provenance@v4/);
  assert.match(release, /gh release create "\$GITHUB_REF_NAME" dist\/\* --verify-tag/);
  assert.match(release, /generate-formula\.mjs/);
  assert.match(release, /git push origin main/);
  assert.doesNotMatch(release, /HOMEBREW_TAP_TOKEN/);
});
