import { Transform } from "node:stream";

// LiteLLM's chat → Responses bridge streams function_call argument deltas live,
// but queues function_call_arguments.done and output_item.done until the chat
// stream ends. Codex paints apply_patch on item-done, so two whole-file patches
// in one Grok turn appear in the same millisecond. This transform closes the
// previous tool item as soon as the next output_item.added arrives.

const LF_SEP = Buffer.from("\n\n");
const CRLF_SEP = Buffer.from("\r\n\r\n");
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

function findFrameEnd(buffer) {
  const crlf = buffer.indexOf(CRLF_SEP);
  const lf = buffer.indexOf(LF_SEP);
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { index: crlf, separator: CRLF_SEP };
  if (lf !== -1) return { index: lf, separator: LF_SEP };
  return undefined;
}

function parseBlock(block) {
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  if (!dataLines.length) return undefined;
  const dataText = dataLines.join("\n");
  if (dataText === "[DONE]") return { terminal: true };
  try {
    return { event: JSON.parse(dataText) };
  } catch {
    return undefined;
  }
}

function frameFor(type, event, newline) {
  const payload = { type, ...event };
  if (payload.type !== type) payload.type = type;
  return `event: ${type}${newline}data: ${JSON.stringify(payload)}${newline}${newline}`;
}

function toolId(item, event) {
  return item?.call_id || item?.id || event?.item_id || undefined;
}

export class EarlyToolItemDoneTransform extends Transform {
  #buffer = Buffer.alloc(0);
  #open;
  #closed = new Set();
  #newline = "\n";

  _transform(chunk, encoding, callback) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, piece]) : piece;
    this.#drain(false);
    callback();
  }

  _flush(callback) {
    this.#drain(true);
    this.#closeOpen();
    callback();
  }

  #drain(flush) {
    while (this.#buffer.length) {
      const found = findFrameEnd(this.#buffer);
      if (!found) {
        if (!flush) return;
        const original = this.#buffer;
        this.#buffer = Buffer.alloc(0);
        this.#handle(original, Buffer.alloc(0));
        return;
      }
      const original = this.#buffer.subarray(0, found.index + found.separator.length);
      this.#buffer = this.#buffer.subarray(found.index + found.separator.length);
      this.#handle(original, found.separator);
    }
  }

  #handle(original, separator) {
    const text = original.toString("utf8");
    if (separator.length === 4) this.#newline = "\r\n";
    const parsed = parseBlock(text.replace(/\r?\n\r?\n$/u, "").replace(/\r?\n$/u, ""));
    if (!parsed || parsed.terminal) {
      if (parsed?.terminal) this.#closeOpen();
      this.push(Buffer.from(original));
      return;
    }
    const event = parsed.event;
    const type = event?.type;
    if (TERMINAL_TYPES.has(type)) {
      this.#closeOpen();
      this.push(Buffer.from(original));
      return;
    }
    if (type === "response.output_item.added" && TOOL_TYPES.has(event.item?.type)) {
      this.#closeOpen();
      this.#open = {
        id: toolId(event.item, event),
        outputIndex: event.output_index,
        item: { ...event.item },
        arguments: typeof event.item.arguments === "string" ? event.item.arguments : "",
        input: typeof event.item.input === "string" ? event.item.input : "",
        kind: event.item.type,
      };
      this.push(Buffer.from(original));
      return;
    }
    if (ARG_DELTA_TYPES.has(type) && this.#open && (event.item_id === this.#open.id || event.output_index === this.#open.outputIndex)) {
      const piece = typeof event.delta === "string" ? event.delta : "";
      if (this.#open.kind === "custom_tool_call") this.#open.input += piece;
      else this.#open.arguments += piece;
      this.push(Buffer.from(original));
      return;
    }
    if (ARG_DONE_TYPES.has(type)) {
      const id = event.item_id;
      if (id && this.#closed.has(id)) return;
      if (this.#open && (id === this.#open.id || event.output_index === this.#open.outputIndex)) {
        if (typeof event.arguments === "string") this.#open.arguments = event.arguments;
        if (typeof event.input === "string") this.#open.input = event.input;
      }
      this.push(Buffer.from(original));
      return;
    }
    if (type === "response.output_item.done") {
      const id = toolId(event.item, event);
      if (id && this.#closed.has(id)) return;
      if (id) this.#closed.add(id);
      if (this.#open && (id === this.#open.id || event.output_index === this.#open.outputIndex)) {
        this.#open = undefined;
      }
      this.push(Buffer.from(original));
      return;
    }
    this.push(Buffer.from(original));
  }

  #closeOpen() {
    const open = this.#open;
    if (!open || (open.id && this.#closed.has(open.id))) {
      this.#open = undefined;
      return;
    }
    if (open.id) this.#closed.add(open.id);
    const item = {
      ...open.item,
      status: "completed",
      ...(open.kind === "custom_tool_call"
        ? { input: open.input }
        : { arguments: open.arguments }),
    };
    const doneType = open.kind === "custom_tool_call"
      ? "response.custom_tool_call_input.done"
      : "response.function_call_arguments.done";
    const doneBody = open.kind === "custom_tool_call"
      ? { item_id: open.id, output_index: open.outputIndex, input: open.input }
      : { item_id: open.id, output_index: open.outputIndex, arguments: open.arguments };
    this.push(Buffer.from(frameFor(doneType, doneBody, this.#newline)));
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
