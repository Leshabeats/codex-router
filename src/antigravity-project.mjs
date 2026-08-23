import { createHash } from "node:crypto";

import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_PROD_ENDPOINT,
  antigravityBootstrapHeaders,
  antigravityLoadCodeAssistMetadata,
} from "./antigravity-oauth-constants.mjs";
import { updateAntigravityToken } from "./antigravity-oauth-session.mjs";

const PROJECT_CACHE_TTL_MS = 30 * 60_000;
const projectCache = new Map();
const projectPending = new Map();
const projectKeyGenerations = new Map();
let projectCacheGeneration = 0;

// Bound a single request path so discovery cannot block on the two upstream
// endpoints indefinitely: one request approves at most one hit per endpoint.
export const DEFAULT_ATTEMPTS = 2;
export const DEFAULT_RETRY_DELAY_MS = 1_000;

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("aborted"));
    };
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function combinedSignal(parentSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) return timeout;
  return AbortSignal.any([parentSignal, timeout]);
}

function projectUnavailable(message, { code = "project_required", status = 502 } = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function projectIdFrom(payload) {
  const project = payload?.cloudaicompanionProject;
  if (typeof project === "string" && project) return project;
  if (project && typeof project.id === "string" && project.id) return project.id;
  return undefined;
}

function tierIdFrom(payload) {
  return typeof payload?.currentTier?.id === "string" && payload.currentTier.id
    ? payload.currentTier.id
    : undefined;
}

function defaultTierId(allowedTiers) {
  if (!Array.isArray(allowedTiers)) return "free-tier";
  const selected = allowedTiers.find(
    (tier) => tier?.isDefault && typeof tier.id === "string" && tier.id,
  ) || allowedTiers.find((tier) => typeof tier?.id === "string" && tier.id);
  return selected?.id || "free-tier";
}

function projectCacheKey(refreshToken) {
  return createHash("sha256").update(refreshToken).digest("hex");
}

function projectGeneration(key) {
  return {
    global: projectCacheGeneration,
    key: projectKeyGenerations.get(key) || 0,
  };
}

function generationIsCurrent(key, generation) {
  return (
    generation.global === projectCacheGeneration &&
    generation.key === (projectKeyGenerations.get(key) || 0)
  );
}

export function invalidateAntigravityProjectCache(refreshToken) {
  if (!refreshToken) {
    projectCacheGeneration += 1;
    projectKeyGenerations.clear();
    projectCache.clear();
    projectPending.clear();
    return;
  }
  const key = projectCacheKey(refreshToken);
  projectKeyGenerations.set(key, (projectKeyGenerations.get(key) || 0) + 1);
  projectCache.delete(key);
  projectPending.delete(key);
}

export async function loadAntigravityProject(
  accessToken,
  { fetchImpl = fetch, timeoutMs = 15_000, signal } = {},
) {
  const headers = antigravityBootstrapHeaders(accessToken);
  const body = JSON.stringify({ metadata: antigravityLoadCodeAssistMetadata() });
  for (const base of [...new Set([ANTIGRAVITY_ENDPOINT, ANTIGRAVITY_PROD_ENDPOINT])]) {
    try {
      const response = await fetchImpl(`${base}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body,
        signal: combinedSignal(signal, timeoutMs),
      });
      if (!response.ok) continue;
      const payload = await response.json();
      if (payload && typeof payload === "object") return payload;
    } catch {
      if (signal?.aborted) throw signal.reason || new Error("aborted");
      // Daily and production discovery are independent rollout surfaces.
    }
  }
  return null;
}

export async function onboardAntigravityProject(
  accessToken,
  tierId,
  {
    fetchImpl = fetch,
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    delayImpl = abortableDelay,
    timeoutMs = 15_000,
    signal,
  } = {},
) {
  const body = JSON.stringify({ tierId });
  for (const base of [...new Set([ANTIGRAVITY_PROD_ENDPOINT, ANTIGRAVITY_ENDPOINT])]) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchImpl(`${base}/v1internal:onboardUser`, {
          method: "POST",
          headers: antigravityBootstrapHeaders(accessToken),
          body,
          signal: combinedSignal(signal, timeoutMs),
        });
        if (!response.ok) break;
        const payload = await response.json().catch(() => ({}));
        const projectId = projectIdFrom(payload?.response);
        if (payload?.done && projectId) return projectId;
      } catch {
        if (signal?.aborted) throw signal.reason || new Error("aborted");
        break;
      }
      if (attempt < attempts - 1) {
        await delayImpl(retryDelayMs, signal);
      }
    }
  }
  return undefined;
}

export async function discoverAntigravityProject(
  accessToken,
  {
    fetchImpl = fetch,
    now = Date.now,
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    delayImpl = abortableDelay,
    timeoutMs = 15_000,
    signal,
    allowOnboard = false,
  } = {},
) {
  const payload = await loadAntigravityProject(accessToken, { fetchImpl, timeoutMs, signal });
  const capturedTierId = tierIdFrom(payload);
  const managedProjectId = projectIdFrom(payload);
  if (managedProjectId) {
    return {
      projectId: managedProjectId,
      source: "managed",
      tierId: capturedTierId,
      checkedAt: now(),
    };
  }

  // Provisioning creates a Google Cloud project under the signed-in account,
  // so it is a sign-in-time action gated by explicit consent. The request path
  // never provisions implicitly; if no managed project is discoverable there,
  // fail with a clear message rather than routing through a foreign project.
  if (!allowOnboard) {
    throw projectUnavailable(
      "Antigravity could not discover a Google Cloud project. Check Google connectivity and try again; sign-in can provision a project when none exists.",
    );
  }

  const selectedTierId = defaultTierId(payload?.allowedTiers);
  const provisionedProjectId = await onboardAntigravityProject(
    accessToken,
    selectedTierId,
    { fetchImpl, attempts, retryDelayMs, delayImpl, timeoutMs, signal },
  );
  if (provisionedProjectId) {
    return {
      projectId: provisionedProjectId,
      source: "managed",
      tierId: capturedTierId || selectedTierId,
      checkedAt: now(),
    };
  }
  throw projectUnavailable(
    "Antigravity could not provision a Google Cloud project during sign-in.",
  );
}

// Compatibility wrapper used from the explicit sign-in flow, where provisioning
// a Google Cloud project is an explicitly consented action.
export async function resolveAntigravityProject(accessToken, options = {}) {
  return (await discoverAntigravityProject(accessToken, { allowOnboard: true, ...options })).projectId;
}

function alreadyResolved(session, nowMs) {
  if (session.project_id && session.project_source !== "fallback") {
    return {
      projectId: session.project_id,
      source: "managed",
      tierId: session.tier_id,
      checkedAt: session.project_checked_at,
    };
  }
  // A fallback is a recorded absence, not a project. Re-deriving it on every
  // turn would hammer discovery for an account that has none, so the same TTL
  // that bounds a real answer also bounds how often the absence is retried --
  // and inside that window the caller is told plainly rather than routed
  // through a project that does not exist.
  if (
    session.project_source === "fallback" &&
    Number.isFinite(session.project_checked_at) &&
    nowMs - session.project_checked_at < PROJECT_CACHE_TTL_MS
  ) {
    throw projectUnavailable(
      "The Antigravity Google Cloud project is not available; re-run sign-in to provision one.",
    );
  }
  return undefined;
}

async function persistProjectContext(session, context) {
  const saved = await updateAntigravityToken((latest) => {
    if (latest.refresh_token !== session.refresh_token) return undefined;
    return {
      ...latest,
      // A fallback records that discovery produced nothing usable. Writing its
      // placeholder id would make the next `alreadyResolved` treat it as a
      // managed project and route through it.
      project_id: context.source === "managed" ? context.projectId : "",
      project_source: context.source,
      project_checked_at: context.checkedAt,
      tier_id: context.tierId,
    };
  });
  return saved;
}

export async function ensureAntigravityProject(
  session,
  {
    fetchImpl = fetch,
    now = Date.now,
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    delayImpl = abortableDelay,
    timeoutMs = 15_000,
    signal,
    allowOnboard = false,
    forceFallbackRefresh = false,
  } = {},
) {
  const nowMs = now();
  // An explicit retry is the one caller allowed past the fallback TTL: it has
  // already failed a turn and is asking for a fresh answer, not a cached
  // absence.
  const refreshFallback = forceFallbackRefresh && session.project_source === "fallback";
  if (refreshFallback) invalidateAntigravityProjectCache(session.refresh_token);
  const resolved = refreshFallback ? undefined : alreadyResolved(session, nowMs);
  if (resolved) return { session, ...resolved };

  const refreshToken = session.refresh_token;
  const key = projectCacheKey(refreshToken);
  const cached = projectCache.get(key);
  if (cached && nowMs - cached.cachedAt < PROJECT_CACHE_TTL_MS) {
    const saved = await persistProjectContext(session, cached.context);
    if (saved.refresh_token !== refreshToken) {
      return ensureAntigravityProject(saved, {
        fetchImpl,
        now,
        attempts,
        retryDelayMs,
        delayImpl,
        timeoutMs,
        signal,
        allowOnboard,
        forceFallbackRefresh,
      });
    }
    return { session: saved, ...cached.context };
  }
  if (cached) projectCache.delete(key);

  const pending = projectPending.get(key);
  if (pending) {
    const context = await pending;
    const saved = await persistProjectContext(session, context);
    if (saved.refresh_token !== refreshToken) {
      return ensureAntigravityProject(saved, {
        fetchImpl,
        now,
        attempts,
        retryDelayMs,
        delayImpl,
        timeoutMs,
        signal,
        allowOnboard,
        forceFallbackRefresh,
      });
    }
    return { session: saved, ...context };
  }

  const generation = projectGeneration(key);
  const promise = discoverAntigravityProject(session.access_token, {
    fetchImpl,
    now,
    attempts,
    retryDelayMs,
    delayImpl,
    timeoutMs,
    signal,
    allowOnboard,
  }).then((context) => {
    if (generationIsCurrent(key, generation)) {
      projectCache.set(key, { context, cachedAt: now() });
    }
    return context;
  }).finally(() => {
    if (projectPending.get(key) === promise) projectPending.delete(key);
  });
  projectPending.set(key, promise);

  const context = await promise;
  const saved = await persistProjectContext(session, context);
  if (saved.refresh_token !== refreshToken) {
    return ensureAntigravityProject(saved, {
      fetchImpl,
      now,
      attempts,
      retryDelayMs,
      delayImpl,
      timeoutMs,
      signal,
      allowOnboard,
      forceFallbackRefresh,
    });
  }
  return { session: saved, ...context };
}
