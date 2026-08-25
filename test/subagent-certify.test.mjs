import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHECK_LABELS,
  checksComplete,
  firstFailure,
  newMarker,
  parseEventLines,
  readDelegation,
} from "../src/subagent-certify.mjs";
import { VERIFICATION_CHECKS } from "../src/subagent-proofs.mjs";

test("every check has a label a reader can act on", () => {
  for (const name of VERIFICATION_CHECKS) {
    assert.equal(typeof CHECK_LABELS[name], "string", `${name} needs a label`);
    assert.doesNotMatch(CHECK_LABELS[name], /v2|certif|relay protocol/i);
  }
});

test("a run is complete only when all five checks passed", () => {
  const all = {};
  for (const name of VERIFICATION_CHECKS) all[name] = { outcome: "pass" };
  assert.equal(checksComplete(all), true);
  assert.equal(firstFailure(all), undefined);

  for (const name of VERIFICATION_CHECKS) {
    const partial = { ...all, [name]: { outcome: "fail", detail: "nope" } };
    assert.equal(checksComplete(partial), false);
    assert.equal(firstFailure(partial).check, name);
    assert.equal(firstFailure(partial).label, CHECK_LABELS[name]);
  }
});

test("the first failure is reported in reviewer order", () => {
  const checks = {
    streaming: { outcome: "pass" },
    toolCall: { outcome: "fail", detail: "no tool call" },
    encryptedRelay: { outcome: "fail" },
    markerReturn: { outcome: "pending" },
    sameThreadFollowUp: { outcome: "pending" },
  };
  assert.equal(firstFailure(checks).check, "toolCall");
  assert.equal(firstFailure(checks).detail, "no tool call");
});

test("markers are unique per run so a stale transcript cannot pass a route", () => {
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) seen.add(newMarker());
  assert.equal(seen.size, 200);
});

test("a parent echoing the marker itself does not count as delegation", () => {
  const marker = "CRV-ABC123";
  // The parent was told the marker, so it appears in its own message. No child
  // ever started; treating this as a pass is exactly how a v1 route would slip
  // into Codex's v2 subagent list.
  const events = [
    { type: "item.completed", item: { type: "agent_message", text: `I will ask for ${marker}` } },
    { type: "turn.completed" },
  ];
  const result = readDelegation(events, { agentName: "router_deepseek_deepseek_v4_flash", marker });
  assert.equal(result.childStarted, false);
  assert.equal(result.markerReturned, false);
});

test("a child that starts and answers is a delegation", () => {
  const marker = "CRV-ABC123";
  const agentName = "router_deepseek_deepseek_v4_flash";
  const events = [
    { type: "item.started", item: { type: "agent_call", agent_type: agentName } },
    { type: "item.completed", item: { type: "agent_call", output: marker } },
    { type: "turn.completed" },
  ];
  const result = readDelegation(events, { agentName, marker });
  assert.equal(result.childStarted, true);
  assert.equal(result.markerReturned, true);
});

test("a child that starts but never returns the marker fails the marker check", () => {
  const agentName = "router_vendor_model";
  const events = [
    { type: "item.started", item: { type: "agent_call", agent_type: agentName } },
    { type: "item.completed", item: { type: "agent_call", output: "I could not comply." } },
  ];
  const result = readDelegation(events, { agentName, marker: "CRV-ZZZ" });
  assert.equal(result.childStarted, true);
  assert.equal(result.markerReturned, false);
});

test("event parsing survives interleaved non-JSON output", () => {
  const stdout = [
    '{"type":"turn.started"}',
    "warning: something on stderr got interleaved",
    '{"type":"turn.completed"}',
    "",
  ].join("\n");
  const events = parseEventLines(stdout);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "turn.started");
  assert.equal(typeof events[1], "string");
  assert.equal(events[2].type, "turn.completed");
});

test("the checks call the endpoint the router actually serves", async () => {
  // A 404 from `chat/completions` was reported to the operator as "this model
  // cannot run subagents". The caller endpoint speaks Responses and takes the
  // caller key as a bearer; both are part of the check, not incidental.
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "subagent-certify.mjs"),
    "utf8",
  );
  assert.match(source, /\$\{baseUrl\}\/responses/);
  // Only the comment explaining the original bug may still name that path.
  assert.doesNotMatch(source, /fetch\([^)]*chat\/completions/);
  assert.doesNotMatch(source, /`\$\{baseUrl\}\/chat\/completions`/);
  assert.match(source, /authorization: `Bearer \$\{secret\}`/);
  // Responses puts the forced call in `output`, not in a chat `message`.
  assert.match(source, /\(payload\?\.output \|\| \[\]\)\.find\(\(item\) => item\?\.type === "function_call"\)/);
  assert.match(source, /tool_choice: \{ type: "function", name: "codex_router_probe" \}/);
});
