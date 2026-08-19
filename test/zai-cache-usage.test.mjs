import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import {
  ZaiCacheUsageCompatTransform,
  zaiCacheUsageTransform,
} from "../src/zai-cache-usage.mjs";

async function transformed(chunks) {
  const stream = Readable.from(chunks).pipe(new ZaiCacheUsageCompatTransform());
  const output = [];
  for await (const chunk of stream) output.push(chunk);
  return Buffer.concat(output).toString("utf8");
}

test("Z.ai cache usage compatibility survives split SSE chunks and explicit zero", async () => {
  const prefix = 'data: {"usage":{"prompt_tokens":12,"prompt_tokens_details":{"cached_tokens":';
  const output = await transformed([prefix, '0}}}\r\n', 'data: [DONE]\r\n']);
  const usageLine = output.split(/\r?\n/).find((line) => line.includes('"usage"'));
  const payload = JSON.parse(usageLine.slice(5).trim());
  assert.equal(payload.usage.prompt_tokens_details.cached_tokens, 0);
  assert.equal(payload.usage.prompt_cache_hit_tokens, 0);
});

test("Z.ai cache compatibility never overwrites a provider-supplied compatibility count", async () => {
  const line = 'data: {"usage":{"prompt_tokens_details":{"cached_tokens":800},"prompt_cache_hit_tokens":700}}\n';
  assert.equal(await transformed([line]), line);
});

test("cache compatibility is installed only for Z.ai event streams", () => {
  assert.ok(zaiCacheUsageTransform("zai-coding", "text/event-stream"));
  assert.ok(zaiCacheUsageTransform("zai-api", "text/event-stream; charset=utf-8"));
  assert.equal(zaiCacheUsageTransform("zai-coding", "application/json"), undefined);
  assert.equal(zaiCacheUsageTransform("deepseek", "text/event-stream"), undefined);
});

test("non-usage and malformed SSE lines pass through byte-for-byte", async () => {
  const input = 'event: message\r\ndata: {not-json}\r\ndata: [DONE]\r\n';
  assert.equal(await transformed([input]), input);
});
