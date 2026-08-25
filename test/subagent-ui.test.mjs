import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("browser panel subagent settings show native and unverified enabled models", () => {
  const source = readFileSync(path.join(root, "apps", "panel", "app.js"), "utf8");
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
  assert.match(source, /if \(!model \|\| model\.visible === false\) return false/);
  assert.match(source, /if \(subagentCertification\(model\) === "v2"\)/);
  assert.match(source, /model\.multiAgentVersion === "v1" \? "v1" : "unknown"/);
  assert.match(source, /settings\.mode === "selected" && settings\.enabled\.includes\(slug\)/);

  // The four states share one control and one vocabulary. What must not blur is
  // which of them can actually host a subagent: only a certified v2 route.
  const control = source.slice(
    source.indexOf("function subagentControl("),
    source.indexOf("function ModelRouteRow("),
  );
  assert.ok(control, "subagentControl is the single source of subagent wording");
  const certified = control.slice(
    control.indexOf('if (certification === "v2")'),
    control.indexOf('if (certification === "v1")'),
  );
  assert.match(certified, /kind: "subagent" as const/);
  assert.match(certified, /checked: selectedInSettings/);
  assert.match(certified, /showEffort: true/);
  // Thinking effort belongs to a route that really runs subagents, so exactly
  // one branch may offer it.
  assert.equal(control.match(/showEffort: true/g)?.length, 1);

  const knownV1 = control.slice(
    control.indexOf('if (certification === "v1")'),
    control.indexOf('if (proof?.status === "checking")'),
  );
  assert.match(knownV1, /kind: "unsupported" as const/);
  assert.match(knownV1, /checked: false/);
  assert.match(knownV1, /disabled: true/);

  // A local proof is diagnostic only. It stays a candidate: never checked,
  // never toggleable, and never presented as a working subagent route.
  assert.match(control, /\["candidate", "experimental", "proven"\]\.includes\(proof\?\.status \?\? ""\)/);
  const candidate = control.slice(
    control.indexOf('["candidate", "experimental", "proven"].includes(proof?.status ?? "")'),
    control.indexOf("const failed = proof?.status === \"failed\""),
  );
  assert.match(candidate, /kind: "unsupported" as const/);
  assert.match(candidate, /checked: false/);
  assert.match(candidate, /disabled: true/);
  assert.doesNotMatch(candidate, /kind: "subagent"/);

  // An unsupported route offers no switch at all, so there is nothing to click
  // that could imply the route is one test away from working.
  assert.match(source, /subagent\.kind === "unsupported" \? \(/);
  assert.match(source, /className="pm-model-control-note"/);
  assert.match(source, /disabled=\{!apiAvailable \|\| subagent\.disabled\}/);
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

test("the browser and macOS tray model pickers can search enabled models", () => {
  const panel = readFileSync(path.join(root, "apps", "panel", "app.js"), "utf8");
  const html = readFileSync(path.join(root, "apps", "panel", "index.html"), "utf8");
  const macos = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(html, /id="picker-model-search"/);
  assert.match(panel, /modelMatchesQuery\(model, state\.pickerModelFilter/);
  assert.match(macos, /private var filteredPickerModels: \[RouterModel\]/);
  assert.match(macos, /ForEach\(providerGroups\(filteredPickerModels\)\)/);
});
