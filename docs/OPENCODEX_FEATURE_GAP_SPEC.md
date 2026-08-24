# OpenCodex feature gap specification for Codex Router

Status: implementation handoff

Baseline: 2026-08-24

Implementation tracking: [OpenCodex parity implementation roadmap](./OPENCODEX_IMPLEMENTATION_ROADMAP.md)

This document describes the OpenCodex features that are not currently present in
Codex Router, or that are present only in a narrower form. It is written for an
AI coding agent. The agent must verify the live checkout and upstream APIs before
changing code; this is a design and acceptance specification, not a request to
copy OpenCodex code.

## 1. Source baseline

- [OpenCodex](https://github.com/lidge-jun/opencodex), inspected at the `main`
  branch release represented by version `2.31.0`.
- [Codex Router](https://github.com/duolahypercho/codex-router), inspected at
  the current `main` documentation and the local `0.4.0-beta.4` checkout.
- The OpenCodex registry and types are the source for feature names. The
  Codex Router source and its generated catalog are authoritative for what is
  already supported here.

Provider names below are OpenCodex registry IDs. Some IDs are aliases or protocol
variants rather than independent companies. “Missing” means that Codex Router
has no equivalent first-class route today; it does not mean that a user can never
reach the service through a manually configured endpoint.

## 2. Executive summary

Codex Router already has a strong, deliberately narrow path for the Codex App,
Codex CLI, DeepSeek Harness and Gemini CLI. It preserves the native GPT catalog,
native default model, and native speed controls. It also has provider/model
failover, cooldowns, usage reporting, a vision bridge, standalone-search metadata,
and a large set of configured providers.

OpenCodex is broader in three areas:

1. It treats credentials as routable pools, not only as one credential per
   provider. This includes multiple ChatGPT/Codex accounts, API-key pools,
   account priority, quota-aware selection, sticky account affinity and
   re-authentication.
2. It has a generic provider management layer. A user can add any OpenAI-
   compatible endpoint, discover or register its models, set headers and key
   transport, and expose it through the same routing surface.
3. It includes more adapters, client integrations, virtual combo models, a
   provider-agnostic web-search sidecar, and a dashboard for live management.

The implementation target is additive parity. It must not replace the native
Codex path, silently change a user's default model, remove GPT speed tiers,
rewrite existing provider logins, or weaken the current verified-model safety
policy.

## 3. Current capability matrix

| Area | Codex Router today | OpenCodex behavior | Gap |
| --- | --- | --- | --- |
| Native GPT catalog/login | Native Codex-owned catalog and login are preserved | OpenAI/ChatGPT route plus pooled Codex accounts | Add pooled accounts without taking ownership of native GPT metadata |
| Provider failover | Automatic model/provider failover and cooldowns | Failover plus user-defined combos and account pools | Add explicit combos and credential-level failover |
| Per-model custom endpoint | `custom` provider supports a per-model endpoint and metadata | Generic provider can be added/edited with base URL, adapter, headers and models | Promote the capability to a reusable provider object |
| OpenAI-compatible protocol | Several curated routes and custom model routes | Any OpenAI-compatible provider; OpenAI Responses and Chat Completions adapters | Add generic adapter/capability negotiation and broader endpoint pass-through |
| API keys | Provider-specific credential handling | Multiple API keys per provider, active key, key health and rotation | Add a provider-scoped key pool |
| ChatGPT accounts | One native Codex login flow | Multiple accounts, quota tracking, strategies, sticky affinity and re-auth | Add a policy-controlled account pool |
| Anthropic | API route | API and OAuth account pool | Add OAuth only if the provider terms and auth contract permit it |
| Model catalog | Curated registry, verified metadata, custom model files | Live model discovery plus add/edit/remove/enable/disable/selected models | Add provider-scoped discovery and user catalog overrides |
| Search | Native client-side standalone search for verified models; hosted provider-specific search where available | Web-search sidecar that can serve models which cannot consume the native search tool | Add an explicit sidecar, with bounded results and opt-in policy |
| Vision | Vision bridge and local vision support already exist | Vision translation across adapters and sidecars | Reuse current bridge; add capability declarations, not another image shim |
| Sub-agents | v1/v2 and certified model metadata | Any model, fallback chains, effort/injection controls | Add opt-in unverified models and per-agent fallback policy |
| Virtual models | Internal model/provider fallback | Named combos with failover or weighted round-robin, weights and sticky limits | Add persisted combo definitions |
| Dashboard | macOS tray/control center and operational views | Web dashboard for providers, models, accounts, combos, logs and usage | Add a browser control plane only where the existing UI cannot manage a feature |
| Client exports | Codex, DSH and Gemini-oriented integration | OpenCode, Pi, OMP, Hermes, OpenClaw, Kimi, Gajae, DSH, MCode, ZCode, Prime Agent and others | Add exports only after the gateway contracts are stable |

## 4. Gap A: account and credential pooling

### 4.1 Required concepts

Implement a provider-neutral credential store with two credential classes:

- `account`: an OAuth or first-party login identity, for example a ChatGPT/Codex
  account or an Anthropic OAuth account;
- `api_key`: a key or token for an API provider.

Each credential must have a stable opaque ID. Email addresses, provider account
IDs and aliases are metadata, not routing keys. Secrets must remain encrypted at
rest and must never be returned by list/status endpoints or written to ordinary
request logs.

Logical account fields:

```json
{
  "id": "acct_opaque_id",
  "provider": "openai",
  "kind": "account",
  "alias": "personal",
  "email": "redacted-or-local-only",
  "plan": "unknown",
  "providerAccountId": "provider-id-if-available",
  "auth": {
    "accessTokenRef": "secret-ref",
    "refreshTokenRef": "secret-ref",
    "expiresAt": "2026-08-24T12:00:00Z"
  },
  "state": "healthy",
  "paused": false,
  "priority": 50,
  "usage": {
    "window5h": {"used": 0, "limit": null, "resetAt": null},
    "weekly": {"used": 0, "limit": null, "resetAt": null},
    "monthly": {"used": 0, "limit": null, "resetAt": null}
  },
  "lastUsedAt": null,
  "lastErrorAt": null
}
```

Logical API-key fields:

```json
{
  "id": "key_opaque_id",
  "provider": "openrouter",
  "kind": "api_key",
  "alias": "primary",
  "secretRef": "secret-ref",
  "transport": "authorization-bearer",
  "state": "healthy",
  "paused": false,
  "priority": 50,
  "usage": {"requests": 0, "tokens": 0, "resetAt": null}
}
```

The exact persistence format may follow the existing Codex Router state store.
Do not create a second unencrypted credentials database.

### 4.2 Pool policies

Support these policies for each provider pool:

- `quota`: choose the healthy account with the most remaining quota, or the
  highest remaining score when a provider exposes several windows;
- `round-robin`: distribute new requests across eligible credentials;
- `fill-first`: keep using the highest-priority eligible credential until it
  reaches the configured threshold, then move to the next one.

Common policy fields:

```json
{
  "strategy": "quota",
  "autoSwitchThreshold": 0.10,
  "sticky": true,
  "stickyLimit": 50,
  "maxCooldownSeconds": 300,
  "pausedCredentialIds": [],
  "priorityOrder": ["acct_opaque_id"]
}
```

The threshold is a fraction of the provider-reported remaining quota. If quota is
unknown, the router must not invent a percentage; use health, priority and the
selected non-quota strategy instead.

### 4.3 Selection and affinity

1. A new conversation receives one eligible credential.
2. The selected credential is stored in conversation/session state.
3. Subsequent turns keep that credential while it is healthy and within policy.
4. A credential may be rebound on expiry, explicit pause, 401/403, rate limit,
   provider outage or quota threshold crossing.
5. Rebinding must be atomic for the conversation. Two concurrent turns must not
   select different credentials for the same session.
6. Streaming failures may retry only before any assistant bytes are committed.
   After output starts, report the error and preserve the transcript; do not
   silently duplicate a tool call.

OpenCodex's sticky limit is a pool policy, not a global timeout. Implement it as
the maximum number of turns or requests that may retain a binding before a
re-evaluation. Make the unit explicit in the configuration and API.

### 4.4 Lifecycle operations

Provide authenticated control operations for:

- list accounts/keys with health, quota snapshot and last error;
- add, remove, pause and resume a credential;
- select a credential for the next new session;
- set priority and pool strategy;
- refresh or re-authenticate OAuth credentials;
- clear cooldown and reset local usage counters;
- test a credential with a non-billable metadata request where supported.

Provider quota refresh must be cached and rate-limited. A request must not block
on a quota API call unless the cache is expired and the operation is explicitly a
health check.

### 4.5 Policy and safety constraints

Pooling is for continuity, quota-aware routing and operational resilience. It
must not be marketed or implemented as a way to evade provider limits, account
enforcement or terms of service. Show a warning before adding a pool and keep an
audit record of account changes without storing token values. Never accept a pool
of credentials from an untrusted remote control client.

## 5. Gap B: generic OpenAI-compatible providers

### 5.1 Desired user model

A user should be able to add a provider without a source-code change:

```text
router provider add local-vllm \
  --adapter openai-chat \
  --base-url http://127.0.0.1:8000/v1 \
  --api-key-ref env:LOCAL_VLLM_KEY \
  --allow-private-network
```

The provider then exposes models from `/v1/models`, or accepts explicitly
registered model IDs when discovery is unavailable. A provider may contain many
models and many credentials. The current `custom` route remains supported as a
compatibility alias for a single model endpoint.

### 5.2 Provider object

Use one logical schema, mapped to the existing Codex Router state/config system:

```json
{
  "id": "local-vllm",
  "displayName": "Local vLLM",
  "enabled": true,
  "adapter": "openai-chat",
  "baseUrl": "http://127.0.0.1:8000/v1",
  "auth": {
    "mode": "api_key",
    "keyIds": ["key_opaque_id"],
    "transport": "authorization-bearer",
    "headers": {"X-Tenant": "local"}
  },
  "network": {
    "allowPrivate": true,
    "connectTimeoutMs": 10000,
    "requestTimeoutMs": 300000
  },
  "discovery": {
    "enabled": true,
    "path": "/models",
    "refreshSeconds": 900
  },
  "models": {
    "qwen-local": {
      "upstreamId": "Qwen/Qwen3.8-27B",
      "displayName": "Qwen 3.8 27B (Local)",
      "modalities": ["text"],
      "supportsTools": true,
      "supportsReasoning": true,
      "supportsVision": false,
      "contextWindow": 131072,
      "requestProfile": "auto-tool-choice"
    }
  }
}
```

Private or loopback endpoints must require an explicit local opt-in. Remote
control requests must not be allowed to use arbitrary private-network URLs.
Validate URL schemes, reject file URLs, and protect against DNS rebinding where
the process is exposed beyond loopback.

### 5.3 Adapters and capabilities

Implement adapters as protocol translators, not provider-name conditionals:

- `openai-responses`: `/v1/responses`, streaming events, tool calls and
  reasoning items;
- `openai-chat`: `/v1/chat/completions`, streamed deltas and tool calls;
- `openai-completions`: legacy `/v1/completions` for text-only models;
- `anthropic-messages`: `/v1/messages` where the provider has a supported
  Anthropic contract;
- `google-generative-ai`: Gemini-native request/response mapping;
- `azure-openai`: Azure URL/version/auth rules.

The adapter must advertise capabilities before translating a request:

```json
{
  "inputModalities": ["text"],
  "outputModalities": ["text"],
  "streaming": true,
  "tools": true,
  "parallelToolCalls": false,
  "reasoning": "field-or-none",
  "vision": false,
  "webSearch": false,
  "structuredOutput": true,
  "maxOutputTokensField": "max_tokens"
}
```

Unsupported fields must be omitted or translated according to the capability
profile. Never send `image_url`, native search tools, reasoning fields or
`parallel_tool_calls` to a model that declares those capabilities as unsupported.
Do not infer a capability from a marketing name; use provider metadata, a
verified preset or an explicit user override.

### 5.4 OpenAI endpoint coverage

The generic provider layer should expose a capability-aware pass-through for the
following OpenAI-compatible routes:

| Route | Priority | Requirement |
| --- | --- | --- |
| `GET /v1/models` | P0 | Discovery, filtering and model health |
| `POST /v1/responses` | P0 | Codex-native route and Responses-compatible providers |
| `POST /v1/chat/completions` | P0 | Main compatibility path |
| `POST /v1/completions` | P1 | Legacy text-only providers |
| `POST /v1/embeddings` | P2 | Expose only if a client calls it; never advertise it as a chat model |
| `POST /v1/images/generations` | P2 | Expose only for a provider/model declaring image generation |
| `POST /v1/audio/speech` | P2 | Expose only for TTS-capable providers |
| `POST /v1/audio/transcriptions` | P2 | Expose only for transcription-capable providers |
| `POST /v1/audio/translations` | P2 | Same capability gate as transcription |
| `POST /v1/moderations` | P2 | Expose only for moderation-capable providers |
| `POST /v1/files` and `DELETE /v1/files/{id}` | P2 | Multipart upload/list/retrieve/delete with size limits |
| `POST /v1/batches` and batch status routes | P3 | Long-running jobs, polling and cancellation |
| Fine-tuning job routes | P3 | Expose only when the upstream and client contract support them |
| Assistants/threads/runs/vector stores | P3 | Legacy/extended compatibility; verify current OpenAI contract first |

P0 is required for Codex Router feature parity. P1/P2 are general OpenAI API
compatibility and must not be wired into the Codex model selector unless the
client contract supports them. Keep endpoint forwarding separate from model
selection so a provider cannot accidentally claim to be a chat model.

For literal full-API compatibility, add `supportedEndpoints` to the provider
manifest and route only declared paths. The router should support the OpenAI
resource families above as a transparent, capability-aware proxy, but it must
not pretend that a chat model supports files, fine-tuning or vector stores. File
uploads require independent size/type limits, streaming routes require
cancellation propagation, and long-running jobs require an idempotency key plus
polling state. The implementing agent must re-check the current OpenAI API
reference before enabling the P3 legacy resources; the compatibility surface has
changed over time and should not be hard-coded from an old SDK.

For every route:

- preserve request IDs and trace IDs;
- preserve streaming backpressure and cancellation;
- redact authorization, cookies and sensitive headers;
- normalize upstream errors without losing provider status and request ID;
- apply the same timeout, retry and cooldown policy as chat requests;
- never retry a non-idempotent request after upstream bytes are committed.

### 5.5 Model discovery and registration

Discovery must be provider-scoped, cached and observable. A refresh must not
delete user-defined models. Merge precedence should be:

1. explicit user override;
2. verified provider preset;
3. live provider metadata;
4. conservative defaults.

Persist `upstreamId`, display name, context window, input/output modalities,
tool/reasoning/search support, cost metadata when available, and the selected
request profile. Keep the upstream ID separate from the clean UI label.

## 6. Provider parity plan

### 6.1 Already covered or substantially covered

Do not duplicate these as new providers. Reuse the existing implementation and
only add missing protocol or credential features:

`openai` native Codex, `xai` (`grok-oauth`/`grok-api`), `command-code`,
`anthropic-apikey` (API only), `kimi`, `openrouter`, `opencode-go`,
`opencode-zen`, `deepseek`, `groq`, `cerebras`, `chutes`, `github-copilot`,
`huggingface`, `nvidia` through `nvidia-nim`, `mistral`, `siliconflow`,
`together`, `fireworks`, `ollama` through `local`, `ollama-cloud`, `lm-studio`,
`google` through the Gemini API compatibility route, `qwen-cloud` through the
Qwen plan route, `zai`, `xiaomi-mimo`, `orcarouter` through `orca`, `minimax`,
`cline-pass`, and `opencode-free`.

These are equivalences, not proof that every adapter, login flow, model or
pricing feature is identical. Preserve the current provider-specific behavior.

### 6.2 Missing first-party, OAuth or client-specific adapters

| OpenCodex ID | Gap in Codex Router | Implementation note |
| --- | --- | --- |
| `cursor` | No Cursor adapter and Cursor is not a supported target | Add only with a documented auth contract; never scrape a desktop session |
| `anthropic` | Anthropic OAuth account route missing | Reuse Anthropic messages adapter and implement official OAuth only if permitted |
| `kiro` | Missing | Add an adapter/auth preset after verifying API contract |
| `nous` | Missing | Add generic OpenAI-compatible preset if protocol is confirmed |
| `openai-apikey` | Direct OpenAI API-key provider missing | Separate from native ChatGPT/Codex login and native GPT catalog |
| `umans` | Missing | Generic preset plus live model discovery |
| `neuralwatt` | Missing | Generic preset plus health/quota behavior |
| `cline` | Distinct provider from `clinepass`; missing | Do not alias without checking auth and endpoint semantics |
| `kimi-code` | Direct `api.kimi.com/coding/v1` route missing | Keep separate from Kimi API Platform and OAuth |
| `gitlab-duo` | Missing | Requires GitLab auth and tenant/project context |
| `cloudflare-ai-gateway` | Missing | Gateway URL and credential/header mapping |
| `cloudflare-workers-ai` | Missing | Workers AI account/endpoint mapping; not the same as an AI Gateway |

### 6.3 Missing cloud, aggregator and infrastructure providers

`bizrouter`, `deepinfra`, `hyperbolic`, `nscale`, `vultr`, `baseten`,
`sambanova`, `nebius`, `digitalocean`, `scaleway`, `featherless`, `novita`,
`venice`, `nanogpt`, `synthetic`, `litellm`, `vercel-ai-gateway`, `zenmux`,
and `parallel` are absent as first-class routes.

Implement these as data-driven provider presets on top of the generic provider
layer whenever they are OpenAI-compatible. Add a custom adapter only when the
wire contract differs. A preset must contain base URL, auth transport, discovery
path, supported adapters, default timeout, retry policy and capability defaults.

### 6.4 Missing regional, coding-plan and product variants

`google-vertex`, `google-antigravity`, `azure-openai`, `vllm`, `firepass`,
`zhipu-bigmodel`, `zhipu-bigmodel-coding`, `tencent-coding-plan`, `volcengine`,
`volcengine-coding-plan`, `volcengine-agent-plan`, `qianfan`, `alibaba`,
`alibaba-token-plan`, `alibaba-token-plan-intl`, `mimo-free`, paid `kilo`, and
the Anthropic-compatible `xiaomi` variant are missing or only partially covered.

Do not collapse plan-specific products into a generic API route when their
credentials, quotas or model IDs differ. Model aliases may be shared only after
the provider contract is proven equivalent.

### 6.5 Implementation order for provider parity

1. Generic OpenAI Responses/Chat provider and model discovery.
2. Direct OpenAI API key and Azure OpenAI.
3. Google Vertex and Gemini-native adapter.
4. Local vLLM and other OpenAI-compatible infrastructure presets.
5. Regional/coding-plan presets with explicit auth and quota adapters.
6. Product-specific OAuth/client integrations (`cursor`, `kiro`, `gitlab-duo`,
   and similar) only after a maintained official auth flow exists.

This order maximizes coverage without adding dozens of provider-specific code
paths.

## 7. Other OpenCodex capabilities to port

### 7.1 Combos (virtual models)

Add a persisted virtual model that points to provider/model targets:

```json
{
  "id": "fast-coding",
  "displayName": "Fast Coding",
  "strategy": "failover",
  "sticky": true,
  "stickyLimit": 20,
  "targets": [
    {"provider": "openrouter", "model": "qwen/qwen3.8-max", "weight": 1},
    {"provider": "local-vllm", "model": "qwen-local", "weight": 1}
  ]
}
```

Supported strategies: `failover` and weighted `round-robin`. A combo must be
resolved before request translation, preserve the selected target for a sticky
session, and use the normal provider/model capability gate. A combo must never
hide an incompatible tool, vision or search capability.

### 7.2 Web-search sidecar

Codex Router currently has native standalone-search metadata for verified models.
The missing OpenCodex feature is a provider-agnostic sidecar for models that do
not accept the native search tool.

Design requirements:

- explicit per-provider/model opt-in;
- a bounded search query and result schema;
- ChatGPT-native search account as a sidecar credential, kept separate from the
  selected generation account;
- result citations and source URLs preserved in the model-visible payload;
- timeout, cancellation, retry and cache policy;
- no search sidecar when the model already supports native search unless the user
  explicitly selects it;
- no hidden search calls on ordinary text requests;
- clear telemetry showing sidecar latency and failure reason.

This must be capability-driven. Do not add model-name conditionals.

### 7.3 Broad sub-agent roster and fallback

Codex Router already supports v1/v2 sub-agents and certified model metadata. Add:

- `allowUnverifiedModels` as an explicit opt-in, default `false`;
- per-agent model chains with provider/model targets and weights;
- fallback on pre-commit transport failures only;
- tool/vision/search capability validation before assigning a model;
- per-agent token/time budgets and concurrency limits;
- clear display labels and an audit trail of the actual target used.

Do not expand the default roster merely because a provider advertises a model.

### 7.4 Dashboard and live management

OpenCodex's web dashboard manages providers, models, accounts, combos, sidecars,
logs and usage. Codex Router's macOS tray remains the primary local UI, but the
control API should expose equivalent authenticated operations:

- providers and credentials;
- model discovery and overrides;
- combos and sub-agent policies;
- quota/health/cooldown state;
- sidecar configuration;
- bounded logs and request traces;
- export/import of non-secret configuration.

The UI must show whether a value is native, verified, user-defined, live-
discovered or inferred. Do not overwrite native GPT labels or speed controls.

### 7.5 Client integrations and exports

OpenCodex provides exports or integrations for OpenCode, Pi, OMP, Hermes,
OpenClaw, Kimi, Gajae, DeepSeek Harness, MiniMax Code, ZCode and Prime Agent,
plus Claude Code/Desktop and Grok Build flows. Codex Router currently targets
Codex, DeepSeek Harness and Gemini CLI; OpenCode is a provider rather than a
supported target.

Implement exports as generated, versioned adapters. Each export must declare the
gateway URL, auth mechanism, model aliases and whether tool/search/vision
features are supported. Never copy secrets into generated files by default.

### 7.6 Memory and cache controls

OpenCodex exposes an app-owned memory budget and cache retention controls. Codex
Router already has operational logs and retention behavior, but parity requires:

- bounded in-memory queues and response buffers;
- explicit cache retention and maximum size;
- eviction metrics;
- a diagnostic report showing active memory budget and retained stores;
- no unbounded transcript or tool-result retention in the router process.

This is an operational hardening item, not a reason to cache prompts or provider
secrets.

## 8. Proposed architecture

Keep the existing gateway and provider registry. Add layers with single
responsibilities:

```text
Control API / tray / CLI
        |
Config + encrypted credential store
        |
Pool policy + session affinity + cooldown
        |
Combo resolver + model capability registry
        |
Protocol adapter (Responses / Chat / Anthropic / Gemini / Azure)
        |
Existing Codex Router gateway and request/stream pipeline
```

Suggested module boundaries (adapt names to the checkout):

- `credentials`: encrypted secret references, account/key lifecycle;
- `pools`: eligibility, strategy, quota snapshots and session bindings;
- `providers`: provider manifests, generic provider CRUD and discovery;
- `models`: live catalog merge, capability profiles and user overrides;
- `combos`: virtual model resolution and sticky target state;
- `adapters`: protocol translation and endpoint capability gates;
- `sidecars`: web search and other explicit auxiliary services;
- `control`: authenticated API, CLI and tray operations;
- `exports`: generated client-specific configuration.

Avoid provider-specific branches in the core router. A provider manifest should
provide data and adapter selection; an adapter should provide protocol behavior.

### 8.1 Routing order

For every request, use this deterministic order:

1. authenticate the control/client request;
2. resolve native or user-selected provider/model/combo;
3. load merged model capabilities;
4. choose a session-bound credential or run pool selection;
5. validate requested tools, images, search and reasoning against capabilities;
6. choose the protocol adapter;
7. translate only supported fields;
8. send the request with cancellation and trace propagation;
9. update quota, health, cooldown and session state;
10. expose the selected provider/model/credential alias in diagnostics, never the
    secret.

## 9. Control API and CLI contract

The exact HTTP prefix must follow the existing Codex Router control namespace.
The following are logical contracts, not permission to expose an unauthenticated
server.

| Operation | Method | Result |
| --- | --- | --- |
| List providers | `GET /control/providers` | Sanitized provider manifests |
| Add provider | `POST /control/providers` | Provider ID and validation result |
| Discover models | `POST /control/providers/{id}/discover` | Merged model catalog |
| Add credential | `POST /control/providers/{id}/credentials` | Credential ID only |
| List credential health | `GET /control/providers/{id}/credentials` | State/quota/alias, no secret |
| Set pool policy | `PUT /control/providers/{id}/pool` | Effective policy |
| Bind session | `PUT /control/sessions/{id}/credential` | Sanitized binding |
| Manage combos | `/control/combos` | CRUD and validation |
| Test route | `POST /control/routes/test` | Redacted request/response metadata |
| Export client config | `POST /control/exports/{client}` | Generated config with secret refs |

CLI equivalents should be scriptable and non-interactive:

```text
router provider list
router provider add NAME --adapter openai-chat --base-url URL
router provider discover NAME
router provider test NAME/MODEL
router credential add PROVIDER --kind account|api-key
router credential list PROVIDER
router pool set PROVIDER --strategy quota --sticky-limit 50
router combo set NAME PROVIDER/MODEL[:WEIGHT]...
router model list --provider NAME
router export CLIENT --output PATH
```

Commands that accept secrets must support environment variables or OS keychain
references. Do not print the value in shell history or command output.

## 10. Security requirements

- Store OAuth tokens and API keys in the existing OS keychain/secure store or an
  encrypted store with a process-local key reference.
- Redact `Authorization`, cookies, refresh tokens, API keys, signed URLs and
  provider-specific secret headers from logs, errors, traces and exports.
- Bind control operations to loopback by default and require an explicit,
  authenticated opt-in for remote access.
- Validate provider URLs, including scheme, redirects, private-network access,
  DNS rebinding and maximum redirect count.
- Apply per-provider and per-credential rate limits; avoid retry storms.
- Separate provider/account scopes in cache, cooldown, quota and session state.
- Do not use account pooling to bypass provider restrictions. Surface terms and
  require explicit confirmation for multi-account configuration.
- Preserve native Codex authentication and model metadata. A custom provider
  must not be able to overwrite native GPT display name, speed or default model.
- Treat upstream model metadata as untrusted input; validate lengths, IDs,
  modalities and numeric limits before persisting or displaying them.

## 11. Compatibility and migration

The implementation must satisfy all of the following:

1. Existing provider configs continue to load without a migration command.
2. Existing `custom` per-model endpoints continue to work unchanged.
3. Existing native GPT models, labels, default model and `normal`/`fast` speed
   controls remain client-owned and untouched.
4. Existing OAuth/API logins remain valid; migration must copy references, not
   re-print or re-enter secrets.
5. A failed migration leaves the previous state loadable and provides rollback.
6. New generic providers are disabled until explicitly enabled and tested.
7. Live discovery never deletes manually configured model entries.
8. Existing sub-agent certification and tool safety defaults remain unchanged.
9. Config export/import is versioned and rejects unknown destructive changes.
10. Update/rollback works with the current supervised macOS tray installation.

Add a schema version and an idempotent migration. Back up only encrypted state
and non-secret configuration; do not create plaintext copies of credentials.

## 12. Test plan

### Unit tests (P0)

- pool eligibility, quota unknown, threshold and priority;
- round-robin and fill-first ordering;
- sticky session binding and atomic rebind;
- cooldown after 401/403/429/5xx and recovery;
- no retry after a committed stream;
- provider URL and private-network validation;
- secret redaction in logs and errors;
- capability gate for tools, image input, search, reasoning and structured output;
- live catalog merge precedence and preservation of user models;
- combo failover, weights, sticky limit and capability validation;
- migration idempotence and rollback.

### Protocol contract tests (P0/P1)

Use local fixtures for:

- OpenAI Responses streaming;
- OpenAI Chat Completions streaming;
- tool calls and parallel tool calls;
- reasoning content in both Responses and Chat formats;
- image input accepted and rejected;
- upstream error/status/request ID propagation;
- `/v1/models` discovery;
- legacy Completions and optional embeddings/images/audio routes.

### Integration tests

- one provider with two API keys;
- one ChatGPT account pool with simulated quota windows;
- two providers behind one combo;
- sidecar search success, timeout, cancellation and cache hit;
- private loopback provider with explicit opt-in and remote rejection;
- tray/control API and CLI produce the same state;
- generated client exports contain secret references, not secret values.

### End-to-end acceptance

Run a real text turn, streamed tool call, image turn and native web-search turn
for at least one verified provider. Run the same text/tool cases through a local
generic OpenAI-compatible fixture. Verify that a restart preserves session
affinity, pool health and native GPT selector state. Record provider-specific
limitations instead of marking an unsupported capability as passed.

## 13. Phased implementation plan

### P0: safe foundation

- credential abstractions and encrypted storage;
- provider-scoped API-key pool;
- generic OpenAI Chat/Responses provider;
- model discovery and capability profiles;
- control API/CLI with redaction;
- migration, rollback and regression tests for native GPT.

### P1: routing parity

- ChatGPT/Codex account pool;
- quota strategies, sticky affinity and re-auth;
- virtual combos;
- direct OpenAI API key, Azure, Vertex and local vLLM presets;
- capability-driven request field filtering.

### P2: ecosystem parity

- web-search sidecar;
- remaining OpenAI-compatible provider manifests;
- broader sub-agent opt-in and fallback chains;
- dashboard views and usage/health diagnostics;
- client exports for OpenCode and the other maintained integrations.

### P3: product-specific adapters

- OAuth/client integrations such as Anthropic OAuth, Cursor, Kiro and GitLab Duo;
- regional coding plans and non-OpenAI protocol adapters;
- optional OpenAI non-chat endpoints (embeddings, images and audio).

Each phase must be independently shippable and must pass all prior acceptance
tests.

## 14. Definition of done

The work is complete only when:

- a user can add an arbitrary OpenAI-compatible provider and model without a
  source change;
- two API keys can be rotated with a documented policy and no secret leakage;
- a supported ChatGPT account pool retains conversation affinity and safely
  rebinds on an explicit failure;
- a named combo can fail over or distribute requests without violating model
  capabilities;
- a model without vision or native search receives no unsupported image/search
  fields;
- native GPT labels, default selection and speed controls are unchanged;
- at least one missing provider category is implemented through a data-driven
  preset rather than a core-router conditional;
- control API, tray and CLI show consistent sanitized state;
- migration, restart, rollback and end-to-end streaming tests pass.

## 15. Open questions for the implementing agent

Resolve these from current provider documentation before implementation:

1. Which official OAuth flows and account-pool use cases are permitted by each
   provider's terms?
2. Which providers expose reliable 5-hour, weekly or monthly quota APIs?
3. Does the current Codex client require only Responses, or should the gateway
   expose the full optional OpenAI endpoint set to other clients?
4. Which providers support native reasoning fields versus plain text reasoning?
5. What is the exact existing control API authentication and persistence contract?
6. Should the dashboard be added to the tray package, the router process, or a
   separately supervised local UI?
7. Which exports are still maintained upstream and therefore worth implementing?

When a provider's contract is unknown, keep it disabled and expose it as an
experimental preset. Do not guess endpoint paths, auth headers, quota behavior
or model capabilities.
