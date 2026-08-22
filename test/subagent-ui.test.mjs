import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("desktop subagent settings show native and unverified enabled models", () => {
  const source = readFileSync(path.join(root, "apps", "desktop", "ui", "app.js"), "utf8");
  assert.match(source, /const subagentModels = enabledModels;/);
  assert.doesNotMatch(source, /!model\.native\s*&&\s*model\.visible/);
  assert.match(source, /selectedSubagents\.has\(model\.slug\)/);
  const activeCapability = source.slice(
    source.indexOf("const isSubagentOn = (model)"),
    source.indexOf("const subagentRow = (model)"),
  );
  assert.match(source, /const isCertifiedV2 = \(model\) => subagentCertification\(model\) === "v2"/);
  assert.match(activeCapability, /isCertifiedV2\(model\)/);
  assert.doesNotMatch(activeCapability, /selectedSubagents/);
  assert.match(source, /model\.multiAgentVersion === "v1" \? "v1" : "unknown"/);
  assert.match(source, /: certified\s*\? t\("models\.provenV2"\)/);
  assert.match(source, /\["candidate", "experimental", "proven"\]\.includes\(proof\?\.status\)/);
  assert.match(source, /const testActive = !certified && !knownV1 && !candidate &&\s*selectedSubagents\.has\(model\.slug\)/);
  assert.doesNotMatch(source, /knownV1 \|\| checking \|\| candidate \? " disabled"/);
});

test("Control Center keeps legacy local proofs as candidates, not active v2 routes", () => {
  const source = readFileSync(
    path.join(root, "apps", "control-center", "src", "pages", "ModelsPage.tsx"),
    "utf8",
  );
  assert.match(source, /const selectedAsSubagent = certified && selectedInSettings/);
  assert.match(source, /const certified = certification === "v2"/);
  assert.match(source, /model\.multiAgentVersion === "v1" \? "v1" : "unknown"/);
  assert.match(source, /\{eligible \? "v2 relay" : knownV1 \? "v1 only" : checking/);
  assert.match(source, /if \(!model \|\| model\.visible === false\) return false/);
  assert.match(source, /if \(subagentCertification\(model\) === "v2"\)/);
  assert.match(source, /settings\.mode === "selected" && settings\.enabled\.includes\(slug\)/);
  assert.match(source, /\["candidate", "experimental", "proven"\]\.includes\(proof\?\.status \?\? ""\)/);
  assert.match(source, /const testActive = !certified && !knownV1 && !candidate && selectedInSettings/);
  assert.match(source, /disabled=\{!api \|\| candidate \|\| knownV1\}/);
});

test("macOS subagent settings show native and unverified enabled models", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(source, /private var subagentModels: \[RouterModel\]/);
  assert.match(source, /ForEach\(providerGroups\(subagentModels\)\)/);
  const subagentList = source.slice(
    source.indexOf("private var subagentModels"),
    source.indexOf("private var enabledModels"),
  );
  assert.doesNotMatch(subagentList, /provider != "openai"/);
  assert.match(source, /let subagentCertification: String\?/);
  assert.match(source, /if model\.multiAgentVersion == "v1" \{ return "v1" \}/);
  const activeCapability = source.slice(
    source.indexOf("private func isSubagent(_ model: RouterModel)"),
    source.indexOf("private func subagentToggleOn(_ model: RouterModel)"),
  );
  assert.match(source, /private func isCertifiedV2\(_ model: RouterModel\) -> Bool/);
  assert.match(activeCapability, /isCertifiedV2\(model\)/);
  assert.doesNotMatch(activeCapability, /selectedSubagentSet/);
  assert.match(source, /private func subagentToggleOn\(_ model: RouterModel\)/);
  assert.match(source, /selectedSubagentSet\.contains\(model\.slug\)/);
  assert.doesNotMatch(source, /let authoritative = checking \|\| selectedSubagentSet/);
  assert.match(source, /return isKnownV1\(model\) \|\| isCertificationCandidate\(model\)/);
  assert.match(source, /\["candidate", "experimental", "proven"\]\.contains\(status\)/);
  assert.match(source, /get: \{ subagentToggleOn\(model\) \}/);
  assert.match(source, /disabled: subagentToggleDisabled\(model\)/);
  assert.match(source, /title: model\.displayName/);
  assert.match(source, /subagentStatusTags\(for: model\)/);
  assert.match(source, /Text\(routerLocalized\("Subagent"\)\)/);
  assert.match(source, /settings\?\.subagents\.efforts\?\[model\.slug\]/);
  assert.match(source, /subagentEffortRow\(for: model\)/);
});
