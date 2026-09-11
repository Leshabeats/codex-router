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
const HIDDEN_NATIVE_TOOLS = new Set(["apply_patch", "exec_command", "shell_command"]);

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

export function compileReadFileCommand(argumentsText) {
  const value = parseFacadeObject(argumentsText);
  if (!value || typeof value.target_file !== "string") return undefined;
  const quoted = posixSingleQuote(value.target_file);
  if (!quoted) return undefined;
  const offset = value.offset === undefined ? 1 : value.offset;
  const limit = value.limit === undefined ? DEFAULT_READ_LIMIT : value.limit;
  if (!Number.isInteger(offset) || offset < 1) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) return undefined;
  const end = offset + limit - 1;
  return JSON.stringify({ cmd: `sed -n '${offset},${end}p' ${quoted}` });
}

export function compileGrepCommand(argumentsText) {
  const value = parseFacadeObject(argumentsText);
  if (!value || typeof value.pattern !== "string" || value.pattern.length === 0) return undefined;
  const pattern = posixSingleQuote(value.pattern);
  if (!pattern) return undefined;
  const path = value.path === undefined ? "." : value.path;
  const quotedPath = posixSingleQuote(path);
  if (!quotedPath) return undefined;
  let cmd = `rg --line-number --color never --max-count 50 -e ${pattern}`;
  if (Object.hasOwn(value, "glob")) {
    if (typeof value.glob !== "string" || !value.glob) return undefined;
    const glob = posixSingleQuote(value.glob);
    if (!glob) return undefined;
    cmd += ` --glob ${glob}`;
  }
  cmd += ` -- ${quotedPath}`;
  return JSON.stringify({ cmd });
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

function execCommandName(tools) {
  const names = tools.map((tool) => tool?.name).filter(Boolean);
  if (names.includes("exec_command")) return "exec_command";
  return names.find((name) => name === "shell_command" || name.endsWith("__exec_command"));
}

export function compileListDirCommand(argumentsText) {
  const value = parseFacadeObject(argumentsText) ?? {};
  const directory = value.target_directory === undefined ? "." : value.target_directory;
  const quoted = posixSingleQuote(directory);
  if (!quoted) return undefined;
  return JSON.stringify({ cmd: `ls -la ${quoted}` });
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

export function classifyShellCommand(command) {
  if (typeof command !== "string" || command.includes("\0")) return { kind: "process" };
  if (/\.write_text\b|\btee\s|>>|open\([^)]*['\"]w/.test(command)) {
    return { kind: "write" };
  }
  if (/(?:^|[\s;|&])>(?!>)/.test(command) && /\.(js|jsx|ts|tsx|json|mjs|cjs|css|scss|md)\b/.test(command)) {
    return { kind: "write" };
  }
  const pyRead = /Path\(['"]([^'"]+)['"]\)[\s\S]*\.read_text\(/.exec(command);
  if (pyRead) return { kind: "read_file", args: { target_file: pyRead[1] } };
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
    const canonical = /^rg --line-number --color never --max-count 50 -e (.+?)(?: --glob (.+))? -- (.+)$/u.exec(line);
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

export function compileRunTerminalCommand(argumentsText) {
  const value = parseFacadeObject(argumentsText);
  if (!value || typeof value.command !== "string" || !value.command) return undefined;
  if (value.command.includes("\0")) return undefined;
  const classified = classifyShellCommand(value.command);
  if (classified.kind === "read_file") {
    return compileReadFileCommand(JSON.stringify(classified.args));
  }
  if (classified.kind === "grep") {
    return compileGrepCommand(JSON.stringify(classified.args));
  }
  if (classified.kind === "list_dir") {
    return compileListDirCommand(JSON.stringify(classified.args));
  }
  if (classified.kind === "write") {
    return JSON.stringify({ cmd: SHELL_NOT_EDITOR_COMMAND });
  }
  const payload = { cmd: value.command };
  if (typeof value.working_directory === "string" && value.working_directory) {
    payload.workdir = value.working_directory;
  }
  return JSON.stringify(payload);
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
    }
    return item;
  });
  return changed ? routed : input;
}

function hideNativeTools(tools, nativeExec) {
  return tools.filter((tool) => {
    const name = tool?.name;
    if (typeof name !== "string") return true;
    if (HIDDEN_NATIVE_TOOLS.has(name)) return false;
    if (nativeExec && name === nativeExec) return false;
    if (name.endsWith("__exec_command") || name.endsWith("__apply_patch")) return false;
    return true;
  });
}

export function grokEditFacadeEnabled(route, structuredPatch) {
  return structuredPatch === true && route?.slug === GROK_EDIT_FACADE_ROUTE;
}

export function applyGrokEditFacade(tools, namespaces, route, structuredPatch) {
  if (!grokEditFacadeEnabled(route, structuredPatch) || !Array.isArray(tools)) return tools;
  const existing = new Set(
    tools
      .map((tool) => (typeof tool?.name === "string" ? tool.name : ""))
      .filter(Boolean),
  );
  const aliases = [];
  const extra = [];
  for (const tool of FACADE_TOOLS) {
    if (existing.has(tool.name)) continue;
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
  const nativeExec = execCommandName(tools);
  const functionRelays = [];
  if (nativeExec) {
    if (!existing.has(READ_FILE_TOOL_NAME)) {
      functionRelays.push({
        providerName: READ_FILE_TOOL_NAME,
        nativeName: nativeExec,
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
        nativeName: nativeExec,
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
        nativeName: nativeExec,
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
        nativeName: nativeExec,
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
  if (extra.length === 0) return hideNativeTools(tools, nativeExec);
  return hideNativeTools([...tools, ...extra], nativeExec);
}
