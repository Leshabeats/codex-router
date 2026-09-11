import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  EarlyToolItemDoneTransform,
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

function toolAdded(index, id, name) {
  return {
    type: "response.output_item.added",
    output_index: index,
    item: { type: "function_call", id, call_id: id, name, arguments: "", status: "in_progress" },
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
    "1:done",
  ]);
});
