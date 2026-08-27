import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const MAX_CANDIDATE_BYTES = 64 * 1024;
const MAX_CANDIDATE_MS = 1_000;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_JSON_MS = 1_000;
const TERMINAL_EMPTY_PART_KEYS = new Set([
  "type",
  "text",
  "annotations",
  "logprobs",
]);
const TERMINAL_EMPTY_MESSAGE_KEYS = new Set([
  "id",
  "type",
  "status",
  "role",
  "content",
  "phase",
]);

function parsedBlock(block) {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const dataLineIndexes = lines
    .map((line, index) => (line.startsWith("data:") ? index : -1))
    .filter((index) => index !== -1);
  const eventLines = lines.filter((line) => line.startsWith("event:"));
  if (dataLineIndexes.length !== 1 || eventLines.length > 1) return undefined;
  const [dataLineIndex] = dataLineIndexes;
  const dataText = lines[dataLineIndex].slice(5).trimStart();
  if (!dataText || dataText === "[DONE]") return undefined;
  try {
    const event = JSON.parse(dataText);
    if (
      eventLines.length === 1 &&
      eventLines[0].slice(6).trim() !== event?.type
    ) {
      return undefined;
    }
    return { lines, dataLineIndex, newline, event };
  } catch {
    return undefined;
  }
}

function rewrittenBlock(parsed, event, separator) {
  const lines = [...parsed.lines];
  lines[parsed.dataLineIndex] = `data: ${JSON.stringify(event)}`;
  return `${lines.join(parsed.newline)}${separator}`;
}

function itemId(value) {
  return typeof value === "string" && value ? value : undefined;
}

function eventItemReference(event) {
  const direct = itemId(event?.item_id);
  const nested = itemId(event?.item?.id);
  return {
    id: direct ?? nested,
    conflict: direct !== undefined && nested !== undefined && direct !== nested,
  };
}

function eventItemId(event) {
  return eventItemReference(event).id;
}

function isToolCall(item) {
  return item?.type === "function_call" || item?.type === "custom_tool_call";
}

function candidateStart(item) {
  return (
    item?.type === "message" &&
    item.role === "assistant" &&
    Array.isArray(item.content) &&
    item.content.length === 0
  );
}

function finiteLimit(value, fallback, { minimum = 0, integer = false } = {}) {
  if (!Number.isFinite(value) || value < minimum) return fallback;
  return integer ? Math.floor(value) : value;
}

function exactEmptyPart(part) {
  return (
    part != null &&
    typeof part === "object" &&
    ["output_text", "text"].includes(part.type) &&
    part.text === ""
  );
}

function exactEmptyMessage(item) {
  return (
    item?.type === "message" &&
    item.role === "assistant" &&
    Array.isArray(item.content) &&
    item.content.length > 0 &&
    item.content.every(exactEmptyPart)
  );
}

// LiteLLM 1.96.0's terminal Chat-Completions -> Responses object represents
// the same empty text part as either null or an omitted `text` property. The
// streamed lifecycle is kept stricter above: every event must still explicitly
// prove an empty string before we consider suppressing it.
function exactTerminalEmptyPart(part) {
  return (
    part != null &&
    typeof part === "object" &&
    !Array.isArray(part) &&
    Object.keys(part).every((key) => TERMINAL_EMPTY_PART_KEYS.has(key)) &&
    ["output_text", "text"].includes(part.type) &&
    (part.text === "" || part.text === null || part.text === undefined) &&
    (part.annotations === undefined ||
      (Array.isArray(part.annotations) && part.annotations.length === 0)) &&
    (part.logprobs === undefined || part.logprobs === null ||
      (Array.isArray(part.logprobs) && part.logprobs.length === 0))
  );
}

function exactCompletedEmptyMessage(item) {
  return (
    item != null &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    Object.keys(item).every((key) => TERMINAL_EMPTY_MESSAGE_KEYS.has(key)) &&
    item?.type === "message" &&
    item.role === "assistant" &&
    Array.isArray(item.content) &&
    item.content.length > 0 &&
    item.content.every(exactTerminalEmptyPart) &&
    itemId(item.id) !== undefined &&
    (item.phase === undefined || item.phase === null) &&
    (item.status === undefined || item.status === "completed")
  );
}

function isReasoningItem(item) {
  return item?.type === "reasoning";
}

function hasValidToolCallIdentity(item) {
  return (
    isToolCall(item) &&
    itemId(item.id) !== undefined &&
    itemId(item.call_id) !== undefined &&
    typeof item.name === "string" &&
    item.name.length > 0
  );
}

function matchesToolCallIdentity(item, expected) {
  return (
    expected !== undefined &&
    hasValidToolCallIdentity(item) &&
    item.type === expected.type &&
    item.name === expected.name &&
    item.call_id === expected.callId
  );
}

// Non-streaming Responses bodies have no lifecycle events to corroborate an
// empty message. Keep the proof deliberately narrower: the item must be a
// completed, exactly empty assistant message, and the only output allowed
// between it and the function call that proves the bridge pattern is
// reasoning. A visible/refusal/unknown item ends that candidate.
function removableJsonMessageIndexes(output) {
  if (!Array.isArray(output)) return [];
  const removable = [];
  let pending;
  let ambiguousRun = false;
  for (let index = 0; index < output.length; index += 1) {
    const item = output[index];
    if (exactCompletedEmptyMessage(item)) {
      // Two empty messages with no intervening tool are ambiguous. Preserve
      // both instead of letting one tool retroactively prove both envelopes.
      if (pending !== undefined || ambiguousRun) {
        pending = undefined;
        ambiguousRun = true;
      } else {
        pending = index;
      }
      continue;
    }
    if (ambiguousRun) {
      if (!isReasoningItem(item)) ambiguousRun = false;
      continue;
    }
    if (pending === undefined) continue;
    if (hasValidToolCallIdentity(item)) {
      removable.push(pending);
      pending = undefined;
      continue;
    }
    if (!isReasoningItem(item)) pending = undefined;
  }
  return removable;
}

function jsonResponseOutput(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (payload.error !== undefined && payload.error !== null) return undefined;
  if (payload.object !== undefined && payload.object !== "response") return undefined;
  if (payload.status !== undefined && payload.status !== "completed") return undefined;
  return Array.isArray(payload.output) ? payload.output : undefined;
}

function candidateLifecycle(event, id) {
  if (eventItemId(event) !== id) return false;
  return [
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
  ].includes(event?.type);
}

function exactEmptyCandidateEvent(event) {
  switch (event?.type) {
    case "response.output_item.added":
      return candidateStart(event.item);
    case "response.content_part.added":
      return exactEmptyPart(event.part);
    case "response.output_text.delta":
      return event.delta === "";
    case "response.output_text.done":
      return event.text === "";
    case "response.content_part.done":
      return (
        exactEmptyPart(event.part) ||
        (event.part?.type === "reasoning_text" &&
          event.part.reasoning === "")
      );
    case "response.output_item.done":
      return exactEmptyMessage(event.item);
    default:
      return false;
  }
}

// LiteLLM's Chat-Completions/Anthropic -> Responses bridge can announce an
// empty assistant message before a tool call, then close that message after
// the call. Codex renders the empty lifecycle as a separate assistant turn.
//
// The tool cannot be renumbered until the preceding message is conclusively
// known to be empty: a legitimate mixed text/tool response has the same prefix.
// This transform therefore holds only that ambiguous interval under strict
// byte and time budgets. Every ambiguous, malformed, large, or slow shape fails
// open byte-for-byte and permanently disables the repair for that response.
export class TranslatedToolMessageCompatTransform extends Transform {
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #capture;
  #disabled = false;
  #suppressed;
  #maxCandidateBytes;
  #maxCandidateMs;
  #maxFrameBytes;
  #timer;

  constructor({
    maxCandidateBytes = MAX_CANDIDATE_BYTES,
    maxCandidateMs = MAX_CANDIDATE_MS,
    maxFrameBytes = MAX_FRAME_BYTES,
  } = {}) {
    super();
    this.#maxCandidateBytes = finiteLimit(
      maxCandidateBytes,
      MAX_CANDIDATE_BYTES,
      { integer: true },
    );
    this.#maxCandidateMs = finiteLimit(maxCandidateMs, MAX_CANDIDATE_MS);
    this.#maxFrameBytes = finiteLimit(maxFrameBytes, MAX_FRAME_BYTES, {
      minimum: 1,
      integer: true,
    });
  }

  _transform(chunk, _encoding, callback) {
    this.#buffer += this.#decoder.write(chunk);
    if (this.#disabled) {
      this.#pushBuffered();
      callback();
      return;
    }
    this.#emitCompleteBlocks();
    if (this.#disabled) {
      this.#pushBuffered();
    } else if (Buffer.byteLength(this.#buffer) > this.#maxFrameBytes) {
      this.#failOpen();
      this.#pushBuffered();
    }
    callback();
  }

  _flush(callback) {
    this.#clearTimer();
    this.#buffer += this.#decoder.end();
    if (this.#disabled) {
      this.#pushBuffered();
      callback();
      return;
    }
    this.#emitCompleteBlocks(true);
    if (this.#capture) this.#failOpen();
    this.#pushBuffered();
    callback();
  }

  _destroy(error, callback) {
    this.#clearTimer();
    callback(error);
  }

  #emitCompleteBlocks(flush = false) {
    while (this.#buffer.length && !this.#disabled) {
      const crlf = this.#buffer.indexOf("\r\n\r\n");
      const lf = this.#buffer.indexOf("\n\n");
      let index = -1;
      let separator = "";
      if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
        index = crlf;
        separator = "\r\n\r\n";
      } else if (lf !== -1) {
        index = lf;
        separator = "\n\n";
      }
      if (index === -1) {
        if (!flush) return;
        const block = this.#buffer;
        this.#buffer = "";
        if (Buffer.byteLength(block) > this.#maxFrameBytes) {
          this.#oversizedFrame(block);
          return;
        }
        this.#handleBlock(block, "");
        return;
      }
      const block = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + separator.length);
      if (Buffer.byteLength(block) + Buffer.byteLength(separator) > this.#maxFrameBytes) {
        this.#oversizedFrame(`${block}${separator}`);
        return;
      }
      this.#handleBlock(block, separator);
    }
  }

  #handleBlock(block, separator) {
    const frame = {
      original: `${block}${separator}`,
      parsed: parsedBlock(block),
      separator,
    };
    if (!frame.parsed) {
      if (this.#capture) this.#failOpen(frame);
      else this.push(Buffer.from(frame.original));
      return;
    }
    const event = frame.parsed.event;
    if (this.#suppressed) {
      this.#pushCompacted(frame);
      return;
    }

    if (eventItemReference(event).conflict) {
      this.#failOpen(frame);
      return;
    }

    if (!this.#capture) {
      if (
        event.type === "response.output_item.added" &&
        candidateStart(event.item) &&
        itemId(event.item?.id) &&
        Number.isInteger(event.output_index) &&
        event.output_index >= 0
      ) {
        const candidate = {
          id: event.item.id,
          outputIndex: event.output_index,
          sawTool: false,
          closed: false,
        };
        this.#capture = {
          firstOutputIndex: event.output_index,
          frames: [],
          bytes: 0,
          candidates: new Map([[candidate.id, candidate]]),
          candidateOrder: [candidate],
          itemIndexes: new Map([[event.item.id, event.output_index]]),
          indexItems: new Map([[event.output_index, event.item.id]]),
          toolItems: new Map(),
        };
        this.#startTimer();
        this.#hold(frame);
      } else {
        this.push(Buffer.from(frame.original));
      }
      return;
    }

    const capture = this.#capture;
    const attachedId = eventItemId(event);
    const attachedCandidate = capture.candidates.get(attachedId);
    if (
      attachedCandidate &&
      !candidateLifecycle(event, attachedCandidate.id)
    ) {
      this.#failOpen(frame);
      return;
    }
    if (attachedCandidate) {
      if (
        attachedCandidate.closed ||
        event.type === "response.output_item.added" ||
        !Number.isInteger(event.output_index) ||
        event.output_index !== attachedCandidate.outputIndex ||
        !exactEmptyCandidateEvent(event)
      ) {
        this.#failOpen(frame);
        return;
      }
    } else if (event.type === "response.output_item.added") {
      const id = itemId(event.item?.id);
      const index = event.output_index;
      if (
        !id ||
        !Number.isInteger(index) ||
        index < 0 ||
        index <= capture.firstOutputIndex ||
        capture.itemIndexes.has(id) ||
        capture.indexItems.has(index)
      ) {
        this.#failOpen(frame);
        return;
      }
      if (candidateStart(event.item)) {
        const previous = capture.candidateOrder.at(-1);
        if (!previous?.sawTool) {
          this.#failOpen(frame);
          return;
        }
        const candidate = { id, outputIndex: index, sawTool: false, closed: false };
        capture.candidates.set(id, candidate);
        capture.candidateOrder.push(candidate);
      } else if (isToolCall(event.item)) {
        if (!hasValidToolCallIdentity(event.item)) {
          this.#failOpen(frame);
          return;
        }
        capture.candidateOrder.at(-1).sawTool = true;
        capture.toolItems.set(id, {
          type: event.item.type,
          name: event.item.name,
          callId: event.item.call_id,
        });
      }
      capture.itemIndexes.set(id, index);
      capture.indexItems.set(index, id);
    } else if (attachedId) {
      const expectedIndex = capture.itemIndexes.get(attachedId);
      if (
        expectedIndex === undefined ||
        !Number.isInteger(event.output_index) ||
        event.output_index !== expectedIndex
      ) {
        this.#failOpen(frame);
        return;
      }
      if (isToolCall(event.item)) {
        if (
          event.type !== "response.output_item.done" ||
          !matchesToolCallIdentity(
            event.item,
            capture.toolItems.get(attachedId),
          )
        ) {
          this.#failOpen(frame);
          return;
        }
      }
    }

    this.#hold(frame);
    if (!this.#capture) return;

    if (
      event.type === "response.output_item.done" &&
      attachedCandidate
    ) {
      attachedCandidate.closed = true;
      return;
    }

    if (event.type === "response.completed" && Array.isArray(event.response?.output)) {
      if (this.#terminalMatchesCapture(event.response.output, capture)) {
        this.#suppress();
      } else this.#failOpen();
    }
  }

  #hold(frame) {
    if (!this.#capture) return;
    const bytes = Buffer.byteLength(frame.original);
    if (this.#capture.bytes + bytes > this.#maxCandidateBytes) {
      this.#failOpen(frame);
      return;
    }
    this.#capture.frames.push(frame);
    this.#capture.bytes += bytes;
  }

  #terminalMatchesCapture(output, capture) {
    const candidatesByIndex = new Map();
    for (const candidate of capture.candidateOrder) {
      if (!candidate.closed || !candidate.sawTool) return false;
      if (candidate.outputIndex >= output.length) return false;
      if (!exactCompletedEmptyMessage(output[candidate.outputIndex])) return false;
      candidatesByIndex.set(candidate.outputIndex, candidate);
    }
    for (const [id, expected] of capture.toolItems) {
      const item = output[capture.itemIndexes.get(id)];
      if (!matchesToolCallIdentity(item, expected)) return false;
    }
    const ids = new Set();
    for (let index = 0; index < output.length; index += 1) {
      const id = itemId(output[index]?.id);
      if (!id || ids.has(id)) return false;
      ids.add(id);
      if (index < capture.firstOutputIndex) continue;
      const mappedIndex = capture.itemIndexes.get(id);
      if (candidatesByIndex.has(index)) {
        // The pinned LiteLLM bridge uses a generated msg_* ID for streaming,
        // but the originating chat-completion ID for this exact terminal
        // empty item. Permit only that candidate slot to change identity; a
        // collision with any other streamed item remains ambiguous.
        if (mappedIndex !== undefined && mappedIndex !== index) return false;
      } else if (mappedIndex !== index) return false;
    }
    return output.length - capture.firstOutputIndex === capture.itemIndexes.size;
  }

  #suppress() {
    const capture = this.#capture;
    if (!capture) return;
    this.#capture = undefined;
    const items = capture.candidateOrder
      .map(({ id, outputIndex }) => ({ id, outputIndex }))
      .sort((left, right) => left.outputIndex - right.outputIndex);
    this.#suppressed = {
      items,
      streamIds: new Set(items.map(({ id }) => id)),
      outputIndexes: new Set(items.map(({ outputIndex }) => outputIndex)),
    };
    this.#clearTimer();
    for (const frame of capture.frames) this.#pushCompacted(frame);
  }

  #failOpen(extraFrame) {
    const capture = this.#capture;
    this.#capture = undefined;
    this.#clearTimer();
    if (capture) {
      for (const frame of capture.frames) this.push(Buffer.from(frame.original));
    }
    if (extraFrame) this.push(Buffer.from(extraFrame.original));
    this.#disabled = true;
  }

  #pushCompacted(frame) {
    const event = frame.parsed?.event;
    const suppressed = this.#suppressed;
    if (!event || !suppressed) {
      this.push(Buffer.from(frame.original));
      return;
    }
    const attachedId = eventItemId(event);
    if (
      suppressed.streamIds.has(attachedId) &&
      candidateLifecycle(event, attachedId)
    ) return;
    let next = event;
    let changed = false;
    if (Number.isInteger(event.output_index)) {
      const shift = suppressed.items.filter(
        ({ outputIndex }) => outputIndex < event.output_index,
      ).length;
      if (shift > 0) next = { ...next, output_index: event.output_index - shift };
      changed = shift > 0;
    }
    if (event.type === "response.completed" && Array.isArray(event.response?.output)) {
      const output = event.response.output.filter(
        (_item, index) => !suppressed.outputIndexes.has(index),
      );
      next = {
        ...next,
        response: {
          ...event.response,
          output,
        },
      };
      changed ||= output.length !== event.response.output.length;
    }
    this.push(
      Buffer.from(
        changed ? rewrittenBlock(frame.parsed, next, frame.separator) : frame.original,
      ),
    );
  }

  #oversizedFrame(original) {
    const frame = { original };
    if (this.#capture) this.#failOpen(frame);
    else {
      this.push(Buffer.from(original));
      this.#disabled = true;
    }
  }

  #pushBuffered() {
    if (!this.#buffer) return;
    this.push(Buffer.from(this.#buffer));
    this.#buffer = "";
  }

  #startTimer() {
    if (this.#timer || !this.#capture) return;
    this.#timer = setTimeout(() => {
      this.#failOpen();
      this.#pushBuffered();
    }, this.#maxCandidateMs);
    this.#timer.unref?.();
  }

  #clearTimer() {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

// Non-streaming translated responses can be normalized without inventing an
// event lifecycle. Hold one bounded JSON body, change only exact empty message
// items proven by a later function call, and release malformed, oversized, or
// slow bodies byte-for-byte.
export class TranslatedToolMessageJsonCompatTransform extends Transform {
  #pending = [];
  #pendingBytes = 0;
  #released = false;
  #maxBytes;
  #maxMs;
  #timer;

  constructor({ maxBytes = MAX_JSON_BYTES, maxMs = MAX_JSON_MS } = {}) {
    super();
    this.#maxBytes = finiteLimit(maxBytes, MAX_JSON_BYTES, {
      minimum: 1,
      integer: true,
    });
    this.#maxMs = finiteLimit(maxMs, MAX_JSON_MS);
  }

  _transform(chunk, _encoding, callback) {
    if (this.#released) {
      this.push(chunk);
      callback();
      return;
    }
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#startTimer();
    if (this.#pendingBytes + piece.length > this.#maxBytes) {
      this.#clearTimer();
      this.#releasePending();
      this.push(piece);
      this.#released = true;
      callback();
      return;
    }
    this.#pending.push(piece);
    this.#pendingBytes += piece.length;
    callback();
  }

  _flush(callback) {
    this.#clearTimer();
    const body = Buffer.concat(this.#pending, this.#pendingBytes);
    this.#pending = [];
    this.#pendingBytes = 0;
    if (this.#released || !body.length) {
      if (body.length) this.push(body);
      callback();
      return;
    }
    try {
      const source = body.toString("utf8");
      if (!Buffer.from(source).equals(body)) throw new Error("invalid utf-8");
      const payload = JSON.parse(source);
      const output = jsonResponseOutput(payload);
      const indexes = removableJsonMessageIndexes(output);
      if (!indexes.length) {
        this.push(body);
      } else {
        const removed = new Set(indexes);
        this.push(Buffer.from(JSON.stringify({
          ...payload,
          output: output.filter((_item, index) => !removed.has(index)),
        })));
      }
    } catch {
      this.push(body);
    }
    callback();
  }

  _destroy(error, callback) {
    this.#clearTimer();
    callback(error);
  }

  #startTimer() {
    if (this.#timer || this.#released) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#releasePending();
      this.#released = true;
    }, this.#maxMs);
    this.#timer.unref?.();
  }

  #clearTimer() {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #releasePending() {
    for (const piece of this.#pending) this.push(piece);
    this.#pending = [];
    this.#pendingBytes = 0;
  }
}

function translatedProtocol(provider) {
  if (!provider || typeof provider !== "object") return false;
  const protocol = provider.protocol ?? "openai";
  return protocol === "openai" || protocol === "anthropic";
}

export function translatedToolMessageCompatTransform(provider, contentType = "") {
  if (!translatedProtocol(provider)) return undefined;
  const mediaType = String(contentType).split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "text/event-stream") {
    return new TranslatedToolMessageCompatTransform();
  }
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return new TranslatedToolMessageJsonCompatTransform();
  }
  return undefined;
}

// Preserve the previous provider-specific factory for internal consumers while
// keeping its original SSE-only behavior.
export function deepseekToolMessageCompatTransform(providerId, contentType = "") {
  if (String(providerId) !== "deepseek") return undefined;
  return String(contentType).toLowerCase().includes("text/event-stream")
    ? new TranslatedToolMessageCompatTransform()
    : undefined;
}

// Kept as an internal compatibility alias for code that imported the original
// provider-specific class directly before the transform became protocol-scoped.
export const DeepseekToolMessageCompatTransform =
  TranslatedToolMessageCompatTransform;
