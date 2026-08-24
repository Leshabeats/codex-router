import { PORTS } from "./paths.mjs";

// Client exports are deliberately descriptors, not rendered target files.  A
// descriptor is safe to hand to a client-specific adapter later: it names the
// loopback capability and model metadata without copying provider credentials.
export const CLIENT_EXPORT_SCHEMA_VERSION = 1;

export const CLIENT_EXPORT_CLIENTS = Object.freeze([
  "openai-compatible",
  "opencode",
  "deepseek-harness",
]);

const CAPABILITY_NAMES = Object.freeze([
  "responses",
  "chat",
  "completions",
  "tools",
  "parallelTools",
  "vision",
  "webSearch",
  "streaming",
]);

const ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,199}$/i;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
// Export metadata is copied into client-facing files.  Keep the descriptor
// deliberately text-only, but reject fields that are normally used to carry a
// secret instead of silently serializing them.
const SENSITIVE_METADATA_KEY =
  /(?:api[-_]?key|authorization|bearer|caller[-_]?key|cookie|credential|password|private[-_]?key|secret|token)/i;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function invalid(message) {
  throw new Error(`Invalid client export: ${message}`);
}

function normalizeClient(value) {
  const client = text(value).toLowerCase();
  if (!CLIENT_EXPORT_CLIENTS.includes(client)) {
    invalid(`client must be one of: ${CLIENT_EXPORT_CLIENTS.join(", ")}.`);
  }
  return client;
}

function normalizeSecretEnv(value) {
  const name = text(value) || "CODEX_ROUTER_CALLER_KEY";
  if (!ENV_PATTERN.test(name)) {
    invalid("secretEnv must be an environment variable name.");
  }
  return name;
}

function validateBaseUrl(value) {
  const baseUrl = text(value);
  if (!baseUrl) invalid("baseUrl is required.");
  // URL escapes braces in an env placeholder.  Validate a temporary URL while
  // retaining the original template for clients that perform interpolation.
  const candidate = baseUrl.replace(/\$\{[A-Z][A-Z0-9_]{0,127}\}/g, "router-secret");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    invalid("baseUrl must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    invalid("baseUrl must use HTTP(S) and must not contain credentials.");
  }
  if (parsed.search || parsed.hash) invalid("baseUrl must not contain a query or fragment.");
  // A generated export may contain an environment placeholder, but a literal
  // caller capability would be a secret leak.  Require callers to use
  // secretEnv instead of pasting the token into an export.
  const callerSegment = baseUrl.match(/\/_codex-router\/([^/]+)\//i)?.[1];
  if (callerSegment && !/^\$\{[A-Z][A-Z0-9_]{0,127}\}$/.test(callerSegment)) {
    invalid("baseUrl must reference the caller key through an environment placeholder.");
  }
  return baseUrl.replace(/\/+$/, "");
}

function defaultBaseUrl(secretEnv) {
  return `http://127.0.0.1:${PORTS.router}/_codex-router/\${${secretEnv}}/v1`;
}

function normalizeCapabilities(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("capabilities must be an object of booleans.");
  }
  const capabilities = {};
  for (const [name, enabled] of Object.entries(value)) {
    if (!CAPABILITY_NAMES.includes(name)) invalid(`unknown capability ${name}.`);
    if (typeof enabled !== "boolean") invalid(`capability ${name} must be boolean.`);
    capabilities[name] = enabled;
  }
  return capabilities;
}

function normalizeModels(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid("models must be an array.");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalid(`models[${index}] must be an object.`);
    }
    const id = text(entry.id || entry.slug);
    if (!ID_PATTERN.test(id)) invalid(`models[${index}].id is invalid.`);
    const alias = text(entry.alias || entry.name || id);
    if (!alias || alias.length > 200) invalid(`models[${index}].alias is invalid.`);
    const model = { id, alias };
    const description = text(entry.description);
    if (description) model.description = description.slice(0, 240);
    if (entry.capabilities !== undefined) {
      model.capabilities = normalizeCapabilities(entry.capabilities);
    }
    return model;
  });
}

/**
 * Build a versioned, provider-agnostic client export descriptor.
 *
 * `secretEnv` is a reference only.  The generated endpoint contains an env
 * placeholder and never the caller capability or an upstream provider key.
 */
export function buildClientExport({
  client = "openai-compatible",
  baseUrl,
  secretEnv,
  models,
  capabilities,
  metadata,
} = {}) {
  const normalizedClient = normalizeClient(client);
  const normalizedSecretEnv = normalizeSecretEnv(secretEnv);
  const endpoint = baseUrl ? validateBaseUrl(baseUrl) : defaultBaseUrl(normalizedSecretEnv);
  const result = {
    schemaVersion: CLIENT_EXPORT_SCHEMA_VERSION,
    client: normalizedClient,
    gateway: {
      baseUrl: endpoint,
      protocol: "openai-compatible",
      auth: {
        type: "path-capability",
        secretRef: { type: "environment", name: normalizedSecretEnv },
      },
    },
    models: normalizeModels(models),
    capabilities: normalizeCapabilities(capabilities),
  };
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      invalid("metadata must be an object.");
    }
    // Keep metadata intentionally shallow and text-only.  This makes it safe
    // for adapters to copy labels without accidentally carrying credentials.
    result.metadata = Object.fromEntries(
      Object.entries(metadata)
        .filter(([key, value]) => {
          if (SENSITIVE_METADATA_KEY.test(key)) {
            invalid(`metadata.${key} cannot contain a secret; use secretEnv instead.`);
          }
          return /^[a-z][a-zA-Z0-9_.-]{0,63}$/.test(key) && typeof value === "string";
        })
        .map(([key, value]) => [key, value.slice(0, 240)]),
    );
  }
  return result;
}

export function renderClientExport(options = {}) {
  return `${JSON.stringify(buildClientExport(options), null, 2)}\n`;
}
