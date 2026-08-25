import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROXY = "http://127.0.0.1:3213";

// `bin/start` resolves `node` from PATH. A shim that records its arguments and
// exits instead of running them turns "which layer does this verb reach" into
// an observable fact, without touching this machine's launchd.
function withNodeShim(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-lifecycle-"));
  const log = path.join(directory, "argv.log");
  const shim = path.join(directory, "node");
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(shim, 0o755);
  writeFileSync(log, "");
  try {
    return run({
      env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` },
      readLog: () => readFileSync(log, "utf8").trim(),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("start and stop act on the same layer", { skip: process.platform === "win32" }, () => {
  withNodeShim(({ env, readLog }) => {
    execFileSync(path.join(root, "bin", "start"), [], { env, encoding: "utf8" });
    const started = readLog();
    // Not `src/start.mjs`. A `start` that execs the supervisor leaves the
    // service that `stop` unloaded still unloaded, and puts an unmanaged copy
    // carrying the calling shell's environment in its place.
    assert.match(started, /src\/service\.mjs start$/);
    assert.doesNotMatch(started, /start\.mjs$/);
  });

  withNodeShim(({ env, readLog }) => {
    execFileSync(path.join(root, "bin", "stop"), [], { env, encoding: "utf8" });
    assert.match(readLog(), /src\/service\.mjs stop$/);
  });
});

test("the foreground supervisor is reachable, but only on purpose", { skip: process.platform === "win32" }, () => {
  withNodeShim(({ env, readLog }) => {
    execFileSync(path.join(root, "bin", "start"), ["--foreground"], { env, encoding: "utf8" });
    assert.match(readLog(), /src\/start\.mjs$/);
  });

  // An unrecognized argument is refused rather than quietly falling through to
  // either layer.
  withNodeShim(({ env, readLog }) => {
    const result = spawnSync(path.join(root, "bin", "start"), ["--deamon"], { env, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: start \[--foreground\]/);
    assert.equal(readLog(), "");
  });
});

test("a supervisor started with no proxy environment adopts the installed one", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-lifecycle-state-"));
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(stateDir, "install-manifest.json"),
      JSON.stringify({
        version: 1,
        current: {
          proxyEnvironment: {
            HTTP_PROXY: `http://user:hunter2@127.0.0.1:3213`,
            HTTPS_PROXY: PROXY,
            NODE_USE_ENV_PROXY: "1",
          },
        },
        history: [],
      }),
    );

    // Nothing here names a proxy -- exactly what a shell spawned by a desktop
    // app hands the supervisor. Startup stops at the missing gateway binary,
    // which is well after the restore and costs no ports or children.
    const result = spawnSync(process.execPath, [path.join(root, "src", "start.mjs")], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_LITELLM_BIN: path.join(stateDir, "no-such-litellm"),
      },
      encoding: "utf8",
    });

    assert.match(result.stderr, /restored the installed one \(http:\/\/127\.0\.0\.1:3213\)/);
    // The manifest may hold a proxy password. The log is not where it leaks.
    assert.doesNotMatch(result.stderr, /hunter2/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a declared proxy environment is left exactly as the operator set it", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-lifecycle-state-"));
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(stateDir, "install-manifest.json"),
      JSON.stringify({
        version: 1,
        current: { proxyEnvironment: { HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: "1" } },
        history: [],
      }),
    );

    // This is the managed path: the service definition already carries the
    // proxy, so there is nothing to restore and nothing to announce.
    const result = spawnSync(process.execPath, [path.join(root, "src", "start.mjs")], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_LITELLM_BIN: path.join(stateDir, "no-such-litellm"),
        HTTPS_PROXY: PROXY,
        NODE_USE_ENV_PROXY: "1",
      },
      encoding: "utf8",
    });
    assert.doesNotMatch(result.stderr, /restored the installed one/);

    // And an operator who turned the proxy off keeps it off.
    const off = spawnSync(process.execPath, [path.join(root, "src", "start.mjs")], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_LITELLM_BIN: path.join(stateDir, "no-such-litellm"),
        NODE_USE_ENV_PROXY: "0",
      },
      encoding: "utf8",
    });
    assert.doesNotMatch(off.stderr, /restored the installed one/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
