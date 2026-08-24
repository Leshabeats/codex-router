import { Transform } from "node:stream";

const RESPONSE_PROTOCOL = "openai-responses";

function adapterError(message, code = "invalid_responses_request") {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function clone(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw adapterError("The Responses request must contain JSON values.");
  }
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw adapterError(`${name} must be an object.`);
  }
  return value;
}

function contentToResponses(content) {
  if (content === undefined || content === null) return content;
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return clone(content);
  return content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return clone(part);
    if (part.type === "text") return { ...part, type: "input_text" };
    if (part.type === "image_url") {
      const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (!imageUrl) throw adapterError("An image_url content part requires a URL.");
      return {
        type: "input_image",
        image_url: imageUrl,
        ...(part.detail || part.image_url?.detail ? { detail: part.detail || part.image_url.detail } : {}),
      };
    }
    return clone(part);
  });
}

function chatMessageToResponses(message) {
  object(message, "message");
  const role = typeof message.role === "string" && message.role ? message.role : "user";
  if (role === "tool") {
    if (typeof message.tool_call_id !== "string" || !message.tool_call_id) {
      throw adapterError("A tool message requires tool_call_id.");
    }
    return [{
      type: "function_call_output",
      call_id: message.tool_call_id,
      output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
    }];
  }
  const output = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    output.push({ type: "reasoning", summary: [{ type: "summary_text", text: message.reasoning_content }] });
  }
  const content = contentToResponses(message.content);
  output.push({
    type: "message",
    role,
    content: content === undefined || content === null ? [] : content,
    ...(typeof message.name === "string" && message.name ? { name: message.name } : {}),
  });
  for (const call of message.tool_calls || []) {
    object(call, "tool call");
    const fn = object(call.function || {}, "tool call function");
    if (typeof call.id !== "string" || !call.id || typeof fn.name !== "string" || !fn.name) {
      throw adapterError("A function tool call requires id and function name.");
    }
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    output.push({ type: "function_call", call_id: call.id, name: fn.name, arguments: args });
  }
  return output;
}

function chatMessagesToResponses(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.flatMap((message) => chatMessageToResponses(message));
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return clone(tool);
  if (tool.type !== "function" || !tool.function) return clone(tool);
  const fn = object(tool.function, "function tool");
  if (typeof fn.name !== "string" || !fn.name) throw adapterError("A function tool requires a name.");
  const { function: _function, ...rest } = tool;
  return { ...rest, name: fn.name, ...(fn.description !== undefined ? { description: fn.description } : {}), ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}), ...(fn.strict !== undefined ? { strict: fn.strict } : {}) };
}

function normalizeToolChoice(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (value.type !== "function" || !value.function) return clone(value);
  const name = value.function.name;
  if (typeof name !== "string" || !name) throw adapterError("A function tool_choice requires a name.");
  return { type: "function", name };
}

function normalizeResponseFormat(payload) {
  if (payload.response_format === undefined) return;
  if (payload.text !== undefined) throw adapterError("Use either response_format or text.format, not both.");
  const format = object(payload.response_format, "response_format");
  if (format.type === "json_object") {
    payload.text = { format: { type: "json_object" } };
  } else if (format.type === "json_schema") {
    const schema = object(format.json_schema, "response_format.json_schema");
    payload.text = {
      format: {
        type: "json_schema",
        ...(schema.name !== undefined ? { name: schema.name } : {}),
        ...(schema.schema !== undefined ? { schema: schema.schema } : {}),
        ...(schema.strict !== undefined ? { strict: schema.strict } : {}),
      },
    };
  } else {
    throw adapterError(`Unsupported response_format type ${String(format.type)}.`);
  }
  delete payload.response_format;
}

function normalizeResponsesRequest(payload) {
  const next = object(clone(payload), "Responses request");
  if (typeof next.model !== "string" || !next.model) throw adapterError("A Responses request requires model.");
  if (next.input !== undefined && next.messages !== undefined) {
    throw adapterError("A Responses request cannot contain both input and messages.");
  }
  if (next.input === undefined && next.messages !== undefined) {
    next.input = chatMessagesToResponses(next.messages);
    delete next.messages;
  }
  if (next.input !== undefined && !Array.isArray(next.input) && typeof next.input !== "string") {
    throw adapterError("Responses input must be a string or array.");
  }
  if (Array.isArray(next.input)) {
    next.input = next.input.map((item) => {
      object(item, "input item");
      if (item.type === "message" && item.content !== undefined) {
        return { ...item, content: contentToResponses(item.content) };
      }
      if (item.type === "function_call" && (!item.call_id || !item.name)) {
        throw adapterError("A function_call input item requires call_id and name.");
      }
      if (item.type === "function_call_output" && (!item.call_id || item.output === undefined)) {
        throw adapterError("A function_call_output input item requires call_id and output.");
      }
      return clone(item);
    });
  }
  if (Array.isArray(next.tools)) next.tools = next.tools.map(normalizeTool);
  if (next.tool_choice !== undefined) next.tool_choice = normalizeToolChoice(next.tool_choice);
  if (next.reasoning_effort !== undefined) {
    if (next.reasoning !== undefined) throw adapterError("Use either reasoning or reasoning_effort, not both.");
    next.reasoning = { effort: next.reasoning_effort };
    delete next.reasoning_effort;
  }
  if (next.max_tokens !== undefined) {
    if (next.max_output_tokens !== undefined && next.max_output_tokens !== next.max_tokens) {
      throw adapterError("max_tokens and max_output_tokens must not disagree.");
    }
    next.max_output_tokens ??= next.max_tokens;
    delete next.max_tokens;
  }
  normalizeResponseFormat(next);
  if (next.parallel_tool_calls !== undefined && typeof next.parallel_tool_calls !== "boolean") {
    throw adapterError("parallel_tool_calls must be a boolean.");
  }
  if (next.stream !== undefined && typeof next.stream !== "boolean") {
    throw adapterError("stream must be a boolean.");
  }
  return next;
}

function normalizeResponseBody(payload) {
  const next = object(clone(payload), "Responses response");
  if (next.output !== undefined && !Array.isArray(next.output)) {
    throw new Error("The upstream Responses response has an invalid output array.");
  }
  return next;
}

function parseFrame(frame) {
  const lines = frame.replace(/\r/g, "").split("\n");
  const data = [];
  let event;
  let id;
  let retry;
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "retry") retry = value;
    else if (field === "data") data.push(value);
  }
  return { event, id, retry, data: data.join("\n") };
}

function frameData(frame) {
  if (frame.data === "[DONE]" || frame.data === "") return frame.data;
  try {
    return JSON.parse(frame.data);
  } catch {
    return frame.data;
  }
}

function serializeFrame(frame, data = frame.data) {
  const lines = [];
  if (frame.event) lines.push(`event: ${frame.event}`);
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.retry !== undefined) lines.push(`retry: ${frame.retry}`);
  const text = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of String(text).split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

function streamState() {
  return {
    responseId: undefined,
    outputIndex: 0,
    itemIndexes: new Map(),
    sawEvent: false,
    terminal: false,
  };
}

const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.error",
]);

function validOutputIndex(value) {
  return Number.isInteger(value) && value >= 0;
}

function normalizeResponsesEvent(frame, state) {
  const data = frameData(frame);
  state.sawEvent = true;
  if (frame.event === "error") state.terminal = true;
  if (data === "[DONE]") {
    state.terminal = true;
    return serializeFrame(frame, data);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return serializeFrame(frame, data);
  if (typeof data.type === "string" && TERMINAL_EVENTS.has(data.type)) state.terminal = true;
  if (data.type === "response.created") {
    state.responseId ||= data.response?.id || data.response_id;
  }
  if (data.type === "response.output_item.added") {
    const item = data.item && typeof data.item === "object" ? data.item : undefined;
    let index = validOutputIndex(data.output_index) ? data.output_index : item?.output_index;
    if (!validOutputIndex(index)) index = state.outputIndex;
    state.outputIndex = Math.max(state.outputIndex, index + 1);
    if (item?.id) state.itemIndexes.set(item.id, index);
    if (item?.call_id) state.itemIndexes.set(item.call_id, index);
    if (!validOutputIndex(data.output_index)) data.output_index = index;
  }
  if (data.type === "response.function_call_arguments.delta" || data.type === "response.function_call_arguments.done") {
    const key = data.call_id || data.item_id;
    let index = validOutputIndex(data.output_index) ? data.output_index : state.itemIndexes.get(key);
    if (!validOutputIndex(index) && key) {
      index = state.outputIndex;
      state.outputIndex += 1;
      state.itemIndexes.set(key, index);
    }
    if (validOutputIndex(index) && !validOutputIndex(data.output_index)) data.output_index = index;
  }
  if (data.type === "response.output_text.delta" && !validOutputIndex(data.output_index) && state.outputIndex > 0) {
    data.output_index = state.outputIndex - 1;
  }
  if (data.type === "response.completed" && data.response && typeof data.response === "object" && state.responseId && !data.response.id) {
    data.response.id = state.responseId;
  }
  return serializeFrame(frame, data);
}

export function createResponsesStreamTransform() {
  let buffer = "";
  const state = streamState();
  const decoder = new TextDecoder();
  const nextBoundary = (value) => {
    const match = /\r?\n\r?\n/.exec(value);
    return match ? { index: match.index, length: match[0].length } : undefined;
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = nextBoundary(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          if (frame.trim()) this.push(normalizeResponsesEvent(parseFrame(frame), state));
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        buffer += decoder.decode();
        if (buffer.trim()) this.push(normalizeResponsesEvent(parseFrame(buffer), state));
        if (state.sawEvent && !state.terminal) {
          this.push(serializeFrame({ event: "error" }, {
            type: "error",
            code: "upstream_stream_incomplete",
            message: "The upstream Responses stream ended before a terminal event.",
            param: null,
          }));
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

export function createResponsesJsonTransform() {
  let body = "";
  return new Transform({
    transform(chunk, _encoding, callback) {
      body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      callback();
    },
    flush(callback) {
      try {
        const parsed = JSON.parse(body);
        this.push(JSON.stringify(normalizeResponseBody(parsed)));
      } catch {
        this.push(body);
      }
      callback();
    },
  });
}

export function normalizeOpenAIRequest(payload, { adapter = RESPONSE_PROTOCOL } = {}) {
  if (adapter !== RESPONSE_PROTOCOL && adapter !== "responses") {
    throw adapterError(`Unsupported OpenAI adapter ${String(adapter)}.`, "unsupported_openai_adapter");
  }
  return normalizeResponsesRequest(payload);
}

export function normalizeOpenAIResponse(payload) {
  return normalizeResponseBody(payload);
}
