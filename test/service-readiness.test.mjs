import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { waitForServiceReadiness } from "../src/service-readiness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a persistently absent Windows task fails readiness early with its result", async () => {
  let stateQueries = 0;
  await assert.rejects(
    waitForServiceReadiness({
      platform: "win32",
      timeoutMs: 60_000,
      launchGraceMs: 20,
      pollMs: 10,
      getWindowsTaskState: () => {
        stateQueries += 1;
        return { instanceCount: 0, lastTaskResult: 1 };
      },
      waitForHealth: () => new Promise(() => {}),
    }),
    /no running instance \(LastTaskResult=0x1\)/,
  );
  assert.equal(stateQueries > 1, true);
});

test("brief Task Scheduler launch lag does not reject a healthy start", async () => {
  const health = await waitForServiceReadiness({
    platform: "win32",
    timeoutMs: 1_000,
    launchGraceMs: 25,
    pollMs: 10,
    getWindowsTaskState: () => ({ instanceCount: 0, lastTaskResult: 1 }),
    waitForHealth: () => new Promise((resolve) => setTimeout(resolve, 30, { ok: true })),
  });
  assert.deepEqual(health, { ok: true });
});

test("an unavailable Task Scheduler query cannot make readiness fail closed", async () => {
  const health = await waitForServiceReadiness({
    platform: "win32",
    timeoutMs: 100,
    pollMs: 10,
    getWindowsTaskState: () => undefined,
    waitForHealth: () => Promise.resolve({ ok: true }),
  });
  assert.deepEqual(health, { ok: true });
});

test("non-Windows readiness uses only router health", async () => {
  let queried = false;
  const health = await waitForServiceReadiness({
    platform: "linux",
    timeoutMs: 100,
    getWindowsTaskState: () => {
      queried = true;
      return { instanceCount: 0, lastTaskResult: 1 };
    },
    waitForHealth: () => Promise.resolve({ ok: true }),
  });
  assert.deepEqual(health, { ok: true });
  assert.equal(queried, false);
});

test("the service delegates its full readiness budget to the guarded wait", () => {
  const source = readFileSync(path.join(root, "src", "service.mjs"), "utf8");
  assert.match(source, /waitForServiceReadiness/);
  assert.match(source, /timeoutMs: READINESS_TIMEOUT_MS/);
  assert.doesNotMatch(source, /waitForRouterHealth/);
});
