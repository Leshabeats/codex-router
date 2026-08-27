import { Transform } from "node:stream";
import { TextDecoder } from "node:util";

const MAX_CANDIDATE_BYTES = 64 * 1024;
const MAX_CANDIDATE_MS = 1_000;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_JSON_MS = 1_000;
const LF_FRAME_SEPARATOR = Buffer.from("\n\n");
const CRLF_FRAME_SEPARATOR = Buffer.from("\r\n\r\n");
const RESPONSE_EVENT_KEYS = new Set(["type", "sequence_number", "response"]);
const OUTPUT_ITEM_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "output_index",
  "item",
]);
const CONTENT_PART_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "content_index",
  "part",
]);
const TEXT_DELTA_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "content_index",
  "delta",
  "logprobs",
  "obfuscation",
]);
const TEXT_DONE_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "content_index",
  "text",
  "logprobs",
]);
const TOOL_DELTA_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "delta",
  "obfuscation",
]);
const FUNCTION_DONE_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "arguments",
]);
const CUSTOM_DONE_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "input",
]);
const REASONING_PART_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "summary_index",
  "content_index",
  "part",
]);
const REASONING_TEXT_DELTA_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "summary_index",
  "content_index",
  "delta",
  "obfuscation",
]);
const REASONING_TEXT_DONE_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "summary_index",
  "content_index",
  "text",
]);
const CANDIDATE_MESSAGE_KEYS = new Set([
  "id",
  "type",
  "status",
  "role",
  "content",
  "phase",
]);
const FUNCTION_CALL_KEYS = new Set([
  "id",
  "type",
  "status",
  "arguments",
  "call_id",
  "name",
]);
const CUSTOM_TOOL_CALL_KEYS = new Set([
  "id",
  "type",
  "status",
  "input",
  "call_id",
  "name",
]);
const REASONING_ITEM_KEYS = new Set([
  "id",
  "type",
  "status",
  "summary",
  "content",
  "encrypted_content",
]);
const REASONING_PART_KEYS = new Set(["type", "text"]);
const EMPTY_REASONING_PART_KEYS = new Set(["type", "reasoning"]);
const REFUSAL_PART_KEYS = new Set(["type", "refusal"]);
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

const EVENT_KEYS = new Map([
  ["response.created", RESPONSE_EVENT_KEYS],
  ["response.in_progress", RESPONSE_EVENT_KEYS],
  ["response.completed", RESPONSE_EVENT_KEYS],
  ["response.output_item.added", OUTPUT_ITEM_EVENT_KEYS],
  ["response.output_item.done", OUTPUT_ITEM_EVENT_KEYS],
  ["response.content_part.added", CONTENT_PART_EVENT_KEYS],
  ["response.content_part.done", CONTENT_PART_EVENT_KEYS],
  ["response.output_text.delta", TEXT_DELTA_EVENT_KEYS],
  ["response.output_text.done", TEXT_DONE_EVENT_KEYS],
  ["response.function_call_arguments.delta", TOOL_DELTA_EVENT_KEYS],
  ["response.function_call_arguments.done", FUNCTION_DONE_EVENT_KEYS],
  ["response.custom_tool_call_input.delta", TOOL_DELTA_EVENT_KEYS],
  ["response.custom_tool_call_input.done", CUSTOM_DONE_EVENT_KEYS],
  ["response.reasoning_summary_part.added", REASONING_PART_EVENT_KEYS],
  ["response.reasoning_summary_part.done", REASONING_PART_EVENT_KEYS],
  ["response.reasoning_summary_text.delta", REASONING_TEXT_DELTA_EVENT_KEYS],
  ["response.reasoning_summary_text.done", REASONING_TEXT_DONE_EVENT_KEYS],
  ["response.reasoning_text.delta", REASONING_TEXT_DELTA_EVENT_KEYS],
  ["response.reasoning_text.done", REASONING_TEXT_DONE_EVENT_KEYS],
]);

function plainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function exactKeys(value, allowed) {
  const object = plainObject(value);
  return object !== undefined && Object.keys(object).every((key) => allowed.has(key));
}

function validSequenceNumber(event) {
  return event.sequence_number === undefined ||
    (Number.isInteger(event.sequence_number) && event.sequence_number >= 0);
}

function validObfuscation(event) {
  return event.obfuscation === undefined || typeof event.obfuscation === "string";
}

function exactEventKeys(event) {
  const allowed = EVENT_KEYS.get(event?.type);
  return allowed !== undefined && exactKeys(event, allowed) && validSequenceNumber(event);
}

function fatalUtf8(buffer) {
  // Preserve a leading BOM as a real code point. It is not part of the
  // confirmed bridge grammar, so the parser will fail open instead of silently
  // dropping three raw bytes while decoding a frame or JSON body.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
}

function parsedBlock(blockBytes) {
  let block;
  try {
    block = fatalUtf8(blockBytes);
  } catch {
    return { invalidUtf8: true };
  }
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const dataLineIndexes = lines
    .map((line, index) => (line.startsWith("data:") ? index : -1))
    .filter((index) => index !== -1);
  const eventLines = lines.filter((line) => line.startsWith("event:"));
  const unknownLines = lines.filter((line) => {
    return line !== "" && !line.startsWith("data:") && !line.startsWith("event:");
  });
  if (
    dataLineIndexes.length !== 1 ||
    eventLines.length > 1 ||
    unknownLines.length > 0
  ) {
    return { malformed: true };
  }
  const [dataLineIndex] = dataLineIndexes;
  const dataText = lines[dataLineIndex].slice(5).trimStart();
  if (!dataText) return { malformed: true };
  if (dataText === "[DONE]") {
    return eventLines.length === 0 ? { done: true } : { malformed: true };
  }
  try {
    const event = JSON.parse(dataText);
    if (
      eventLines.length === 1 &&
      eventLines[0].slice(6).trim() !== event?.type
    ) {
      return { malformed: true };
    }
    return { parsed: { lines, dataLineIndex, newline, event } };
  } catch {
    return { malformed: true };
  }
}

function rewrittenBlock(parsed, event, separator) {
  const lines = [...parsed.lines];
  lines[parsed.dataLineIndex] = `data: ${JSON.stringify(event)}`;
  return Buffer.from(`${lines.join(parsed.newline)}${separator}`);
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
    exactKeys(item, CANDIDATE_MESSAGE_KEYS) &&
    item?.type === "message" &&
    item.role === "assistant" &&
    item.status === "in_progress" &&
    Array.isArray(item.content) &&
    item.content.length === 0 &&
    (item.phase === undefined || item.phase === null)
  );
}

function finiteLimit(value, fallback, { minimum = 0, integer = false } = {}) {
  if (!Number.isFinite(value) || value < minimum) return fallback;
  return integer ? Math.floor(value) : value;
}

function exactEmptyPart(part) {
  return (
    exactKeys(part, TERMINAL_EMPTY_PART_KEYS) &&
    ["output_text", "text"].includes(part.type) &&
    part.text === "" &&
    (part.annotations === undefined ||
      (Array.isArray(part.annotations) && part.annotations.length === 0)) &&
    (part.logprobs === undefined || part.logprobs === null ||
      (Array.isArray(part.logprobs) && part.logprobs.length === 0))
  );
}

function exactEmptyMessage(item) {
  return (
    exactKeys(item, CANDIDATE_MESSAGE_KEYS) &&
    item?.type === "message" &&
    item.role === "assistant" &&
    item.status === "completed" &&
    Array.isArray(item.content) &&
    item.content.length === 1 &&
    item.content.every(exactEmptyPart) &&
    itemId(item.id) !== undefined &&
    (item.phase === undefined || item.phase === null)
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
    exactKeys(item, TERMINAL_EMPTY_MESSAGE_KEYS) &&
    item?.type === "message" &&
    item.role === "assistant" &&
    item.status === "completed" &&
    Array.isArray(item.content) &&
    item.content.length === 1 &&
    item.content.every(exactTerminalEmptyPart) &&
    itemId(item.id) !== undefined &&
    (item.phase === undefined || item.phase === null)
  );
}

function exactVisibleTextPart(part) {
  return (
    exactKeys(part, TERMINAL_EMPTY_PART_KEYS) &&
    ["output_text", "text"].includes(part.type) &&
    typeof part.text === "string" &&
    (part.annotations === undefined || Array.isArray(part.annotations)) &&
    (part.logprobs === undefined || part.logprobs === null ||
      Array.isArray(part.logprobs))
  );
}

function exactRefusalPart(part) {
  return (
    exactKeys(part, REFUSAL_PART_KEYS) &&
    part.type === "refusal" &&
    typeof part.refusal === "string"
  );
}

function exactCompletedMessage(item) {
  return (
    exactKeys(item, TERMINAL_EMPTY_MESSAGE_KEYS) &&
    item?.type === "message" &&
    itemId(item.id) !== undefined &&
    item.status === "completed" &&
    item.role === "assistant" &&
    Array.isArray(item.content) &&
    item.content.length > 0 &&
    item.content.every((part) => {
      return exactTerminalEmptyPart(part) ||
        exactVisibleTextPart(part) ||
        exactRefusalPart(part);
    }) &&
    (item.phase === undefined || item.phase === null || typeof item.phase === "string")
  );
}

function isReasoningItem(item) {
  return item?.type === "reasoning";
}

function exactReasoningArrayPart(part, type) {
  return (
    exactKeys(part, REASONING_PART_KEYS) &&
    part.type === type &&
    typeof part.text === "string"
  );
}

function exactReasoningItem(item, { completed = false } = {}) {
  return (
    exactKeys(item, REASONING_ITEM_KEYS) &&
    item?.type === "reasoning" &&
    itemId(item.id) !== undefined &&
    (item.status === undefined || item.status === (completed ? "completed" : "in_progress")) &&
    (item.summary === undefined ||
      (Array.isArray(item.summary) &&
        item.summary.every((part) => exactReasoningArrayPart(part, "summary_text")))) &&
    (item.content === undefined ||
      (Array.isArray(item.content) &&
        item.content.every((part) => exactReasoningArrayPart(part, "reasoning_text")))) &&
    (item.encrypted_content === undefined || item.encrypted_content === null ||
      typeof item.encrypted_content === "string")
  );
}

function toolValueField(type) {
  return type === "function_call" ? "arguments" : "input";
}

function exactToolCall(item, { completed = false } = {}) {
  if (!isToolCall(item)) return false;
  const allowed = item.type === "function_call" ? FUNCTION_CALL_KEYS : CUSTOM_TOOL_CALL_KEYS;
  const valueField = toolValueField(item.type);
  return (
    exactKeys(item, allowed) &&
    itemId(item.id) !== undefined &&
    itemId(item.call_id) !== undefined &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    typeof item[valueField] === "string" &&
    item.status === (completed ? "completed" : "in_progress")
  );
}

function hasValidToolCallIdentity(item, options) {
  return exactToolCall(item, options);
}

function matchesToolCallIdentity(item, expected) {
  return (
    expected !== undefined &&
    hasValidToolCallIdentity(item, { completed: true }) &&
    item.type === expected.type &&
    item.name === expected.name &&
    item.call_id === expected.callId &&
    item[toolValueField(item.type)] === expected.value
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
      if (!exactReasoningItem(item, { completed: true })) ambiguousRun = false;
      continue;
    }
    if (pending === undefined) continue;
    if (hasValidToolCallIdentity(item, { completed: true })) {
      removable.push(pending);
      pending = undefined;
      continue;
    }
    if (!exactReasoningItem(item, { completed: true })) pending = undefined;
  }
  return removable;
}

function jsonResponseOutput(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (payload.error !== undefined && payload.error !== null) return undefined;
  if (payload.object !== "response" || payload.status !== "completed") return undefined;
  const responseId = itemId(payload.id);
  if (!responseId || !Array.isArray(payload.output)) return undefined;
  const ids = new Set([responseId]);
  for (const item of payload.output) {
    const id = itemId(item?.id);
    if (!id || ids.has(id)) return undefined;
    ids.add(id);
    if (item?.type === "message") {
      if (!exactCompletedMessage(item)) return undefined;
      continue;
    }
    if (isReasoningItem(item)) {
      if (!exactReasoningItem(item, { completed: true })) return undefined;
      continue;
    }
    if (!hasValidToolCallIdentity(item, { completed: true })) return undefined;
  }
  return payload.output;
}

function successfulResponseEnvelope(response, status, responseId) {
  return (
    plainObject(response) !== undefined &&
    itemId(response.id) !== undefined &&
    (responseId === undefined || response.id === responseId) &&
    response.object === "response" &&
    response.status === status &&
    (response.error === undefined || response.error === null) &&
    Array.isArray(response.output)
  );
}

function exactReasoningPart(part) {
  return (
    exactKeys(part, REASONING_PART_KEYS) &&
    part.type === "summary_text" &&
    typeof part.text === "string"
  );
}

function eventIndexMatches(event, record) {
  return (
    eventItemId(event) === record.id &&
    Number.isInteger(event.output_index) &&
    event.output_index === record.outputIndex
  );
}

function terminalCandidateLifecycle(event, candidateId) {
  return (
    eventItemId(event) === candidateId &&
    [
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
    ].includes(event?.type)
  );
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
  #buffer = Buffer.alloc(0);
  #capture;
  #disabled = false;
  #finished = false;
  #responseId;
  #sawInProgress = false;
  #items = new Map();
  #indexItems = new Map();
  #lastSequence = -1;
  #preludeBytes = 0;
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
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#buffer = this.#buffer.length
      ? Buffer.concat([this.#buffer, piece])
      : Buffer.from(piece);
    if (this.#disabled || this.#finished) {
      this.#pushBuffered();
      callback();
      return;
    }
    this.#emitCompleteBlocks();
    if (this.#disabled || this.#finished) {
      this.#pushBuffered();
    } else if (this.#buffer.length > this.#maxFrameBytes) {
      this.#failOpen();
      this.#pushBuffered();
    }
    callback();
  }

  _flush(callback) {
    this.#clearTimer();
    if (this.#disabled || this.#finished) {
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
    while (this.#buffer.length && !this.#disabled && !this.#finished) {
      const crlf = this.#buffer.indexOf(CRLF_FRAME_SEPARATOR);
      const lf = this.#buffer.indexOf(LF_FRAME_SEPARATOR);
      let index = -1;
      let separator = Buffer.alloc(0);
      if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
        index = crlf;
        separator = CRLF_FRAME_SEPARATOR;
      } else if (lf !== -1) {
        index = lf;
        separator = LF_FRAME_SEPARATOR;
      }
      if (index === -1) {
        if (!flush) return;
        const block = Buffer.from(this.#buffer);
        this.#buffer = Buffer.alloc(0);
        if (block.length > this.#maxFrameBytes) {
          this.#oversizedFrame(block);
          return;
        }
        this.#handleBlock(block, Buffer.alloc(0));
        return;
      }
      const end = index + separator.length;
      const block = Buffer.from(this.#buffer.subarray(0, index));
      const original = Buffer.from(this.#buffer.subarray(0, end));
      this.#buffer = Buffer.from(this.#buffer.subarray(end));
      if (original.length > this.#maxFrameBytes) {
        this.#oversizedFrame(original);
        return;
      }
      this.#handleBlock(block, separator);
    }
  }

  #handleBlock(block, separator) {
    const parsedResult = parsedBlock(block);
    const frame = {
      original: Buffer.concat([block, separator]),
      parsed: parsedResult.parsed,
      separator: separator.toString("ascii"),
    };
    if (parsedResult.invalidUtf8 || parsedResult.malformed) {
      this.#failOpen(frame);
      return;
    }
    if (parsedResult.done) {
      if (this.#capture) this.#failOpen(frame);
      else {
        this.push(frame.original);
        this.#finished = true;
      }
      return;
    }
    if (!frame.parsed) {
      this.#failOpen(frame);
      return;
    }
    const event = frame.parsed.event;
    if (
      !exactEventKeys(event) ||
      eventItemReference(event).conflict ||
      !this.#acceptSequence(event)
    ) {
      this.#failOpen(frame);
      return;
    }

    if (event.type === "response.created") {
      if (
        this.#responseId !== undefined ||
        !successfulResponseEnvelope(event.response, "in_progress") ||
        event.response.output.length !== 0
      ) {
        this.#failOpen(frame);
        return;
      }
      this.#responseId = event.response.id;
      this.push(frame.original);
      return;
    }

    if (this.#responseId === undefined) {
      this.#failOpen(frame);
      return;
    }

    if (event.type === "response.in_progress") {
      if (
        this.#sawInProgress ||
        this.#capture ||
        this.#items.size > 0 ||
        !successfulResponseEnvelope(event.response, "in_progress", this.#responseId) ||
        event.response.output.length !== 0
      ) {
        this.#failOpen(frame);
        return;
      }
      this.#sawInProgress = true;
      this.push(frame.original);
      return;
    }

    if (event.type === "response.completed") {
      this.#handleCompleted(frame, event);
      return;
    }

    if (event.type === "response.output_item.added") {
      this.#handleAdded(frame, event);
      return;
    }

    this.#handleItemLifecycle(frame, event);
  }

  #acceptSequence(event) {
    if (event.sequence_number === undefined) return true;
    if (event.sequence_number <= this.#lastSequence) return false;
    this.#lastSequence = event.sequence_number;
    return true;
  }

  #handleAdded(frame, event) {
    const id = itemId(event.item?.id);
    const outputIndex = event.output_index;
    if (
      !id ||
      !Number.isInteger(outputIndex) ||
      outputIndex < 0 ||
      outputIndex !== this.#indexItems.size ||
      this.#items.has(id) ||
      this.#indexItems.has(outputIndex)
    ) {
      this.#failOpen(frame);
      return;
    }

    let record;
    if (candidateStart(event.item)) {
      const previous = this.#capture?.candidates.at(-1);
      if (
        previous &&
        (!previous.sawTool ||
          !previous.done ||
          [...this.#items.values()].some((item) => !item.done))
      ) {
        this.#failOpen(frame);
        return;
      }
      record = {
        id,
        outputIndex,
        kind: "candidate",
        done: false,
        sawTool: false,
        contentStarted: false,
        textDone: false,
        partDone: false,
      };
    } else if (exactReasoningItem(event.item)) {
      record = {
        id,
        outputIndex,
        kind: "reasoning",
        done: false,
        parts: new Set(),
        partDones: new Set(),
        textDones: new Set(),
        textDeltas: new Set(),
        textValues: new Map(),
        doneTexts: new Map(),
      };
    } else if (exactToolCall(event.item)) {
      const valueField = toolValueField(event.item.type);
      record = {
        id,
        outputIndex,
        kind: event.item.type,
        done: false,
        name: event.item.name,
        callId: event.item.call_id,
        valueField,
        delta: event.item[valueField],
        value: undefined,
        valueDone: false,
      };
    } else {
      // A visible assistant message or an unknown output item makes the whole
      // envelope ineligible. Nothing before this point has been rewritten.
      this.#failOpen(frame);
      return;
    }

    if (record.kind !== "candidate" && !this.#trackPrelude(frame)) return;

    this.#items.set(id, record);
    this.#indexItems.set(outputIndex, id);
    if (record.kind === "candidate") {
      if (!this.#capture) {
        this.#capture = {
          frames: [],
          bytes: 0,
          candidates: [],
        };
        this.#startTimer();
      }
      this.#capture.candidates.push(record);
    } else if (isToolCall(event.item) && this.#capture) {
      this.#capture.candidates.at(-1).sawTool = true;
    }
    this.#pushOrHold(frame);
  }

  #handleItemLifecycle(frame, event) {
    const id = eventItemId(event);
    const record = id ? this.#items.get(id) : undefined;
    if (!record || !eventIndexMatches(event, record)) {
      this.#failOpen(frame);
      return;
    }
    if (!this.#trackPrelude(frame)) return;

    let valid = false;
    if (record.kind === "candidate") {
      valid = this.#advanceCandidate(event, record);
    } else if (record.kind === "reasoning") {
      valid = this.#advanceReasoning(event, record);
    } else {
      valid = this.#advanceTool(event, record);
    }
    if (!valid) {
      this.#failOpen(frame);
      return;
    }
    this.#pushOrHold(frame);
  }

  #trackPrelude(frame) {
    if (this.#capture) return true;
    if (this.#preludeBytes + frame.original.length > this.#maxCandidateBytes) {
      this.#failOpen(frame);
      return false;
    }
    this.#preludeBytes += frame.original.length;
    return true;
  }

  #advanceCandidate(event, record) {
    if (record.done || !terminalCandidateLifecycle(event, record.id)) return false;
    if (event.type === "response.content_part.added") {
      if (
        record.contentStarted ||
        event.content_index !== 0 ||
        !exactEmptyPart(event.part)
      ) return false;
      record.contentStarted = true;
      return true;
    }
    if (event.type === "response.output_text.delta") {
      return (
        record.contentStarted &&
        !record.textDone &&
        !record.partDone &&
        event.content_index === 0 &&
        event.delta === "" &&
        validObfuscation(event) &&
        (event.logprobs === undefined || event.logprobs === null ||
          (Array.isArray(event.logprobs) && event.logprobs.length === 0))
      );
    }
    if (event.type === "response.output_text.done") {
      if (
        !record.contentStarted ||
        record.textDone ||
        record.partDone ||
        event.content_index !== 0 ||
        event.text !== "" ||
        !(event.logprobs === undefined || event.logprobs === null ||
          (Array.isArray(event.logprobs) && event.logprobs.length === 0))
      ) return false;
      record.textDone = true;
      return true;
    }
    if (event.type === "response.content_part.done") {
      if (
        !record.contentStarted ||
        !record.textDone ||
        record.partDone ||
        event.content_index !== 0 ||
        !(
          exactEmptyPart(event.part) ||
          (exactKeys(event.part, EMPTY_REASONING_PART_KEYS) &&
            event.part.type === "reasoning_text" &&
            event.part.reasoning === "")
        )
      ) return false;
      record.partDone = true;
      return true;
    }
    if (event.type !== "response.output_item.done") return false;
    if (
      !exactEmptyMessage(event.item) ||
      event.item.id !== record.id ||
      (record.contentStarted && (!record.textDone || !record.partDone))
    ) return false;
    record.done = true;
    return true;
  }

  #advanceTool(event, record) {
    if (record.done) return false;
    const isFunction = record.kind === "function_call";
    const deltaType = isFunction
      ? "response.function_call_arguments.delta"
      : "response.custom_tool_call_input.delta";
    const doneType = isFunction
      ? "response.function_call_arguments.done"
      : "response.custom_tool_call_input.done";
    if (event.type === deltaType) {
      if (
        record.valueDone ||
        typeof event.delta !== "string" ||
        !validObfuscation(event)
      ) return false;
      record.delta += event.delta;
      return true;
    }
    if (event.type === doneType) {
      const value = event[record.valueField];
      if (
        record.valueDone ||
        typeof value !== "string" ||
        (record.delta && record.delta !== value)
      ) return false;
      record.value = value;
      record.valueDone = true;
      return true;
    }
    if (event.type !== "response.output_item.done") return false;
    const expected = {
      type: record.kind,
      name: record.name,
      callId: record.callId,
      value: record.valueDone
        ? record.value
        : record.delta || event.item?.[record.valueField],
    };
    if (
      event.item?.id !== record.id ||
      !matchesToolCallIdentity(event.item, expected)
    ) return false;
    record.value = event.item[record.valueField];
    record.valueDone = true;
    record.done = true;
    return true;
  }

  #reasoningIndex(event, prefix) {
    const expectedKey = prefix === "summary" ? "summary_index" : "content_index";
    const otherKey = prefix === "summary" ? "content_index" : "summary_index";
    if (
      !Number.isInteger(event[expectedKey]) ||
      event[expectedKey] < 0 ||
      event[otherKey] !== undefined
    ) return undefined;
    return `${prefix}:${event[expectedKey]}`;
  }

  #advanceReasoning(event, record) {
    if (record.done) return false;
    if (event.type === "response.output_item.done") {
      if (
        event.item?.id !== record.id ||
        !exactReasoningItem(event.item, { completed: true })
      ) return false;
      for (const key of record.parts) if (!record.partDones.has(key)) return false;
      for (const key of record.textDeltas) if (!record.textDones.has(key)) return false;
      record.done = true;
      return true;
    }

    const summary = event.type.startsWith("response.reasoning_summary_");
    const reasoningText = event.type.startsWith("response.reasoning_text.");
    if (!summary && !reasoningText) return false;
    const key = this.#reasoningIndex(event, summary ? "summary" : "content");
    if (!key) return false;
    if (event.type.endsWith("part.added")) {
      if (record.parts.has(key) || !exactReasoningPart(event.part)) return false;
      record.parts.add(key);
      record.textValues.set(key, event.part.text);
      return true;
    }
    if (event.type.endsWith("part.done")) {
      if (
        !record.parts.has(key) ||
        record.partDones.has(key) ||
        !exactReasoningPart(event.part) ||
        (record.textDeltas.has(key) && !record.textDones.has(key)) ||
        event.part.text !== (record.doneTexts.get(key) ?? record.textValues.get(key))
      ) return false;
      record.partDones.add(key);
      return true;
    }
    if (event.type.endsWith(".delta")) {
      if (
        !record.parts.has(key) ||
        record.partDones.has(key) ||
        record.textDones.has(key) ||
        typeof event.delta !== "string" ||
        !validObfuscation(event)
      ) {
        return false;
      }
      record.textDeltas.add(key);
      record.textValues.set(key, `${record.textValues.get(key) ?? ""}${event.delta}`);
      return true;
    }
    if (event.type.endsWith(".done")) {
      if (
        !record.parts.has(key) ||
        record.partDones.has(key) ||
        record.textDones.has(key) ||
        typeof event.text !== "string" ||
        (record.textDeltas.has(key) && event.text !== record.textValues.get(key))
      ) return false;
      record.textDones.add(key);
      record.doneTexts.set(key, event.text);
      return true;
    }
    return false;
  }

  #handleCompleted(frame, event) {
    if (
      !successfulResponseEnvelope(event.response, "completed", this.#responseId)
    ) {
      this.#failOpen(frame);
      return;
    }
    if (!this.#capture) {
      this.push(frame.original);
      this.#finished = true;
      return;
    }
    if (!this.#terminalMatchesCapture(event.response.output)) {
      this.#failOpen(frame);
      return;
    }
    this.#hold(frame);
    if (this.#capture) this.#suppress();
  }

  #pushOrHold(frame) {
    if (this.#capture) this.#hold(frame);
    else this.push(frame.original);
  }

  #hold(frame) {
    if (!this.#capture) return;
    const bytes = frame.original.length;
    if (this.#capture.bytes + bytes > this.#maxCandidateBytes) {
      this.#failOpen(frame);
      return;
    }
    this.#capture.frames.push(frame);
    this.#capture.bytes += bytes;
  }

  #terminalMatchesCapture(output) {
    if (output.length !== this.#items.size) return false;
    const ids = new Set([this.#responseId]);
    for (let index = 0; index < output.length; index += 1) {
      const recordId = this.#indexItems.get(index);
      const record = recordId ? this.#items.get(recordId) : undefined;
      const item = output[index];
      const id = itemId(item?.id);
      if (!record || !record.done) return false;
      if (!id || ids.has(id)) return false;
      ids.add(id);
      if (record.kind === "candidate") {
        if (!record.sawTool || !exactCompletedEmptyMessage(item)) return false;
        // The pinned LiteLLM bridge uses a generated msg_* ID for streaming,
        // but the originating chat-completion ID for this exact terminal
        // empty item. Permit only that candidate slot to change identity; a
        // collision with any other streamed item remains ambiguous.
        if (id !== record.id && this.#items.has(id)) return false;
        continue;
      }
      if (id !== record.id) return false;
      if (record.kind === "reasoning") {
        if (!exactReasoningItem(item, { completed: true })) return false;
        continue;
      }
      if (!matchesToolCallIdentity(item, {
        type: record.kind,
        name: record.name,
        callId: record.callId,
        value: record.value,
      })) return false;
    }
    return true;
  }

  #suppress() {
    const capture = this.#capture;
    if (!capture) return;
    this.#capture = undefined;
    const items = capture.candidates
      .map(({ id, outputIndex }) => ({ id, outputIndex }))
      .sort((left, right) => left.outputIndex - right.outputIndex);
    const suppressed = {
      items,
      streamIds: new Set(items.map(({ id }) => id)),
      outputIndexes: new Set(items.map(({ outputIndex }) => outputIndex)),
    };
    this.#clearTimer();
    for (const frame of capture.frames) this.#pushCompacted(frame, suppressed);
    this.#finished = true;
  }

  #failOpen(extraFrame) {
    const capture = this.#capture;
    this.#capture = undefined;
    this.#clearTimer();
    if (capture) {
      for (const frame of capture.frames) this.push(frame.original);
    }
    if (extraFrame) this.push(extraFrame.original);
    this.#disabled = true;
  }

  #pushCompacted(frame, suppressed) {
    const event = frame.parsed?.event;
    if (!event || !suppressed) {
      this.push(frame.original);
      return;
    }
    const attachedId = eventItemId(event);
    if (
      suppressed.streamIds.has(attachedId) &&
      (event.type === "response.output_item.added" ||
        terminalCandidateLifecycle(event, attachedId))
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
    this.push(changed ? rewrittenBlock(frame.parsed, next, frame.separator) : frame.original);
  }

  #oversizedFrame(original) {
    const frame = { original: Buffer.isBuffer(original) ? original : Buffer.from(original) };
    if (this.#capture) this.#failOpen(frame);
    else {
      this.push(frame.original);
      this.#disabled = true;
    }
  }

  #pushBuffered() {
    if (!this.#buffer.length) return;
    this.push(this.#buffer);
    this.#buffer = Buffer.alloc(0);
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
      const source = fatalUtf8(body);
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
