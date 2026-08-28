import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const rotationModule = await import("../src/caller-key-rotation.mjs").catch(() => ({}));
const rotateCallerCapability = rotationModule.rotateCallerCapability;

async function fixture(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-caller-rotation-"));
  const secretPath = path.join(directory, "caller-secret");
  writeFileSync(secretPath, `${"o".repeat(48)}\n`, { mode: 0o600 });
  try {
    return await run({ directory, secretPath });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("caller capability rotation replaces the key and removes rollback material", async () => {
  assert.equal(typeof rotateCallerCapability, "function");
  await fixture(async ({ directory, secretPath }) => {
    const applied = [];
    const result = await rotateCallerCapability({
      secretPath,
      generateSecret: () => "n".repeat(48),
      protect: () => {},
      apply: async () => applied.push(readFileSync(secretPath, "utf8").trim()),
      verify: async ({ previousSecret, currentSecret }) => {
        assert.equal(previousSecret, "o".repeat(48));
        assert.equal(currentSecret, "n".repeat(48));
      },
    });
    assert.deepEqual(result, { rotated: true });
    assert.equal(readFileSync(secretPath, "utf8").trim(), "n".repeat(48));
    assert.deepEqual(applied, ["n".repeat(48)]);
    assert.deepEqual(readdirSync(directory), ["caller-secret"]);
  });
});

test("caller capability rotation restores the old key and reapplies clients on failure", async () => {
  assert.equal(typeof rotateCallerCapability, "function");
  await fixture(async ({ directory, secretPath }) => {
    const applied = [];
    let first = true;
    await assert.rejects(
      rotateCallerCapability({
        secretPath,
        generateSecret: () => "n".repeat(48),
        protect: () => {},
        apply: async () => {
          applied.push(readFileSync(secretPath, "utf8").trim());
          if (first) {
            first = false;
            throw new Error("apply failed");
          }
        },
        verify: async () => {},
      }),
      /apply failed/,
    );
    assert.equal(readFileSync(secretPath, "utf8").trim(), "o".repeat(48));
    assert.deepEqual(applied, ["n".repeat(48), "o".repeat(48)]);
    assert.deepEqual(readdirSync(directory), ["caller-secret"]);
  });
});