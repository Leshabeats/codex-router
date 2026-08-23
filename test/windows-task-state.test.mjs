import assert from "node:assert/strict";
import test from "node:test";

import { windowsScheduledTaskState } from "../src/windows-task-state.mjs";

test("parses the authoritative Task Scheduler instance count and result", async () => {
  let invocation;
  const execFile = (executable, args, options, callback) => {
    invocation = { executable, args, options };
    callback(null, "2|267009\n");
  };

  // `platform` is injected rather than inherited. Without it the call returns
  // undefined from the non-Windows short-circuit on every runner except the
  // Windows one, so the parser this test exists to cover is never reached --
  // and the test passes or fails on which host happens to run it.
  assert.deepEqual(await windowsScheduledTaskState({ execFile, platform: "win32" }), {
    instanceCount: 2,
    lastTaskResult: 267009,
  });
  assert.equal(invocation.executable, "powershell.exe");
  assert.equal(invocation.options.timeout, 5_000);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.env.CODEX_ROUTER_TASK, "Codex Router");
  assert.match(invocation.args.at(-1), /Schedule\.Service/);
  assert.match(invocation.args.at(-1), /GetInstances\(0\)/);
});

test("query failures and malformed output stay inconclusive", async () => {
  // Also pinned to win32. Off Windows these calls return undefined from the
  // platform short-circuit, which is the same value the fail-closed path
  // returns -- so the assertions passed without ever exercising it, and the
  // inconclusive behaviour was covered only on the Windows job.
  assert.equal(
    await windowsScheduledTaskState({
      platform: "win32",
      execFile: () => {
        throw new Error("access denied");
      },
    }),
    undefined,
  );
  assert.equal(
    await windowsScheduledTaskState({
      platform: "win32",
      execFile: (_executable, _args, _options, callback) => callback(null, "not-a-count|1"),
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
