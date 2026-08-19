import { Transform } from "node:stream";

const LINE_FEED = 0x0a;

// Z.ai reports cache reads in usage.prompt_tokens_details.cached_tokens. The
// generic LiteLLM streaming bridge can lose that nested detail before its
// Chat-Completions -> Responses conversion, while its Usage compatibility
// layer explicitly recognizes prompt_cache_hit_tokens. Mirror only an
// authoritative provider count; never infer a hit or turn missing data into 0.
function cachedTokens(payload) {
  const value = payload?.usage?.prompt_tokens_details?.cached_tokens;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export class ZaiCacheUsageCompatTransform extends Transform {
  #pending = Buffer.alloc(0);

  _transform(chunk, _encoding, callback) {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    this.#consumeLines();
    callback();
  }

  _flush(callback) {
    this.#consumeLines(true);
    callback();
  }

  #consumeLines(flush = false) {
    while (true) {
      const index = this.#pending.indexOf(LINE_FEED);
      if (index === -1) break;
      const line = this.#pending.subarray(0, index + 1);
      this.#pending = this.#pending.subarray(index + 1);
      this.push(this.#rewriteLine(line));
    }
    if (flush && this.#pending.length) {
      this.push(this.#rewriteLine(this.#pending));
      this.#pending = Buffer.alloc(0);
    }
  }

  #rewriteLine(line) {
    const text = line.toString("utf8");
    const terminator = text.endsWith("\r\n") ? "\r\n" : text.endsWith("\n") ? "\n" : "";
    const content = terminator ? text.slice(0, -terminator.length) : text;
    if (!content.startsWith("data:")) return line;
    const data = content.slice(5).trim();
    if (!data || data === "[DONE]") return line;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return line;
    }
    const cached = cachedTokens(payload);
    if (cached === undefined || payload?.usage?.prompt_cache_hit_tokens !== undefined) return line;
    payload.usage.prompt_cache_hit_tokens = cached;
    return Buffer.from(`data: ${JSON.stringify(payload)}${terminator}`, "utf8");
  }
}

export function zaiCacheUsageTransform(providerId, contentType = "") {
  if (!["zai-api", "zai-coding"].includes(String(providerId))) return undefined;
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new ZaiCacheUsageCompatTransform();
}
