import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callerBaseUrl, redactCallerUrl } from "./caller-auth.mjs";
import { rotateCallerCapability } from "./caller-key-rotation.mjs";
import { CALLER_SECRET_PATH, PORTS } from "./paths.mjs";
import { assertStateOwnership } from "./state-owner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function installedTargetsFromStatus({ codex = {}, dsh = {}, gemini = {} } = {}) {
  const targets = [];
  if (codex.mode === "router") targets.push("codex");
  if (dsh.routeInstalled || dsh.credentialInstalled) targets.push("dsh");
  if (gemini.installed || gemini.baseUrlManaged) targets.push("gemini");
  return targets;
}

const republishCommand = Object.freeze({
  codex: ["src/config-manager.mjs", ["enable"]],
  dsh: ["src/dsh-config-manager.mjs", ["install"]],
  gemini: ["src/gemini-config-manager.mjs", ["install"]],
});

function commandDetail(result, fallback) {
  if (result.error) return result.error.message;
  const detail = String(result.stderr || result.stdout || "").trim();
  return detail ? redactCallerUrl(detail.slice(-2_000)) : fallback;
}

export function runNodeCommand(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(commandDetail(result, `${script} failed.`));
  }
  return String(result.stdout || "");
}

function parseJsonCommand(script, args, runNode = runNodeCommand) {
  const output = runNode(script, args);
  try {
    return JSON.parse(String(output || ""));
  } catch {
    throw new Error(`${script} returned invalid status JSON.`);
  }
}

export async function readManagedClientStatuses({ runNode = runNodeCommand } = {}) {
  return {
    codex: parseJsonCommand("src/config-manager.mjs", ["status"], runNode),
    dsh: parseJsonCommand("src/dsh-config-manager.mjs", ["status"], runNode),
    gemini: parseJsonCommand("src/gemini-config-manager.mjs", ["status"], runNode),
  };
}

export async function readRouterServiceStatus({ runNode = runNodeCommand } = {}) {
  return parseJsonCommand("src/service.mjs", ["status"], runNode);
}

export async function verifyCallerRotation({ previousSecret, currentSecret }) {
  try {
    const fresh = await fetch(`${callerBaseUrl(PORTS.router, currentSecret)}/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    const stale = await fetch(`${callerBaseUrl(PORTS.router, previousSecret)}/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (fresh.status !== 200) throw new Error("The new caller capability was not accepted.");
    if (stale.status === 200) throw new Error("The previous caller capability is still accepted.");
  } catch (error) {
    if (error instanceof Error && /caller capability/.test(error.message)) throw error;
    throw new Error("Router caller-capability verification failed.");
  }
}

export async function runCallerKeyRotation({
  readClientStatuses = () => readManagedClientStatuses(),
  readServiceStatus = () => readRouterServiceStatus(),
  runNode = runNodeCommand,
  rotate = rotateCallerCapability,
  verifyServiceKeys = verifyCallerRotation,
  secretPath = CALLER_SECRET_PATH,
  assertOwnership = () => assertStateOwnership("rotate the router caller capability"),
} = {}) {
  assertOwnership();
  const statuses = await readClientStatuses();
  const targets = installedTargetsFromStatus(statuses);
  const service = await readServiceStatus();
  const serviceRestarted = service?.installed === true;

  const apply = async () => {
    for (const target of targets) {
      const [script, args] = republishCommand[target];
      await runNode(script, args);
    }
    if (serviceRestarted) {
      await runNode("src/service.mjs", ["install"]);
      await runNode("src/wait-health.mjs", []);
    }
  };

  const verify = serviceRestarted
    ? (keys) => verifyServiceKeys(keys)
    : async () => {};
  const result = await rotate({ secretPath, apply, verify });
  return { ...result, targets, serviceRestarted };
}

function restartNotice(targets, serviceRestarted) {
  const notes = [];
  if (targets.includes("codex")) notes.push("Fully quit and reopen Codex before continuing existing tasks.");
  if (targets.includes("gemini")) notes.push("Restart any running Gemini CLI session.");
  if (!serviceRestarted) notes.push("The router service was not installed; the new capability will be used on its next start.");
  return notes.join(" ");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  if (command !== "rotate" || process.argv.length !== 3) {
    console.error("Usage: caller-key rotate");
    process.exit(2);
  }
  try {
    const result = await runCallerKeyRotation();
    process.stdout.write(`Caller capability rotated. ${restartNotice(result.targets, result.serviceRestarted)}\n`);
  } catch (error) {
    console.error(`caller-key rotate failed: ${redactCallerUrl(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  }
}