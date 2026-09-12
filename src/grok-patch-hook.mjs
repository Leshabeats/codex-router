import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  compileStructuredPatchArguments,
  MAX_STRUCTURED_PATCH_BYTES,
  StructuredPatchError,
} from "./grok-structured-patch.mjs";
import { GROK_PATCH_HOOK_PREFIX } from "./grok-patch-hook-transport.mjs";

// JSON escaping can expand the 1 MiB argument string sixfold. Reserve room
// for the native event metadata as well; reject the complete event above 8 MiB.
export const MAX_GROK_PATCH_HOOK_INPUT_BYTES = MAX_STRUCTURED_PATCH_BYTES * 8;

const ADD_FILE_HEADER = "*** Add File:";
const ADD_FILE_EXISTS_REASON = "file exists; use search_replace";
const PATH_OUTSIDE_REASON = "path is outside the workspace";
const OLD_STRING_NOT_FOUND_REASON = "old_string not found";
const OLD_STRING_NOT_UNIQUE_REASON = "old_string is not unique; narrow the match";
const OLD_STRING_FILE_TOO_LARGE_REASON = "file too large to verify unique match";

function patchWorkingDirectory(event) {
  const cwd = event?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

function inspectWorkspacePath(cwd, target) {
  if (typeof cwd !== "string" || typeof target !== "string" || !cwd || !target) return "outside";
  if (cwd.includes("\0") || target.includes("\0")) return "outside";
  let root;
  try {
    root = realpathSync(cwd);
  } catch {
    return "outside";
  }
  const candidate = resolve(root, target);
  if (pathEscapesWorkspace(relative(root, candidate))) return "outside";
  const relativePath = relative(root, candidate);
  const parts = relativePath === "" ? [] : relativePath.split(sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || part === ".") continue;
    current = join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch {
      return index === parts.length - 1 ? "missing" : "outside";
    }
    if (info.isSymbolicLink()) return "outside";
  }
  return "exists";
}

function workspaceCandidate(cwd, target) {
  return inspectWorkspacePath(cwd, target) === "exists" ? resolve(realpathSync(cwd), target) : undefined;
}

function readWorkspaceFile(cwd, target) {
  const candidate = workspaceCandidate(cwd, target);
  if (!candidate) return undefined;
  let fd;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
    if (!constants.O_NOFOLLOW) {
      if (lstatSync(candidate).isSymbolicLink()) return undefined;
    }
    fd = openSync(candidate, flags);
    const info = fstatSync(fd);
    if (!info.isFile()) return undefined;
    if (info.size > MAX_STRUCTURED_PATCH_BYTES) return { tooLarge: true };
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const n = readSync(fd, buffer, offset, info.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return { contents: buffer.toString("utf8") };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

function pathEscapesWorkspace(relativePath) {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

// Grok subagents emit whole-file Add File for paths that already exist.
// Router compile cannot see the worktree; this client hook can existsSync.
function addFileTargetProblem(patch, event) {
  const cwd = patchWorkingDirectory(event);
  for (const rawLine of patch.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith(ADD_FILE_HEADER)) continue;
    const target = line.slice(ADD_FILE_HEADER.length).trim();
    const status = inspectWorkspacePath(cwd, target);
    if (status === "outside") return PATH_OUTSIDE_REASON;
    if (status === "exists") return ADD_FILE_EXISTS_REASON;
  }
  return undefined;
}

function deny(reason) {
  return { hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  } };
}

function logicalLines(text) {
  if (text === "") return [];
  const lines = text.split(/\r?\n/u);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineAlignedMatchCount(contents, needle) {
  const fileLines = logicalLines(contents);
  const needleLines = logicalLines(needle);
  if (needleLines.length === 0) return 0;
  let count = 0;
  for (let i = 0; i <= fileLines.length - needleLines.length; i += 1) {
    if (needleLines.every((line, offset) => fileLines[i + offset] === line)) count += 1;
  }
  return count;
}

function searchReplaceMatchProblem(raw, event) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.old_string !== "string" || typeof value.path !== "string") return undefined;
  const cwd = patchWorkingDirectory(event);
  const file = readWorkspaceFile(cwd, value.path);
  if (!file) return OLD_STRING_NOT_FOUND_REASON;
  if (file.tooLarge) return OLD_STRING_FILE_TOO_LARGE_REASON;
  const count = lineAlignedMatchCount(file.contents, value.old_string);
  if (count === 0) return OLD_STRING_NOT_FOUND_REASON;
  if (count > 1) return OLD_STRING_NOT_UNIQUE_REASON;
  return undefined;
}

// This adapter only serializes. Native apply_patch still validates the patch
// and enforces its permissions. If this hook fails or is absent, the original
// prefixed envelope cannot be a native patch; this is not a general guarantee
// that the client's hook failures deny arbitrary native tool invocations.
export function adaptHookInput(event) {
  const command = event?.tool_input?.command;
  if (event?.model !== "grok-oauth/grok-4.6" || event?.tool_name !== "apply_patch" ||
      typeof command !== "string") return {};
  if (command.startsWith(GROK_PATCH_HOOK_PREFIX)) {
    try {
      const raw = command.slice(GROK_PATCH_HOOK_PREFIX.length);
      const matchProblem = searchReplaceMatchProblem(raw, event);
      if (matchProblem) return deny(matchProblem);
      const patch = compileStructuredPatchArguments(raw);
      const addProblem = addFileTargetProblem(patch, event);
      if (addProblem) return deny(addProblem);
      return { hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: patch },
      } };
    } catch (error) {
      if (!(error instanceof StructuredPatchError)) throw error;
      // Only a bounded codec identifier enters feedback, never argument text or
      // arbitrary exception messages. The client may separately echo the command.
      const code = typeof error.code === "string" && /^[a-z_]{1,64}$/u.test(error.code)
        ? error.code : "invalid_arguments";
      return { hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Invalid structured apply_patch arguments (${code}). Correct the structured arguments and retry this tool.`,
      } };
    }
  }
  const addProblem = addFileTargetProblem(command, event);
  if (addProblem) return deny(addProblem);
  return {};
}

export async function readHookInput(stream) {
  // A fixed byte buffer also bounds bookkeeping when stdin arrives one byte
  // at a time. Decode only after accumulation so split Unicode stays intact.
  const input = Buffer.allocUnsafe(MAX_GROK_PATCH_HOOK_INPUT_BYTES);
  let bytes = 0;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("hook input must be a byte stream");
    if (chunk.byteLength > input.length - bytes) throw new Error("hook event exceeds input bound");
    input.set(chunk, bytes);
    bytes += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(0, bytes));
  return JSON.parse(text);
}
