const PROXY_ENVIRONMENT_VARIABLES = [
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
];

// Match EnvHttpProxyAgent's precedence exactly: a present lowercase value,
// including an empty string, overrides its uppercase counterpart. ALL_PROXY
// is preserved for child processes but is not supported by EnvHttpProxyAgent.
export function environmentHttpProxyConfigured(environment = process.env) {
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
  return values;
}
