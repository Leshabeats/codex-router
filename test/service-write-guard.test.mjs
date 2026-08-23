import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertServiceWriteIsolated,
  skipServiceManagerCall,
} from "../src/service-write-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("outside a test run the guard never interferes", () => {
  // Real installs are the whole point of this code path; the guard exists only
  // to stop the suite from performing one.
  assert.equal(
    assertServiceWriteIsolated("/Users/someone/Library/LaunchAgents/x.plist", {
      env: {},
      redirected: false,
    }),
    undefined,
  );
});

test("inside a test run an unredirected service write is refused", () => {
  assert.throws(
    () =>
      assertServiceWriteIsolated("/Users/someone/Library/LaunchAgents/x.plist", {
        env: { NODE_TEST_CONTEXT: "child-v8" },
        redirected: false,
        label: "LaunchAgent",
        override: "MODEL_ROUTER_LAUNCH_AGENTS_DIR",
      }),
    /Refusing to write the LaunchAgent[\s\S]*MODEL_ROUTER_LAUNCH_AGENTS_DIR/,
  );
});

test("a redirected write is allowed inside a test run", () => {
  assert.equal(
    assertServiceWriteIsolated("/tmp/fixture/x.plist", {
      env: { NODE_TEST_CONTEXT: "child-v8" },
      redirected: true,
    }),
    undefined,
  );
});

test("test-mode skips host service-manager mutations but leaves reads live", () => {
  assert.equal(
    skipServiceManagerCall({ hostManaged: true, env: { NODE_TEST_CONTEXT: "child-v8" } }),
    true,
  );
  assert.equal(
    skipServiceManagerCall({ hostManaged: false, env: { NODE_TEST_CONTEXT: "child-v8" } }),
    false,
  );
  // The explicit environment switch is a mutation escape hatch too, but the
  // helper is only consulted by mutating call sites. Query callers never use it
  // and therefore retain truthful installed/status results.
  assert.equal(
    skipServiceManagerCall({ hostManaged: true, env: { MODEL_ROUTER_SKIP_SERVICE_MANAGER: "1" } }),
    true,
  );
});

test("installing the macOS service from a test refuses instead of writing", () => {
  // The end-to-end shape of the accident this guards: a test spawns the real
  // service installer, which rewrites the developer's own LaunchAgent to point
  // at the checkout under test. HOME is redirected here so that even a guard
  // regression lands in the fixture rather than on this machine -- the
  // assertions below still fail loudly if the write goes through.
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-guard-home-"));
  const agents = path.join(fakeHome, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "service-macos.mjs"), "install"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fakeHome,
          CODEX_HOME: path.join(fakeHome, "codex"),
          MODEL_ROUTER_STATE_DIR: path.join(fakeHome, "state"),
          CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
          CODEX_ROUTER_NODE_BIN: process.execPath,
          NODE_TEST_CONTEXT: "child-v8",
          MODEL_ROUTER_LAUNCH_AGENTS_DIR: "",
          CODEX_ROUTER_LAUNCH_AGENTS_DIR: "",
        },
      },
    );
    assert.notEqual(result.status, 0, "an unredirected install must not succeed");
    assert.match(result.stderr, /Refusing to write the LaunchAgent/);
    assert.equal(
      existsSync(path.join(agents, "io.github.codex-router.plist")),
      false,
      "the guard must refuse before anything is written",
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("installing the Windows service from a test refuses before mkdir or scheduler calls", () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-guard-home-"));
  const state = path.join(fakeHome, "codex-router");
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "service-windows.mjs"), "install"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fakeHome,
          CODEX_HOME: fakeHome,
          CODEX_ROUTER_SERVICE_PLATFORM: "win32",
          NODE_TEST_CONTEXT: "child-v8",
          // Deliberately no MODEL/CODEX_ROUTER_STATE_DIR override: this is
          // the unredirected path the guard must reject before mkdirSync.
          MODEL_ROUTER_STATE_DIR: "",
          CODEX_ROUTER_STATE_DIR: "",
        },
      },
    );
    assert.notEqual(result.status, 0, "an unredirected Windows install must fail");
    assert.match(result.stderr, /Refusing to write the service launchers/);
    assert.equal(existsSync(state), false, "the guard must run before mkdirSync");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("a redirected install is still able to write its fixture", () => {
  // The guard must not block the isolated installs the suite legitimately does,
  // or it would simply trade one broken behaviour for another.
  const fixture = mkdtempSync(path.join(os.tmpdir(), "codex-router-guard-fixture-"));
  const agents = path.join(fixture, "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "service-macos.mjs"), "install"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fixture,
          CODEX_HOME: path.join(fixture, "codex"),
          MODEL_ROUTER_STATE_DIR: path.join(fixture, "state"),
          CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
          CODEX_ROUTER_NODE_BIN: process.execPath,
          CODEX_ROUTER_SKIP_LAUNCHCTL: "1",
          NODE_TEST_CONTEXT: "child-v8",
          MODEL_ROUTER_LAUNCH_AGENTS_DIR: agents,
        },
      },
    );
    assert.doesNotMatch(result.stderr || "", /Refusing to write the LaunchAgent/);
    assert.equal(existsSync(path.join(agents, "io.github.codex-router.plist")), true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// The damage this suite caused for real. `install` writes its plist wherever
// the test redirected it, and then boots the machine's own launchd job out and
// registers that fixture in its place -- addressed by label, which no path
// override can redirect. When the test deleted its temporary directory,
// launchd was left pointing at a definition that no longer existed and the
// router stayed dead.
//
// Only meaningful where launchctl is this machine's own service manager;
// elsewhere the darwin module reaches no real launchd and there is nothing to
// protect.
test(
  "an install from a test leaves the machine's own launchd job alone",
  { skip: process.platform !== "darwin" && "launchctl is not this host's service manager" },
  () => {
    const registration = () =>
      spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/io.github.codex-router`], {
        encoding: "utf8",
      }).stdout || "";
    const before = registration();
    const fixture = mkdtempSync(path.join(os.tmpdir(), "codex-router-manager-fixture-"));
    const agents = path.join(fixture, "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(root, "src", "service-macos.mjs"), "install"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: fixture,
            CODEX_HOME: path.join(fixture, "codex"),
            MODEL_ROUTER_STATE_DIR: path.join(fixture, "state"),
            CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
            CODEX_ROUTER_NODE_BIN: process.execPath,
            NODE_TEST_CONTEXT: "child-v8",
            MODEL_ROUTER_LAUNCH_AGENTS_DIR: agents,
            // Deliberately absent. Nothing should have to opt out of this.
            CODEX_ROUTER_SKIP_LAUNCHCTL: "",
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      // The fixture still gets its definition: the skip is of the service
      // manager, not of the install.
      assert.equal(existsSync(path.join(agents, "io.github.codex-router.plist")), true);
      // And the machine's own registration is exactly as it was -- this is the
      // assertion the old behaviour failed, silently.
      assert.equal(registration(), before);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
