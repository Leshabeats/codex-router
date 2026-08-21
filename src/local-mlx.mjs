import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STATE_DIR } from "./paths.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

export const DEFAULT_MLX_URL =
  "https://huggingface.co/orcarouter/Qwen3.8-27B-Uncensored-MLX";
export const LOCAL_MLX_ID = "qwen38-27b-uncensored-mlx";
export const LOCAL_MLX_CONTEXT = 32768;
export const LMSTUDIO_URL = "http://127.0.0.1:1234/v1";
export const HF_REPOSITORY = "orcarouter/Qwen3.8-27B-Uncensored-MLX";
export const MLX_INCLUDE = "4-bit/**";
export const LOCAL_MLX_DIR = path.join(STATE_DIR, "local-mlx", LOCAL_MLX_ID);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function executableNames(platform) {
  return platform === "win32" ? ["lms.exe", "lms.cmd", "lms.bat", "lms"] : ["lms"];
}

function commandNames(command, platform) {
  return platform === "win32"
    ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
    : [command];
}

function commandCandidates(command, {
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  const candidates = [];
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const name of commandNames(command, platform)) candidates.push(path.join(directory, name));
  }
  for (const name of commandNames(command, platform)) {
    candidates.push(path.join(home, ".local", "bin", name));
    candidates.push(path.join(home, ".cargo", "bin", name));
  }
  return candidates;
}

function findExecutable(candidates, access = accessSync) {
  for (const candidate of [...new Set(candidates)]) {
    try {
      access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking in the remaining documented/default locations.
    }
  }
  return undefined;
}

export function lmsCandidates({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  const candidates = [];
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const name of executableNames(platform)) candidates.push(path.join(directory, name));
  }
  candidates.push(path.join(home, ".lmstudio", "bin", platform === "win32" ? "lms.exe" : "lms"));
  if (platform === "darwin") {
    candidates.push(
      "/Applications/LM Studio.app/Contents/Resources/app/.webpack/lms",
      path.join(home, "Applications/LM Studio.app/Contents/Resources/app/.webpack/lms"),
    );
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(path.join(localAppData, "LM Studio", "bin", "lms.exe"));
    }
  }
  return [...new Set(candidates)];
}

export function findLms(options = {}) {
  const access = options.accessSyncImpl || accessSync;
  return findExecutable(lmsCandidates(options), access);
}

export function findUvx(options = {}) {
  return findExecutable(
    commandCandidates("uvx", options),
    options.accessSyncImpl || accessSync,
  );
}

export function missingLmsMessage(platform = process.platform) {
  const command =
    platform === "win32"
      ? "irm https://lmstudio.ai/install.ps1 | iex"
      : "curl -fsSL https://lmstudio.ai/install.sh | bash";
  return (
    "LM Studio's `lms` CLI was not found. Install the official llmster package yourself, " +
    `then retry. Official command: ${command}\n` +
    "This router does not download or execute that installer for you."
  );
}

export function missingUvxMessage() {
  return (
    "The `uvx` command was not found. Install uv from the official instructions at " +
    "https://docs.astral.sh/uv/getting-started/installation/, then retry. " +
    "This router does not install system runtimes for you."
  );
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const target = spawnableCommand(command, args, options.platform || process.platform);
    const child = spawn(target.command, target.args, {
      ...target.options,
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function checkedRun(run, command, args, label) {
  const result = await run(command, args, { cwd: REPO_ROOT });
  if (result?.code !== 0) {
    throw new Error(`${label} failed (exit ${result?.code ?? "unknown"}).`);
  }
  return result;
}

function huggingFaceIdentity(reference) {
  let url;
  try {
    url = new URL(reference);
  } catch {
    throw new Error("The model must be an https://huggingface.co/<owner>/<repository> URL.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname !== "huggingface.co" || parts.length !== 2) {
    throw new Error("The model must be an https://huggingface.co/<owner>/<repository> URL.");
  }
  return `${decodeURIComponent(parts[0])}/${decodeURIComponent(parts[1]).replace(/\.git$/i, "")}`;
}

function directoryHasFiles(directory) {
  try {
    return readdirSync(directory).some((name) => {
      const target = path.join(directory, name);
      const stat = statSync(target);
      return stat.isFile() || (stat.isDirectory() && directoryHasFiles(target));
    });
  } catch {
    return false;
  }
}

export async function probeLmstudio({
  fetchImpl = fetch,
  timeoutMs = 3000,
  baseUrl = LMSTUDIO_URL,
} = {}) {
  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { reachable: false, ids: [] };
    const payload = await response.json().catch(() => ({}));
    const rows = Array.isArray(payload) ? payload : payload?.data;
    const ids = Array.isArray(rows)
      ? [...new Set(rows.map((row) => String(row?.id || "").trim()).filter(Boolean))]
      : [];
    return { reachable: true, ids };
  } catch {
    return { reachable: false, ids: [] };
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function installLocalMlx({
  reference = DEFAULT_MLX_URL,
  yes = false,
  lmsPath = findLms(),
  uvxPath = findUvx(),
  modelDir = LOCAL_MLX_DIR,
  downloadReady = directoryHasFiles,
  run = runProcess,
  fetchImpl = fetch,
  sleep = wait,
  probeAttempts = 20,
} = {}) {
  const identity = huggingFaceIdentity(reference);
  if (!yes) {
    throw new Error("Pass --yes to consent to downloading and loading this large local model.");
  }
  if (!lmsPath) throw new Error(missingLmsMessage());
  if (!uvxPath) throw new Error(missingUvxMessage());

  // This repository contains 2-, 4-, 6-, and 8-bit weights in nested folders.
  // Fetching through `lms get --mlx` can select/download more than one precision,
  // and LMS's @quant selector does not reliably address nested repositories.
  // Keep the one supported precision in private router state and load that exact path.
  mkdirSync(modelDir, { recursive: true, mode: 0o700 });

  await checkedRun(run, lmsPath, ["daemon", "up", "--json"], "Starting llmster");
  try {
    await checkedRun(
      run,
      uvxPath,
      [
        "--from",
        "huggingface-hub",
        "hf",
        "download",
        identity,
        "--include",
        MLX_INCLUDE,
        "--local-dir",
        modelDir,
      ],
      "Downloading the 4-bit MLX model",
    );
  } catch {
    throw new Error(
      "LM Studio could not download the model. Check that the repository exists and is not gated; " +
        "if Hugging Face authentication is needed, sign in with the official Hugging Face CLI " +
        "used by this command, then retry. " +
        "The router never reads or copies Hugging Face tokens.",
    );
  }
  const modelKey = path.join(modelDir, "4-bit");
  if (!downloadReady(modelKey)) {
    throw new Error(
      "The Hugging Face download completed without a usable 4-bit model directory. " +
        "The repository may be absent, gated, or have changed layout.",
    );
  }
  await checkedRun(
    run,
    lmsPath,
    [
      "load",
      modelKey,
      "--identifier",
      LOCAL_MLX_ID,
      "--context-length",
      String(LOCAL_MLX_CONTEXT),
      "--gpu",
      "max",
      "-y",
    ],
    "Loading the MLX model",
  );
  const serverStart = await run(
    lmsPath,
    ["server", "start", "--port", "1234", "--bind", "127.0.0.1"],
    { cwd: REPO_ROOT },
  );
  if (serverStart?.code !== 0) {
    // `lms server start` can reject a duplicate start even though the exact
    // loopback server we need is already healthy. That state is success; any
    // other nonzero result remains a hard failure before publication.
    const existing = await probeLmstudio({ fetchImpl });
    if (!existing.reachable) {
      throw new Error(
        `Starting the LM Studio server failed (exit ${serverStart?.code ?? "unknown"}).`,
      );
    }
  }

  let served = { reachable: false, ids: [] };
  for (let attempt = 0; attempt < probeAttempts; attempt += 1) {
    served = await probeLmstudio({ fetchImpl });
    if (served.reachable && served.ids.includes(LOCAL_MLX_ID)) break;
    if (attempt + 1 < probeAttempts) await sleep(500);
  }
  if (!served.reachable) {
    throw new Error("LM Studio did not become reachable at http://127.0.0.1:1234/v1.");
  }
  if (!served.ids.includes(LOCAL_MLX_ID)) {
    throw new Error(`LM Studio is reachable but does not serve the required id ${LOCAL_MLX_ID}.`);
  }

  await checkedRun(
    run,
    path.join(REPO_ROOT, "bin", "control"),
    ["local-models", "lmstudio-set", LOCAL_MLX_ID, "on"],
    "Publishing the LM Studio model to Codex",
  );
  return {
    ok: true,
    modelKey,
    id: LOCAL_MLX_ID,
    slug: `lmstudio/${LOCAL_MLX_ID}`,
    contextLength: LOCAL_MLX_CONTEXT,
  };
}

export async function localMlxStatus({
  lmsPath = findLms(),
  uvxPath = findUvx(),
  fetchImpl = fetch,
  published,
} = {}) {
  const server = await probeLmstudio({ fetchImpl });
  let isPublished = published;
  if (isPublished === undefined) {
    try {
      const { isLmstudioModelEnabled } = await import("./lmstudio-models.mjs");
      isPublished = isLmstudioModelEnabled(LOCAL_MLX_ID);
    } catch {
      isPublished = false;
    }
  }
  return {
    lmsAvailable: Boolean(lmsPath),
    lmsPath: lmsPath || null,
    uvxAvailable: Boolean(uvxPath),
    uvxPath: uvxPath || null,
    loopbackReachable: server.reachable,
    served: server.ids.includes(LOCAL_MLX_ID),
    published: Boolean(isPublished),
    id: LOCAL_MLX_ID,
    slug: `lmstudio/${LOCAL_MLX_ID}`,
  };
}

function renderStatus(status) {
  return [
    `lms CLI: ${status.lmsAvailable ? `available (${status.lmsPath})` : "not found"}`,
    `uvx: ${status.uvxAvailable ? `available (${status.uvxPath})` : "not found"}`,
    `LM Studio loopback: ${status.loopbackReachable ? "reachable" : "unreachable"}`,
    `Model served: ${status.served ? "yes" : "no"}`,
    `Published to Codex: ${status.published ? "yes" : "no"}`,
    `Codex model: ${status.slug}`,
  ].join("\n");
}

async function main(args = process.argv.slice(2)) {
  const action = args[0];
  if (action === "status") {
    const status = await localMlxStatus();
    process.stdout.write(`${args.includes("--json") ? JSON.stringify(status) : renderStatus(status)}\n`);
    return;
  }
  if (action === "install") {
    if (process.env.MODEL_ROUTER_TARGET && process.env.MODEL_ROUTER_TARGET !== "codex") {
      throw new Error("local-mlx install currently supports the Codex target only.");
    }
    const positional = args.slice(1).filter((value) => !value.startsWith("--"));
    if (positional.length > 1) {
      throw new Error("Usage: local-mlx install [HF_URL] --yes");
    }
    const result = await installLocalMlx({
      reference: positional[0] || DEFAULT_MLX_URL,
      yes: args.includes("--yes"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error("Usage: local-mlx install [HF_URL] --yes | local-mlx status [--json]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
