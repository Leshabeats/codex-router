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

function rawBlock(type, json, newline = "\n") {
  return `event: ${type}${newline}data: ${json}${newline}${newline}`;
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

async function transformedBytes(input, options = {}, chunkSize = 0) {
  const stream = new TranslatedToolMessageCompatTransform(options);
  const output = [];
  stream.on("data", (chunk) => { output.push(Buffer.from(chunk)); });
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (chunkSize > 0) {
    for (let at = 0; at < bytes.length; at += chunkSize) {
      stream.write(bytes.subarray(at, at + chunkSize));
    }
  } else {
    stream.write(bytes);
  }
  stream.end();
  await once(stream, "end");
  return Buffer.concat(output);
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

function responseCreated(
  id = "resp_1",
  { newline = "\n", sequenceNumber, response = {} } = {},
) {
  const event = {
    type: "response.created",
    response: {
      id,
      object: "response",
      status: "in_progress",
      error: null,
      output: [],
      ...response,
    },
  };
  if (sequenceNumber !== undefined) event.sequence_number = sequenceNumber;
  return block(event, newline);
}

function responseCompleted(
  output,
  {
    id = "resp_1",
    newline = "\n",
    sequenceNumber,
    response = {},
  } = {},
) {
  const event = {
    type: "response.completed",
    response: {
      id,
      object: "response",
      status: "completed",
      error: null,
      output,
      ...response,
    },
  };
  if (sequenceNumber !== undefined) event.sequence_number = sequenceNumber;
  return block(event, newline);
}

function jsonResponse(output, overrides = {}) {
  return {
    id: "resp_json",
    object: "response",
    status: "completed",
    error: null,
    output,
    ...overrides,
  };
}

function phantomToolStream(
  newline = "\n",
  { terminalBlank = blankMessage, terminalReasoning = "" } = {},
) {
  return [
    responseCreated("resp_1", { newline, sequenceNumber: 0 }),
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
    responseCompleted([terminalBlank, functionCall], {
      id: "resp_1",
      newline,
      sequenceNumber: 9,
    }),
    `data: [DONE]${newline}${newline}`,
  ].join("");
}

// LiteLLM 1.96.0 emits this non-monotonic sequence on its
// Chat-Completions -> Responses bridge. In particular, the terminal empty
// message item is hard-coded to sequence_number=1 after higher-numbered tool
// events, while its output_text/content_part closes are unnumbered.
function pinnedLiteLlmPhantomEvents() {
  const inProgressResponse = {
    id: "resp_pinned_litellm",
    object: "response",
    status: "in_progress",
    error: null,
    output: [],
  };
  return [
    {
      type: "response.created",
      sequence_number: 1,
      response: { ...inProgressResponse },
    },
    {
      type: "response.in_progress",
      sequence_number: 2,
      response: { ...inProgressResponse },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 3,
      item: { ...blankMessage, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 4,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      sequence_number: 5,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: functionCall.id,
      output_index: 1,
      sequence_number: 6,
      delta: "{}",
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      sequence_number: 7,
      item: { ...functionCall },
    },
    {
      type: "response.output_text.done",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      text: "",
    },
    {
      type: "response.content_part.done",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 1,
      item: { ...blankMessage },
    },
    {
      type: "response.completed",
      response: {
        id: inProgressResponse.id,
        object: "response",
        status: "completed",
        error: null,
        output: [{ ...blankMessage }, { ...functionCall }],
      },
    },
  ];
}

function pinnedLiteLlmPhantomToolStream(mutate) {
  const wireEvents = pinnedLiteLlmPhantomEvents();
  if (mutate) mutate(wireEvents);
  return `${wireEvents.map((event) => block(event)).join("")}data: [DONE]\n\n`;
}

test("repairs LiteLLM 1.96.0's pinned terminal sequence reset", async () => {
  const source = pinnedLiteLlmPhantomToolStream();
  const output = await transformed(source, {}, 5);
  const seen = events(output);

  assert.equal(output.includes(blankMessage.id), false);
  assert.deepEqual(
    seen.filter((event) => eventItem(event) === functionCall.id)
      .map((event) => [event.type, event.output_index, event.sequence_number]),
    [
      ["response.output_item.added", 0, 5],
      ["response.function_call_arguments.delta", 0, 6],
      ["response.output_item.done", 0, 7],
    ],
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [functionCall],
  );
});

test("the pinned sequence exception fails open for every adjacent ambiguity", async () => {
  const cases = [
    ["a different reset value", (wireEvents) => {
      wireEvents[9].sequence_number = 2;
    }],
    ["a reset before tool evidence", (wireEvents) => {
      const [terminal] = wireEvents.splice(9, 1);
      wireEvents.splice(4, 0, terminal);
    }],
    ["a mismatched output index", (wireEvents) => {
      wireEvents[9].output_index = 1;
    }],
    ["a mismatched item id", (wireEvents) => {
      wireEvents[9].item = { ...wireEvents[9].item, id: "msg_other" };
    }],
    ["visible terminal content", (wireEvents) => {
      wireEvents[9].item = {
        ...wireEvents[9].item,
        content: [{ type: "output_text", text: "visible", annotations: [] }],
      };
    }],
    ["a reset on a tool item", (wireEvents) => {
      wireEvents[6].sequence_number = 1;
    }],
    ["a second terminal reset", (wireEvents) => {
      wireEvents.splice(10, 0, {
        ...wireEvents[9],
        item: { ...wireEvents[9].item },
      });
    }],
    ["a later event below the retained high-water mark", (wireEvents) => {
      wireEvents[10].sequence_number = 7;
    }],
  ];

  for (const [name, mutate] of cases) {
    const source = pinnedLiteLlmPhantomToolStream(mutate);
    assert.equal(await transformed(source, {}, 3), source, name);
  }
});

test("a reasoning terminal cannot use the pinned candidate reset", async () => {
  const reasoning = {
    id: "rs_reset",
    type: "reasoning",
    status: "completed",
    summary: [],
  };
  const source = [
    responseCreated("resp_reasoning_reset", { sequenceNumber: 1 }),
    block({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 2,
      item: { ...reasoning, status: "in_progress" },
    }),
    block({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 1,
      item: reasoning,
    }),
  ].join("");
  assert.equal(await transformed(source), source);
});

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

test("accepts only the pinned empty reasoning_text bridge terminator", async () => {
  const exact = block({
    type: "response.content_part.done",
    item_id: blankMessage.id,
    output_index: 0,
    content_index: 0,
    sequence_number: 7,
    part: { type: "reasoning_text", reasoning: "" },
  });
  const widened = block({
    type: "response.content_part.done",
    item_id: blankMessage.id,
    output_index: 0,
    content_index: 0,
    sequence_number: 7,
    part: { type: "reasoning_text", reasoning: "", unexpected: true },
  });
  const input = phantomToolStream().replace(exact, widened);
  assert.equal(await transformed(input), input);
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
    responseCreated(),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.content_part.added",
      output_index: 0,
      item_id: blankMessage.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    block({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: blankMessage.id,
      content_index: 0,
      delta: "I will inspect it.",
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    }),
  ].join("");
  assert.equal(await transformed(input), input);
});

test("leaves a blank response without a tool call byte-identical", async () => {
  const input = [
    responseCreated(),
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
  const reasoning = {
    id: "rs_1",
    type: "reasoning",
    status: "completed",
    summary: [],
  };
  const secondTool = { ...functionCall, id: "call_two", call_id: "call_two" };
  const input = [
    responseCreated("resp_reasoning"),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: { ...reasoning, status: "in_progress" },
    }),
    block({ type: "response.output_item.done", output_index: 1, item: reasoning }),
    block({
      type: "response.output_item.added",
      output_index: 2,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    }),
    block({
      type: "response.function_call_arguments.done",
      output_index: 2,
      item_id: functionCall.id,
      arguments: "{}",
    }),
    block({ type: "response.output_item.done", output_index: 2, item: functionCall }),
    block({
      type: "response.output_item.added",
      output_index: 3,
      item: { ...secondTool, status: "in_progress", arguments: "" },
    }),
    block({
      type: "response.function_call_arguments.done",
      output_index: 3,
      item_id: secondTool.id,
      arguments: "{}",
    }),
    block({ type: "response.output_item.done", output_index: 3, item: secondTool }),
    block({ type: "response.output_item.done", output_index: 0, item: blankMessage }),
    responseCompleted([blankMessage, reasoning, functionCall, secondTool], {
      id: "resp_reasoning",
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
  const reasoning = {
    id: "rs_between",
    type: "reasoning",
    status: "completed",
    summary: [],
  };
  const source = [
    responseCreated("resp_multiple", { sequenceNumber: 0 }),
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
      item: { ...reasoning, status: "in_progress" },
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
    responseCompleted(
      [firstBlank, firstTool, secondBlank, reasoning, secondTool],
      { id: "resp_multiple", sequenceNumber: 13 },
    ),
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
    [0, 2, 3, 4, 7, 8, 9, 10, 11, 13],
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
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tail = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress", arguments: "" },
  });
  const stream = new DeepseekToolMessageCompatTransform({ maxCandidateMs: 5 });
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  stream.write(created + start);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, created + start);
  stream.write(tail);
  assert.equal(output, created + start + tail);
  stream.end();
  await once(stream, "end");
});

test("malformed and duplicate candidate lifecycles fail open", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const malformed = "event: response.output_item.added\ndata: {not-json}\n\n";
  assert.equal(await transformed(created + start + malformed), created + start + malformed);

  const duplicate = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  assert.equal(await transformed(created + start + duplicate), created + start + duplicate);

  const second = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...blankMessage, id: "msg_two", status: "in_progress", content: [] },
  });
  assert.equal(await transformed(created + start + second), created + start + second);
});

test("conflicting item references and non-assistant messages fail open", async () => {
  const created = responseCreated();
  const conflicting = block({
    type: "response.output_item.added",
    item_id: "msg_other",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  assert.equal(await transformed(created + conflicting), created + conflicting);

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
  assert.equal(await transformed(created + nonAssistant), created + nonAssistant);
});

test("refusal and unknown message parts are never classified as empty", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tool = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress", arguments: "" },
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
    assert.equal(
      await transformed(created + start + tool + close),
      created + start + tool + close,
    );
  }
  const refusal = block({
    type: "response.refusal.delta",
    output_index: 0,
    item_id: blankMessage.id,
    delta: "cannot comply",
  });
  assert.equal(
    await transformed(created + start + tool + refusal),
    created + start + tool + refusal,
  );
});

test("mismatched, duplicate, missing, and negative indexes fail open", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const toolAtOne = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress", arguments: "" },
  });
  const wrongDelta = block({
    type: "response.function_call_arguments.delta",
    output_index: 0,
    item_id: functionCall.id,
    delta: "{}",
  });
  assert.equal(
    await transformed(created + start + toolAtOne + wrongDelta),
    created + start + toolAtOne + wrongDelta,
  );

  const duplicateIndex = block({
    type: "response.output_item.added",
    output_index: 1,
    item: {
      ...functionCall,
      id: "call_duplicate",
      call_id: "call_duplicate",
      status: "in_progress",
      arguments: "",
    },
  });
  assert.equal(
    await transformed(created + start + toolAtOne + duplicateIndex),
    created + start + toolAtOne + duplicateIndex,
  );

  const missingIndex = block({
    type: "response.function_call_arguments.done",
    item_id: functionCall.id,
    arguments: "{}",
  });
  assert.equal(
    await transformed(created + start + toolAtOne + missingIndex),
    created + start + toolAtOne + missingIndex,
  );

  const negative = block({
    type: "response.output_item.added",
    output_index: -1,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  assert.equal(
    await transformed(created + negative + toolAtOne),
    created + negative + toolAtOne,
  );
});

test("tool proof requires a valid added lifecycle and matching terminal order", async () => {
  const created = responseCreated();
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
    await transformed(created + start + toolDoneOnly + blankDone),
    created + start + toolDoneOnly + blankDone,
  );

  const terminalOnly = responseCompleted([blankMessage, functionCall]);
  assert.equal(
    await transformed(created + start + blankDone + terminalOnly),
    created + start + blankDone + terminalOnly,
  );

  const toolAdded = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress", arguments: "" },
  });
  const malformedTool = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, name: "", status: "in_progress", arguments: "" },
  });
  assert.equal(
    await transformed(created + start + malformedTool + blankDone),
    created + start + malformedTool + blankDone,
  );

  const changedToolDone = block({
    type: "response.output_item.done",
    output_index: 1,
    item: { ...functionCall, name: "different_tool" },
  });
  assert.equal(
    await transformed(created + start + toolAdded + changedToolDone + blankDone),
    created + start + toolAdded + changedToolDone + blankDone,
  );

  const validToolDone = block({
    type: "response.output_item.done",
    output_index: 1,
    item: functionCall,
  });

  const wrongOrder = responseCompleted([functionCall, blankMessage]);
  assert.equal(
    await transformed(created + start + toolAdded + validToolDone + blankDone + wrongOrder),
    created + start + toolAdded + validToolDone + blankDone + wrongOrder,
  );

  const changedTool = responseCompleted([
    blankMessage,
    { ...functionCall, name: "different_tool" },
  ]);
  assert.equal(
    await transformed(created + start + toolAdded + validToolDone + blankDone + changedTool),
    created + start + toolAdded + validToolDone + blankDone + changedTool,
  );
});

test("an oversized unterminated frame fails open without retaining the body", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tail = `data: ${"x".repeat(1_024)}`;
  assert.equal(
    await transformed(created + start + tail, {
      maxFrameBytes: 512,
      maxCandidateMs: 60_000,
    }),
    created + start + tail,
  );
});

test("delimiter-terminated frames and single-frame cap crossings are bounded", async () => {
  const created = responseCreated();
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
    await transformed(created + start + huge, {
      maxFrameBytes: 512,
      maxCandidateMs: 60_000,
    }),
    created + start + huge,
  );

  const tool = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress", arguments: "" },
  });
  assert.equal(
    await transformed(created + start + tool, {
      maxCandidateBytes: Buffer.byteLength(start) + 1,
      maxCandidateMs: 60_000,
    }),
    created + start + tool,
  );
});

test("timer expiry also releases an incomplete buffered frame", async () => {
  const created = responseCreated();
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
  stream.write(created + start + partial);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, created + start + partial);
  stream.end();
  await once(stream, "end");
});

test("destroying a pending stream clears its hold without later output", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const stream = new DeepseekToolMessageCompatTransform({ maxCandidateMs: 5 });
  let output = "";
  stream.on("data", (chunk) => { output += chunk.toString("utf8"); });
  stream.write(created + start);
  stream.destroy();
  await once(stream, "close");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, created);
});

test("post-suppression frames without shifted indexes remain byte-identical", async () => {
  const untouched = "event: response.done\ndata:  {\"type\":\"response.done\",\"response\":{\"id\":\"r1\"}}\n\n";
  const output = await transformed(phantomToolStream().replace("data: [DONE]\n\n", untouched));
  assert.ok(output.endsWith(untouched));
});

test("binds the response id and requires an exact successful terminal envelope", async () => {
  const source = phantomToolStream();
  const validCreated = responseCreated("resp_1", { sequenceNumber: 0 });
  const validCompleted = responseCompleted([blankMessage, functionCall], {
    sequenceNumber: 9,
  });
  const invalidCreated = [
    responseCreated("resp_1", {
      sequenceNumber: 0,
      response: { object: undefined },
    }),
    responseCreated("resp_1", {
      sequenceNumber: 0,
      response: { status: "completed" },
    }),
    responseCreated("", { sequenceNumber: 0 }),
    responseCreated("resp_1", {
      sequenceNumber: 0,
      response: { output: [blankMessage] },
    }),
  ];
  for (const created of invalidCreated) {
    const input = source.replace(validCreated, created);
    assert.equal(await transformed(input), input);
  }

  const invalidCompleted = [
    responseCompleted([blankMessage, functionCall], {
      id: "resp_other",
      sequenceNumber: 9,
    }),
    responseCompleted([blankMessage, functionCall], {
      sequenceNumber: 9,
      response: { object: undefined },
    }),
    responseCompleted([blankMessage, functionCall], {
      sequenceNumber: 9,
      response: { status: "incomplete" },
    }),
    responseCompleted([blankMessage, functionCall], {
      sequenceNumber: 9,
      response: { error: { message: "upstream failed" } },
    }),
    responseCompleted(
      [{ ...blankMessage, id: "resp_1" }, functionCall],
      { sequenceNumber: 9 },
    ),
    block({
      type: "response.completed",
      sequence_number: 9,
      unexpected: true,
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        error: null,
        output: [blankMessage, functionCall],
      },
    }),
  ];
  for (const completed of invalidCompleted) {
    const input = source.replace(validCompleted, completed);
    assert.equal(await transformed(input), input);
  }
});

test("unknown item, event, and SSE frame fields disable compaction byte-for-byte", async () => {
  const created = responseCreated();
  const candidate = {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  };
  const reasoning = {
    id: "rs_strict",
    type: "reasoning",
    status: "in_progress",
    summary: [],
  };
  const custom = {
    id: "custom_strict",
    type: "custom_tool_call",
    status: "in_progress",
    call_id: "custom_strict",
    name: "shell",
    input: "",
  };
  const cases = [
    block({ ...candidate, unexpected: true }),
    block({ ...candidate, item: { ...candidate.item, unexpected: true } }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: { ...reasoning, unexpected: true },
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        ...reasoning,
        summary: [{ type: "opaque_reasoning", text: "visible" }],
      },
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        ...reasoning,
        content: [{ type: "reasoning_text", reasoning: "ambiguous" }],
      },
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        ...functionCall,
        status: "in_progress",
        arguments: "",
        unexpected: true,
      },
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: { ...custom, unexpected: true },
    }),
    [
      block({
        type: "response.output_item.added",
        output_index: 1,
        item: { ...functionCall, status: "in_progress", arguments: "" },
      }),
      block({
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: functionCall.id,
        delta: "{}",
        unexpected: true,
      }),
    ].join(""),
    [
      block({
        type: "response.output_item.added",
        output_index: 1,
        item: custom,
      }),
      block({
        type: "response.custom_tool_call_input.delta",
        output_index: 1,
        item_id: custom.id,
        delta: "echo",
        unexpected: true,
      }),
    ].join(""),
    [
      block({
        type: "response.output_item.added",
        output_index: 1,
        item: reasoning,
      }),
      block({
        type: "response.reasoning_summary_part.added",
        output_index: 1,
        item_id: reasoning.id,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
        unexpected: true,
      }),
    ].join(""),
    block({
      type: "response.unknown.delta",
      output_index: 0,
      item_id: blankMessage.id,
      delta: "opaque",
    }),
    `id: opaque\n${block({
      type: "response.output_item.done",
      output_index: 0,
      item: blankMessage,
    })}`,
  ];
  for (const tail of cases) {
    const input = created + block(candidate) + tail;
    assert.equal(await transformed(input), input);
  }
});

test("ambiguous response, message, and tool lifecycle transitions fail open", async () => {
  const inProgress = block({
    type: "response.in_progress",
    response: {
      id: "resp_1",
      object: "response",
      status: "in_progress",
      error: null,
      output: [],
    },
  });
  const duplicateProgress = responseCreated() + inProgress + inProgress;
  assert.equal(await transformed(duplicateProgress), duplicateProgress);

  const source = phantomToolStream();
  const toolDone = block({
    type: "response.output_item.done",
    output_index: 1,
    sequence_number: 5,
    item: functionCall,
  });
  const mismatchedToolDone = block({
    type: "response.output_item.done",
    output_index: 1,
    sequence_number: 5,
    item: { ...functionCall, arguments: "[]" },
  });
  const mismatchedTool = source.replace(toolDone, mismatchedToolDone);
  assert.equal(await transformed(mismatchedTool), mismatchedTool);

  const candidateDone = block({
    type: "response.output_item.done",
    output_index: 0,
    sequence_number: 8,
    item: blankMessage,
  });
  const ambiguousCandidateDone = block({
    type: "response.output_item.done",
    output_index: 0,
    sequence_number: 8,
    item: {
      ...blankMessage,
      content: [blankMessage.content[0], { ...blankMessage.content[0] }],
    },
  });
  const ambiguousCandidate = source.replace(candidateDone, ambiguousCandidateDone);
  assert.equal(await transformed(ambiguousCandidate), ambiguousCandidate);

  const repeatedSequence = source.replace(
    '"output_index":1,"sequence_number":5',
    '"output_index":1,"sequence_number":4',
  );
  assert.notEqual(repeatedSequence, source);
  assert.equal(await transformed(repeatedSequence), repeatedSequence);

  const invalidObfuscation = [
    responseCreated(),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.content_part.added",
      output_index: 0,
      item_id: blankMessage.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    block({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: blankMessage.id,
      content_index: 0,
      delta: "",
      obfuscation: { unexpected: true },
    }),
  ].join("");
  assert.equal(await transformed(invalidObfuscation), invalidObfuscation);
});

test("pre-candidate tracking is bounded and becomes passthrough on overflow", async () => {
  const reasoning = {
    id: "rs_prelude",
    type: "reasoning",
    status: "in_progress",
    summary: [],
  };
  const input = [
    responseCreated(),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: reasoning,
    }),
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: { ...reasoning, status: "completed" },
    }),
    phantomToolStream(),
  ].join("");
  assert.equal(
    await transformed(input, { maxCandidateBytes: 64, maxCandidateMs: 60_000 }),
    input,
  );
});

test("compacts a strictly confirmed custom-tool lifecycle without changing its identity", async () => {
  const custom = {
    id: "custom_shell",
    type: "custom_tool_call",
    status: "completed",
    call_id: "custom_shell_call",
    name: "shell",
    input: "echo ready",
  };
  const input = [
    responseCreated("resp_custom", { sequenceNumber: 0 }),
    block({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 1,
      item: { ...custom, status: "in_progress", input: "" },
    }),
    block({
      type: "response.custom_tool_call_input.delta",
      sequence_number: 3,
      output_index: 1,
      item_id: custom.id,
      delta: "echo ready",
    }),
    block({
      type: "response.custom_tool_call_input.done",
      sequence_number: 4,
      output_index: 1,
      item_id: custom.id,
      input: "echo ready",
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 1,
      item: custom,
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 6,
      output_index: 0,
      item: blankMessage,
    }),
    responseCompleted([blankMessage, custom], {
      id: "resp_custom",
      sequenceNumber: 7,
    }),
  ].join("");

  const seen = events(await transformed(input, {}, 1));
  const customEvents = seen.filter((event) => eventItem(event) === custom.id);
  assert.deepEqual(
    customEvents.map((event) => [event.type, event.output_index, event.sequence_number]),
    [
      ["response.output_item.added", 0, 2],
      ["response.custom_tool_call_input.delta", 0, 3],
      ["response.custom_tool_call_input.done", 0, 4],
      ["response.output_item.done", 0, 5],
    ],
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [custom],
  );
});

test("preserves real reasoning bytes, ids, and sequence numbers while compacting", async () => {
  const reasoningDone = {
    id: "rs_real",
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text: "real private reasoning" }],
  };
  const input = [
    responseCreated("resp_reasoning_real", { sequenceNumber: 0 }),
    block({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 1,
      item: { ...reasoningDone, status: "in_progress", summary: [] },
    }),
    block({
      type: "response.reasoning_summary_part.added",
      sequence_number: 3,
      item_id: reasoningDone.id,
      output_index: 1,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }),
    block({
      type: "response.reasoning_summary_text.delta",
      sequence_number: 4,
      item_id: reasoningDone.id,
      output_index: 1,
      summary_index: 0,
      delta: "real private reasoning",
    }),
    block({
      type: "response.reasoning_summary_text.done",
      sequence_number: 5,
      item_id: reasoningDone.id,
      output_index: 1,
      summary_index: 0,
      text: "real private reasoning",
    }),
    block({
      type: "response.reasoning_summary_part.done",
      sequence_number: 6,
      item_id: reasoningDone.id,
      output_index: 1,
      summary_index: 0,
      part: { type: "summary_text", text: "real private reasoning" },
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 7,
      output_index: 1,
      item: reasoningDone,
    }),
    block({
      type: "response.output_item.added",
      sequence_number: 8,
      output_index: 2,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 9,
      output_index: 2,
      item: functionCall,
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 10,
      output_index: 0,
      item: blankMessage,
    }),
    responseCompleted([blankMessage, reasoningDone, functionCall], {
      id: "resp_reasoning_real",
      sequenceNumber: 11,
    }),
  ].join("");

  const output = await transformed(input, {}, 1);
  assert.match(output, /real private reasoning/);
  const seen = events(output);
  assert.deepEqual(
    seen.map((event) => event.sequence_number),
    [0, 2, 3, 4, 5, 6, 7, 8, 9, 11],
  );
  assert.ok(
    seen
      .filter((event) => eventItem(event) === reasoningDone.id)
      .every((event) => event.output_index === 0),
  );
  assert.ok(
    seen
      .filter((event) => eventItem(event) === functionCall.id)
      .every((event) => event.output_index === 1),
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [reasoningDone, functionCall],
  );
});

test("reasoning output-item provenance must match the terminal response", async () => {
  const reasoningDone = {
    id: "rs_provenance",
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text: "alpha" }],
  };
  const terminalReasoning = {
    ...reasoningDone,
    summary: [{ type: "summary_text", text: "beta" }],
  };
  const input = [
    responseCreated("resp_reasoning_provenance", { sequenceNumber: 0 }),
    block({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 1,
      item: { ...reasoningDone, status: "in_progress", summary: [] },
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 3,
      output_index: 1,
      item: reasoningDone,
    }),
    block({
      type: "response.output_item.added",
      sequence_number: 4,
      output_index: 2,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 2,
      item: functionCall,
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 6,
      output_index: 0,
      item: blankMessage,
    }),
    responseCompleted([blankMessage, terminalReasoning, functionCall], {
      id: "resp_reasoning_provenance",
      sequenceNumber: 7,
    }),
  ].join("");

  assert.equal(await transformed(input, {}, 1), input);
});

test("stops rewriting after the first bound terminal envelope", async () => {
  const first = phantomToolStream().replace("data: [DONE]\n\n", "");
  const normalizedFirst = await transformed(first, {}, 1);
  const second = phantomToolStream()
    .replaceAll("resp_1", "resp_second")
    .replaceAll("msg_blank", "msg_second")
    .replaceAll("call_list", "call_second");
  const invalidTrailingBytes = Buffer.from([0xc0, 0xff, 0x00, 0x0a]);
  const input = Buffer.concat([
    Buffer.from(first),
    Buffer.from(second),
    invalidTrailingBytes,
  ]);
  const expected = Buffer.concat([
    Buffer.from(normalizedFirst),
    Buffer.from(second),
    invalidTrailingBytes,
  ]);

  assert.deepEqual(await transformedBytes(input, {}, 1), expected);
});

test("invalid fragmented UTF-8 during a held candidate fails open byte-for-byte", async () => {
  const prefix = [
    responseCreated(),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
  ].join("");
  const invalidFrame = Buffer.concat([
    Buffer.from("event: response.output_item.done\ndata: "),
    Buffer.from([0xc0]),
    Buffer.from("\n\n"),
  ]);
  const opaqueTail = Buffer.from([0xff, 0x00, 0x61, 0x0a]);
  const input = Buffer.concat([Buffer.from(prefix), invalidFrame, opaqueTail]);

  assert.deepEqual(await transformedBytes(input, {}, 1), input);

  const bomPrefixed = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(phantomToolStream()),
  ]);
  assert.deepEqual(await transformedBytes(bomPrefixed, {}, 1), bomPrefixed);
});

test("a failed attempt cannot poison a fresh retry transform", async () => {
  const provider = { id: "deepseek", protocol: "openai" };
  const failed = translatedToolMessageCompatTransform(provider, "text/event-stream");
  const retry = translatedToolMessageCompatTransform(provider, "text/event-stream");
  const malformed = Buffer.concat([
    Buffer.from(responseCreated()),
    Buffer.from([0xc0]),
    Buffer.from("\n\n"),
  ]);
  const failedOutput = [];
  failed.on("data", (chunk) => { failedOutput.push(Buffer.from(chunk)); });
  failed.end(malformed);
  await once(failed, "end");
  assert.deepEqual(Buffer.concat(failedOutput), malformed);

  let retryOutput = "";
  retry.setEncoding("utf8");
  retry.on("data", (chunk) => { retryOutput += chunk; });
  retry.end(phantomToolStream());
  await once(retry, "end");
  assert.equal(retryOutput.includes(blankMessage.id), false);
  assert.deepEqual(
    events(retryOutput).find((event) => event.type === "response.completed").response.output,
    [functionCall],
  );
});

test("duplicate SSE lifecycle members fail open before last-wins parsing", async () => {
  const source = phantomToolStream();
  const valid = block({
    type: "response.output_item.added",
    output_index: 0,
    sequence_number: 1,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const visible = {
    ...blankMessage,
    status: "in_progress",
    content: [{ type: "output_text", text: "MUST_KEEP_LIFECYCLE" }],
  };
  const duplicate = rawBlock(
    "response.output_item.added",
    `{"type":"response.output_item.added","output_index":0,"sequence_number":1,` +
      `"item":${JSON.stringify(visible)},` +
      `"\\u0069tem":${JSON.stringify({
        ...blankMessage,
        status: "in_progress",
        content: [],
      })}}`,
  );
  const input = source.replace(valid, duplicate);
  assert.notEqual(input, source);
  assert.equal(await transformed(input, {}, 1), input);
});

test("duplicate terminal SSE members preserve visible and error values byte-for-byte", async () => {
  const source = phantomToolStream();
  const completedEvent = {
    type: "response.completed",
    sequence_number: 9,
    response: {
      id: "resp_1",
      object: "response",
      status: "completed",
      error: null,
      output: [blankMessage, functionCall],
    },
  };
  const valid = responseCompleted([blankMessage, functionCall], {
    id: "resp_1",
    sequenceNumber: 9,
  });
  const visible = {
    id: "msg_must_keep",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "MUST_KEEP_OUTPUT" }],
  };
  const json = JSON.stringify(completedEvent);
  const cases = [
    json.replace(
      `"output":${JSON.stringify(completedEvent.response.output)}`,
      `"output":${JSON.stringify([visible])},` +
        `"output":${JSON.stringify(completedEvent.response.output)}`,
    ),
    json.replace(
      '"error":null',
      '"error":{"message":"MUST_KEEP_ERROR"},"error":null',
    ),
    json.replace(
      '"status":"completed"',
      '"status":"failed","status":"completed"',
    ),
    json.replace('"text":""', '"text":"MUST_KEEP_TEXT","text":""'),
    json.replace(
      '"arguments":"{}"',
      '"arguments":"MUST_KEEP_TOOL","arguments":"{}"',
    ),
  ];
  for (const duplicateJson of cases) {
    const input = source.replace(
      valid,
      rawBlock("response.completed", duplicateJson),
    );
    assert.notEqual(input, source);
    assert.equal(await transformed(input, {}, 1), input);
  }
});

test("bounded uniqueness scanning fails open and accepts unique escaped keys", async () => {
  const source = phantomToolStream();
  for (const options of [
    { maxJsonDepth: 1 },
    { maxJsonMembers: 1 },
    { maxJsonKeyCodeUnits: 1 },
  ]) {
    assert.equal(await transformed(source, options, 1), source);
  }

  const escaped = source.replace(
    '"sequence_number":3',
    '"\\u0073equence_number":3',
  );
  assert.notEqual(escaped, source);
  const normalized = await transformed(escaped, {}, 1);
  assert.equal(normalized.includes(blankMessage.id), false);
  assert.deepEqual(
    events(normalized).find((event) => event.type === "response.completed").response.output,
    [functionCall],
  );
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
    status: "completed",
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

test("duplicate non-streaming members never erase earlier output or metadata", async () => {
  const visible = {
    id: "msg_must_keep_json",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "MUST_KEEP_OUTPUT" }],
  };
  const reasoning = {
    id: "rs_duplicate_json",
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text: "kept reasoning" }],
  };
  const base = JSON.stringify(jsonResponse([blankMessage, functionCall]));
  const reasoningBase = JSON.stringify(
    jsonResponse([blankMessage, reasoning, functionCall]),
  );
  const cases = [
    base.replace(
      `"output":${JSON.stringify([blankMessage, functionCall])}`,
      `"output":${JSON.stringify([visible])},` +
        `"output":${JSON.stringify([blankMessage, functionCall])}`,
    ),
    base.replace(
      '"error":null',
      '"error":{"message":"MUST_KEEP_ERROR"},"\\u0065rror":null',
    ),
    base.replace(
      '"status":"completed"',
      '"status":"failed","status":"completed"',
    ),
    base.replace('"text":""', '"text":"MUST_KEEP_TEXT","text":""'),
    base.replace(
      '"arguments":"{}"',
      '"arguments":"MUST_KEEP_TOOL","arguments":"{}"',
    ),
    reasoningBase.replace(
      `"summary":${JSON.stringify(reasoning.summary)}`,
      `"summary":[{"type":"summary_text","text":"MUST_KEEP_REASONING"}],` +
        `"summary":${JSON.stringify(reasoning.summary)}`,
    ),
  ];
  for (const input of cases) {
    assert.equal(await transformedJson(input, {}, 1), input);
  }
});

test("non-streaming uniqueness limits fail open while unique JSON remains eligible", async () => {
  const source = JSON.stringify(jsonResponse([blankMessage, functionCall]));
  for (const options of [
    { maxJsonDepth: 1 },
    { maxJsonMembers: 1 },
    { maxJsonKeyCodeUnits: 1 },
  ]) {
    assert.equal(await transformedJson(source, options, 1), source);
  }

  const unique = source.replace(
    '"error":null',
    '"\\u0065rror":null,"metadata":{' +
      '"astral":"\\ud83d\\ude00","lone":"\\ud800",' +
      '"fraction":-1.25e+3,"huge":123456789012345678901234567890}',
  );
  const normalized = await transformedJson(unique, {}, 1);
  assert.notEqual(normalized, unique);
  const payload = JSON.parse(normalized);
  assert.deepEqual(payload.output, [functionCall]);
  assert.equal(payload.metadata.astral, "😀");
  assert.equal(payload.metadata.lone, "\ud800");
  assert.equal(payload.metadata.fraction, -1250);
  assert.equal(typeof payload.metadata.huge, "number");
});

test("non-streaming normalization requires a successful envelope and unique ids", async () => {
  const valid = jsonResponse([blankMessage, functionCall]);
  const invalidPayloads = [
    { ...valid, id: "" },
    { ...valid, object: undefined },
    { ...valid, object: "list" },
    { ...valid, status: undefined },
    { ...valid, status: "incomplete" },
    { ...valid, error: { message: "failed" } },
    jsonResponse([
      blankMessage,
      { ...functionCall, id: blankMessage.id },
    ]),
    jsonResponse([
      { ...blankMessage, id: "resp_json" },
      functionCall,
    ]),
    jsonResponse([
      { ...blankMessage, id: "" },
      functionCall,
    ]),
    jsonResponse([
      blankMessage,
      {
        id: "rs_unknown",
        type: "reasoning",
        summary: [{ type: "opaque_reasoning", text: "visible" }],
      },
      functionCall,
    ]),
  ];
  for (const payload of invalidPayloads) {
    const input = JSON.stringify(payload, null, 2);
    assert.equal(await transformedJson(input, {}, 1), input);
  }
});

test("non-streaming malformed neighboring messages make the whole body fail open", async () => {
  const secondBlank = { ...blankMessage, id: "msg_after_malformed" };
  const secondTool = {
    ...functionCall,
    id: "call_after_malformed",
    call_id: "call_after_malformed",
  };
  const baseNeighbor = {
    id: "msg_malformed_neighbor",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "visible", annotations: [] }],
  };
  const malformedNeighbors = [
    { ...baseNeighbor, role: "user" },
    { ...baseNeighbor, content: "visible" },
    { ...baseNeighbor, content: [] },
    { ...baseNeighbor, content: [{ type: "opaque", value: "visible" }] },
    { ...baseNeighbor, phase: { value: "final" } },
  ];
  for (const neighbor of malformedNeighbors) {
    const input = JSON.stringify(
      jsonResponse([blankMessage, neighbor, secondBlank, secondTool]),
      null,
      2,
    );
    assert.equal(await transformedJson(input, {}, 1), input);
  }
});

test("non-streaming ambiguous, malformed, and oversized bodies fail open byte-for-byte", async () => {
  const secondBlank = { ...blankMessage, id: "msg_second" };
  const consecutive = JSON.stringify(
    jsonResponse([blankMessage, secondBlank, functionCall]),
    null,
    2,
  );
  assert.equal(await transformedJson(consecutive), consecutive);

  const visible = JSON.stringify(
    jsonResponse([
      blankMessage,
      {
        id: "msg_visible",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "real text" }],
      },
      functionCall,
    ]),
    null,
    2,
  );
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
    const malformedItems = JSON.stringify(jsonResponse(output), null, 2);
    assert.equal(await transformedJson(malformedItems), malformedItems);
  }

  const incomplete = JSON.stringify({
    id: "resp_incomplete",
    object: "response",
    status: "incomplete",
    error: null,
    output: [blankMessage, functionCall],
  }, null, 2);
  assert.equal(await transformedJson(incomplete), incomplete);

  const oversized = JSON.stringify(jsonResponse([blankMessage, functionCall], {
    opaque: "x".repeat(256),
  }));
  assert.equal(await transformedJson(oversized, { maxBytes: 64 }, 11), oversized);

  const invalidUtf8 = Buffer.from('{"output":"\xc0"}', "latin1");
  const stream = new TranslatedToolMessageJsonCompatTransform();
  const chunks = [];
  stream.on("data", (chunk) => { chunks.push(chunk); });
  stream.end(invalidUtf8);
  await once(stream, "end");
  assert.deepEqual(Buffer.concat(chunks), invalidUtf8);

  const bomJson = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(jsonResponse([blankMessage, functionCall]))),
  ]);
  const bomStream = new TranslatedToolMessageJsonCompatTransform();
  const bomChunks = [];
  bomStream.on("data", (chunk) => { bomChunks.push(chunk); });
  bomStream.end(bomJson);
  await once(bomStream, "end");
  assert.deepEqual(Buffer.concat(bomChunks), bomJson);
});

test("a slow non-streaming body releases pending bytes and becomes passthrough", async () => {
  const source = JSON.stringify(jsonResponse([blankMessage, functionCall]));
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
