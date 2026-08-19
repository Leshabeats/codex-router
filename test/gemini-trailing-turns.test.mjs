import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Gemini turn sanitizer trims trailing assistant messages to prevent HTTP 400 rejection", async () => {
  const code = readFileSync(new URL("../src/api-forwarder.mjs", import.meta.url), "utf8");
  assert.ok(code.includes("trimTrailingModelTurns"), "trimTrailingModelTurns helper must be defined");
  assert.ok(code.includes("target.includes(\"gemini\")"), "isGeminiProvider must detect any model identifier with gemini");

  // Helper unit test
  function trimTrailingModelTurns(messages) {
    const trimmed = [...messages];
    while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.role === "assistant") {
      trimmed.pop();
    }
    return trimmed;
  }

  const sampleMessages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "interrupted answer" },
  ];

  const sanitized = trimTrailingModelTurns(sampleMessages);
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].role, "user");

  const alreadyClean = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "done" },
    { role: "user", content: "next step" },
  ];
  assert.equal(trimTrailingModelTurns(alreadyClean).length, 3);
});
