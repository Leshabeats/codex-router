import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const callerSecret = "doctor-vision-caller-capability-with-sufficient-length";

function writeCodexStub(directory, models) {
  const windows = process.platform === "win32";
  const target = path.join(directory, windows ? "codex-vision.cmd" : "codex-vision");
  const payload = JSON.stringify({ models });
  writeFileSync(
    target,
    windows
      ? `@echo off\r\nif "%1"=="--version" (echo codex-cli 99.0.0& exit /b 0)\r\nif "%1"=="login" exit /b 0\r\nif "%1"=="debug" (echo ${payload}& exit /b 0)\r\nexit /b 1\r\n`
      : `#!/bin/sh\ncase "$1" in\n  --version) echo 'codex-cli 99.0.0' ;;\n  login) exit 0 ;;\n  debug) printf '%s\\n' '${payload}' ;;\n  *) exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );
  return target;
}
test("Codex doctor resolves a default bridge through an installed native vision engine", { timeout: 30_000 }, () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-doctor-vision-"));
  const stateDir = path.join(codexHome, "router-state");
  const launchAgents = path.join(codexHome, "launch-agents");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
  const luna = {
    slug: "gpt-5.6-luna",
    display_name: "GPT-5.6-Luna",
    visibility: "list",
    priority: 10,
    input_modalities: ["text", "image"],
  };
  writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.6-luna"\n', { mode: 0o600 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: [] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "caller-secret"), `${callerSecret}\n`, { mode: 0o600 });
  writeFileSync(
    path.join(stateDir, "internal-secret"),
    "doctor-vision-internal-service-key-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "merged-models.json"), `${JSON.stringify({ models: [luna] })}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateDir, "native-models.json"), `${JSON.stringify({ models: [luna] })}\n`, { mode: 0o600 });
  const env = {
    ...process.env,
    CODEX_BIN: writeCodexStub(codexHome, [luna]),
    CODEX_HOME: codexHome,
    CODEX_ROUTER_NO_DISCOVERY: "1",
    CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
    MODEL_ROUTER_LAUNCH_AGENTS_DIR: launchAgents,
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_PORT: "46993",
  };

  try {
    const doctor = spawnSync(process.execPath, [path.join(root, "src", "doctor.mjs"), "--json"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.ok(doctor.stdout.trim(), doctor.stderr);
    const report = JSON.parse(doctor.stdout);
    const vision = report.checks.find((check) => check.name === "Vision bridge");
    assert.equal(vision.status, "ok");
    assert.equal(vision.detail, "text-only models read images via gpt-5.6-luna");

    writeFileSync(path.join(stateDir, "merged-models.json"), `${JSON.stringify({ models: [] })}\n`, { mode: 0o600 });
    writeFileSync(path.join(stateDir, "native-models.json"), `${JSON.stringify({ models: [] })}\n`, { mode: 0o600 });
    const withoutEngine = spawnSync(
      process.execPath,
      [path.join(root, "src", "doctor.mjs"), "--json"],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.ok(withoutEngine.stdout.trim(), withoutEngine.stderr);
    const noEngineReport = JSON.parse(withoutEngine.stdout);
    const noEngineVision = noEngineReport.checks.find((check) => check.name === "Vision bridge");
    assert.equal(noEngineVision.status, "ok");
    assert.equal(noEngineVision.detail, "on by default, but no enabled vision engine is available yet");
    assert.doesNotMatch(noEngineVision.detail, /pinned engine/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
