import assert from "node:assert/strict";
import test from "node:test";

import { windowsScheduledTaskState } from "../src/windows-task-state.mjs";

test("parses the authoritative instance count, result, and launcher liveness", async () => {
  let invocation;
  const execFile = (executable, args, options, callback) => {
    invocation = { executable, args, options };
    callback(null, "2|267009|1\n");
  };

  assert.deepEqual(await windowsScheduledTaskState({ execFile }), {
    instanceCount: 2,
    lastTaskResult: 267009,
    launcherAlive: true,
  });
  assert.equal(invocation.executable, "powershell.exe");
  assert.equal(invocation.options.timeout, 10_000);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.env.CODEX_ROUTER_TASK, "Codex Router");
  const script = invocation.args.at(-1);
  assert.match(script, /Schedule\.Service/);
  assert.match(script, /GetInstances\(0\)/);
  // The launcher probe is what catches Task Scheduler reporting an instance
  // whose process tree has already died.
  assert.match(script, /start-codex-router/);
  assert.match(script, /Win32_Process/);
  // The probe's own command line carries the match literals, so it must
  // exclude itself or every query would report a live launcher.
  assert.match(script, /ProcessId -ne \$PID/);
});

test("a dead launcher process is reported as not alive", async () => {
  const execFile = (_e, _a, _o, callback) => callback(null, "1|267014|0\n");
  assert.deepEqual(await windowsScheduledTaskState({ execFile }), {
    instanceCount: 1,
    lastTaskResult: 267014,
    launcherAlive: false,
  });
});

test("query failures and malformed output stay inconclusive", async () => {
  assert.equal(
    await windowsScheduledTaskState({
      execFile: () => {
        throw new Error("access denied");
      },
    }),
    undefined,
  );
  assert.equal(
    await windowsScheduledTaskState({
      execFile: (_executable, _args, _options, callback) => callback(null, "not-a-count|1"),
    }),
    undefined,
  );
  assert.equal(
    await windowsScheduledTaskState({
      execFile: (_executable, _args, _options, callback) => callback(null, ""),
    }),
    undefined,
  );
});

test("non-Windows callers never invoke Task Scheduler", async () => {
  let called = false;
  assert.equal(
    await windowsScheduledTaskState({
      execFile: () => {
        called = true;
        return "1|0";
      },
      platform: "linux",
    }),
    undefined,
  );
  assert.equal(called, false);
});
