import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

// Machine-local subagent capability proofs.
//
// The registry's `multiAgentVersion: "v2"` marks models proven through the
// full native collaboration probe and shipped to every installer. This file
// holds local triage evidence for models the operator nominated for
// certification. It is deliberately not a second source of v2 claims: only a
// checked-in registry entry has completed the full native collaboration proof
// and may be exposed to Codex as a v2 subagent.
//
// Lifecycle per slug:
//   checking      the probe worker is running; nothing is advertised yet
//   candidate     the low-cost stream/tool probe passed; submit its redacted
//                 application for the native encrypted-relay proof
//   experimental  retained only for legacy local records; later child traffic
//                 may refine the diagnostic record, but cannot advertise v2
//   proven        retained only for legacy local records; it means one child
//                 HTTP turn once completed, not that delegated work finished
//   failed        the probe or legacy observed child traffic failed; the
//                 reason remains visible where the model was nominated
//
// Legacy experimental/proven records are certification candidates, not
// authority. They are kept so upgrades neither erase useful evidence nor
// automatically repeat quota-spending probes. Completing the encrypted relay,
// marker-return, and same-thread checks belongs in v2_agent/; only the matching
// checked-in registry declaration may expose the route as v2.
export const SUBAGENT_PROOFS_PATH =
  process.env.MODEL_ROUTER_SUBAGENT_PROOFS ||
  path.join(STATE_DIR, "multi-agent-proofs.json");

const KNOWN_STATUSES = new Set(["checking", "candidate", "experimental", "proven", "failed"]);

// A file that exists but cannot be parsed promotes nothing: somebody's
// evidence was here and we can no longer read it, so the conservative v1
// default applies until the operator re-verifies.
export function readSubagentProofs(filePath = SUBAGENT_PROOFS_PATH) {
  if (!existsSync(filePath)) return { version: 1, proofs: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed?.version === 1 && parsed.proofs && typeof parsed.proofs === "object") {
      const proofs = {};
      for (const [slug, proof] of Object.entries(parsed.proofs)) {
        if (proof && typeof proof === "object" && KNOWN_STATUSES.has(proof.status)) {
          proofs[slug] = proof;
        }
      }
      return { version: 1, proofs };
    }
  } catch {
    // Fall through to the empty (promote-nothing) state.
  }
  return { version: 1, proofs: {} };
}

function writeProofs(state, filePath = SUBAGENT_PROOFS_PATH) {
  writePrivateJson(filePath, state, { directoryMode: 0o700 });
}

function updateProof(slug, update, filePath = SUBAGENT_PROOFS_PATH) {
  const state = readSubagentProofs(filePath);
  const key = String(slug);
  const next = {
    version: 1,
    proofs: { ...state.proofs, [key]: { ...state.proofs[key], ...update } },
  };
  writeProofs(next, filePath);
  return next.proofs[key];
}

export function recordProbeStarted(slug, { at = new Date().toISOString() } = {}) {
  return updateProof(slug, { status: "checking", startedAt: at });
}

export function recordProbeResult(slug, { ok, checks, detail, at = new Date().toISOString() }) {
  if (ok) {
    return updateProof(slug, {
      status: "candidate",
      toolProbe: { ok: true, checks, at },
      reason: undefined,
    });
  }
  return updateProof(slug, {
    status: "failed",
    toolProbe: { ok: false, checks, at },
    reason: detail || "compatibility probe failed",
  });
}

export function recordSpawnObserved(slug, { status, at = new Date().toISOString() } = {}) {
  return updateProof(slug, { status: "proven", spawn: { ok: true, status, at } });
}

// `turns` and `newInputTokens` are carried so the recorded evidence says how
// much of a spawn it took, not just that one failed: the proofs snapshot is
// what `control subagents verify`, `control subagents status` and the tray
// render, so this is where negative diagnostic evidence becomes readable.
export function recordSpawnFailure(
  slug,
  { status, reason, turns, newInputTokens, at = new Date().toISOString() } = {},
) {
  return updateProof(slug, {
    status: "failed",
    spawn: {
      ok: false,
      status,
      at,
      ...(Number.isInteger(turns) && turns > 0 ? { turns } : {}),
      ...(Number.isInteger(newInputTokens) && newInputTokens > 0
        ? { newInputTokens }
        : {}),
    },
    reason: reason || `spawn failed with HTTP ${status}`,
  });
}

export function clearSubagentProof(slug, filePath = SUBAGENT_PROOFS_PATH) {
  const state = readSubagentProofs(filePath);
  if (!(String(slug) in state.proofs)) return;
  const proofs = { ...state.proofs };
  delete proofs[String(slug)];
  writeProofs({ version: 1, proofs }, filePath);
}

export function subagentProofSnapshot(filePath = SUBAGENT_PROOFS_PATH) {
  return readSubagentProofs(filePath).proofs;
}

// Local proof records are diagnostic and application material only. Promoting
// from this file let a stream/tool probe masquerade as native collaboration
// proof, creating a path where an actually-v1 route appeared in Codex's v2
// subagent list. Repository `multiAgentVersion: "v2"` is the sole promotion
// authority.
export function applySubagentProofs(models, proofs, { hidden, disabled } = {}) {
  void proofs;
  void hidden;
  void disabled;
  return models;
}

// Legacy helper retained only to refine an historical experimental record from
// child traffic. New candidate records never reach Codex's v2 catalog.
export function awaitingSpawnProof(slug, proofs = subagentProofSnapshot()) {
  return proofs[String(slug)]?.status === "experimental";
}

// Whether child traffic may refine a legacy experimental diagnostic. This can
// change only the local record; it cannot demote or promote registry authority.
export function spawnProofRevocable(slug, proofs = subagentProofSnapshot()) {
  return proofs[String(slug)]?.status === "experimental";
}
