const OVERLAYS = {
  "efficient-agentic": `## Routed execution discipline
- Continue through routine tool work without narrating each routine tool step. Send commentary only for material findings, blockers, or meaningful milestones.
- Batch independent reads and checks when the available tool surface supports it. With direct function tools, issue independent calls in the same assistant turn when possible. Do not invent helper tools; use only tools exposed in the current turn.
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
