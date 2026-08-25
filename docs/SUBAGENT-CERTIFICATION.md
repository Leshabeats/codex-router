# Making a route usable as a subagent

A model can only be spawned as a Codex subagent if its exact `provider/model`
route is `multiAgentVersion: "v2"`. Everything else in this file is about how a
route gets there, and how to avoid paying to measure the same route twice.

Read this before changing anything under `src/subagent-*.mjs`, `v2_agent/`, or
the Subagents column in the Control Center.

## What "v2" is, and what "v1" is not

`v2` means the route provably carries Codex's native collaboration: the parent
delegates through the encrypted payload relay, the child answers, and it answers
again on a follow-up in the same thread.

`v1` is **not** a lesser working mode. Nothing spawns a v1 route as a subagent:

```js
// src/multi-agent-state.mjs
subagentEligibleModels → model.multiAgentVersion === "v2"
```

and only eligible models get an agent definition written into
`~/.codex/agents/`. A route without a definition cannot be spawned by name at
all. In the registry almost every route has **no** `multiAgentVersion` field;
`"v1"` is the publication default (`multiAgentVersion || "v1"`), so a route
showing v1 means "not certified yet", never "reviewed and rejected".

## The five checks

From `v2_agent/README.md`, in the order a reviewer reproduces them:

| Check | What it proves |
|---|---|
| `streaming` | a streamed Responses turn emits text and completes |
| `toolCall` | a forced function call returns the requested name and valid JSON arguments |
| `encryptedRelay` | a native Codex parent delegates a child through the encrypted payload relay |
| `markerReturn` | the child returns an exact marker |
| `sameThreadFollowUp` | a same-thread follow-up returns a second marker |

Checks 1–2 are cheap and prove almost nothing about delegation. **Never treat
them as evidence of native collaboration** — a route can stream and call tools
perfectly and still fail the relay. That confusion is the whole reason the
promotion gate exists.

## Two ways a route becomes v2

1. **The registry.** `multiAgentVersion: "v2"` checked in, alongside an accepted
   `v2_agent/` application. This ships to every installer.
2. **A completed local verification.** All five checks passing in one run on
   this machine, recorded in `~/.codex/codex-router/multi-agent-proofs.json`.

There is no third way. In particular, the legacy diagnostic statuses in that
proofs file — `candidate`, `experimental`, `proven` — promote nothing, and never
have.

## A ChatGPT account cannot certify a routed model

Checks 3–5 cannot complete while Codex is signed in with a ChatGPT account.
Codex says so in the parent's own message:

```
The '<provider>/<model>' model is not supported when using Codex with a
ChatGPT account.
```

This is a property of the harness and the account, not of the route, so it
records as **deferred** — never as a refusal. Do not "fix" it by relaxing the
promotion gate.

Two things that look like a way out and are not:

- **Signed routing** (`set_signed_routing`) declares a provider block with
  `requires_openai_auth = true`. That is the same ChatGPT-account auth, so it
  changes nothing here.
- **Marking the candidate v2 in the catalog** is already done: Codex only
  offers a subagent for a route its catalog marks v2, so the run builds a
  private catalog copy with just the candidate marked. That clears an earlier
  "not supported with the current ChatGPT account" error and gets as far as the
  refusal above — it does not get past it.

The remaining untested path is running Codex under `auth_mode: "apikey"` rather
than `"chatgpt"`. The wording of the refusal implies an API key would be
accepted, but that has not been verified, and it bills separately from a
ChatGPT plan. Verify before promising anyone this works.

## Running it

From the Control Center: expand a model, flip the switch in the **Subagents**
column. It reads `Checking…`, then either stays on or comes back with one
sentence. That is the whole user-facing surface — no check names, no
"certification", no protocol versions.

From the CLI:

```bash
bin/model-router codex subagents certify <provider>/<model>
```

Both spend real quota: two HTTP turns against the route, then a Codex parent
turn plus child turns, twice. The run stops at the first failure, so a route
that cannot stream never pays for a delegation.

## Don't measure the same route twice

This is the part that matters for cost.

- **Same machine.** The verified record persists. It does **not** expire on a
  router upgrade — what the checks measure is the provider route, and a patch
  bump does not change the provider. `PROOF_EPOCH` in `src/subagent-proofs.mjs`
  exists to invalidate records deliberately if a future change makes old
  evidence untrue; do not add per-version expiry back.
- **Everyone else.** A passing run writes
  `v2_agent/<provider>/<model>/proof.json` with the real outcomes and
  timestamps. Commit it, open the PR, and once it is accepted **with the
  matching registry change in the same PR**, every installer gets the route as
  v2 and nobody runs the checks again.

So the intended lifecycle is: verify once locally → the artifact is written for
you → PR → registry → nobody pays again.

## Rules for agents changing this code

1. **Never promote on partial evidence.** `verifiedForRoute()` requires all five
   checks passing, the record's slug matching the route exactly, and the current
   epoch. A run that reached three checks must leave a record that promotes
   nothing.
2. **A record promotes only its own route.** `deepseek/deepseek-v4-flash` and
   `openrouter/deepseek-v4-flash` are separate applications: different
   credential, adapter, and tool handling.
3. **A local pass never sets `status: "accepted"`.** Only the PR that also moves
   the registry entry may do that.
4. **Never write secrets into an application.** Outcomes, HTTP statuses, and
   timestamps only. No prompts, response bodies, decrypted payloads, or
   credentials — CI refuses evidence that looks credential-shaped.
5. **Call the endpoint the router serves.** The caller base already ends in
   `/v1`; the router answers Responses at `<callerBase>/responses` and takes the
   caller key as a bearer. `chat/completions` is not served — posting there
   returns 404, which once got reported to the operator as "this model cannot
   run subagents".
6. **Never offer a control that cannot change the outcome.** The Subagents
   column previously showed a "Test subagents" switch whose best case was
   relabelling a route from `Untested` to `Awaiting certification` — still
   unusable. If a control cannot produce the result its label implies, remove it
   or make it produce that result.
7. **Do not show the machinery.** The reader chooses a model; they should never
   need to know what "v2", "relay", or "certification" mean to do it.

## Where things live

| Path | Role |
|---|---|
| `src/subagent-proofs.mjs` | the record store and the promotion gate (`verifiedForRoute`, `applySubagentProofs`) |
| `src/subagent-certify.mjs` | the five-check runner, and the application writer |
| `src/subagent-verify.mjs` | the older cheap two-request probe — **diagnostic only**, do not conflate with the above |
| `src/multi-agent-state.mjs` | resolves effective v2 claims for catalog, agents dir, and doctor |
| `v2_agent/` | applications; the review gate for shipping a route to every installer |

## Tests that must keep passing

- `test/subagent-local-verification.test.mjs` — the promotion gate, including
  the exact failure it exists to prevent (checks 1–2 pass, delegation never ran)
- `test/subagent-certify.test.mjs` — the runner's decision logic and endpoint,
  including the false pass where a parent repeats the marker from its own prompt
- `test/subagent-ui.test.mjs` — that the Control Center never offers a control
  implying a local probe can promote a route
