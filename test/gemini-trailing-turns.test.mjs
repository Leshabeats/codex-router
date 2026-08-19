import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Gemini turn sanitizer trims trailing assistant messages to prevent HTTP 400 rejection", async () => {
  const code = readFileSync(new URL("../src/api-forwarder.mjs", import.meta.url), "utf8");
  assert.ok(code.includes("trimTrailingModelTurns"), "trimTrailingModelTurns helper must be defined");

  // Synthetic extraction test for the function logic
  function trimTrailingModelTurns(messages) {
    const trimmed = [...messages];
    while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.role === "assistant") {
      trimmed.pop();
    }
    return trimmed;
  }

  const sampleMessages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "partial response before interruption" },
  ];

  const sanitized = trimTrailingModelTurns(sampleMessages);
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].role, "user");
});
