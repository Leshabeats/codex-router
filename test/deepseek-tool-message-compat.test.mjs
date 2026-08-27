import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  DeepseekToolMessageCompatTransform,
  TranslatedToolMessageCompatTransform,
  TranslatedToolMessageJsonCompatTransform,
  deepseekToolMessageCompatTransform,
  translatedToolMessageCompatTransform,
} from "../src/deepseek-tool-message-compat.mjs";

function block(event, newline = "\n") {
  return `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`;
}

function events(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.split(/\r?\n/).find((line) => line.startsWith("data:")))
    .filter((line) => line && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(5).trimStart()));
}

async function transformed(input, options = {}, chunkSize = 0) {
  const stream = new TranslatedToolMessageCompatTransform(options);
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  if (chunkSize > 0) {
    const bytes = Buffer.from(input);
    for (let at = 0; at < bytes.length; at += chunkSize) {
      stream.write(bytes.subarray(at, at + chunkSize));
    }
  } else {
    stream.write(input);
  }
  stream.end();
  await once(stream, "end");
  return output;
}

async function transformedJson(input, options = {}, chunkSize = 0) {
  const stream = new TranslatedToolMessageJsonCompatTransform(options);
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  if (chunkSize > 0) {
    const bytes = Buffer.from(input);
    for (let at = 0; at < bytes.length; at += chunkSize) {
      stream.write(bytes.subarray(at, at + chunkSize));
    }
  } else {
    stream.write(input);
  }
  stream.end();
  await once(stream, "end");
  return output;
}

const blankMessage = {
  id: "msg_blank",
  type: "message",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text: "", annotations: [] }],
};

const functionCall = {
  id: "call_list",
  type: "function_call",
  call_id: "call_list",
  name: "exec_command",
  arguments: "{}",
  status: "completed",
};

function phantomToolStream(
  newline = "\n",
  { terminalBlank = blankMessage, terminalReasoning = "" } = {},
) {
  return [
    block({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }, newline),
    block({
      type: "response.content_part.added",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 2,
      part: { type: "output_text", text: "", annotations: [] },
    }, newline),
    block({
      type: "response.output_item.added",
      output_index: 1,
      sequence_number: 3,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    }, newline),
    block({
      type: "response.function_call_arguments.delta",
      item_id: functionCall.id,
      output_index: 1,
      sequence_number: 4,
      delta: "{}",
    }, newline),
    block({
      type: "response.output_item.done",
      output_index: 1,
      sequence_number: 5,
      item: functionCall,
    }, newline),
    block({
      type: "response.output_text.done",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 6,
      text: "",
    }, newline),
    block({
      type: "response.content_part.done",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 7,
      part: { type: "reasoning_text", reasoning: terminalReasoning },
    }, newline),
    block({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 8,
      item: blankMessage,
    }, newline),
    block({
      type: "response.completed",
      sequence_number: 9,
      response: { id: "resp_1", status: "completed", output: [terminalBlank, functionCall] },
    }, newline),
    `data: [DONE]${newline}${newline}`,
  ].join("");
}

test("removes DeepSeek's confirmed blank tool message and compacts indexes", async () => {
  const output = await transformed(phantomToolStream(), {}, 7);
  const seen = events(output);
  assert.equal(output.includes(blankMessage.id), false);
  assert.match(output, /data: \[DONE\]/);
  const toolEvents = seen.filter((event) => eventItem(event) === functionCall.id);
  assert.ok(toolEvents.length >= 3);
  assert.ok(toolEvents.every((event) => event.output_index === 0));
  assert.deepEqual(toolEvents.map((event) => event.sequence_number), [3, 4, 5]);
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [functionCall],
  );
});

test("matches the pinned LiteLLM bridge's changed terminal id and null text", async () => {
  for (const content of [
    [{ type: "output_text", text: null, annotations: [] }],
    [{ type: "output_text", annotations: [] }],
  ]) {
    const terminalBlank = {
      ...blankMessage,
      id: "chatcmpl_probe",
      content,
    };
    const output = await transformed(phantomToolStream("\n", { terminalBlank }), {}, 3);
    const seen = events(output);
    assert.equal(output.includes(blankMessage.id), false);
    assert.equal(output.includes(terminalBlank.id), false);
    assert.deepEqual(
      seen.find((event) => event.type === "response.completed").response.output,
      [functionCall],
    );
  }
});

test("preserves real reasoning and ambiguous terminal identity byte-for-byte", async () => {
  const reasoning = phantomToolStream("\n", { terminalReasoning: "keep this reasoning" });
  assert.equal(await transformed(reasoning), reasoning);

  const collidingId = phantomToolStream("\n", {
    terminalBlank: {
      ...blankMessage,
      id: functionCall.id,
      content: [{ type: "output_text", text: null, annotations: [] }],
    },
  });
  assert.equal(await transformed(collidingId), collidingId);

  const visibleTerminal = phantomToolStream("\n", {
    terminalBlank: {
      ...blankMessage,
      id: "chatcmpl_visible",
      content: [{ type: "output_text", text: "real text", annotations: [] }],
    },
  });
  assert.equal(await transformed(visibleTerminal), visibleTerminal);
});

function eventItem(event) {
  return event.item_id ?? event.item?.id;
}

test("preserves CRLF framing while compacting the stream", async () => {
  const output = await transformed(phantomToolStream("\r\n"), {}, 11);
  assert.ok(output.includes("\r\n\r\n"));
  assert.equal(output.replaceAll("\r\n\r\n", "").includes("\n\n"), false);
  assert.ok(events(output).every((event) => {
    return !Number.isInteger(event.output_index) || event.output_index === 0;
  }));
});

test("fails open when the candidate later contains visible text", async () => {
  const input = [
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: blankMessage.id,
      delta: "I will inspect it.",
    }),
    block({ type: "response.output_item.added", output_index: 1, item: functionCall }),
  ].join("");
  assert.equal(await transformed(input), input);
});

test("leaves a blank response without a tool call byte-identical", async () => {
  const input = [
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({ type: "response.output_item.done", output_index: 0, item: blankMessage }),
  ].join("");
  assert.equal(await transformed(input), input);
});

test("compacts separate reasoning and multiple later output items consistently", async () => {
  const reasoning = { id: "rs_1", type: "reasoning", summary: [] };
  const secondTool = { ...functionCall, id: "call_two", call_id: "call_two" };
  const input = [
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({ type: "response.output_item.added", output_index: 1, item: reasoning }),
    block({ type: "response.output_item.done", output_index: 1, item: reasoning }),
    block({ type: "response.output_item.added", output_index: 2, item: functionCall }),
    block({
      type: "response.function_call_arguments.done",
      output_index: 2,
      item_id: functionCall.id,
      arguments: "{}",
    }),
    block({ type: "response.output_item.added", output_index: 3, item: secondTool }),
    block({ type: "response.output_item.done", output_index: 0, item: blankMessage }),
    block({
      type: "response.completed",
      response: { output: [blankMessage, reasoning, functionCall, secondTool] },
    }),
  ].join("");
  const seen = events(await transformed(input));
  assert.deepEqual(
    seen.filter((event) => event.type === "response.output_item.added")
      .map((event) => [event.item.id, event.output_index]),
    [[reasoning.id, 0], [functionCall.id, 1], [secondTool.id, 2]],
  );
  assert.equal(
    seen.find((event) => event.type === "response.function_call_arguments.done").output_index,
    1,
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [reasoning, functionCall, secondTool],
  );
});

test("removes multiple independently confirmed bridge messages in one stream", async () => {
  const firstBlank = { ...blankMessage, id: "msg_blank_one" };
  const secondBlank = { ...blankMessage, id: "msg_blank_two" };
  const firstTool = { ...functionCall, id: "call_one", call_id: "call_one" };
  const secondTool = { ...functionCall, id: "call_two", call_id: "call_two" };
  const reasoning = { id: "rs_between", type: "reasoning", summary: [] };
  const source = [
    block({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: { ...firstBlank, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      sequence_number: 2,
      item: { ...firstTool, status: "in_progress", arguments: "" },
    }),
    block({
      type: "response.function_call_arguments.delta",
      item_id: firstTool.id,
      output_index: 1,
      sequence_number: 3,
      delta: "{}",
    }),
    block({
      type: "response.output_item.done",
      output_index: 1,
      sequence_number: 4,
      item: firstTool,
    }),
    block({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 5,
      item: firstBlank,
    }),
    block({
      type: "response.output_item.added",
      output_index: 2,
      sequence_number: 6,
      item: { ...secondBlank, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_item.added",
      output_index: 3,
      sequence_number: 7,
      item: reasoning,
    }),
    block({
      type: "response.output_item.done",
      output_index: 3,
      sequence_number: 8,
      item: reasoning,
    }),
    block({
      type: "response.output_item.added",
      output_index: 4,
      sequence_number: 9,
      item: { ...secondTool, status: "in_progress", arguments: "" },
    }),
    block({
      type: "response.function_call_arguments.done",
      item_id: secondTool.id,
      output_index: 4,
      sequence_number: 10,
      arguments: "{}",
    }),
    block({
      type: "response.output_item.done",
      output_index: 4,
      sequence_number: 11,
      item: secondTool,
    }),
    block({
      type: "response.output_item.done",
      output_index: 2,
      sequence_number: 12,
      item: secondBlank,
    }),
    block({
      type: "response.completed",
      sequence_number: 13,
      response: {
        id: "resp_multiple",
        output: [firstBlank, firstTool, secondBlank, reasoning, secondTool],
      },
    }),
  ].join("");

  const seen = events(await transformed(source, {}, 5));
  assert.deepEqual(
    seen
      .filter((event) => event.type === "response.output_item.added")
      .map((event) => [event.item.id, event.output_index]),
    [[firstTool.id, 0], [reasoning.id, 1], [secondTool.id, 2]],
  );
  assert.deepEqual(
    seen.map((event) => event.sequence_number),
    [2, 3, 4, 7, 8, 9, 10, 11, 13],
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [firstTool, reasoning, secondTool],
  );
});

test("byte budget expiry releases the entire stream unchanged", async () => {
  const input = phantomToolStream();
  assert.equal(
    await transformed(input, { maxCandidateBytes: 32, maxCandidateMs: 60_000 }),
    input,
  );
});

test("timer expiry releases pending bytes and subsequent chunks immediately", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tail = block({ type: "response.output_item.added", output_index: 1, item: functionCall });
  const stream = new DeepseekToolMessageCompatTransform({ maxCandidateMs: 5 });
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  stream.write(start);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, start);
  stream.write(tail);
  assert.equal(output, start + tail);
  stream.end();
  await once(stream, "end");
});

test("malformed and duplicate candidate lifecycles fail open", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const malformed = "event: response.output_item.added\ndata: {not-json}\n\n";
  assert.equal(await transformed(start + malformed), start + malformed);

  const duplicate = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  assert.equal(await transformed(start + duplicate), start + duplicate);

  const second = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...blankMessage, id: "msg_two", status: "in_progress", content: [] },
  });
  assert.equal(await transformed(start + second), start + second);
});

test("conflicting item references and non-assistant messages fail open", async () => {
  const conflicting = block({
    type: "response.output_item.added",
    item_id: "msg_other",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tail = phantomToolStream().slice(phantomToolStream().indexOf("\n\n") + 2);
  assert.equal(await transformed(conflicting + tail), conflicting + tail);

  const nonAssistant = block({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      ...blankMessage,
      role: "user",
      status: "in_progress",
      content: [],
    },
  });
  assert.equal(await transformed(nonAssistant + tail), nonAssistant + tail);
});

test("refusal and unknown message parts are never classified as empty", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tool = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress" },
  });
  for (const part of [
    { type: "refusal", refusal: "cannot comply" },
    { type: "audio", audio: "opaque" },
  ]) {
    const close = block({
      type: "response.output_item.done",
      output_index: 0,
      item: { ...blankMessage, content: [part] },
    });
    assert.equal(await transformed(start + tool + close), start + tool + close);
  }
  const refusal = block({
    type: "response.refusal.delta",
    output_index: 0,
    item_id: blankMessage.id,
    delta: "cannot comply",
  });
  assert.equal(await transformed(start + tool + refusal), start + tool + refusal);
});

test("mismatched, duplicate, missing, and negative indexes fail open", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const toolAtTwo = block({
    type: "response.output_item.added",
    output_index: 2,
    item: { ...functionCall, status: "in_progress" },
  });
  const wrongDelta = block({
    type: "response.function_call_arguments.delta",
    output_index: 1,
    item_id: functionCall.id,
    delta: "{}",
  });
  assert.equal(
    await transformed(start + toolAtTwo + wrongDelta),
    start + toolAtTwo + wrongDelta,
  );

  const duplicateIndex = block({
    type: "response.output_item.added",
    output_index: 2,
    item: { ...functionCall, id: "call_duplicate" },
  });
  assert.equal(
    await transformed(start + toolAtTwo + duplicateIndex),
    start + toolAtTwo + duplicateIndex,
  );

  const missingIndex = block({
    type: "response.function_call_arguments.done",
    item_id: functionCall.id,
    arguments: "{}",
  });
  assert.equal(
    await transformed(start + toolAtTwo + missingIndex),
    start + toolAtTwo + missingIndex,
  );

  const negative = block({
    type: "response.output_item.added",
    output_index: -1,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  assert.equal(await transformed(negative + toolAtTwo), negative + toolAtTwo);
});

test("tool proof requires a valid added lifecycle and matching terminal order", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const blankDone = block({
    type: "response.output_item.done",
    output_index: 0,
    item: blankMessage,
  });
  const toolDoneOnly = block({
    type: "response.output_item.done",
    output_index: 1,
    item: functionCall,
  });
  assert.equal(
    await transformed(start + toolDoneOnly + blankDone),
    start + toolDoneOnly + blankDone,
  );

  const terminalOnly = block({
    type: "response.completed",
    response: { output: [blankMessage, functionCall] },
  });
  assert.equal(
    await transformed(start + blankDone + terminalOnly),
    start + blankDone + terminalOnly,
  );

  const toolAdded = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress" },
  });
  const malformedTool = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, name: "", status: "in_progress" },
  });
  assert.equal(
    await transformed(start + malformedTool + blankDone),
    start + malformedTool + blankDone,
  );

  const changedToolDone = block({
    type: "response.output_item.done",
    output_index: 1,
    item: { ...functionCall, name: "different_tool" },
  });
  assert.equal(
    await transformed(start + toolAdded + changedToolDone + blankDone),
    start + toolAdded + changedToolDone + blankDone,
  );

  const wrongOrder = block({
    type: "response.completed",
    response: { output: [functionCall, blankMessage] },
  });
  assert.equal(
    await transformed(start + toolAdded + blankDone + wrongOrder),
    start + toolAdded + blankDone + wrongOrder,
  );

  const changedTool = block({
    type: "response.completed",
    response: {
      output: [blankMessage, { ...functionCall, name: "different_tool" }],
    },
  });
  assert.equal(
    await transformed(start + toolAdded + blankDone + changedTool),
    start + toolAdded + blankDone + changedTool,
  );
});

test("an oversized unterminated frame fails open without retaining the body", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tail = `data: ${"x".repeat(256)}`;
  assert.equal(
    await transformed(start + tail, { maxFrameBytes: 64, maxCandidateMs: 60_000 }),
    start + tail,
  );
});

test("delimiter-terminated frames and single-frame cap crossings are bounded", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const huge = block({
    type: "response.function_call_arguments.delta",
    output_index: 1,
    item_id: functionCall.id,
    delta: "x".repeat(2_000),
  });
  assert.equal(
    await transformed(start + huge, { maxFrameBytes: 512, maxCandidateMs: 60_000 }),
    start + huge,
  );

  const tool = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress" },
  });
  assert.equal(
    await transformed(start + tool, {
      maxCandidateBytes: Buffer.byteLength(start) + 1,
      maxCandidateMs: 60_000,
    }),
    start + tool,
  );
});

test("timer expiry also releases an incomplete buffered frame", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const partial = "event: response.output_item.added\ndata: {\"type\":";
  const stream = new DeepseekToolMessageCompatTransform({ maxCandidateMs: 5 });
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  stream.write(start + partial);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, start + partial);
  stream.end();
  await once(stream, "end");
});

test("destroying a pending stream clears its hold without later output", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const stream = new DeepseekToolMessageCompatTransform({ maxCandidateMs: 5 });
  let output = "";
  stream.on("data", (chunk) => { output += chunk.toString("utf8"); });
  stream.write(start);
  stream.destroy();
  await once(stream, "close");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, "");
});

test("post-suppression frames without shifted indexes remain byte-identical", async () => {
  const untouched = "event: response.done\ndata:  {\"type\":\"response.done\",\"response\":{\"id\":\"r1\"}}\n\n";
  const output = await transformed(phantomToolStream().replace("data: [DONE]\n\n", untouched));
  assert.ok(output.endsWith(untouched));
});

test("non-streaming responses remove only exact empty messages proven by tool traffic", async () => {
  const secondBlank = {
    ...blankMessage,
    id: "msg_second",
    content: [{ type: "output_text", text: null, annotations: [] }],
    phase: null,
  };
  const secondTool = { ...functionCall, id: "call_second", call_id: "call_second" };
  const reasoning = { id: "rs_json", type: "reasoning", summary: [{ type: "summary_text", text: "kept" }] };
  const visible = {
    id: "msg_visible",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "done", annotations: [] }],
  };
  const payload = {
    id: "resp_json",
    object: "response",
    error: null,
    output: [blankMessage, reasoning, functionCall, secondBlank, secondTool, visible],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  };
  const result = JSON.parse(await transformedJson(JSON.stringify(payload, null, 2), {}, 7));
  assert.deepEqual(result, {
    ...payload,
    output: [reasoning, functionCall, secondTool, visible],
  });
});

test("non-streaming ambiguous, malformed, and oversized bodies fail open byte-for-byte", async () => {
  const secondBlank = { ...blankMessage, id: "msg_second" };
  const consecutive = JSON.stringify({
    output: [blankMessage, secondBlank, functionCall],
  }, null, 2);
  assert.equal(await transformedJson(consecutive), consecutive);

  const visible = JSON.stringify({
    output: [
      blankMessage,
      {
        id: "msg_visible",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "real text" }],
      },
      functionCall,
    ],
  }, null, 2);
  assert.equal(await transformedJson(visible), visible);

  const malformed = "{not-json";
  assert.equal(await transformedJson(malformed), malformed);

  for (const output of [
    [{ ...blankMessage, id: undefined }, functionCall],
    [blankMessage, { ...functionCall, name: "" }],
    [blankMessage, { ...functionCall, call_id: undefined }],
    [
      { ...blankMessage, content: [{ type: "refusal", refusal: "kept" }] },
      functionCall,
    ],
  ]) {
    const malformedItems = JSON.stringify({ output }, null, 2);
    assert.equal(await transformedJson(malformedItems), malformedItems);
  }

  const incomplete = JSON.stringify({
    object: "response",
    status: "incomplete",
    output: [blankMessage, functionCall],
  }, null, 2);
  assert.equal(await transformedJson(incomplete), incomplete);

  const oversized = JSON.stringify({
    output: [blankMessage, functionCall],
    opaque: "x".repeat(256),
  });
  assert.equal(await transformedJson(oversized, { maxBytes: 64 }, 11), oversized);

  const invalidUtf8 = Buffer.from('{"output":"\xc0"}', "latin1");
  const stream = new TranslatedToolMessageJsonCompatTransform();
  const chunks = [];
  stream.on("data", (chunk) => { chunks.push(chunk); });
  stream.end(invalidUtf8);
  await once(stream, "end");
  assert.deepEqual(Buffer.concat(chunks), invalidUtf8);
});

test("a slow non-streaming body releases pending bytes and becomes passthrough", async () => {
  const source = JSON.stringify({ output: [blankMessage, functionCall] });
  const split = Math.floor(source.length / 2);
  const stream = new TranslatedToolMessageJsonCompatTransform({ maxMs: 5 });
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  stream.write(source.slice(0, split));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, source.slice(0, split));
  stream.end(source.slice(split));
  await once(stream, "end");
  assert.equal(output, source);
});

test("factory is translated-protocol scoped and returns fresh retry transforms", () => {
  const provider = { id: "deepseek" };
  const first = translatedToolMessageCompatTransform(provider, "text/event-stream");
  const retry = translatedToolMessageCompatTransform(provider, "text/event-stream");
  assert.ok(first instanceof TranslatedToolMessageCompatTransform);
  assert.ok(first instanceof DeepseekToolMessageCompatTransform);
  assert.ok(retry instanceof TranslatedToolMessageCompatTransform);
  assert.notEqual(first, retry);
  for (const translated of [
    { id: "opencode-go" },
    { id: "commandcode", protocol: "anthropic" },
    { id: "generic", protocol: "openai" },
  ]) {
    assert.ok(
      translatedToolMessageCompatTransform(translated, "text/event-stream")
        instanceof TranslatedToolMessageCompatTransform,
    );
  }
  assert.ok(
    translatedToolMessageCompatTransform(provider, "application/json; charset=utf-8")
      instanceof TranslatedToolMessageJsonCompatTransform,
  );
  assert.equal(
    translatedToolMessageCompatTransform(
      { id: "opencode-go-responses", protocol: "openai-responses" },
      "text/event-stream",
    ),
    undefined,
  );
  assert.equal(translatedToolMessageCompatTransform(undefined, "text/event-stream"), undefined);
  assert.equal(translatedToolMessageCompatTransform(provider, "text/plain"), undefined);
  assert.ok(
    deepseekToolMessageCompatTransform("deepseek", "TEXT/EVENT-STREAM; charset=utf-8")
      instanceof TranslatedToolMessageCompatTransform,
  );
  assert.equal(
    deepseekToolMessageCompatTransform("opencode-go", "text/event-stream"),
    undefined,
  );
  assert.equal(
    deepseekToolMessageCompatTransform("deepseek", "application/json"),
    undefined,
  );
});
