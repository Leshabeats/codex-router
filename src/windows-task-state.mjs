import { execFile as execFileCallback } from "node:child_process";

// Task Scheduler's `State` can remain Running after its only instance has
// gone. The COM instance enumeration is the authority for whether the managed
// task still has something running; `LastTaskResult` preserves the exit code
// when it does not. A query failure is deliberately inconclusive so a
// restricted shell cannot turn a slow-but-valid startup into a false failure.
export async function windowsScheduledTaskState({
  taskName = "Codex Router",
  execFile = execFileCallback,
  platform = process.platform,
  timeoutMs = 5_000,
  powershellExecutable = "powershell.exe",
} = {}) {
  // Task Scheduler queries must not block the event loop that owns the
  // concurrent router-health probe.
  if (platform !== "win32") return Promise.resolve(undefined);

  const script = [
    "try {",
    "  Get-ScheduledTask -TaskName $env:CODEX_ROUTER_TASK -ErrorAction Stop | Out-Null",
    "  $info = Get-ScheduledTaskInfo -TaskName $env:CODEX_ROUTER_TASK -ErrorAction Stop",
    "  $scheduler = New-Object -ComObject Schedule.Service",
    "  $scheduler.Connect()",
    "  $task = $scheduler.GetFolder('\\').GetTask($env:CODEX_ROUTER_TASK)",
    "  $instances = [array]$task.GetInstances(0)",
    "  [Console]::Out.Write($instances.Count.ToString() + '|' + $info.LastTaskResult)",
    "} catch { exit 1 }",
  ].join("\n");

  const command = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ];
  const options = {
    encoding: "utf8",
    env: { ...process.env, CODEX_ROUTER_TASK: taskName },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    windowsHide: true,
  };

  try {
    const output = String(
      await new Promise((resolve, reject) => {
        execFile(powershellExecutable, command, options, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      }),
    ).trim();
    const separator = output.lastIndexOf("|");
    if (separator < 1) return undefined;
    const instanceCount = Number(output.slice(0, separator));
    const lastTaskResult = Number(output.slice(separator + 1));
    if (!Number.isSafeInteger(instanceCount) || instanceCount < 0) return undefined;
    if (!Number.isSafeInteger(lastTaskResult) || lastTaskResult < 0) return undefined;
    return { instanceCount, lastTaskResult };
  } catch {
    return undefined;
  }
}
