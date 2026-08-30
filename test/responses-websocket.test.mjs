import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { authenticatedRoute } from "../src/caller-auth.mjs";
import {
  handleResponsesWebSocketUpgrade,
  RESPONSES_WEBSOCKET_BETA,
} from "../src/responses-websocket.mjs";

const CALLER_KEY = "test-responses-websocket-caller-capability-0123456789abcdef";
const WS_KEY = Buffer.from("0123456789abcdef").toString("base64");

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("condition timed out"));
      setTimeout(check, 10);
    };
    check();
  });
}

async function startServer(handler, options = {}) {
  const server = http.createServer(async (request, response) => {
    try {
      const route = authenticatedRoute(
        new URL(request.url, "http://127.0.0.1").pathname,
        CALLER_KEY,
      );
      if (route !== "/v1/responses") {
        response.writeHead(401).end();
        return;
      }
      await handler(request, response);
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  server.on("upgrade", (request, socket, head) => {
    handleResponsesWebSocketUpgrade(request, socket, head, {
      callerKey: CALLER_KEY,
      responsesUrl: `http://127.0.0.1:${port}/_codex-router/${CALLER_KEY}/v1/responses`,
      ...options,
    });
  });
  return { server, port };
}

function maskedFrame(opcode, payload, { fin = true, declaredLength } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "", "utf8");
  const length = declaredLength ?? data.length;
  let header;
  if (length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = Buffer.from([0x13, 0x57, 0x9b, 0xdf]);
  const masked = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) {
    masked[index] = data[index] ^ mask[index & 3];
  }
  return Buffer.concat([header, mask, masked]);
}

function unmaskedFrame(opcode, payload) {
  const data = Buffer.from(payload || "", "utf8");
  return Buffer.concat([Buffer.from([0x80 | opcode, data.length]), data]);
}

function makePeer(socket, initial = Buffer.alloc(0)) {
  let buffer = initial;
  const frames = [];
  const waiters = [];
  const consume = () => {
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      const frame = { opcode, payload: buffer.subarray(offset, offset + length) };
      buffer = buffer.subarray(offset + length);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
      else frames.push(frame);
    }
  };
  socket.on("data", (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    consume();
  });
  consume();
  return {
    socket,
    sendJson(value, options) {
      socket.write(maskedFrame(options?.opcode ?? 0x1, JSON.stringify(value), options));
    },
    sendFrame(opcode, payload, options) {
      socket.write(maskedFrame(opcode, payload, options));
    },
    nextFrame(timeoutMs = 2_000) {
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("frame timed out")), timeoutMs);
        waiters.push({
          resolve(frame) {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
    async nextJson() {
      const frame = await this.nextFrame();
      assert.equal(frame.opcode, 0x1);
      return JSON.parse(frame.payload.toString("utf8"));
    },
    close() {
      socket.end(maskedFrame(0x8, Buffer.from([0x03, 0xe8])));
    },
  };
}

function handshakeRequest(port, path, headers = {}) {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Connection: keep-alive, Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${WS_KEY}`,
    `OpenAI-Beta: ${RESPONSES_WEBSOCKET_BETA}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");
}

async function connect(port, { path, headers } = {}) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    handshakeRequest(
      port,
      path || `/_codex-router/${CALLER_KEY}/v1/responses`,
      headers,
    ),
  );
  let received = Buffer.alloc(0);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("handshake timed out")), 2_000);
    const onData = (chunk) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf("\r\n\r\n");
      if (end === -1) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve({
        head: received.subarray(0, end + 4).toString("latin1"),
        rest: received.subarray(end + 4),
      });
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  return { ...result, socket, peer: makePeer(socket, result.rest) };
}

function sse(response, events, { delayMs = 0 } = {}) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  let index = 0;
  const write = () => {
    if (index >= events.length) {
      response.end();
      return;
    }
    response.write(`event: ${events[index].type}\ndata: ${JSON.stringify(events[index])}\n\n`);
    index += 1;
    if (delayMs) setTimeout(write, delayMs);
    else write();
  };
  write();
}

function createRequest(overrides = {}) {
  return {
    type: "response.create",
    model: "test/model",
    instructions: "be useful",
    input: [{ type: "message", role: "user", content: "hello" }],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: null,
    store: false,
    stream: true,
    include: [],
    ...overrides,
  };
}

test("authenticates the capability and beta contract before switching protocols", async (t) => {
  const { server, port } = await startServer(() => assert.fail("HTTP route must not run"));
  t.after(() => server.close());

  const wrong = await connect(port, {
    path: "/_codex-router/wrong-caller-capability-with-sufficient-length/v1/responses",
  });
  assert.match(wrong.head, /^HTTP\/1\.1 401 /);
  assert.doesNotMatch(wrong.head, /101 Switching Protocols/);
  wrong.socket.destroy();

  const noBetaSocket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve) => noBetaSocket.once("connect", resolve));
  noBetaSocket.write(
    handshakeRequest(port, `/_codex-router/${CALLER_KEY}/v1/responses`).replace(
      `OpenAI-Beta: ${RESPONSES_WEBSOCKET_BETA}\r\n`,
      "",
    ),
  );
  const noBeta = await new Promise((resolve) => noBetaSocket.once("data", resolve));
  assert.match(String(noBeta), /^HTTP\/1\.1 426 /);
  assert.match(String(noBeta), new RegExp(`OpenAI-Beta: ${RESPONSES_WEBSOCKET_BETA}`, "i"));
  assert.doesNotMatch(String(noBeta), /101 Switching Protocols/);
  noBetaSocket.destroy();

  const oldBetaSocket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve) => oldBetaSocket.once("connect", resolve));
  oldBetaSocket.write(
    handshakeRequest(port, `/_codex-router/${CALLER_KEY}/v1/responses`).replace(
      RESPONSES_WEBSOCKET_BETA,
      "responses_websockets=2025-01-01",
    ),
  );
  const oldBeta = await new Promise((resolve) => oldBetaSocket.once("data", resolve));
  assert.match(String(oldBeta), /^HTTP\/1\.1 426 /);
  assert.match(String(oldBeta), new RegExp(`OpenAI-Beta: ${RESPONSES_WEBSOCKET_BETA}`, "i"));
  assert.doesNotMatch(String(oldBeta), /101 Switching Protocols/);
  oldBetaSocket.destroy();

  const browser = await connect(port, { headers: { Origin: "https://attacker.invalid" } });
  assert.match(browser.head, /^HTTP\/1\.1 403 /);
  assert.doesNotMatch(browser.head, /101 Switching Protocols/);
  browser.socket.destroy();
});

test("accepts an injected direct-bearer policy without weakening pre-upgrade auth", async (t) => {
  let internalAuthorization;
  const { server, port } = await startServer(
    async (request, response) => {
      internalAuthorization = request.headers.authorization;
      for await (const _chunk of request) {}
      sse(response, [
        { type: "response.created", response: { id: "resp-direct" } },
        { type: "response.completed", response: { id: "resp-direct", usage: {} } },
      ]);
    },
    {
      authenticateUpgrade(request, requestUrl) {
        return request.headers.authorization === "Bearer direct-caller" &&
          requestUrl.pathname === "/v1/responses"
          ? requestUrl.pathname
          : undefined;
      },
      internalAuthorization: "Bearer internal-loopback-caller",
    },
  );
  t.after(() => server.close());

  const denied = await connect(port, { path: "/v1/responses" });
  assert.match(denied.head, /^HTTP\/1\.1 401 /);
  denied.socket.destroy();

  const accepted = await connect(port, {
    path: "/v1/responses",
    headers: { Authorization: "Bearer direct-caller" },
  });
  assert.match(accepted.head, /^HTTP\/1\.1 101 /);
  accepted.peer.sendJson(createRequest());
  assert.equal((await accepted.peer.nextJson()).type, "response.created");
  assert.equal((await accepted.peer.nextJson()).type, "response.completed");
  assert.equal(internalAuthorization, "Bearer internal-loopback-caller");
  accepted.peer.close();
});

test("relays canonical per-request metadata through HTTP and never forwards the caller capability", async (t) => {
  const bodies = [];
  const authorizations = [];
  const betaHeaders = [];
  const requestHeaders = [];
  const { server, port } = await startServer(async (request, response) => {
    authorizations.push(request.headers.authorization);
    betaHeaders.push(request.headers["openai-beta"]);
    requestHeaders.push(request.headers);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const events = [
      { type: "response.created", response: { id: "resp-full" } },
      {
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      },
      { type: "response.completed", response: { id: "resp-full", usage: {} } },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    const wire = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
    // Split in the middle of both an SSE field and a multi-byte-capable JSON
    // text decoder boundary; chunk boundaries are not event boundaries.
    response.write(wire.slice(0, 17));
    response.write(wire.slice(17, 103));
    response.end(wire.slice(103));
  });
  t.after(() => server.close());
  const { head, peer } = await connect(port, {
    headers: { Authorization: `Bearer ${CALLER_KEY}` },
  });
  assert.match(head, /^HTTP\/1\.1 101 Switching Protocols/);
  const turnMetadata = JSON.stringify({ request_kind: "turn", turn_id: "turn-paid" });
  peer.sendJson(createRequest({
    client_metadata: {
      "x-codex-turn-metadata": turnMetadata,
      "x-codex-turn-state": "turn-state-paid",
      "x-codex-window-id": "window-paid",
      ws_request_header_traceparent:
        "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      ws_request_header_tracestate: "vendor=value",
      ws_request_header_x_openai_internal_codex_responses_lite: "true",
      "x-codex-ws-stream-request-start-ms": "1234",
    },
  }));
  assert.equal((await peer.nextJson()).type, "response.created");
  assert.equal((await peer.nextJson()).type, "response.output_item.done");
  assert.equal((await peer.nextJson()).type, "response.completed");
  assert.equal(authorizations[0], undefined);
  assert.equal(betaHeaders[0], undefined, "the edge-only WebSocket beta must stop at the edge");
  assert.equal(bodies[0].type, undefined);
  assert.equal(bodies[0].previous_response_id, undefined);
  assert.deepEqual(bodies[0].client_metadata, {
    "x-codex-turn-metadata": turnMetadata,
    "x-codex-turn-state": "turn-state-paid",
    "x-codex-window-id": "window-paid",
  });
  assert.equal(requestHeaders[0]["x-codex-turn-metadata"], turnMetadata);
  assert.equal(requestHeaders[0]["x-codex-turn-state"], "turn-state-paid");
  assert.equal(requestHeaders[0]["x-codex-window-id"], "window-paid");
  assert.equal(
    requestHeaders[0].traceparent,
    "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
  );
  assert.equal(requestHeaders[0].tracestate, "vendor=value");
  assert.equal(requestHeaders[0]["x-openai-internal-codex-responses-lite"], "true");
  assert.equal(
    bodies[0].client_metadata.ws_request_header_x_openai_internal_codex_responses_lite,
    undefined,
  );
  assert.deepEqual(bodies[0].input, createRequest().input);

  peer.sendFrame(0x9, "ping");
  const pong = await peer.nextFrame();
  assert.equal(pong.opcode, 0xa);
  assert.equal(pong.payload.toString(), "ping");
  peer.close();

  const upstreamAuth = await connect(port, {
    headers: { Authorization: "Bearer real-upstream-session" },
  });
  upstreamAuth.peer.sendJson(createRequest());
  assert.equal((await upstreamAuth.peer.nextJson()).type, "response.created");
  assert.equal((await upstreamAuth.peer.nextJson()).type, "response.output_item.done");
  assert.equal((await upstreamAuth.peer.nextJson()).type, "response.completed");
  assert.equal(authorizations[1], "Bearer real-upstream-session");
  upstreamAuth.peer.close();
});

test("prewarms locally and reconstructs incremental turns without losing history", async (t) => {
  const bodies = [];
  const requestHeaders = [];
  const assistant = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "shell",
    arguments: "{}",
  };
  const { server, port } = await startServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    bodies.push(body);
    requestHeaders.push(request.headers);
    const id = bodies.length === 1 ? "resp-one" : "resp-two";
    if (bodies.length === 1) response.setHeader("x-codex-turn-state", "sticky-turn-one");
    sse(response, [
      { type: "response.created", response: { id } },
      ...(bodies.length === 1 ? [{ type: "response.output_item.done", item: assistant }] : []),
      { type: "response.completed", response: { id, usage: {} } },
    ]);
  });
  t.after(() => server.close());
  const staleTurnMetadata = JSON.stringify({ request_kind: "prewarm", turn_id: "turn-stale" });
  const { peer } = await connect(port, {
    headers: {
      "X-Codex-Turn-Metadata": staleTurnMetadata,
      "X-Codex-Turn-State": "stale-handshake-state",
      Traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      Tracestate: "stale=value",
    },
  });
  peer.sendJson(createRequest({ previous_response_id: "resp-missing", input: [] }));
  const missing = await peer.nextJson();
  assert.equal(missing.type, "error");
  assert.equal(missing.error.code, "previous_response_not_found");

  const initial = createRequest({ generate: false });
  peer.sendJson(initial);
  assert.equal((await peer.nextJson()).type, "response.created");
  const prewarm = await peer.nextJson();
  assert.equal(prewarm.type, "response.completed");
  assert.equal(bodies.length, 0, "generate=false must not spend a provider request");

  const paidTurnMetadata = JSON.stringify({ request_kind: "turn", turn_id: "turn-current" });
  peer.sendJson(createRequest({
    previous_response_id: prewarm.response.id,
    input: [],
    client_metadata: {
      "x-codex-turn-metadata": paidTurnMetadata,
      ws_request_header_traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      ws_request_header_tracestate: "current=value",
    },
  }));
  const responseMetadata = await peer.nextJson();
  assert.equal(responseMetadata.type, "response.metadata");
  assert.equal(responseMetadata.headers["x-codex-turn-state"], "sticky-turn-one");
  assert.equal((await peer.nextJson()).type, "response.created");
  assert.equal((await peer.nextJson()).type, "response.output_item.done");
  assert.equal((await peer.nextJson()).type, "response.completed");
  assert.deepEqual(bodies[0].input, initial.input);
  assert.equal(
    requestHeaders[0].traceparent,
    "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
  );
  assert.equal(requestHeaders[0].tracestate, "current=value");
  assert.equal(requestHeaders[0]["x-codex-turn-metadata"], paidTurnMetadata);
  assert.equal(requestHeaders[0]["x-codex-turn-state"], undefined);
  assert.equal(bodies[0].client_metadata["x-codex-turn-metadata"], paidTurnMetadata);
  assert.equal(bodies[0].client_metadata.ws_request_header_traceparent, undefined);

  const toolResult = { type: "function_call_output", call_id: "call_1", output: "done" };
  peer.sendJson(createRequest({
    previous_response_id: "resp-one",
    input: [toolResult],
    client_metadata: {
      "x-codex-turn-metadata": paidTurnMetadata,
      "x-codex-turn-state": "sticky-turn-one",
    },
  }));
  assert.equal((await peer.nextJson()).type, "response.created");
  assert.equal((await peer.nextJson()).type, "response.completed");
  assert.deepEqual(bodies[1].input, [...initial.input, assistant, toolResult]);
  assert.equal(requestHeaders[1]["x-codex-turn-state"], "sticky-turn-one");
  peer.close();
});

test("wraps HTTP failures and serializes requests on a reused connection", async (t) => {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const { server, port } = await startServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the body before answering, like the real HTTP route.
    }
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (calls === 1) {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "7",
      });
      response.end(JSON.stringify({ error: { type: "usage_limit", message: "limit" } }));
    } else {
      sse(response, [
        { type: "response.created", response: { id: `resp-${calls}` } },
        { type: "response.completed", response: { id: `resp-${calls}`, usage: {} } },
      ]);
    }
    active -= 1;
  });
  t.after(() => server.close());
  const { peer } = await connect(port);
  peer.sendJson(createRequest({ input: [{ type: "message", role: "user", content: "one" }] }));
  peer.sendJson(createRequest({ input: [{ type: "message", role: "user", content: "two" }] }));
  const error = await peer.nextJson();
  assert.equal(error.type, "error");
  assert.equal(error.status, 429);
  assert.equal(error.error.type, "usage_limit");
  assert.equal(error.headers["retry-after"], "7");
  assert.equal((await peer.nextJson()).type, "response.created");
  assert.equal((await peer.nextJson()).type, "response.completed");
  assert.equal(maximumActive, 1);
  peer.close();
});

test("projects successful HTTP response headers into official Codex metadata events", async (t) => {
  const { server, port } = await startServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.setHeader("openai-model", "gpt-server-selected");
    response.setHeader("x-codex-turn-state", "turn-state-1");
    response.setHeader("x-models-etag", "models-etag-1");
    response.setHeader("x-reasoning-included", "true");
    response.setHeader("x-private-header", "must-not-cross");
    sse(response, [
      { type: "response.created", response: { id: "resp-headers" } },
      { type: "response.completed", response: { id: "resp-headers", usage: {} } },
    ]);
  });
  t.after(() => server.close());

  const { peer } = await connect(port);
  peer.sendJson(createRequest({
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn-headers" }),
    },
  }));
  const responseMetadata = await peer.nextJson();
  assert.deepEqual(responseMetadata, {
    type: "response.metadata",
    headers: {
      "openai-model": "gpt-server-selected",
      "x-codex-turn-state": "turn-state-1",
      "x-models-etag": "models-etag-1",
      "x-reasoning-included": "true",
    },
  });
  assert.deepEqual(await peer.nextJson(), {
    type: "codex.response.metadata",
    headers: { "x-models-etag": "models-etag-1" },
  });
  assert.equal((await peer.nextJson()).type, "response.created");
  assert.equal((await peer.nextJson()).type, "response.completed");
  peer.close();
});

test("drops oversized continuation state so Codex retries the full request", async (t) => {
  let calls = 0;
  const { server, port } = await startServer(
    async (request, response) => {
      for await (const _chunk of request) {}
      calls += 1;
      sse(response, [
        { type: "response.created", response: { id: "resp-large-state" } },
        {
          type: "response.output_item.done",
          item: { type: "message", role: "assistant", content: "a".repeat(300) },
        },
        {
          type: "response.output_item.done",
          item: { type: "message", role: "assistant", content: "b".repeat(300) },
        },
        { type: "response.completed", response: { id: "resp-large-state", usage: {} } },
      ]);
    },
    { maxContinuationBytes: 512 },
  );
  t.after(() => server.close());

  const { peer } = await connect(port);
  peer.sendJson(createRequest());
  assert.equal((await peer.nextJson()).type, "response.created");
  assert.equal((await peer.nextJson()).type, "response.output_item.done");
  assert.equal((await peer.nextJson()).type, "response.output_item.done");
  assert.equal((await peer.nextJson()).type, "response.completed");
  peer.sendJson(createRequest({ previous_response_id: "resp-large-state", input: [] }));
  const retry = await peer.nextJson();
  assert.equal(retry.type, "error");
  assert.equal(retry.status, 409);
  assert.equal(retry.error.code, "previous_response_not_found");
  assert.equal(calls, 1, "the missing baseline must fail before another provider request");
  peer.close();
});

test("turns malformed internal SSE into a bounded WebSocket error", async (t) => {
  const { server, port } = await startServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: definitely-not-json\n\n");
  });
  t.after(() => server.close());
  const { peer } = await connect(port);
  peer.sendJson(createRequest());
  const error = await peer.nextJson();
  assert.equal(error.type, "error");
  assert.equal(error.status, 502);
  assert.equal(error.error.type, "ERR_RESPONSES_WS_INVALID_SSE");
  peer.close();
});

test("accepts fragmented text and closes on unmasked or oversized frames", async (t) => {
  const { server, port } = await startServer(
    async (request, response) => {
      for await (const _chunk of request) {}
      sse(response, [
        { type: "response.created", response: { id: "resp-fragment" } },
        { type: "response.completed", response: { id: "resp-fragment", usage: {} } },
      ]);
    },
    { maxMessageBytes: 1_024, maxFragmentFrames: 3 },
  );
  t.after(() => server.close());

  const fragmented = await connect(port);
  const text = JSON.stringify(createRequest());
  const split = Math.floor(text.length / 2);
  fragmented.peer.sendFrame(0x1, text.slice(0, split), { fin: false });
  fragmented.peer.sendFrame(0x9, "still-here");
  assert.equal((await fragmented.peer.nextFrame()).opcode, 0xa);
  fragmented.peer.sendFrame(0x0, text.slice(split));
  assert.equal((await fragmented.peer.nextJson()).type, "response.created");
  assert.equal((await fragmented.peer.nextJson()).type, "response.completed");
  fragmented.peer.close();

  const unmasked = await connect(port);
  unmasked.socket.write(unmaskedFrame(0x1, "{}"));
  const protocolClose = await unmasked.peer.nextFrame();
  assert.equal(protocolClose.opcode, 0x8);
  assert.equal(protocolClose.payload.readUInt16BE(0), 1002);

  const oversized = await connect(port);
  oversized.socket.write(maskedFrame(0x1, Buffer.alloc(0), { declaredLength: 1_025 }));
  const sizeClose = await oversized.peer.nextFrame();
  assert.equal(sizeClose.opcode, 0x8);
  assert.equal(sizeClose.payload.readUInt16BE(0), 1009);

  const fragmentFlood = await connect(port);
  fragmentFlood.peer.sendFrame(0x1, "", { fin: false });
  fragmentFlood.peer.sendFrame(0x0, "", { fin: false });
  fragmentFlood.peer.sendFrame(0x0, "", { fin: false });
  fragmentFlood.peer.sendFrame(0x0, "", { fin: false });
  const fragmentClose = await fragmentFlood.peer.nextFrame();
  assert.equal(fragmentClose.opcode, 0x8);
  assert.equal(fragmentClose.payload.readUInt16BE(0), 1009);
});

test("aborts the internal HTTP request when the WebSocket disappears", async (t) => {
  let requestStarted = false;
  let requestAborted = false;
  const { server, port } = await startServer(async (request, response) => {
    requestStarted = true;
    request.once("aborted", () => {
      requestAborted = true;
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "held" } })}\n\n`);
    await new Promise((resolve) => request.once("close", resolve));
  });
  t.after(() => server.close());
  const { peer, socket } = await connect(port);
  peer.sendJson(createRequest());
  assert.equal((await peer.nextJson()).type, "response.created");
  await waitFor(() => requestStarted);
  socket.destroy();
  await waitFor(() => requestAborted);
});
