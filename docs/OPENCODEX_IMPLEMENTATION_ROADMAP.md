# OpenCodex parity implementation roadmap

Status: implementation in progress

Parent specification: [OpenCodex feature gap specification](./OPENCODEX_FEATURE_GAP_SPEC.md)

Baseline: 2026-08-24

This document breaks the parent specification into small, reviewable pull
requests. Every item has one owner, one narrow purpose, explicit tests and a
status. A pull request is not considered complete until its tests pass, its
description is present in simple English, its behavior is checked in the app or
tray when applicable, and it is submitted to the upstream repository.

## Status values

- `to implement`: scope is defined, no implementation accepted;
- `implemented`: code exists, focused tests are still required;
- `to test`: implementation is ready for validation;
- `tested`: focused and regression tests passed locally;
- `complete and submitted`: tests passed and the PR was opened/submitted with
  the required title and short description.

Do not skip a state. If a PR fails review or tests, move it back to the relevant
earlier state and record the reason in the notes column.

## Global rules for every PR

1. Preserve native GPT catalog ownership, default model, labels and `normal` /
   `fast` speed controls.
2. Preserve existing provider credentials, custom per-model endpoints and tray
   settings. Migrations must be reversible and idempotent.
3. Keep the current frontend visual language. Add controls using existing tray
   rows, pickers, cards, spacing, typography and colors; do not introduce a new
   design system or change the Dynamic Island silhouette.
4. Any new provider/model capability must be data-driven. Do not add model-name
   conditionals to the request path.
5. Secrets never appear in source, fixtures, logs, PR text, screenshots,
   generated exports or test output.
6. Each PR must pass `npm run check`, the relevant `npm test` subset, and the
   relevant Swift package tests/build when it touches the tray.
7. Every PR description must be short, human, and written in Simplified
   Technical English. It must include a clear `Reason` section that says what
   problem the PR solves. Use the title and body templates in this document.
8. Do not merge unrelated formatting or generated build artifacts.

## PR queue and dependency graph

| ID | Proposed PR title | Scope | Depends on | Status |
| --- | --- | --- | --- | --- |
| P00 | `docs: add OpenCodex parity implementation roadmap` | This roadmap, linked from the parent specification | None | implemented |
| P01 | `fix: keep provider icons within tray icon bounds` | Fix oversized provider mark in menu bar and Dynamic Island; add Swift regression coverage | None | complete and submitted (#401) |
| P02 | `feat: add secure provider credential primitives` | Encrypted account/key references, redaction, lifecycle types and migration | P00 | complete and submitted (#402) |
| P03 | `feat: add provider-scoped API key pools` | Key pool state, quota/health policy, rotation and control operations | P02 | complete and submitted (#403) |
| P04 | `feat: add generic OpenAI-compatible providers` | Provider CRUD, base URL, headers, adapter selection and private-network guard | P02 | complete and submitted (#404) |
| P05 | `feat: add OpenAI Responses and Chat adapters` | Capability-aware Responses/Chat translation and streaming tests | P04 | complete and submitted (#405) |
| P06 | `feat: add live model discovery and capability overrides` | `/v1/models`, merge precedence, model labels/modalities/tool metadata | P04, P05 | complete and submitted (#406) |
| P07 | `feat: add capability-gated OpenAI API endpoints` | Completions, embeddings, images, audio, moderation, files and optional batches | P05, P06 | to implement |
| P08 | `feat: add ChatGPT account pool routing` | OAuth account pool, quota windows, sticky affinity, re-auth and safe rebind | P02 | complete and submitted (#407) |
| P09 | `feat: add provider combos and weighted failover` | Virtual models, failover/round-robin, weights, sticky limits and validation | P06 | complete and submitted (#408) |
| P10 | `feat: add capability-driven sidecar search` | Explicit web-search sidecar for models without native search | P02, P06 | complete and submitted (#409) |
| P11 | `feat: extend verified sub-agent routing` | Opt-in unverified models, per-agent chains and safe fallback | P06, P09 | complete and submitted (#410) |
| P12 | `feat: add missing provider presets` | Data-driven manifests for high-value missing OpenCodex providers | P04, P05, P06 | complete and submitted (#412) |
| P13 | `feat: expose provider and pool controls in tray` | Native-style settings rows for provider/account/key/pool management | P02, P03, P04 | implemented (pool controls still missing) |
| P14 | `feat: expose combos and sidecars in tray` | Existing tray UI patterns for combos, search sidecar and sub-agent policy | P09, P10, P11 | to implement |
| P15 | `feat: add provider and account dashboard API` | Authenticated control API parity for live management and diagnostics | P02-P11 | implemented (snapshot wiring needs isolated PR) |
| P16 | `feat: add client exports for supported integrations` | Versioned OpenCode/Pi/DSH/etc. exports without plaintext secrets | P04, P06, P15 | complete and submitted (#413) |
| P17 | `perf: bound router cache and memory retention` | Explicit bounded buffers, retention policy and diagnostics | P02, P15 | implemented (hard request cap and eviction metrics pending) |
| P18 | `test: add end-to-end parity and migration suite` | Full regression matrix, restart, rollback, tray and native GPT checks | P01-P17 | to implement |
| P19 | `fix: raise managed subagent concurrency` | Keep router-managed Codex configuration aligned with the 100-thread user setting | P00 | implemented |

The initial implementation order is P01, P02, P04, P05, P06, P03, P08, P09,
P10, P11, P12, then the UI/API/export/hardening items. P01 is independent and
can be submitted first. P02/P04/P05/P06 form the generic-provider foundation;
do not implement dozens of provider-specific branches before that foundation is
tested.

The submitted feature PRs are intentionally small foundations. P08-P11 expose
pure policy modules where the consumer/UI wiring is still a later task. PRs
#402, #404, #405 and #406 are stacked prerequisite branches; review and merge
them in dependency order. Every submitted PR now includes a `Reason` section
in its description.

## P00 — roadmap document

Status: `implemented`

This document and the parent specification are the planning artifacts. No
runtime code is part of P00. The parent document must link here before the first
feature PR is opened.

## P19 — managed subagent concurrency

Status: `implemented`

The local Codex configuration now uses the structured `multi_agent_v2` setting
with a 100-thread limit. The router's managed default and installer documentation
use the same value, while an existing user-owned limit remains authoritative.

Title: `fix: raise managed subagent concurrency`

Description template:

> Raises the Codex Router managed sub-agent limit to 100 threads and keeps the
> structured Codex v2 setting valid. User-owned limits are still preserved.

Validation: config-manager tests, real Codex config parse/login status and a
full Codex restart before using the extra slots.

## P01 — provider icon sizing

Title: `fix: keep provider icons within tray icon bounds`

Description template:

> Provider marks could render larger than the tray slot. This clamps provider
> images to the same fixed bounds used by preset icons in the menu bar and
> Dynamic Island, while keeping the existing provider assets and style.

Implementation:

- Make the shared `ProviderIcon` layout have an explicit fixed slot and clip the
  rendered image to that slot.
- Keep aspect ratio and transparent padding; do not crop provider logos.
- Keep all current call-site sizes (14, 18, 22, 24, 26) unless a test proves a
  caller is wrong.
- Ensure menu bar `.provider`, compact Island, expanded Island and quota rows
  all use the same component behavior.
- Do not change the Dynamic Island shape, animation or typography.

Validation:

- Add a Swift test for the sizing/layout contract if the current test target can
  express it; otherwise add a pure helper test for the normalized slot size.
- Build `apps/macos/ModelRouterTray` in release mode.
- Run existing `MenuBarSettingsTests` and `IslandModeTests`.
- Inspect the installed tray on macOS with provider icon, preset icon and idle
  indicator styles.
- Verify the screenshot case: the provider mark is icon-sized, not a large
  logo clipped by the menu bar or island.

## P02 — secure credential primitives

Title: `feat: add secure provider credential primitives`

Description template:

> Adds provider-neutral account and API-key references with encrypted storage and
> redacted status output. Existing credentials remain compatible and no secret is
> copied into configuration or logs.

Implementation:

- Add opaque credential IDs and `account` / `api_key` kinds.
- Reuse the existing secure store and file-protection helpers.
- Add schema version, idempotent migration and rollback snapshot.
- Provide lifecycle types and sanitized status output before adding routing.
- Add redaction tests for headers, URLs, errors, support bundles and exports.

Validation: unit tests, migration twice, rollback, permission check and
`bin/model-router codex doctor` with the current user's existing credentials.

## P03 — provider-scoped API-key pools

Title: `feat: add provider-scoped API key pools`

Description template:

> Adds optional API-key pools with health-aware selection and safe rotation.
> Single-key providers keep their current behavior and existing credentials are
> not changed.

Implementation:

- Add `quota`, `round-robin` and `fill-first` strategies.
- Track health, cooldown, priority and paused state per key.
- Keep session affinity and rebind only on pre-commit failure.
- Make quota refresh cached and non-blocking for ordinary requests.
- Expose sanitized list/add/pause/resume/test operations.

Validation: two-key fixture, 401/403/429/5xx cooldowns, stream commit boundary,
concurrent session selection and no secret leakage.

## P04 — generic OpenAI-compatible provider

Title: `feat: add generic OpenAI-compatible providers`

Description template:

> Adds a reusable provider definition with base URL, adapter, headers and secure
> credentials. Users can connect compatible endpoints without adding provider-
> specific code, while private-network access stays explicit and protected.

Implementation:

- Promote the current per-model `custom` behavior to a provider object without
  breaking old custom model files.
- Add provider CRUD and test operations through the existing control/CLI plane.
- Add explicit `allowPrivate` validation and loopback-only default.
- Keep provider/model IDs separate from display labels.
- Do not let a generic provider overwrite native GPT catalog metadata.

Validation: local OpenAI fixture, remote URL validation, DNS/private-network
guard, CRUD idempotence, existing `custom` regression and restart persistence.

## P05 — Responses and Chat adapters

Title: `feat: add OpenAI Responses and Chat adapters`

Description template:

> Adds capability-aware OpenAI Responses and Chat Completions translation with
> streaming, tool calls, reasoning fields and cancellation coverage.

Implementation: separate protocol adapters, stream backpressure, request IDs,
tool-call normalization, reasoning mapping, error normalization and omission of
unsupported fields. Never retry after response bytes are committed.

Validation: local fixtures for text, streaming, tools, reasoning, cancellation,
unsupported vision/search and upstream error/request-ID propagation.

## P06 — live models and capabilities

Title: `feat: add live model discovery and capability overrides`

Description template:

> Adds cached provider-scoped model discovery and safe metadata overrides. Live
> refresh preserves user-defined models and native GPT metadata.

Implementation: `/v1/models`, merge precedence (user > verified preset > live >
conservative default), display labels, context windows, modalities, tools,
reasoning, vision, search, cost metadata and request profiles.

Validation: discovery cache, refresh failure, user model preservation, invalid
metadata rejection and catalog publication regression tests.

## P07 — extended OpenAI endpoints

Title: `feat: add capability-gated OpenAI API endpoints`

Description template:

> Adds optional OpenAI-compatible endpoint forwarding with explicit capability
> gates. Chat model routing remains separate from embeddings, media and job APIs.

Implementation priority: legacy Completions first; then embeddings, image/audio,
moderation, files and batches. Verify the current OpenAI contract before any
legacy Assistants/Threads/Vector Stores implementation. Add `supportedEndpoints`,
multipart limits, idempotency and polling state.

Validation: route allowlist, file size/type limits, streaming cancellation,
non-idempotent retry protection and endpoint capability tests.

## P08 — ChatGPT account pool

Title: `feat: add ChatGPT account pool routing`

Description template:

> Adds an optional ChatGPT/Codex account pool with quota-aware selection, session
> affinity and safe re-authentication. The native single-account path remains
> unchanged unless pooling is explicitly enabled.

Implementation: encrypted OAuth account rows, quota windows, priority, paused
accounts, `quota`/`round-robin`/`fill-first`, sticky limit, atomic rebind and
provider-policy warning. Do not use this feature to evade provider restrictions.

Validation: simulated quota windows, expiry, 401/403/429, session affinity,
concurrent turns, restart persistence and native GPT selector regression.

## P09 — virtual combos

Title: `feat: add provider combos and weighted failover`

Description template:

> Adds named virtual models that fail over or distribute requests across
> provider/model targets. Capability checks run before a target is selected.

Implementation: persisted combo definitions, failover/weighted round-robin,
sticky limit, weights, sanitized diagnostics and model selector labels.

Validation: weights, all targets unhealthy, capability mismatch, sticky session,
stream commit boundary and native model list regression.

## P10 — web-search sidecar

Title: `feat: add capability-driven search sidecar`

Description template:

> Adds an explicit web-search sidecar for models that cannot consume native
> search tools. It is bounded, observable and disabled unless configured.

Implementation: sidecar credential, result schema, citations, cache, timeout,
cancellation, retry, latency telemetry and no duplicate call for native-search
models. Never infer sidecar support from a model name.

Validation: success, timeout, cancellation, cache hit, malformed result and
native-search bypass.

## P11 — sub-agent parity

Title: `feat: extend verified sub-agent routing`

Description template:

> Adds opt-in unverified sub-agent models and safe per-agent fallback chains.
> Existing verified-model defaults and tool safety remain unchanged.

Implementation: `allowUnverifiedModels=false` by default, capability validation,
per-agent chains, budgets, concurrency limits and actual-target diagnostics.

Validation: verified default, explicit opt-in, tool/vision/search mismatch,
fallback before stream commit and concurrency budget tests.

## P12 — missing provider presets

Title: `feat: add data-driven missing provider presets`

Description template:

> Adds high-value missing provider manifests on top of the generic adapter layer.
> Presets define endpoints and capabilities without adding provider branches to
> the core router.

Implementation order: direct OpenAI API key, Azure OpenAI, Google Vertex,
Gemini-native, local vLLM, then regional and infrastructure providers. Keep
experimental/unknown presets disabled until their official contracts are tested.

Validation: one fixture per adapter family, auth transport, discovery, model
capabilities, health and quota behavior.

## P13 — tray provider/account controls

Title: `feat: expose provider and pool controls in tray`

Description template:

> Adds provider and pool controls to the existing tray settings using the current
> visual language. Native GPT settings and Dynamic Island layout are unchanged.

Implementation: reuse existing settings rows, sheets, picker styles, spacing,
localization and status cards. Add sanitized provider/account/key health and
strategy controls. Never show secrets.

Validation: Swift tests, release build, tray interaction, Dynamic Island modes,
keyboard/accessibility labels and native GPT settings regression.

## P14 — tray combos, sidecar and sub-agent controls

Title: `feat: expose routing policies in tray`

Description template:

> Adds combo, search-sidecar and sub-agent policy controls to the existing tray
> without changing its visual style or Dynamic Island silhouette.

Implementation: follow existing cards/pickers and show capability/health state;
keep advanced settings opt-in and preserve all current defaults.

Validation: Swift UI tests where available, control API round trips, tray build,
Dynamic Island compact/peek/expanded states and restart persistence.

## P15 — dashboard control API

Title: `feat: add authenticated provider management API`

Description template:

> Adds authenticated control endpoints for providers, models, credentials,
> pools, combos, sidecars and diagnostics. Responses are sanitized and local by
> default.

Implementation: reuse current control namespace/authentication; loopback default,
remote opt-in, audit events, no plaintext secrets and consistent CLI/tray state.

Validation: authorization, loopback/remote policy, redaction, concurrent writes,
idempotence and tray/CLI parity.

## P16 — client exports

Title: `feat: add versioned client configuration exports`

Description template:

> Adds safe exports for supported clients using local gateway URLs and secret
> references. Generated files never contain raw provider credentials.

Implementation: start with OpenCode and DeepSeek Harness where contracts are
stable; add other clients only when maintained and tested. Preserve unrelated
settings/comments in target files.

Validation: export/import, secret reference checks, target config preservation and
live client smoke tests that do not spend a paid request unless explicitly
approved.

## P17 — bounded memory and cache

Title: `perf: bound router cache and memory retention`

Description template:

> Adds explicit limits and diagnostics for router buffers and caches. Request
> routing behavior is unchanged and secrets are never cached in plaintext.

Implementation: bounded queues, response/tool-result retention, eviction metrics,
cache TTL/size settings and support diagnostics.

Validation: stress fixture, eviction, restart, memory ceiling and no transcript or
credential over-retention.

## P18 — final parity suite

Title: `test: add OpenCodex parity and migration suite`

Description template:

> Adds the end-to-end regression matrix for provider pools, generic endpoints,
> combos, sidecars, sub-agents, tray behavior and native GPT preservation.

Validation: `npm run check`, `npm test`, Swift package tests/build, local provider
fixture, restart/rollback, one verified streamed tool call, one image-capability
case, one search case and tray/Dynamic Island inspection.

## PR submission checklist

Before opening any PR:

- verify the change is not already in upstream `main` or an open PR;
- confirm only the intended files changed;
- run focused tests, then the relevant global checks;
- test the live app/tray surface for UI-affecting work;
- update this roadmap status to `tested` only after evidence exists;
- open the PR with a short title and description in Simplified Technical
  English;
- record the PR URL/number and move the state to `complete and submitted` only
  after the PR is actually submitted.

PR body template:

```text
## What changed

<One or two short sentences in simple English.>

## Why

<The user-visible or reliability reason.>

## Validation

- <focused test>
- <regression/build check>
```

## Final acceptance gate

The entire roadmap is complete only when every runtime PR is `complete and
submitted`, P18 passes, the current app and tray continue to work after a full
restart, Dynamic Island modes remain visually consistent, provider icons stay at
preset-icon size, and native GPT model/default/speed controls remain unchanged.
