import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-overlay-publication-test-"));
const testEnvironment = {
  CODEX_ROUTER_STATE_DIR: stateDir,
  MODEL_ROUTER_LOCAL_DOWNLOAD_STATE: path.join(stateDir, "download.json"),
  MODEL_ROUTER_LOCAL_MODELS_STATE: path.join(stateDir, "local-models.json"),
  MODEL_ROUTER_VISION_BRIDGE_STATE: path.join(stateDir, "vision-bridge.json"),
};
const originalEnvironment = Object.fromEntries(
  Object.keys(testEnvironment).map((name) => [name, process.env[name]]),
);
Object.assign(process.env, testEnvironment);

after(() => {
  rmSync(stateDir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const {
  applyModelOverlayPublication,
  publishModelOverlayFresh,
  rebuildModelOverlayPublication,
  transactModelOverlayMutation,
} = await import("../src/model-overlay-publication.mjs");
const { downloadLocalModel, readLocalDownload } = await import("../src/local-download.mjs");

test("shared publication writes gateway routes before every installed target", async () => {
  const events = [];
  const result = await rebuildModelOverlayPublication({
    writeGateway: () => {
      events.push("gateway");
      return "/private/router/litellm.yaml";
    },
    refreshTargets: () => {
      for (const target of ["codex", "dsh", "gemini"]) events.push(target);
      return true;
    },
  });

  assert.deepEqual(events, ["gateway", "codex", "dsh", "gemini"]);
  assert.deepEqual(result, {
    gatewayPath: "/private/router/litellm.yaml",
    targetsRefreshed: true,
  });
});

test("overlay publication always enters through a fresh Node process", () => {
  let invocation;
  const result = publishModelOverlayFresh({
    executable: "/runtime/node",
    sourceRoot: "/stable/router",
    environment: { ROUTER_TEST_SENTINEL: "present" },
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: "{}\n", stderr: "" };
    },
  });

  assert.deepEqual(result, { published: true });
  assert.equal(invocation.command, "/runtime/node");
  assert.match(invocation.args[0], /model-overlay-publication\.mjs$/);
  assert.equal(invocation.args[1], "--publish-in-fresh-process");
  assert.equal(invocation.options.cwd, "/stable/router");
  assert.equal(invocation.options.env.ROUTER_TEST_SENTINEL, "present");
  assert.equal(invocation.options.env.MODEL_ROUTER_TARGET, "codex");
  assert.equal(invocation.options.windowsHide, true);
});

test("synchronous mutations propagate publication errors before restart", async () => {
  const events = [];
  await assert.rejects(
    applyModelOverlayPublication({
      publish: async () => {
        events.push("publish");
        throw new Error("target publication failed");
      },
      restart: true,
      restartService: async () => events.push("restart"),
    }),
    /target publication failed/,
  );
  assert.deepEqual(events, ["publish"]);
});

test("transactional mutations preserve warning-only publication semantics", async () => {
  const events = [];
  const warnings = await transactModelOverlayMutation({
    mutate: async () => events.push("mutate"),
    restore: async () => events.push("restore"),
    warningOnly: true,
    restart: true,
    applyPublication: async (options) => {
      events.push("publish");
      assert.equal(options.warningOnly, true);
      return { catalogError: "installed target could not be refreshed" };
    },
    restartService: async () => events.push("restart"),
  });

  assert.deepEqual(events, ["mutate", "publish"]);
  assert.deepEqual(warnings, { catalogError: "installed target could not be refreshed" });
});

test("transactional rollback preserves warning-only publication semantics", async () => {
  const events = [];
  await assert.rejects(
    transactModelOverlayMutation({
      mutate: async () => {
        events.push("mutate");
        throw new Error("mutation failed");
      },
      restore: async () => events.push("restore"),
      warningOnly: true,
      restart: true,
      applyPublication: async (options) => {
        events.push("publish");
        assert.equal(options.warningOnly, true);
        return {};
      },
      restartService: async () => events.push("restart"),
    }),
    /mutation failed/,
  );
  assert.deepEqual(events, ["mutate", "restore", "publish"]);
});

test("completed operations warn and skip restart when publication fails", async () => {
  const events = [];
  const warnings = await applyModelOverlayPublication({
    warningOnly: true,
    publish: async () => {
      events.push("publish");
      throw new Error("target publication failed");
    },
    restart: true,
    restartService: async () => events.push("restart"),
  });

  assert.deepEqual(events, ["publish"]);
  assert.deepEqual(warnings, {
    catalogError: "target publication failed",
  });
});

test("completed operations retain a post-publication restart failure as a warning", async () => {
  const events = [];
  const warnings = await applyModelOverlayPublication({
    warningOnly: true,
    publish: async () => events.push("publish"),
    restart: true,
    restartService: async () => {
      events.push("restart");
      throw new Error("service restart failed");
    },
  });

  assert.deepEqual(events, ["publish", "restart"]);
  assert.deepEqual(warnings, { restartError: "service restart failed" });
});

test("a completed local pull reports publication failure without becoming failed", async () => {
  const events = [];
  const result = await downloadLocalModel("publication-test:latest", {
    ensureRuntime: async () => ({ running: true }),
    pull: async () => events.push("download"),
    capabilitiesFor: () => ["completion", "tools"],
    enable: async () => events.push("overlay"),
    restartService: async () => events.push("restart"),
    finalizePublication: (options) => applyModelOverlayPublication({
      ...options,
      publish: async () => {
        events.push("publish");
        throw new Error("installed target could not be refreshed");
      },
    }),
  });

  assert.deepEqual(events, ["download", "overlay", "publish"]);
  assert.equal(result.status, "done");
  assert.equal(result.catalogError, "installed target could not be refreshed");
  assert.equal(readLocalDownload().status, "done");
  assert.match(readLocalDownload().detail, /catalog refresh needed/);
});

test("control and both detached workers use the shared publication finalizer", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sources = Object.fromEntries(
    ["control.mjs", "local-download.mjs", "vision-download.mjs"].map((name) => [
      name,
      readFileSync(path.join(root, "src", name), "utf8"),
    ]),
  );

  for (const [name, source] of Object.entries(sources)) {
    assert.ok(
      source.includes('from "./model-overlay-publication.mjs"'),
      `${name} must import the shared publication module`,
    );
    assert.ok(
      source.includes("applyModelOverlayPublication"),
      `${name} must use the shared publication helper`,
    );
  }
  assert.match(sources["control.mjs"], /applyModelOverlayPublication\(/);
  for (const name of ["local-download.mjs", "vision-download.mjs"]) {
    assert.ok(
      sources[name].includes("finalizePublication"),
      `${name} must expose a publication finalizer hook`,
    );
    assert.ok(
      sources[name].includes("applyModelOverlayPublication"),
      `${name} must invoke the shared publication helper`,
    );
  }
  assert.ok(
    [...sources["control.mjs"].matchAll(/applyModelOverlayPublication|transactModelOverlayMutation|finalizeLocalModelPublication/g)].length >= 4,
    "control must publish vision, sync toggle, and uninstall-finalization mutations",
  );
});
