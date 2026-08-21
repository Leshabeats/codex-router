import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

import { environmentHttpProxyConfigured } from "./proxy-environment.mjs";
import { KEEPALIVE_TIMEOUT_MS } from "./http-utils.mjs";

// Node 26's bundled fetch negotiates HTTP/2 by default. A live router process
// observed its pooled session remain destroyed after ERR_HTTP2_INVALID_SESSION,
// so every later native Codex request failed until launchd restarted the whole
// service. Codex uses streaming Responses over ordinary HTTPS and does not
// require HTTP/2; an HTTP/1.1-only dispatcher removes that poisoned-session
// state while retaining keep-alive connection reuse.
//
// Concurrent Codex turns (parent plus subagents) each hold one HTTP/1.1
// streaming socket for the whole generation. Undici's default of 10
// connections per origin plus a shared pool for loopback health probes
// starves `/health` and the next turn: the probe waits for a free socket
// that a long SSE response is sitting on, the tray reports Starting, and
// Codex surfaces "waiting for network". Size the pool for several parallel
// sessions, and keep idle sockets as long as the router server does so
// Codex's 90s client pool is not handed a dead connection.
export const FETCH_CONNECTIONS_PER_ORIGIN = 32;

export function fetchDispatcherOptions() {
  return {
    allowH2: false,
    connections: FETCH_CONNECTIONS_PER_ORIGIN,
    pipelining: 1,
    keepAliveTimeout: KEEPALIVE_TIMEOUT_MS,
  };
}

export function installStableFetchTransport({
  AgentClass = Agent,
  EnvHttpProxyAgentClass = EnvHttpProxyAgent,
  setDispatcher = setGlobalDispatcher,
  environment = process.env,
  execArgv = process.execArgv,
} = {}) {
  const DispatcherClass = environmentHttpProxyConfigured(environment, execArgv)
    ? EnvHttpProxyAgentClass
    : AgentClass;
  const dispatcher = new DispatcherClass(fetchDispatcherOptions());
  setDispatcher(dispatcher);
  return dispatcher;
}

// Health probes must not share the streaming pool. A GET /health/liveliness
// that queues behind five SSE POSTs to the same origin is what made the
// unauthenticated `/health` leaf hang long enough for doctor and the tray
// to call the router dead.
export function createLoopbackProbeDispatcher({
  AgentClass = Agent,
  timeoutMs = 3_000,
} = {}) {
  return new AgentClass({
    allowH2: false,
    connections: 8,
    pipelining: 1,
    connect: { timeout: Math.min(1_000, timeoutMs) },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    keepAliveTimeout: 10_000,
  });
}
