import assert from "node:assert/strict";
import test from "node:test";

const cliModule = await import("../src/caller-key.mjs").catch(() => ({}));
const installedTargetsFromStatus = cliModule.installedTargetsFromStatus;

test("caller-key rotation republishes only client integrations already installed", () => {
  assert.equal(typeof installedTargetsFromStatus, "function");
  assert.deepEqual(
    installedTargetsFromStatus({
      codex: { mode: "router" },
      dsh: { routeInstalled: true, credentialInstalled: true },
      gemini: { installed: true, baseUrlManaged: true },
    }),
    ["codex", "dsh", "gemini"],
  );

  assert.deepEqual(
    installedTargetsFromStatus({
      codex: { mode: "native" },
      dsh: { routeInstalled: false, credentialInstalled: false },
      gemini: { installed: false, baseUrlManaged: false },
    }),
    [],
  );
});

test("partial managed client state is repaired rather than stranded", () => {
  assert.equal(typeof installedTargetsFromStatus, "function");
  assert.deepEqual(
    installedTargetsFromStatus({
      codex: { mode: "native" },
      dsh: { routeInstalled: true, credentialInstalled: false },
      gemini: { installed: false, baseUrlManaged: true },
    }),
    ["dsh", "gemini"],
  );
});

test("caller-key rotation republishes installed clients and restarts one installed service", async () => {
  const runCallerKeyRotation = cliModule.runCallerKeyRotation;
  assert.equal(typeof runCallerKeyRotation, "function");
  const calls = [];
  const result = await runCallerKeyRotation({
    assertOwnership: () => {},
    readClientStatuses: async () => ({
      codex: { mode: "router" },
      dsh: { routeInstalled: true, credentialInstalled: true },
      gemini: { installed: true, baseUrlManaged: true },
    }),
    readServiceStatus: async () => ({ installed: true }),
    runNode: async (script, args) => calls.push([script, ...args]),
    rotate: async ({ apply, verify }) => {
      await apply();
      await verify({ previousSecret: "o".repeat(48), currentSecret: "n".repeat(48) });
      return { rotated: true };
    },
    verifyServiceKeys: async () => calls.push(["verify-keys"]),
    secretPath: "fixture-secret",
  });
  assert.deepEqual(calls, [
    ["src/config-manager.mjs", "enable"],
    ["src/dsh-config-manager.mjs", "install"],
    ["src/gemini-config-manager.mjs", "install"],
    ["src/service.mjs", "install"],
    ["src/wait-health.mjs"],
    ["verify-keys"],
  ]);
  assert.deepEqual(result, { rotated: true, targets: ["codex", "dsh", "gemini"], serviceRestarted: true });
});

test("caller-key rotation does not install a service that was not already installed", async () => {
  const runCallerKeyRotation = cliModule.runCallerKeyRotation;
  assert.equal(typeof runCallerKeyRotation, "function");
  const calls = [];
  const result = await runCallerKeyRotation({
    assertOwnership: () => {},
    readClientStatuses: async () => ({
      codex: { mode: "router" },
      dsh: {},
      gemini: {},
    }),
    readServiceStatus: async () => ({ installed: false }),
    runNode: async (script, args) => calls.push([script, ...args]),
    rotate: async ({ apply, verify }) => {
      await apply();
      await verify({ previousSecret: "o".repeat(48), currentSecret: "n".repeat(48) });
      return { rotated: true };
    },
    verifyServiceKeys: async () => calls.push(["verify-keys"]),
    secretPath: "fixture-secret",
  });
  assert.deepEqual(calls, [["src/config-manager.mjs", "enable"]]);
  assert.deepEqual(result, { rotated: true, targets: ["codex"], serviceRestarted: false });
});

test("caller-key rotation checks state ownership before inspecting or mutating clients", async () => {
  const runCallerKeyRotation = cliModule.runCallerKeyRotation;
  const order = [];
  await runCallerKeyRotation({
    assertOwnership: () => order.push("ownership"),
    readClientStatuses: async () => {
      order.push("clients");
      return { codex: {}, dsh: {}, gemini: {} };
    },
    readServiceStatus: async () => {
      order.push("service");
      return { installed: false };
    },
    rotate: async () => ({ rotated: true }),
    secretPath: "fixture-secret",
  });
  assert.deepEqual(order, ["ownership", "clients", "service"]);
});