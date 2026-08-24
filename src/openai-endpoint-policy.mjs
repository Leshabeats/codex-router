// OpenAI-compatible endpoint policy.
//
// A provider can expose several HTTP surfaces, but a model must opt into each
// one explicitly. Keeping this list data-driven prevents a chat model from
// accidentally receiving an embeddings or media request merely because the
// upstream happens to share a base URL.

export const OPENAI_ENDPOINTS = Object.freeze([
  "/chat/completions",
  "/responses",
  "/completions",
  "/embeddings",
  "/moderations",
  "/images/generations",
  "/audio/speech",
  "/batches",
]);

const ENDPOINTS = new Set(OPENAI_ENDPOINTS);

export function normalizeSupportedEndpoints(value, { field = "supportedEndpoints" } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array.`);
  }
  const result = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !ENDPOINTS.has(entry)) {
      throw new Error(`${field} contains an unsupported endpoint.`);
    }
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

export function protocolEndpoint(adapter) {
  if (adapter === "openai-responses" || adapter === "responses") return "/responses";
  if (adapter === "openai-completions" || adapter === "completions") return "/completions";
  return "/chat/completions";
}

export function adapterForEndpoint(route, adapter) {
  return route === "/completions" ? "openai-completions" : adapter;
}

/**
 * Return whether a model may receive this endpoint.
 *
 * An explicit model or provider declaration is authoritative. Without one,
 * only the adapter's native protocol route is allowed; no extra endpoint is
 * inferred from a provider name or a shared base URL.
 */
export function supportsOpenAIEndpoint(route, { adapter, model, provider } = {}) {
  if (!ENDPOINTS.has(route)) return false;
  const declared = model?.supportedEndpoints ?? provider?.supportedEndpoints;
  if (declared !== undefined) {
    const normalized = normalizeSupportedEndpoints(declared);
    return normalized.includes(route);
  }
  return route === protocolEndpoint(adapter);
}

export function endpointCapabilityError(route, model) {
  const label = model?.displayName || model?.gatewayModel || model?.slug || "model";
  const error = new Error(`${label} does not support ${route}.`);
  error.status = 400;
  error.code = "unsupported_model_endpoint";
  return error;
}
