import assert from "node:assert/strict";
import test from "node:test";

const { buildClientExport, renderClientExport } = await import("../src/client-exports.mjs");

test("builds a versioned OpenCode descriptor without a raw secret", () => {
  const descriptor = buildClientExport({
    client: "opencode",
    models: [{ id: "deepseek/deepseek-v4-flash-latest", alias: "DeepSeek Flash", capabilities: { tools: true } }],
    capabilities: { chat: true, tools: true, streaming: true },
    metadata: { source: "codex-router" },
  });

  assert.equal(descriptor.schemaVersion, 1);
  assert.equal(descriptor.client, "opencode");
  assert.match(descriptor.gateway.baseUrl, /\$\{CODEX_ROUTER_CALLER_KEY\}/);
  assert.equal(descriptor.gateway.auth.secretRef.name, "CODEX_ROUTER_CALLER_KEY");
  assert.deepEqual(descriptor.models[0], {
    id: "deepseek/deepseek-v4-flash-latest",
    alias: "DeepSeek Flash",
    capabilities: { tools: true },
  });
  assert.ok(!JSON.stringify(descriptor).includes("sk-"));
});

test("supports an explicit endpoint template and custom environment reference", () => {
  const descriptor = buildClientExport({
    client: "openai-compatible",
    baseUrl: "https://router.example.test/v1",
    secretEnv: "MY_ROUTER_KEY",
  });
  assert.equal(descriptor.gateway.baseUrl, "https://router.example.test/v1");
  assert.equal(descriptor.gateway.auth.secretRef.name, "MY_ROUTER_KEY");
  assert.match(renderClientExport({ client: "deepseek-harness", secretEnv: "DSH_ROUTER_KEY" }), /"client": "deepseek-harness"/);
});

test("rejects unsupported clients, invalid capabilities and literal caller secrets", () => {
  assert.throws(() => buildClientExport({ client: "pi" }), /client must be one of/);
  assert.throws(() => buildClientExport({ capabilities: { tools: "yes" } }), /must be boolean/);
  assert.throws(
    () => buildClientExport({ baseUrl: "http://127.0.0.1:4202/_codex-router/raw-secret/v1" }),
    /environment placeholder/,
  );
  assert.throws(() => buildClientExport({ secretEnv: "router-key" }), /environment variable name/);
});

test("does not serialize secret-bearing metadata fields", () => {
  for (const key of ["apiKey", "authorization", "callerKey", "credentialRef", "token"]) {
    assert.throws(
      () => buildClientExport({ metadata: { [key]: "not-safe-to-export" } }),
      /cannot contain a secret/,
    );
  }
});
