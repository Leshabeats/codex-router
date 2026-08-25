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

  // The registry is the sole promotion authority and applySubagentProofs()
  // discards local probe results, so the page must not offer a control that
  // implies otherwise. A route certified v2 gets the switch; every other route
  // gets nothing to click at all.
  const control = source.slice(
    source.indexOf("function subagentControl("),
    source.indexOf("function ModelRouteRow("),
  );
  assert.ok(control, "subagentControl is the single source of subagent wording");
  assert.match(control, /if \(certification === "v2"\)[\s\S]{0,140}kind: "ready" as const/);
  assert.match(control, /kind: "ready" as const[\s\S]{0,120}checked: selectedInSettings/);
  // Only an unknown route is a candidate. v2 is already able; v1 was reviewed
  // and refused, and re-checking it would spend quota on a settled answer.
  assert.match(control, /if \(certification === "v1"\)[\s\S]{0,200}kind: "unsupported" as const/);
  assert.match(control, /kind: "certifiable" as const/);

  // No local-proof vocabulary survives anywhere on the page: no probe request,
  // no candidate state, and no wording that reads as one test away from working.
  assert.doesNotMatch(source, /proofs/);
  // The legacy statuses must not be handled as data. Prose may still use the
  // word "candidate" for a route the switch can check.
  assert.doesNotMatch(source, /"candidate"|"experimental"|"proven"/);
  assert.doesNotMatch(source, /Test subagents|Untested|Awaiting certification|Test failed|Checking compatibility/);

  // An uncertified route renders an inert marker, never a Toggle.
  assert.match(source, /if \(subagent\.kind === "unsupported"\) \{[\s\S]{0,200}className="pm-route-none"/);
  assert.match(source, /disabled=\{!apiAvailable\}/);
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
