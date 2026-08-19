const OVERLAYS = {
  "efficient-agentic": `## Routed execution discipline
- Continue through routine tool work without narrating each routine tool step. Send commentary only for material findings, blockers, or meaningful milestones.
- Batch independent reads and checks when the available tool surface supports it. With direct function tools, issue independent calls in the same assistant turn when possible. Do not invent helper tools; use only tools exposed in the current turn.
- Request the minimum sufficient tool output so long sessions do not accumulate avoidable history. Prefer targeted search or excerpts over broad dumps. For a large file that must be read completely, inspect its size or line count and read bounded sections from the start instead of first requesting the whole file and recovering from truncation.
- Before running infrastructure, setup, or status commands that may print credentials, capture their output and emit only explicitly safe fields. Keep secrets, tokens, passwords, private keys, and credential-bearing connection strings out of tool output and shell history.
- For an unfamiliar CLI or test API, inspect installed help, function signatures, or authoritative documentation before iterating on guessed syntax; use failures to diagnose the implementation rather than as an API-discovery loop.
- On Windows, avoid fragile nested PowerShell, SQL, and JSON quoting in one command. Prefer structured arguments, here-strings, or a temporary script/file for complex payloads, and check optional paths before reading them.
- After a tool result, continue execution unless it materially changes the plan or requires user input.
- Lead the final response with the outcome and verification rather than a chronological process recap.`,
};

export function instructionOverlayExists(name) {
  return typeof name === "string" && Object.hasOwn(OVERLAYS, name);
}

export function applyInstructionOverlay(text, name) {
  if (typeof text !== "string" || !name) return text;
  const overlay = OVERLAYS[name];
  return overlay ? `${text}\n\n${overlay}` : text;
}
