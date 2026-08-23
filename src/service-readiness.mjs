import { waitForRouterHealth } from "./router-health.mjs";
import { windowsScheduledTaskState } from "./windows-task-state.mjs";

const TASK_LAUNCH_GRACE_MS = 15_000;
const TASK_STATE_POLL_MS = 1_000;

function sleep(milliseconds) {
  return milliseconds <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Wait for router health while honoring Windows' authoritative task state.
 *
 * A short absence from Task Scheduler's instance enumeration is tolerated as
 * launch lag. Once that absence persists, fail before the full readiness
 * budget instead of polling health from a task that is no longer running.
 */
export async function waitForServiceReadiness({
  platform = process.platform,
  timeoutMs = 300_000,
  launchGraceMs = TASK_LAUNCH_GRACE_MS,
  pollMs = TASK_STATE_POLL_MS,
  getWindowsTaskState = windowsScheduledTaskState,
  waitForHealth = waitForRouterHealth,
} = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  // Keep exactly one rejection handler attached for the whole operation; the
  // readiness guard may finish first and must not create an unhandled rejection.
  const healthOutcome = waitForHealth({ timeoutMs }).then(
    (health) => ({ ok: true, health }),
    (error) => ({ ok: false, error }),
  );

  if (platform !== "win32") {
    const outcome = await healthOutcome;
    if (outcome.ok) return outcome.health;
    throw outcome.error;
  }

  let absentSince;
  while (Date.now() < deadline) {
    const winner = await Promise.race([
      healthOutcome,
      sleep(Math.min(pollMs, deadline - Date.now())).then(() => null),
    ]);
    if (winner) {
      if (winner.ok) return winner.health;
      throw winner.error;
    }

    let taskState;
    try {
      taskState = await getWindowsTaskState();
    } catch {
      taskState = undefined;
    }
    if (taskState?.instanceCount === 0) {
      absentSince ??= Date.now();
      if (Date.now() - absentSince >= launchGraceMs) {
        const result = Number.isSafeInteger(taskState.lastTaskResult)
          ? `0x${taskState.lastTaskResult.toString(16)}`
          : "unknown";
        throw new Error(
          `Windows Scheduled Task has no running instance (LastTaskResult=${result}); router cannot become healthy.`,
        );
      }
    } else if (taskState?.instanceCount > 0) {
      absentSince = undefined;
    }
  }

  const outcome = await healthOutcome;
  if (outcome.ok) return outcome.health;
  throw outcome.error;
}
