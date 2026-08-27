import { spawnSync } from "node:child_process";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";

const SERVICE_SCRIPT = path.join(SOURCE_ROOT, "src", "service.mjs");

// The router reads its model registry at process start, so a local-model route
// added through `control local-models set` is only routable after the
// background service reloads it. Probe the service first: dev checkouts and
// test harnesses run the router in the foreground, where there is nothing to
// restart.
export function routerServiceStatus({ spawn = spawnSync, env = process.env } = {}) {
  const result = spawn(process.execPath, [SERVICE_SCRIPT, "status"], {
    cwd: SOURCE_ROOT,
    env,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return { installed: false };
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      installed: parsed.installed === true,
      loaded: parsed.loaded === true,
      state: typeof parsed.state === "string" ? parsed.state : undefined,
    };
  } catch {
    return { installed: false };
  }
}

// A running managed service cannot acquire a newly named shell variable from a
// restart: launchd, systemd, and Task Scheduler replay the environment already
// stored in their private definitions. Publishing an environment-backed pool
// before that definition is re-rendered would advertise models the live router
// cannot authenticate. Stage only while the service is stopped, then let the
// installer render and start it from the same environment.
export function environmentPoolMutationServiceStatus({ spawn = spawnSync, env = process.env } = {}) {
  const status = routerServiceStatus({ spawn, env });
  if (status.installed && status.loaded) {
    const error = new Error(
      "Cannot add an environment-backed API-key pool entry while the managed router service is running. " +
        "Stop the service, repeat the command with every pooled variable set, then rerun the installer; " +
        "a restart alone does not rewrite the service environment.",
    );
    error.code = "provider_api_key_pool_service_environment_stale";
    throw error;
  }
  return {
    ...status,
    serviceReinstallRequired: status.installed === true,
  };
}

export function restartRouterServiceIfInstalled({ spawn = spawnSync, env = process.env } = {}) {
  if (!routerServiceStatus({ spawn, env }).installed) return false;
  const result = spawn(process.execPath, [SERVICE_SCRIPT, "restart"], {
    cwd: SOURCE_ROOT,
    env,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      "The router service could not be restarted; local model routes will not go live until it is.",
    );
  }
  return true;
}
