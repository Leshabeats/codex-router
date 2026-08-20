const PROXY_ENVIRONMENT_VARIABLES = [
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_USE_ENV_PROXY",
];

// Node's built-in proxy support is deliberately opt-in. Keep the same
// contract when the router installs its own HTTP/1.1 dispatcher: merely
// inheriting HTTP(S)_PROXY from a shell must not silently reroute traffic.
// `--use-env-proxy` is allowed in NODE_OPTIONS on supported Node releases;
// process.execArgv covers the equivalent direct command-line form.
export function environmentProxyOptedIn(
  environment = process.env,
  execArgv = process.execArgv,
) {
  if (Array.isArray(execArgv) && execArgv.includes("--use-env-proxy")) return true;
  if (/(^|\s)--use-env-proxy(?:\s|$)/.test(String(environment.NODE_OPTIONS || ""))) {
    return true;
  }
  return environment.NODE_USE_ENV_PROXY === "1";
}

// Match EnvHttpProxyAgent's precedence exactly: a present lowercase value,
// including an empty string, overrides its uppercase counterpart. ALL_PROXY
// is preserved for child processes but is not supported by EnvHttpProxyAgent.
export function environmentHttpProxyConfigured(
  environment = process.env,
  execArgv = process.execArgv,
) {
  if (!environmentProxyOptedIn(environment, execArgv)) return false;
  const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY;
  const httpsProxy = environment.https_proxy ?? environment.HTTPS_PROXY;
  return Boolean(httpProxy || httpsProxy);
}

// Background service managers do not read a user's shell startup files. Keep
// the proxy environment present during installation so the router and the
// child processes it launches see the same network policy after a restart.
export function serviceProxyEnvironment(environment = process.env) {
  const values = {};
  for (const name of PROXY_ENVIRONMENT_VARIABLES) {
    if (environment[name] !== undefined) values[name] = environment[name];
  }
  // A command-line flag is not automatically present in the environment of a
  // later launchd/systemd/Task Scheduler invocation. Persist the equivalent
  // environment opt-in so the service and every Node child retain the same
  // decision after the installer exits. A positive CLI/NODE_OPTIONS opt-in
  // wins over NODE_USE_ENV_PROXY=0, matching Node's precedence.
  if (environmentProxyOptedIn(environment)) values.NODE_USE_ENV_PROXY = "1";
  return values;
}
