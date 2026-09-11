import { jsonArgumentsAreUnambiguous, registerCustomToolRelays, registerFunctionRelays } from "./namespace-relay.mjs";
import {
  compileStructuredPatchArguments,
  GROK_STRUCTURED_PATCH_CODEC,
  MAX_STRUCTURED_PATCH_BYTES,
} from "./grok-structured-patch.mjs";

export const GROK_EDIT_FACADE_ROUTE = "grok-oauth/grok-4.6";
export const SEARCH_REPLACE_TOOL_NAME = "search_replace";
export const WRITE_TOOL_NAME = "write";
export const READ_FILE_TOOL_NAME = "read_file";
export const GREP_TOOL_NAME = "grep";
export const LIST_DIR_TOOL_NAME = "list_dir";
export const RUN_TERMINAL_COMMAND_TOOL_NAME = "run_terminal_command";
export const DEFAULT_READ_LIMIT = 400;
export const MAX_READ_LIMIT = 2000;
const HIDDEN_NATIVE_TOOLS = new Set(["exec_command", "shell_command"]);

const pathSchema = { type: "string", minLength: 1, maxLength: 65536 };
const bodySchema = { type: "string", maxLength: MAX_STRUCTURED_PATCH_BYTES };
const objectSchema = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const SEARCH_REPLACE_PARAMETERS = objectSchema({
  path: pathSchema,
  old_string: { ...bodySchema, minLength: 1 },
  new_string: bodySchema,
  replace_all: { type: "boolean" },
}, ["path", "old_string", "new_string"]);

export const WRITE_PARAMETERS = objectSchema({
  path: pathSchema,
  contents: bodySchema,
}, ["path", "contents"]);

const facadeCodec = {
  version: GROK_STRUCTURED_PATCH_CODEC.version,
  maxArgumentBytes: MAX_STRUCTURED_PATCH_BYTES,
  decodeArguments: compileStructuredPatchArguments,
};

export const SEARCH_REPLACE_CODEC = {
  ...facadeCodec,
  parameters: SEARCH_REPLACE_PARAMETERS,
  description() {
    return [
      "Replace exact text in an existing file.",
      "path is a workspace-relative file path. old_string must match one unique occurrence.",
      "One occurrence per call; call again for further replacements.",
    ].join(" ");
  },
};

export const WRITE_CODEC = {
  ...facadeCodec,
  parameters: WRITE_PARAMETERS,
  description() {
    return [
      "Create a new file with the given contents.",
      "Fails if the path already exists; change existing files with search_replace.",
    ].join(" ");
  },
};

const FACADE_TOOLS = [
  {
    name: SEARCH_REPLACE_TOOL_NAME,
    codec: SEARCH_REPLACE_CODEC,
  },
  {
    name: WRITE_TOOL_NAME,
    codec: WRITE_CODEC,
  },
];

export function posixSingleQuote(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || /[\r\n]/u.test(value)) {
    return undefined;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseFacadeObject(argumentsText) {
  if (typeof argumentsText !== "string" || !jsonArgumentsAreUnambiguous(argumentsText)) {
    return undefined;
  }
  try {
    const value = JSON.parse(argumentsText);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function parseExactObject(argumentsText, required, optional = []) {
  const value = parseFacadeObject(argumentsText);
  if (!value) return undefined;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return undefined;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return undefined;
  }
  return value;
}

function terminateUnixPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return undefined;
  if (filePath.startsWith("-")) return `./${filePath}`;
  return filePath;
}

function powershellLiteral(value) {
  if (typeof value !== "string" || value.includes("\0") || /[\r\n]/.test(value)) return undefined;
  return `'${value.replace(/'/g, "''")}'`;
}

function withWorkdir(payload, workdir) {
  if (typeof workdir === "string" && workdir) payload.workdir = workdir;
  return JSON.stringify(payload);
}

function fileReadCommand(filePath, offset, limit, workdir, platform = process.platform) {
  if (platform === "win32") {
    const literal = powershellLiteral(filePath);
    if (!literal) return undefined;
    const skip = offset - 1;
    return withWorkdir({
      cmd: `powershell -NoProfile -Command "Get-Content -LiteralPath ${literal} | Select-Object -Skip ${skip} -First ${limit}"`,
    }, workdir);
  }
  const posixPath = terminateUnixPath(filePath);
  const quoted = posixSingleQuote(posixPath);
  if (!quoted) return undefined;
  const end = offset + limit - 1;
  return withWorkdir({ cmd: `sed -n '${offset},${end}p' ${quoted}` }, workdir);
}

export function compileReadFileCommand(argumentsText, workdir, platform = process.platform) {
  const value = parseExactObject(argumentsText, ["target_file"], ["offset", "limit"]);
  if (!value || typeof value.target_file !== "string") return undefined;
  const offset = value.offset === undefined ? 1 : value.offset;
  const limit = value.limit === undefined ? DEFAULT_READ_LIMIT : value.limit;
  if (!Number.isInteger(offset) || offset < 1) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) return undefined;
  return fileReadCommand(value.target_file, offset, limit, workdir, platform);
}

export function compileGrepCommand(argumentsText, workdir, platform = process.platform) {
  const value = parseExactObject(argumentsText, ["pattern"], ["path", "glob"]);
  if (!value || typeof value.pattern !== "string" || value.pattern.length === 0) return undefined;
  const pattern = posixSingleQuote(value.pattern);
  if (!pattern) return undefined;
  const path = value.path === undefined ? "." : value.path;
  const quotedPath = posixSingleQuote(terminateUnixPath(path) || path);
  if (!quotedPath) return undefined;
  let cmd = `rg --line-number --color never --max-count 50 -e ${pattern}`;
  if (Object.hasOwn(value, "glob")) {
    if (typeof value.glob !== "string" || !value.glob) return undefined;
    const glob = posixSingleQuote(value.glob);
    if (!glob) return undefined;
    cmd += ` --glob ${glob}`;
  }
  cmd += ` -- ${quotedPath}`;
  cmd = platform === "win32"
    ? `${cmd} | Select-Object -First 50`
    : `${cmd} | head -n 50`;
  return withWorkdir({ cmd }, workdir);
}

const READ_FILE_PARAMETERS = objectSchema({
  target_file: pathSchema,
  offset: { type: "integer", minimum: 1 },
  limit: { type: "integer", minimum: 1, maximum: MAX_READ_LIMIT },
}, ["target_file"]);

const GREP_PARAMETERS = objectSchema({
  pattern: { type: "string", minLength: 1, maxLength: 65536 },
  path: pathSchema,
  glob: { type: "string", minLength: 1, maxLength: 1024 },
}, ["pattern"]);

const LIST_DIR_PARAMETERS = objectSchema({
  target_directory: pathSchema,
}, []);

const RUN_TERMINAL_COMMAND_PARAMETERS = objectSchema({
  command: { type: "string", minLength: 1, maxLength: MAX_STRUCTURED_PATCH_BYTES },
  working_directory: pathSchema,
}, ["command"]);

function nativeExecRelayTarget(tools, namespaces) {
  const exact = tools.find((tool) => tool?.name === "exec_command" && tool.namespace === undefined);
  if (exact) return { nativeName: "exec_command" };
  if (!(namespaces instanceof Map)) return undefined;
  const owners = [];
  for (const [namespace, names] of namespaces) {
    if (typeof namespace === "string" && namespace && names instanceof Set && names.has("exec_command")) {
      owners.push(namespace);
    }
  }
  if (owners.length !== 1) return undefined;
  return { nativeName: "exec_command", nativeNamespace: owners[0] };
}

export function compileListDirCommand(argumentsText, workdir, platform = process.platform) {
  const value = argumentsText === undefined || argumentsText === ""
    ? {}
    : parseExactObject(argumentsText, [], ["target_directory"]);
  if (!value) return undefined;
  const directory = value.target_directory === undefined ? "." : value.target_directory;
  if (typeof directory !== "string" || !directory) return undefined;
  if (platform === "win32") {
    const literal = powershellLiteral(directory);
    if (!literal) return undefined;
    return withWorkdir({
      cmd: `powershell -NoProfile -Command "Get-ChildItem -LiteralPath ${literal}"`,
    }, workdir);
  }
  const quoted = posixSingleQuote(terminateUnixPath(directory) || directory);
  if (!quoted) return undefined;
  return withWorkdir({ cmd: `ls -la ${quoted}` }, workdir);
}

export function rewriteGrokFacadeToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return toolChoice;
  if (toolChoice.type === "function" && (toolChoice.name === "exec_command" || toolChoice.name === "shell_command")) {
    return { ...toolChoice, name: RUN_TERMINAL_COMMAND_TOOL_NAME };
  }
  if (toolChoice.type === "function" && toolChoice.name === "apply_patch") {
    return { ...toolChoice, name: SEARCH_REPLACE_TOOL_NAME };
  }
  if (toolChoice.type === "allowed_tools" && Array.isArray(toolChoice.tools)) {
    return { ...toolChoice, tools: toolChoice.tools.map((choice) => rewriteGrokFacadeToolChoice(choice)) };
  }
  return toolChoice;
}

export const SHELL_NOT_EDITOR_COMMAND =
  "printf '%s\\n' 'use write or search_replace; shell is not a file editor' >&2; exit 1";

function unquotedOrPosix(token) {
  if (typeof token !== "string") return undefined;
  const trimmed = token.trim();
  return unquotePosix(trimmed) ?? (/^[\w./@+-]+$/u.test(trimmed) ? trimmed : undefined);
}

function singleLineCommand(command) {
  const trimmed = command.trim();
  if (!trimmed || /[\n;&|]/.test(trimmed) || trimmed.includes("&&") || trimmed.includes("||")) {
    return undefined;
  }
  return trimmed;
}

function standalonePathRead(command) {
  const trimmed = command.trim();
  let match = /^Path\(['"]([^'"]+)['"]\)\.read_text\(\)\s*$/u.exec(trimmed);
  if (match) return match[1];
  match = /^from pathlib import Path\s*\nPath\(['"]([^'"]+)['"]\)\.read_text\(\)\s*$/u.exec(trimmed);
  if (match) return match[1];
  match = /^from pathlib import Path\s*\np=Path\(['"]([^'"]+)['"]\)\s*\nprint\(p\.read_text\(\)\)\s*$/u.exec(trimmed);
  if (match) return match[1];
  return undefined;
}

export function classifyShellCommand(command) {
  if (typeof command !== "string" || command.includes("\0")) return { kind: "process" };
  if (/\.write_text\b|\btee\s|>>|open\([^)]*['\"]w/.test(command)) {
    return { kind: "write" };
  }
  if (/(?:^|[\s;|&])>(?!>)/.test(command)) {
    return { kind: "write" };
  }
  const standalone = standalonePathRead(command);
  if (standalone) return { kind: "read_file", args: { target_file: standalone } };
  const pipedGrep = /^rg --line-number --color never --max-count 50 -e (.+?)(?: --glob (.+))? -- (.+?) \| head -n 50$/u.exec(command.trim());
  if (pipedGrep) {
    const pattern = unquotePosix(pipedGrep[1]);
    const path = unquotePosix(pipedGrep[3]);
    if (pattern && path) {
      const args = { pattern, path };
      if (pipedGrep[2]) {
        const glob = unquotePosix(pipedGrep[2]);
        if (glob) args.glob = glob;
      }
      return { kind: "grep", args };
    }
  }
  const line = singleLineCommand(command);
  if (!line) return { kind: "process" };
  const sed = /^sed -n '(\d+),(\d+)p'(?: --)? (.+)$/u.exec(line);
  if (sed) {
    const target_file = unquotedOrPosix(sed[3]);
    if (!target_file) return { kind: "process" };
    return {
      kind: "read_file",
      args: { target_file, offset: Number(sed[1]), limit: Number(sed[2]) - Number(sed[1]) + 1 },
    };
  }
  const cat = /^cat(?: --)? (.+)$/u.exec(line);
  if (cat) {
    const target_file = unquotedOrPosix(cat[1]);
    if (!target_file) return { kind: "process" };
    return { kind: "read_file", args: { target_file } };
  }
  const head = /^head(?: -n (\d+))?(?: --)? (.+)$/u.exec(line);
  if (head) {
    const target_file = unquotedOrPosix(head[2]);
    if (!target_file) return { kind: "process" };
    return {
      kind: "read_file",
      args: { target_file, offset: 1, limit: head[1] ? Number(head[1]) : DEFAULT_READ_LIMIT },
    };
  }
  const rg = /^(?:rg|grep) (?:-[nI]+\s+)?(.+)$/u.exec(line);
  if (rg && !/\snode_modules\/.*dist/.test(line)) {
    // Keep raw rg as grep only when it's a simple `rg -n pattern path` or our canonical form.
    const canonical = /^rg --line-number --color never --max-count 50 -e (.+?)(?: --glob (.+))? -- (.+?)(?: \| head -n 50)?$/u.exec(line);
    if (canonical) {
      const pattern = unquotePosix(canonical[1]);
      const path = unquotePosix(canonical[3]);
      if (!pattern || !path) return { kind: "process" };
      const args = { pattern, path };
      if (canonical[2]) {
        const glob = unquotePosix(canonical[2]);
        if (!glob) return { kind: "process" };
        args.glob = glob;
      }
      return { kind: "grep", args };
    }
    const simple = /^rg -n (\S+) (.+)$/u.exec(line);
    if (simple) {
      const pattern = unquotedOrPosix(simple[1]);
      const path = unquotedOrPosix(simple[2]);
      if (pattern && path) return { kind: "grep", args: { pattern, path } };
    }
  }
  const ls = /^ls(?: -la)?(?: --)?(?: (.+))?$/u.exec(line);
  if (ls) {
    const target_directory = ls[1] ? unquotedOrPosix(ls[1]) : ".";
    if (!target_directory) return { kind: "process" };
    return { kind: "list_dir", args: { target_directory } };
  }
  return { kind: "process" };
}

export function compileRunTerminalCommand(argumentsText, platform = process.platform) {
  const value = parseExactObject(argumentsText, ["command"], ["working_directory"]);
  if (!value || typeof value.command !== "string" || !value.command) return undefined;
  if (value.command.includes("\0")) return undefined;
  if (Object.hasOwn(value, "working_directory") && typeof value.working_directory !== "string") {
    return undefined;
  }
  const workdir = value.working_directory;
  const classified = classifyShellCommand(value.command);
  if (classified.kind === "read_file") {
    return compileReadFileCommand(JSON.stringify(classified.args), workdir, platform);
  }
  if (classified.kind === "grep") {
    return compileGrepCommand(JSON.stringify(classified.args), workdir, platform);
  }
  if (classified.kind === "list_dir") {
    return compileListDirCommand(JSON.stringify(classified.args), workdir, platform);
  }
  if (classified.kind === "write") {
    return JSON.stringify({ cmd: SHELL_NOT_EDITOR_COMMAND });
  }
  return withWorkdir({ cmd: value.command }, workdir);
}

function unquotePosix(value) {
  if (typeof value !== "string" || !value.startsWith("'") || !value.endsWith("'")) return undefined;
  return value.slice(1, -1).replace(/'\\''/g, "'");
}

function parseExecPayload(argumentsText) {
  const value = parseFacadeObject(argumentsText);
  if (!value || typeof value.cmd !== "string") return undefined;
  return value;
}

export function encodeExecCommandHistory(argumentsText) {
  const value = parseExecPayload(argumentsText);
  if (!value) return undefined;
  const classified = classifyShellCommand(value.cmd);
  if (classified.kind === "read_file") {
    return { name: READ_FILE_TOOL_NAME, arguments: JSON.stringify(classified.args) };
  }
  if (classified.kind === "grep") {
    return { name: GREP_TOOL_NAME, arguments: JSON.stringify(classified.args) };
  }
  if (classified.kind === "list_dir") {
    const args = classified.args?.target_directory === "." ? {} : classified.args;
    return { name: LIST_DIR_TOOL_NAME, arguments: JSON.stringify(args ?? {}) };
  }
  const encoded = { command: value.cmd };
  if (typeof value.workdir === "string" && value.workdir) encoded.working_directory = value.workdir;
  return { name: RUN_TERMINAL_COMMAND_TOOL_NAME, arguments: JSON.stringify(encoded) };
}

export function encodeGrokFacadeHistory(input, nativeExec) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const routed = input.map((item) => {
    if (item?.type !== "function_call" || typeof item.name !== "string") return item;
    const isExec = item.name === nativeExec || item.name === "exec_command" ||
      item.name === "shell_command" || item.name.endsWith("__exec_command");
    if (isExec) {
      const encoded = encodeExecCommandHistory(item.arguments);
      if (!encoded) return item;
      changed = true;
      const { name: _name, arguments: _arguments, ...rest } = item;
      return { ...rest, name: encoded.name, arguments: encoded.arguments };
    }
    if (item.name === "apply_patch" || item.name.endsWith("__apply_patch")) {
      const value = parseFacadeObject(item.arguments);
      if (!value) return item;
      if (Object.hasOwn(value, "old_string") || Object.hasOwn(value, "contents") || Object.hasOwn(value, "operations")) {
        changed = true;
        const { name: _name, ...rest } = item;
        const name = Object.hasOwn(value, "contents") ? WRITE_TOOL_NAME : SEARCH_REPLACE_TOOL_NAME;
        return { ...rest, name, arguments: item.arguments };
      }
      if (typeof value.input === "string" && value.input.includes("*** Begin Patch")) {
        changed = true;
        const { name: _name, ...rest } = item;
        const name = value.input.includes("*** Add File:") ? WRITE_TOOL_NAME : SEARCH_REPLACE_TOOL_NAME;
        return { ...rest, name, arguments: item.arguments };
      }
    }
    return item;
  });
  return changed ? routed : input;
}

function hideNativeTools(tools) {
  return tools.filter((tool) => {
    const name = tool?.name;
    if (typeof name !== "string") return true;
    if (HIDDEN_NATIVE_TOOLS.has(name)) return false;
    if (name.endsWith("__exec_command")) return false;
    return true;
  });
}

export function grokEditFacadeEnabled(route, structuredPatch) {
  return structuredPatch === true && route?.slug === GROK_EDIT_FACADE_ROUTE;
}

export function applyGrokEditFacade(tools, namespaces, route, structuredPatch, options = {}) {
  if (!grokEditFacadeEnabled(route, structuredPatch) || !Array.isArray(tools)) return tools;
  const existing = new Set(
    tools
      .map((tool) => (typeof tool?.name === "string" ? tool.name : ""))
      .filter(Boolean),
  );
  const aliases = [];
  const extra = [];
  const allowWrite = options.patchHook === true;
  for (const tool of FACADE_TOOLS) {
    if (existing.has(tool.name)) continue;
    if (tool.name === WRITE_TOOL_NAME && !allowWrite) continue;
    aliases.push({
      providerName: tool.name,
      nativeName: "apply_patch",
      codec: tool.codec,
    });
    extra.push({
      type: "function",
      name: tool.name,
      description: tool.codec.description(),
      parameters: tool.codec.parameters,
    });
  }
  const nativeExec = nativeExecRelayTarget(tools, namespaces);
  const functionRelays = [];
  if (nativeExec) {
    if (!existing.has(READ_FILE_TOOL_NAME)) {
      functionRelays.push({
        providerName: READ_FILE_TOOL_NAME,
        nativeName: nativeExec.nativeName,
        nativeNamespace: nativeExec.nativeNamespace,
        rewriteArguments: compileReadFileCommand,
        maxArgumentBytes: MAX_STRUCTURED_PATCH_BYTES,
      });
      extra.push({
        type: "function",
        name: READ_FILE_TOOL_NAME,
        description: "Read a bounded slice of a local file. Defaults to 400 lines.",
        parameters: READ_FILE_PARAMETERS,
      });
    }
    if (!existing.has(GREP_TOOL_NAME)) {
      functionRelays.push({
        providerName: GREP_TOOL_NAME,
        nativeName: nativeExec.nativeName,
        nativeNamespace: nativeExec.nativeNamespace,
        rewriteArguments: compileGrepCommand,
        maxArgumentBytes: MAX_STRUCTURED_PATCH_BYTES,
      });
      extra.push({
        type: "function",
        name: GREP_TOOL_NAME,
        description: "Search local file contents with a regex. Optional path and glob.",
        parameters: GREP_PARAMETERS,
      });
    }
    if (!existing.has(LIST_DIR_TOOL_NAME)) {
      functionRelays.push({
        providerName: LIST_DIR_TOOL_NAME,
        nativeName: nativeExec.nativeName,
        nativeNamespace: nativeExec.nativeNamespace,
        rewriteArguments: compileListDirCommand,
        maxArgumentBytes: MAX_STRUCTURED_PATCH_BYTES,
      });
      extra.push({
        type: "function",
        name: LIST_DIR_TOOL_NAME,
        description: "List a local directory.",
        parameters: LIST_DIR_PARAMETERS,
      });
    }
    if (!existing.has(RUN_TERMINAL_COMMAND_TOOL_NAME)) {
      functionRelays.push({
        providerName: RUN_TERMINAL_COMMAND_TOOL_NAME,
        nativeName: nativeExec.nativeName,
        nativeNamespace: nativeExec.nativeNamespace,
        rewriteArguments: compileRunTerminalCommand,
        maxArgumentBytes: MAX_STRUCTURED_PATCH_BYTES,
      });
      extra.push({
        type: "function",
        name: RUN_TERMINAL_COMMAND_TOOL_NAME,
        description: "Run a shell command for git, tests, and installs.",
        parameters: RUN_TERMINAL_COMMAND_PARAMETERS,
      });
    }
  }
  if (aliases.length && !registerCustomToolRelays(namespaces, aliases)) {
    return tools;
  }
  if (functionRelays.length && !registerFunctionRelays(namespaces, functionRelays)) {
    return aliases.length ? [...tools, ...extra.filter((tool) => tool.name === SEARCH_REPLACE_TOOL_NAME || tool.name === WRITE_TOOL_NAME)] : tools;
  }
  if (extra.length === 0) return hideNativeTools(tools);
  return hideNativeTools([...tools, ...extra]);
}
