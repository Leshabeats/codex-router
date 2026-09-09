// Bounded request diagnostics for usage events. Counts, billing, routes, and
// retries stay in usage-events.mjs; this module only names a request and the
// Grok OAuth 4.6 ingress byte split. It never stores headers, bodies, thread
// titles, or paths.
//
// The request ID is created by the /activity observer and includes its process
// instance ID, so a service restart cannot accidentally join unrelated requests.

export const ROUTER_INGRESS_OBSERVATION_POINT = "router_ingress";
export const GROK_OAUTH_46_SLUG = "grok-oauth/grok-4.6";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/;
const MAX_CONTEXT_FIELD_BYTES = 1024 * 1024 * 1024;

export function safeDiagnosticRequestId(value) {
  if (typeof value !== "string") {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      value = String(value);
    } else {
      return undefined;
    }
  }
  const text = value.trim();
  return REQUEST_ID_PATTERN.test(text) ? text : undefined;
}

function safeByteCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.min(MAX_CONTEXT_FIELD_BYTES, Math.round(number));
}

export function utf8JsonBytes(value) {
  if (value === undefined) return 0;
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") return 0;
    return Buffer.byteLength(encoded, "utf8");
  } catch {
    return 0;
  }
}

export function measureIngressContextBytes(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  return {
    observationPoint: ROUTER_INGRESS_OBSERVATION_POINT,
    instructionsBytes: utf8JsonBytes(payload.instructions),
    toolsBytes: utf8JsonBytes(payload.tools),
    historyBytes: utf8JsonBytes(payload.input),
  };
}

export function grokOauth46IngressContextBytes(payload, route) {
  if (route?.slug !== GROK_OAUTH_46_SLUG) return undefined;
  return measureIngressContextBytes(payload);
}

export function sanitizeContextBytes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.observationPoint !== ROUTER_INGRESS_OBSERVATION_POINT) return undefined;
  return {
    observationPoint: ROUTER_INGRESS_OBSERVATION_POINT,
    instructionsBytes: safeByteCount(value.instructionsBytes) ?? 0,
    toolsBytes: safeByteCount(value.toolsBytes) ?? 0,
    historyBytes: safeByteCount(value.historyBytes) ?? 0,
  };
}

export function usageDiagnosticMetadata({ requestId, contextBytes } = {}) {
  const safeRequestId = safeDiagnosticRequestId(requestId);
  const safeContextBytes = sanitizeContextBytes(contextBytes);
  return {
    ...(safeRequestId ? { requestId: safeRequestId } : {}),
    ...(safeContextBytes ? { contextBytes: safeContextBytes } : {}),
  };
}
