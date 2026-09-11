import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import {
  bridgeCustomTools,
  buildNamespaceLookups,
  flattenNamespaceTools,
  NamespaceToolCallTransform,
} from "../src/namespace-relay.mjs";
import {
  GROK_STRUCTURED_PATCH_CODEC,
  serializeStructuredPatch,
} from "../src/grok-structured-patch.mjs";
import {
  applyGrokEditFacade,
  classifyShellCommand,
  compileGrepCommand,
  compileListDirCommand,
  compileReadFileCommand,
  compileRunTerminalCommand,
  encodeGrokFacadeHistory,
  SHELL_NOT_EDITOR_COMMAND,
  grokEditFacadeEnabled,
  GREP_TOOL_NAME,
  LIST_DIR_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  RUN_TERMINAL_COMMAND_TOOL_NAME,
  SEARCH_REPLACE_PARAMETERS,
  SEARCH_REPLACE_TOOL_NAME,
  WRITE_PARAMETERS,
  WRITE_TOOL_NAME,
} from "../src/grok-tool-facade.mjs";

const native = {
  type: "custom",
  name: "apply_patch",
  description: "Keep project permissions.",
  format: { type: "grammar", syntax: "lark", definition: "native grammar unchanged" },
};
const codecs = new Map([["apply_patch", GROK_STRUCTURED_PATCH_CODEC]]);
const execTool = { type: "function", name: "exec_command", parameters: { type: "object" } };
const replaceArgs = JSON.stringify({
  path: "notes.txt",
  old_string: "hello",
  new_string: "hello world",
});
const replacePatch = serializeStructuredPatch({
  operations: [{
    op: "update",
    path: "notes.txt",
    hunks: [{ lines: [{ kind: "remove", text: "hello" }, { kind: "add", text: "hello world" }] }],
  }],
});

function setup(route = { slug: "grok-oauth/grok-4.6" }, structuredPatch = true, extraTools = []) {
  const flattened = flattenNamespaceTools([native, execTool, ...extraTools]);
  const bridged = bridgeCustomTools(
    flattened.tools,
    [],
    flattened.namespaces,
    undefined,
    undefined,
    { codecs },
  );
  const tools = applyGrokEditFacade(bridged.tools, flattened.namespaces, route, structuredPatch);
  return {
    ...bridged,
    tools,
    namespaces: flattened.namespaces,
    lookups: buildNamespaceLookups(flattened.namespaces),
  };
}

function frame(type, extra = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
}

async function relay(bridge, name, value) {
  const call = { type: "function_call", id: "fc_edit", call_id: "call_edit", name, arguments: value };
  const parts = [
    frame("response.output_item.added", { output_index: 0, item: { ...call, arguments: "" } }),
    frame("response.function_call_arguments.done", { item_id: call.id, output_index: 0, arguments: value }),
    frame("response.output_item.done", { output_index: 0, item: call }),
    frame("response.completed", { response: { output: [call] } }),
  ];
  const chunks = [];
  await pipeline(
    Readable.from(parts),
    new NamespaceToolCallTransform(bridge.namespaces, "text/event-stream", "grok-oauth/grok-4.6"),
    new Writable({
      write(chunk, _encoding, next) {
        chunks.push(Buffer.from(chunk));
        next();
      },
    }),
  );
  return Buffer.concat(chunks).toString("utf8")
    .split(/\n\n/)
    .filter(Boolean)
    .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
}

test("facade is only offered on Grok 4.6 structured-patch turns", () => {
  assert.equal(grokEditFacadeEnabled({ slug: "grok-oauth/grok-4.6" }, true), true);
  assert.equal(grokEditFacadeEnabled({ slug: "grok-oauth/grok-4.6" }, false), false);
  assert.equal(grokEditFacadeEnabled({ slug: "grok-oauth/grok-4.5" }, true), false);
});

test("search_replace and write are added beside apply_patch without colliding", () => {
  const bridge = setup();
  const names = bridge.tools.map((tool) => tool.name);
  assert.ok(names.includes(SEARCH_REPLACE_TOOL_NAME));
  assert.ok(names.includes(WRITE_TOOL_NAME));
  assert.ok(names.includes(READ_FILE_TOOL_NAME));
  assert.ok(names.includes(GREP_TOOL_NAME));
  assert.ok(names.includes(LIST_DIR_TOOL_NAME));
  assert.ok(names.includes(RUN_TERMINAL_COMMAND_TOOL_NAME));
  assert.ok(!names.includes("exec_command"));
  assert.deepEqual(
    bridge.tools.find((tool) => tool.name === SEARCH_REPLACE_TOOL_NAME).parameters,
    SEARCH_REPLACE_PARAMETERS,
  );
  assert.deepEqual(
    bridge.tools.find((tool) => tool.name === WRITE_TOOL_NAME).parameters,
    WRITE_PARAMETERS,
  );
  const skipped = setup({ slug: "grok-oauth/grok-4.6" }, true, [
    { type: "function", name: SEARCH_REPLACE_TOOL_NAME, parameters: { type: "object" } },
  ]);
  assert.equal(skipped.tools.filter((tool) => tool.name === SEARCH_REPLACE_TOOL_NAME).length, 1);
});

test("read_file and grep compile to bounded exec_command payloads", () => {
  assert.equal(
    compileReadFileCommand(JSON.stringify({ target_file: "/tmp/notes.txt" })),
    JSON.stringify({ cmd: "sed -n '1,400p' '/tmp/notes.txt'" }),
  );
  assert.equal(
    compileReadFileCommand(JSON.stringify({ target_file: "/tmp/a.txt", offset: 10, limit: 5 })),
    JSON.stringify({ cmd: "sed -n '10,14p' '/tmp/a.txt'" }),
  );
  assert.equal(
    compileGrepCommand(JSON.stringify({ pattern: "SelectCompat", path: "smid", glob: "*.js" })),
    JSON.stringify({ cmd: "rg --line-number --color never --max-count 50 -e 'SelectCompat' --glob '*.js' -- 'smid'" }),
  );
  assert.equal(compileReadFileCommand(JSON.stringify({ target_file: "a\nb" })), undefined);
  assert.equal(
    compileListDirCommand(JSON.stringify({ target_directory: "smid/app" })),
    JSON.stringify({ cmd: "ls -la 'smid/app'" }),
  );
  assert.equal(
    compileRunTerminalCommand(JSON.stringify({ command: "yarn test:frontend", working_directory: "smid" })),
    JSON.stringify({ cmd: "yarn test:frontend", workdir: "smid" }),
  );
});

test("history restores Codex exec/apply_patch calls back to Grok tool names", () => {
  const encoded = encodeGrokFacadeHistory([
    { type: "function_call", call_id: "1", name: "exec_command", arguments: compileReadFileCommand(JSON.stringify({ target_file: "/tmp/a.js", offset: 1, limit: 40 })) },
    { type: "function_call", call_id: "2", name: "exec_command", arguments: compileGrepCommand(JSON.stringify({ pattern: "foo", path: "smid" })) },
    { type: "function_call", call_id: "3", name: "exec_command", arguments: JSON.stringify({ cmd: "yarn test" }) },
    { type: "function_call", call_id: "4", name: "apply_patch", arguments: JSON.stringify({ path: "a.js", old_string: "a", new_string: "b" }) },
  ]);
  assert.equal(encoded[0].name, READ_FILE_TOOL_NAME);
  assert.equal(encoded[1].name, GREP_TOOL_NAME);
  assert.equal(encoded[2].name, RUN_TERMINAL_COMMAND_TOOL_NAME);
  assert.equal(JSON.parse(encoded[2].arguments).command, "yarn test");
  assert.equal(encoded[3].name, SEARCH_REPLACE_TOOL_NAME);
  const fromCat = encodeGrokFacadeHistory([
    { type: "function_call", call_id: "5", name: "exec_command", arguments: JSON.stringify({ cmd: "cat '/tmp/a.js'" }) },
    { type: "function_call", call_id: "6", name: "exec_command", arguments: JSON.stringify({ cmd: "from pathlib import Path\np=Path('/tmp/a.js')\nprint(p.read_text())" }) },
  ]);
  assert.equal(fromCat[0].name, READ_FILE_TOOL_NAME);
  assert.equal(JSON.parse(fromCat[0].arguments).target_file, "/tmp/a.js");
  assert.equal(fromCat[1].name, READ_FILE_TOOL_NAME);
});

test("run_terminal_command canonicalizes file reads and refuses file writes", () => {
  assert.equal(
    compileRunTerminalCommand(JSON.stringify({ command: "cat '/tmp/a.js'" })),
    compileReadFileCommand(JSON.stringify({ target_file: "/tmp/a.js" })),
  );
  assert.equal(
    compileRunTerminalCommand(JSON.stringify({ command: "Path('/tmp/a.js').write_text('x')" })),
    JSON.stringify({ cmd: SHELL_NOT_EDITOR_COMMAND }),
  );
  assert.equal(classifyShellCommand("yarn test:frontend").kind, "process");
});

test("search_replace restores to native apply_patch with a compiled V4A payload", async () => {
  const bridge = setup();
  const events = await relay(bridge, SEARCH_REPLACE_TOOL_NAME, replaceArgs);
  const done = events.find((event) => event.type === "response.output_item.done");
  assert.equal(done.item.type, "custom_tool_call");
  assert.equal(done.item.name, "apply_patch");
  assert.equal(done.item.input, replacePatch);
  assert.equal(done.item.call_id, "call_edit");
});

test("read_file restores to native exec_command with a bounded sed command", async () => {
  const bridge = setup();
  const args = JSON.stringify({ target_file: "/tmp/SelectCompat/index.js", offset: 1, limit: 40 });
  const events = await relay(bridge, READ_FILE_TOOL_NAME, args);
  const done = events.find((event) => event.type === "response.output_item.done");
  assert.equal(done.item.type, "function_call");
  assert.equal(done.item.name, "exec_command");
  assert.equal(done.item.arguments, JSON.stringify({ cmd: "sed -n '1,40p' '/tmp/SelectCompat/index.js'" }));
  assert.equal(done.item.call_id, "call_edit");
});

test("run_terminal_command restores to native exec_command", async () => {
  const bridge = setup();
  const args = JSON.stringify({ command: "git status", working_directory: "/tmp/repo" });
  const events = await relay(bridge, RUN_TERMINAL_COMMAND_TOOL_NAME, args);
  const done = events.find((event) => event.type === "response.output_item.done");
  assert.equal(done.item.type, "function_call");
  assert.equal(done.item.name, "exec_command");
  assert.equal(done.item.arguments, compileRunTerminalCommand(args));
});
