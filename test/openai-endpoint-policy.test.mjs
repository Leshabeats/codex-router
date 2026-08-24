import assert from "node:assert/strict";
import test from "node:test";

import {
  adapterForEndpoint,
  endpointCapabilityError,
  normalizeSupportedEndpoints,
  protocolEndpoint,
  supportsOpenAIEndpoint,
} from "../src/openai-endpoint-policy.mjs";

test("endpoint declarations are closed, deduplicated and protocol-aware", () => {
  assert.deepEqual(normalizeSupportedEndpoints(["/embeddings", "/embeddings"]), ["/embeddings"]);
  assert.equal(protocolEndpoint("openai-completions"), "/completions");
  assert.equal(protocolEndpoint("openai-responses"), "/responses");
  assert.equal(adapterForEndpoint("/completions", "openai-chat"), "openai-completions");
  assert.throws(() => normalizeSupportedEndpoints(["/completions"]), /unsupported endpoint/);
});

test("models need an explicit declaration for non-native endpoints", () => {
  assert.equal(supportsOpenAIEndpoint("/chat/completions", { adapter: "openai-chat" }), true);
  assert.equal(supportsOpenAIEndpoint("/embeddings", { adapter: "openai-chat" }), false);
  assert.equal(
    supportsOpenAIEndpoint("/embeddings", {
      adapter: "openai-chat",
      model: { supportedEndpoints: ["/chat/completions", "/embeddings"] },
    }),
    true,
  );
  assert.equal(
    supportsOpenAIEndpoint("/responses", {
      adapter: "openai-chat",
      model: { supportedEndpoints: ["/chat/completions", "/responses"] },
    }),
    false,
  );
  const error = endpointCapabilityError("/embeddings", { displayName: "Text model" });
  assert.equal(error.status, 400);
  assert.equal(error.code, "unsupported_model_endpoint");
});
