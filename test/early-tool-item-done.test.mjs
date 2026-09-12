import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  EarlyToolItemDoneTransform,
  MAX_SSE_FRAME_BYTES,
  earlyToolItemDoneTransform,
} from "../src/early-tool-item-done.mjs";
import { ItemLifecycleNormalizer } from "../src/item-lifecycle-normalizer.mjs";

function block(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function events(text) {
  return text
    .split(/\n\n/)
    .filter(Boolean)
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data:")))
    .filter((line) => line && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(5).trimStart()));
}

async function run(input, extra) {
  const stream = extra ?? new EarlyToolItemDoneTransform();
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
  });
  const ended = once(stream, "end");
  stream.write(input);
  stream.end();
  await ended;
  return output;
}

function toolAdded(index, id, name, callId = id) {
  return {
    type: "response.output_item.added",
    output_index: index,
    item: { type: "function_call", id, call_id: callId, name, arguments: "", status: "in_progress" },
  };
}

test("earlyToolItemDoneTransform is grok-oauth SSE only", () => {
  assert.equal(earlyToolItemDoneTransform({ id: "kimi-oauth" }, "text/event-stream"), undefined);
  assert.equal(earlyToolItemDoneTransform({ id: "grok-oauth" }, "application/json"), undefined);
  assert.ok(earlyToolItemDoneTransform({ id: "grok-oauth" }, "text/event-stream"));
});

test("closes the first tool item when the next tool is added", async () => {
  const body = await run([
    block(toolAdded(0, "c1", "apply_patch")),
    block({ type: "response.function_call_arguments.delta", item_id: "c1", output_index: 0, delta: "*** Begin" }),
    block(toolAdded(1, "c2", "apply_patch")),
    block({ type: "response.function_call_arguments.delta", item_id: "c2", output_index: 1, delta: "*** End" }),
    block({
      type: "response.function_call_arguments.done",
      item_id: "c1",
      output_index: 0,
      arguments: "*** Begin",
    }),
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", id: "c1", call_id: "c1", name: "apply_patch", arguments: "*** Begin", status: "completed" },
    }),
    block({ type: "response.completed", response: { status: "completed" } }),
  ].join(""));
  const seen = events(body);
  const types = seen.map((event) => `${event.output_index ?? "-"}:${event.type}`);
  const firstDone = types.indexOf("0:response.output_item.done");
  const secondAdded = types.indexOf("1:response.output_item.added");
  assert.ok(firstDone !== -1 && secondAdded !== -1);
  assert.ok(firstDone < secondAdded);
  assert.equal(seen.filter((event) => event.type === "response.output_item.done" && event.output_index === 0).length, 1);
  assert.equal(seen[firstDone].item.arguments, "*** Begin");
});

test("argument events with a different item id are not attributed by output_index", async () => {
  const body = await run([
    block(toolAdded(0, "c1", "apply_patch")),
    block({
      type: "response.function_call_arguments.delta",
      item_id: "other",
      output_index: 0,
      delta: "FOREIGN",
    }),
    block({
      type: "response.function_call_arguments.done",
      item_id: "other",
      output_index: 0,
      arguments: "FOREIGN",
    }),
    block(toolAdded(1, "c2", "apply_patch")),
  ].join(""));
  const seen = events(body);
  const firstDone = seen.find((event) => event.type === "response.output_item.done" && event.output_index === 0);
  assert.equal(firstDone.item.id, "c1");
  assert.equal(firstDone.item.arguments, "");
  assert.equal(
    seen.find((event) => event.type === "response.function_call_arguments.done" && event.item_id === "c1").arguments,
    "",
  );
});

test("argument events without an id may still match the open output_index", async () => {
  const body = await run([
    block(toolAdded(0, "c1", "apply_patch")),
    block({ type: "response.function_call_arguments.delta", output_index: 0, delta: "aaa" }),
    block(toolAdded(1, "c2", "apply_patch")),
  ].join(""));
  const done = events(body).find((event) => event.type === "response.function_call_arguments.done");
  assert.equal(done.item_id, "c1");
  assert.equal(done.arguments, "aaa");
});

test("synthesized argument-done uses the item id not the call id", async () => {
  const body = await run([
    block(toolAdded(0, "fc_1", "apply_patch", "call_1")),
    block({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "aaa" }),
    block(toolAdded(1, "fc_2", "apply_patch", "call_2")),
  ].join(""));
  const done = events(body).find((event) => event.type === "response.function_call_arguments.done");
  assert.equal(done.item_id, "fc_1");
  assert.equal(done.arguments, "aaa");
});

test("item lifecycle can start the second tool before the stream ends", async () => {
  const early = new EarlyToolItemDoneTransform();
  const norm = new ItemLifecycleNormalizer();
  let output = "";
  norm.setEncoding("utf8");
  norm.on("data", (chunk) => {
    output += chunk;
  });
  const ended = once(norm, "end");
  early.pipe(norm);
  early.write(block(toolAdded(0, "c1", "apply_patch")));
  early.write(block({ type: "response.function_call_arguments.delta", item_id: "c1", output_index: 0, delta: "aaa" }));
  early.write(block(toolAdded(1, "c2", "apply_patch")));
  early.end();
  await ended;
  const types = events(output)
    .filter((event) => event.type === "response.output_item.added" || event.type === "response.output_item.done")
    .map((event) => `${event.output_index}:${event.type.split(".").pop()}`);
  assert.deepEqual(types, [
    "0:added",
    "0:done",
    "1:added",
  ]);
});

test("does not re-emit arguments-done when the provider already completed them", async () => {
  const body = await run([
    block(toolAdded(0, "c1", "apply_patch")),
    block({ type: "response.function_call_arguments.delta", item_id: "c1", output_index: 0, delta: "aaa" }),
    block({
      type: "response.function_call_arguments.done",
      item_id: "c1",
      output_index: 0,
      arguments: "aaa",
    }),
    block(toolAdded(1, "c2", "apply_patch")),
  ].join(""));
  const seen = events(body);
  assert.equal(seen.filter((event) => event.type === "response.function_call_arguments.done").length, 1);
  const firstDone = seen.findIndex((event) => event.type === "response.output_item.done");
  const secondAdded = seen.findIndex((event) => event.type === "response.output_item.added" && event.output_index === 1);
  assert.ok(firstDone !== -1 && secondAdded !== -1 && firstDone < secondAdded);
});

test("does not complete an open tool call on stream EOF", async () => {
  const body = await run([
    block(toolAdded(0, "c1", "apply_patch")),
    block({ type: "response.function_call_arguments.delta", item_id: "c1", output_index: 0, delta: "aaa" }),
  ].join(""));
  const seen = events(body);
  assert.equal(seen.filter((event) => event.type === "response.function_call_arguments.done").length, 0);
  assert.equal(seen.filter((event) => event.type === "response.output_item.done").length, 0);
});

test("event/body type conflicts disable rewriting", async () => {
  const conflict = `event: response.output_item.added\ndata: ${JSON.stringify({
    type: "response.function_call_arguments.delta",
    item_id: "c1",
    output_index: 0,
    delta: "nope",
  })}\n\n`;
  const body = await run([
    block(toolAdded(0, "c1", "apply_patch")),
    conflict,
    block(toolAdded(1, "c2", "apply_patch")),
  ].join(""));
  const seen = events(body);
  assert.equal(seen.filter((event) => event.type === "response.function_call_arguments.done").length, 0);
  assert.equal(seen.filter((event) => event.type === "response.output_item.done").length, 0);
});

test("decodes mixed-lifecycle argument-done wrappers for custom openings", async () => {
  const customAdded = {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "custom_tool_call",
      id: "c1",
      call_id: "c1",
      name: "apply_patch",
      input: "",
      status: "in_progress",
    },
  };
  const body = await run([
    block(customAdded),
    block({
      type: "response.function_call_arguments.done",
      item_id: "c1",
      output_index: 0,
      arguments: "{\"content\":\"*** Begin\"}",
    }),
    block(toolAdded(1, "c2", "apply_patch")),
  ].join(""));
  const done = events(body).find((event) => event.type === "response.output_item.done");
  assert.equal(done.item.input, "*** Begin");
});

test("unwraps custom-tool content wrappers before synthesizing done", async () => {
  const customAdded = {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "custom_tool_call",
      id: "c1",
      call_id: "c1",
      name: "apply_patch",
      input: "",
      status: "in_progress",
    },
  };
  const body = await run([
    block(customAdded),
    block({
      type: "response.function_call_arguments.delta",
      item_id: "c1",
      output_index: 0,
      delta: "{\"content\":\"*** Begin\"}",
    }),
    block(toolAdded(1, "c2", "apply_patch")),
  ].join(""));
  const done = events(body).find((event) => event.type === "response.custom_tool_call_input.done");
  assert.equal(done.item_id, "c1");
  assert.equal(done.input, "*** Begin");
});

test("accumulated tool argument deltas are bounded across frames", async () => {
  const stream = new EarlyToolItemDoneTransform();
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
  });
  const ended = once(stream, "end");
  stream.write(block(toolAdded(0, "c1", "apply_patch")));
  const piece = "a".repeat(1024 * 1024);
  for (let i = 0; i < 9; i += 1) {
    stream.write(block({
      type: "response.function_call_arguments.delta",
      item_id: "c1",
      output_index: 0,
      delta: piece,
    }));
  }
  stream.write(block(toolAdded(1, "c2", "apply_patch")));
  stream.end();
  await ended;
  const seen = events(output);
  assert.equal(seen.filter((event) => event.type === "response.function_call_arguments.done").length, 0);
});

test("oversized unterminated SSE frames disable rewriting", async () => {
  const stream = new EarlyToolItemDoneTransform();
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
  });
  const ended = once(stream, "end");
  stream.write(Buffer.alloc(MAX_SSE_FRAME_BYTES + 1, 0x61));
  stream.write(block(toolAdded(0, "c1", "apply_patch")));
  stream.write(block({ type: "response.function_call_arguments.delta", item_id: "c1", output_index: 0, delta: "aaa" }));
  stream.write(block(toolAdded(1, "c2", "apply_patch")));
  stream.end();
  await ended;
  const seen = events(output);
  assert.equal(seen.filter((event) => event.type === "response.function_call_arguments.done").length, 0);
});
