import { Transform } from "node:stream";

// LiteLLM's chat → Responses bridge streams function_call argument deltas live,
// but queues function_call_arguments.done and output_item.done until the chat
// stream ends. Codex paints apply_patch on item-done, so two whole-file patches
// in one Grok turn appear in the same millisecond. This transform closes the
// previous tool item as soon as the next output_item.added arrives.

const LF = 10;
const CR = 13;
const TOOL_TYPES = new Set(["function_call", "custom_tool_call"]);
const TERMINAL_TYPES = new Set(["response.completed", "response.done"]);
const ARG_DELTA_TYPES = new Set([
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
]);
const ARG_DONE_TYPES = new Set([
  "response.function_call_arguments.done",
  "response.custom_tool_call_input.done",
]);
export const MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024;

function newlineLength(buffer, index) {
  if (index >= buffer.length) return 0;
  if (buffer[index] === CR && buffer[index + 1] === LF) return 2;
  if (buffer[index] === CR || buffer[index] === LF) return 1;
  return 0;
}

function findFrameEnd(buffer) {
  for (let index = 0; index < buffer.length; index += 1) {
    const first = newlineLength(buffer, index);
    if (!first) continue;
    const second = newlineLength(buffer, index + first);
    if (!second) continue;
    return { index, separator: Buffer.from(buffer.subarray(index, index + first + second)) };
  }
  return undefined;
}

function parseBlock(block) {
  let eventName;
  let eventFields = 0;
  const dataLines = [];
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line.startsWith("event:")) {
      eventFields += 1;
      if (eventFields > 1) return { conflict: true };
      eventName = line.slice(6).trim();
    }
    if (line.startsWith("data:")) {
      if (dataLines.length) return { conflict: true };
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  if (!dataLines.length) return undefined;
  const dataText = dataLines.join("\n");
  if (dataText === "[DONE]") return { terminal: true };
  try {
    const event = JSON.parse(dataText);
    if (eventName && event?.type && eventName !== event.type) return { conflict: true };
    return { event };
  } catch {
    return undefined;
  }
}

function frameFor(type, event, newline) {
  const payload = { type, ...event, type };
  return `event: ${type}${newline}data: ${JSON.stringify(payload)}${newline}${newline}`;
}

function unwrapCustomInput(text) {
  if (typeof text !== "string" || !text.startsWith("{")) return text;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.content === "string") {
      const keys = Object.keys(value);
      if (keys.every((key) => key === "content" || key === "input")) return value.content;
    }
  } catch {
    return text;
  }
  return text;
}

export class EarlyToolItemDoneTransform extends Transform {
  #buffer = Buffer.alloc(0);
  #length = 0;
  #open;
  #closed = new Set();
  #closedIndexes = new Set();
  #newline = "\n";
  #passthrough = false;

  #view() {
    return this.#buffer.subarray(0, this.#length);
  }

  #append(piece) {
    const needed = this.#length + piece.length;
    if (needed > this.#buffer.length) {
      const next = Buffer.allocUnsafe(Math.max(this.#buffer.length * 2, 4096, needed));
      if (this.#length) this.#buffer.copy(next, 0, 0, this.#length);
      this.#buffer = next;
    }
    piece.copy(this.#buffer, this.#length);
    this.#length += piece.length;
  }

  #consume(n) {
    if (n <= 0) return;
    if (n >= this.#length) {
      this.#length = 0;
      return;
    }
    this.#buffer.copyWithin(0, n, this.#length);
    this.#length -= n;
  }

  #release() {
    const original = Buffer.from(this.#view());
    this.#length = 0;
    return original;
  }

  _transform(chunk, encoding, callback) {
    if (this.#passthrough) {
      this.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      callback();
      return;
    }
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.#length + piece.length > MAX_SSE_FRAME_BYTES) {
      this.#passthrough = true;
      if (this.#length) this.push(this.#release());
      this.push(piece);
      callback();
      return;
    }
    this.#append(piece);
    this.#drain(false);
    callback();
  }

  _flush(callback) {
    if (!this.#passthrough) this.#drain(true);
    callback();
  }

  #drain(flush) {
    while (this.#length) {
      if (this.#passthrough) {
        this.push(this.#release());
        return;
      }
      const found = findFrameEnd(this.#view());
      if (!found) {
        if (!flush) return;
        if (this.#length > MAX_SSE_FRAME_BYTES) this.#passthrough = true;
        const original = this.#release();
        if (this.#passthrough) this.push(original);
        else this.#handle(original, Buffer.alloc(0));
        return;
      }
      const end = found.index + found.separator.length;
      const original = Buffer.from(this.#view().subarray(0, end));
      this.#consume(end);
      this.#handle(original, found.separator);
    }
  }

  #handle(original, separator) {
    if (this.#passthrough) {
      this.push(Buffer.from(original));
      return;
    }
    const text = original.subarray(0, Math.max(0, original.length - separator.length)).toString("utf8");
    const firstNewline = newlineLength(separator, 0);
    if (firstNewline === 2) this.#newline = "\r\n";
    else if (separator[0] === CR) this.#newline = "\r";
    else this.#newline = "\n";
    const parsed = parseBlock(text);
    if (!parsed || parsed.terminal || parsed.conflict) {
      if (parsed?.conflict) {
        this.#passthrough = true;
        this.push(Buffer.from(original));
        if (this.#length) this.push(this.#release());
        return;
      }
      this.push(Buffer.from(original));
      return;
    }
    const event = parsed.event;
    const type = event?.type;
    if (TERMINAL_TYPES.has(type)) {
      this.push(Buffer.from(original));
      return;
    }
    if (type === "response.output_item.added" && TOOL_TYPES.has(event.item?.type)) {
      this.#closeOpen();
      this.#open = {
        itemId: typeof event.item.id === "string" ? event.item.id : undefined,
        callId: typeof event.item.call_id === "string" ? event.item.call_id : undefined,
        outputIndex: event.output_index,
        item: { ...event.item },
        arguments: typeof event.item.arguments === "string" ? event.item.arguments : "",
        input: typeof event.item.input === "string" ? event.item.input : "",
        kind: event.item.type,
        argumentsDone: false,
      };
      if (this.#exceedsArgumentBound()) {
        this.#disableRewrite(original);
        return;
      }
      this.push(Buffer.from(original));
      return;
    }
    if (ARG_DELTA_TYPES.has(type) && this.#matchesOpen(event)) {
      const piece = typeof event.delta === "string" ? event.delta : "";
      if (this.#exceedsArgumentBound(piece)) {
        this.#disableRewrite(original);
        return;
      }
      if (this.#open.kind === "custom_tool_call") this.#open.input += piece;
      else this.#open.arguments += piece;
      this.push(Buffer.from(original));
      return;
    }
    if (ARG_DONE_TYPES.has(type)) {
      const id = event.item_id;
      if (id && this.#closed.has(id)) return;
      if (!this.#suppliedIdentity(id) && this.#closedIndexes.has(event.output_index)) return;
      if (this.#matchesOpen(event)) {
        const nextArguments = typeof event.arguments === "string" ? event.arguments : this.#open.arguments;
        let nextInput = typeof event.input === "string" ? event.input : this.#open.input;
        if (this.#open.kind === "custom_tool_call") {
          const wrapped = typeof event.input === "string"
            ? event.input
            : typeof event.arguments === "string"
              ? event.arguments
              : this.#open.input;
          nextInput = unwrapCustomInput(wrapped);
        }
        const next = this.#open.kind === "custom_tool_call" ? nextInput : nextArguments;
        if (this.#exceedsArgumentBound("", next)) {
          this.#disableRewrite(original);
          return;
        }
        this.#open.arguments = nextArguments;
        this.#open.input = nextInput;
        this.#open.argumentsDone = true;
      }
      this.push(Buffer.from(original));
      return;
    }
    if (type === "response.output_item.done") {
      const id = event.item?.id || event.item?.call_id;
      if (id && this.#closed.has(id)) return;
      if (!this.#suppliedIdentity(id) && this.#closedIndexes.has(event.output_index)) return;
      if (id) this.#closed.add(id);
      if (typeof event.output_index === "number") this.#closedIndexes.add(event.output_index);
      if (this.#open && this.#sameOpenIdentity(id, event.output_index)) this.#open = undefined;
      this.push(Buffer.from(original));
      return;
    }
    this.push(Buffer.from(original));
  }

  #suppliedIdentity(id) {
    return typeof id === "string" && id.length > 0;
  }

  #sameOpenIdentity(id, outputIndex) {
    if (!this.#open) return false;
    if (this.#suppliedIdentity(id)) {
      return id === this.#open.itemId || id === this.#open.callId;
    }
    return outputIndex === this.#open.outputIndex;
  }

  #matchesOpen(event) {
    return this.#sameOpenIdentity(event.item_id, event.output_index);
  }

  #exceedsArgumentBound(extra = "", text) {
    const current = text ?? (this.#open.kind === "custom_tool_call" ? this.#open.input : this.#open.arguments);
    return Buffer.byteLength(current) + Buffer.byteLength(extra) > MAX_SSE_FRAME_BYTES;
  }

  #disableRewrite(original) {
    this.#passthrough = true;
    this.#open = undefined;
    this.push(Buffer.from(original));
    if (this.#length) this.push(this.#release());
  }

  #closeOpen() {
    const open = this.#open;
    if (
      !open ||
      (open.itemId && this.#closed.has(open.itemId)) ||
      (open.callId && this.#closed.has(open.callId)) ||
      (typeof open.outputIndex === "number" && this.#closedIndexes.has(open.outputIndex))
    ) {
      this.#open = undefined;
      return;
    }
    const lifecycleId = open.itemId || open.callId;
    if (lifecycleId) this.#closed.add(lifecycleId);
    if (open.callId) this.#closed.add(open.callId);
    if (typeof open.outputIndex === "number") this.#closedIndexes.add(open.outputIndex);
    const customInput = unwrapCustomInput(open.input);
    const item = {
      ...open.item,
      status: "completed",
      ...(open.kind === "custom_tool_call"
        ? { input: customInput }
        : { arguments: open.arguments }),
    };
    if (!open.argumentsDone) {
      const doneType = open.kind === "custom_tool_call"
        ? "response.custom_tool_call_input.done"
        : "response.function_call_arguments.done";
      const doneBody = open.kind === "custom_tool_call"
        ? { item_id: lifecycleId, output_index: open.outputIndex, input: customInput }
        : { item_id: lifecycleId, output_index: open.outputIndex, arguments: open.arguments };
      this.push(Buffer.from(frameFor(doneType, doneBody, this.#newline)));
    }
    this.push(Buffer.from(frameFor("response.output_item.done", {
      output_index: open.outputIndex,
      item,
    }, this.#newline)));
    this.#open = undefined;
  }
}

export function earlyToolItemDoneTransform(provider, contentType = "") {
  const providerId = typeof provider === "string" ? provider : provider?.id;
  if (providerId !== "grok-oauth") return undefined;
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new EarlyToolItemDoneTransform();
}
