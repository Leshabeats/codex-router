import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { PROVIDER_CATALOG_CACHE_PATH } from "./paths.mjs";

// Asking a provider what it serves is a network round trip against a live
// credential, and the answer barely moves between releases. Re-asking it every
// time somebody opens a provider row is what made the Control Center feel like
// it reloads the world before it can add a single model. The answer is cached
// here so the list is present the moment a provider is opened, and a refresh
// stays an explicit choice rather than the price of looking.
//
// Only the provider's own published list is stored. Which of those models are
// registered locally is always recomputed from the live registry, so a cached
// list can never claim a model is curated when it is not.

const CACHE_VERSION = 1;
// How long a stored list is trusted without question. Past it the list is
// still served -- it is the only answer available offline, and it is almost
// always still right -- but it is marked stale so the surfaces that show it can
// re-ask in the background. Without this a provider that shipped a new model
// would never surface it until somebody thought to press Reload.
export const CATALOG_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDERS = 80;
const MAX_MODELS = 4000;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

function readCacheDocument() {
  if (!existsSync(PROVIDER_CATALOG_CACHE_PATH)) return { version: CACHE_VERSION, providers: {} };
  try {
    if (statSync(PROVIDER_CATALOG_CACHE_PATH).size > MAX_FILE_BYTES) {
      return { version: CACHE_VERSION, providers: {} };
    }
    const parsed = JSON.parse(readFileSync(PROVIDER_CATALOG_CACHE_PATH, "utf8"));
    if (parsed?.version !== CACHE_VERSION || !parsed.providers || typeof parsed.providers !== "object") {
      return { version: CACHE_VERSION, providers: {} };
    }
    return { version: CACHE_VERSION, providers: { ...parsed.providers } };
  } catch {
    // A cache is never the authority on anything. An unreadable or foreign
    // document is treated as a miss so the next read goes to the provider.
    return { version: CACHE_VERSION, providers: {} };
  }
}

function stringList(value, limit = MAX_MODELS) {
  if (!Array.isArray(value)) return undefined;
  const kept = value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim())
    .slice(0, limit);
  return [...new Set(kept)];
}

function contextMap(value, allowed) {
  if (!value || typeof value !== "object") return undefined;
  const lengths = {};
  for (const [id, length] of Object.entries(value)) {
    if (!allowed.has(id)) continue;
    const numeric = Number(length);
    if (Number.isInteger(numeric) && numeric > 0) lengths[id] = numeric;
  }
  return Object.keys(lengths).length ? lengths : undefined;
}

function normalizedEntry(entry) {
  if (!entry || typeof entry !== "object") return undefined;
  const discovered = stringList(entry.discovered);
  if (!discovered?.length) return undefined;
  const fetchedAt = typeof entry.fetchedAt === "string" && entry.fetchedAt.trim()
    ? entry.fetchedAt
    : undefined;
  if (!fetchedAt) return undefined;
  const known = new Set(discovered);
  const free = stringList(entry.free)?.filter((id) => known.has(id));
  return {
    fetchedAt,
    discovered,
    ...(free?.length ? { free } : {}),
    ...(contextMap(entry.contextLengths, known) ? { contextLengths: contextMap(entry.contextLengths, known) } : {}),
  };
}

/**
 * Whether a stored list is old enough that it should be re-read in the
 * background. An unparseable timestamp counts as stale: a list whose age
 * cannot be established is not one to keep trusting indefinitely.
 */
export function catalogEntryIsStale(fetchedAt, now = Date.now()) {
  const stamped = Date.parse(String(fetchedAt || ""));
  if (!Number.isFinite(stamped)) return true;
  return now - stamped >= CATALOG_STALE_AFTER_MS;
}

/** The provider's last known published model list, or undefined on a miss. */
export function readProviderCatalogCache(providerId) {
  if (!PROVIDER_ID.test(String(providerId || ""))) return undefined;
  const entry = normalizedEntry(readCacheDocument().providers[providerId]);
  // Age is derived from the timestamp on every read, never stored: a document
  // that carried its own staleness would be answering a question about a
  // moment that has already passed.
  return entry ? { ...entry, stale: catalogEntryIsStale(entry.fetchedAt) } : undefined;
}

/**
 * Record what a provider just published. `fetchedAt` is supplied by the caller
 * so a discovery run and its cache entry cannot disagree about when the list
 * was seen.
 */
export function writeProviderCatalogCache(providerId, { discovered, free, contextLengths, fetchedAt } = {}) {
  if (!PROVIDER_ID.test(String(providerId || ""))) return undefined;
  const entry = normalizedEntry({
    discovered,
    free,
    contextLengths,
    fetchedAt: fetchedAt || new Date().toISOString(),
  });
  if (!entry) return undefined;
  const document = readCacheDocument();
  const providers = { ...document.providers, [providerId]: entry };
  // Bound the document so a long-lived installation that has touched many
  // providers cannot grow it without limit. The oldest entries are the ones
  // whose provider has not been opened in the longest time.
  const ordered = Object.entries(providers)
    .sort(([, left], [, right]) => String(right.fetchedAt).localeCompare(String(left.fetchedAt)))
    .slice(0, MAX_PROVIDERS);
  writePrivateJson(
    PROVIDER_CATALOG_CACHE_PATH,
    { version: CACHE_VERSION, providers: Object.fromEntries(ordered) },
    { directoryMode: 0o700 },
  );
  return entry;
}

/** Drop one provider's cached list, for example after its credential changes. */
export function forgetProviderCatalogCache(providerId) {
  if (!PROVIDER_ID.test(String(providerId || ""))) return false;
  const document = readCacheDocument();
  if (!(providerId in document.providers)) return false;
  delete document.providers[providerId];
  writePrivateJson(PROVIDER_CATALOG_CACHE_PATH, document, { directoryMode: 0o700 });
  return true;
}

export const PROVIDER_CATALOG_CACHE_FILE = path.basename(PROVIDER_CATALOG_CACHE_PATH);
