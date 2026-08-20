import { useMemo, useState, type FormEvent } from "react";
import { ChevronDown, KeyRound, Link2, LogIn, SearchX, ShieldCheck, Trash2 } from "lucide-react";
import { Badge, Button, Dialog, EmptyState, PageHeader, SearchField, StatStrip, Toggle } from "../components";
import { ProviderLogo } from "../provider-branding";
import type { ProviderSetup, ProviderSetupSnapshot, ProviderUsageSnapshot, RouterControlApi, RouterTarget } from "../types";
import "./providers-models.css";

type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;

export function ProvidersPage({ target, setup, usage, api, refreshing, onRefresh, runAction }: {
  target?: RouterTarget;
  setup?: ProviderSetupSnapshot;
  usage?: ProviderUsageSnapshot;
  api?: RouterControlApi;
  refreshing: boolean;
  onRefresh: () => void;
  runAction: RunAction;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "connected" | "available">("all");
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [credentialProvider, setCredentialProvider] = useState<ProviderSetup | null>(null);
  const [removeProvider, setRemoveProvider] = useState<ProviderSetup | null>(null);
  const providers = setup?.providers ?? [];
  const enabled = new Set(target?.enabledProviders ?? []);
  const modelsPerProvider = new Map<string, number>();
  for (const model of target?.models ?? []) {
    modelsPerProvider.set(model.provider, (modelsPerProvider.get(model.provider) ?? 0) + 1);
  }
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return providers
      .filter((provider) => {
        if (filter === "connected" && !provider.configured) return false;
        if (filter === "available" && provider.configured) return false;
        return !needle || `${provider.displayName} ${provider.id} ${provider.kind}`.toLowerCase().includes(needle);
      })
      .sort((left, right) => Number(right.configured) - Number(left.configured) || left.displayName.localeCompare(right.displayName));
  }, [providers, filter, search]);
  const usageById = new Map((usage?.providers ?? []).map((provider) => [provider.id, provider]));
  const connectedCount = providers.filter((provider) => provider.configured).length;

  return (
    <>
      <div className="providers-models-page providers-page">
        <PageHeader
          eyebrow="Connections"
          title="Providers"
          description="Connect provider accounts, manage credentials, and choose which model networks the router can use."
          onRefresh={onRefresh}
          refreshing={refreshing}
        />
        <StatStrip items={[
          { label: "Providers", value: providers.length, detail: "Registered families" },
          { label: "Connected", value: connectedCount, detail: "Credential resolved" },
          { label: "Selected", value: enabled.size, detail: "Catalog selection" },
          { label: "Needs setup", value: providers.length - connectedCount, detail: "OAuth or API key" },
        ]} />

        <section className="panel-section pm-provider-directory">
          <div className="pm-provider-toolbar">
            <SearchField value={search} onChange={setSearch} placeholder="Search providers" />
            <div className="pm-toolbar-summary" aria-live="polite">
              <span>{filtered.length} shown</span>
              <div className="segmented-control compact" role="radiogroup" aria-label="Provider connection filter">
                {(["all", "connected", "available"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={filter === value}
                    className={filter === value ? "is-active" : ""}
                    onClick={() => setFilter(value)}
                  >
                    {value === "available" ? "Needs setup" : value[0].toUpperCase() + value.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {filtered.length ? (
            <div className="pm-provider-list">
              {filtered.map((provider) => {
                const providerUsage = usageById.get(provider.id);
                const configured = provider.configured;
                const isEnabled = enabled.has(provider.id);
                const isLocal = provider.id === "local";
                const modelCount = modelsPerProvider.get(provider.id) ?? 0;
                const needsCuration = configured && modelCount === 0 && provider.id !== "local";
                const expanded = expandedProviderId === provider.id;
                const triggerId = `provider-trigger-${safeId(provider.id)}`;
                const panelId = `provider-panel-${safeId(provider.id)}`;
                return (
                  <article
                    className="pm-provider-row"
                    key={provider.id}
                    data-connection={configured ? "connected" : "setup"}
                    data-expanded={expanded}
                  >
                    <button
                      id={triggerId}
                      className="pm-provider-summary"
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      onClick={() => setExpandedProviderId(expanded ? null : provider.id)}
                    >
                      <ProviderLogo providerId={provider.id} displayName={provider.displayName} size="large" />
                      <div className="pm-provider-main">
                        <div className="pm-provider-title-line">
                          <strong>{provider.displayName}</strong>
                          <Badge tone={configured ? "success" : "neutral"}>{configured ? "connected" : "not connected"}</Badge>
                          <Badge tone="neutral">{connectionMethod(provider)}</Badge>
                        </div>
                        <small>{provider.id}</small>
                      </div>
                      <dl className="pm-provider-facts">
                        <div><dt>Models</dt><dd>{modelCount}</dd></div>
                        <div><dt>Requests</dt><dd>{providerUsage?.requests || 0}</dd></div>
                      </dl>
                      <ChevronDown className="pm-accordion-chevron" aria-hidden size={16} strokeWidth={1.7} />
                    </button>
                    <div
                      id={panelId}
                      className="pm-provider-panel"
                      role="region"
                      aria-labelledby={triggerId}
                      hidden={!expanded}
                    >
                      <div className="pm-provider-panel-copy">
                        <p>{provider.planNote || connectionDetail(provider, providerUsage?.account?.status, providerUsage?.account?.message, needsCuration, api?.platform === "darwin")}</p>
                        {needsCuration ? <span className="pm-curation-note">No models selected yet. Curate this catalog from an interactive terminal.</span> : null}
                      </div>
                      <div className="pm-provider-controls">
                        <div className="pm-provider-actions">
                          {provider.kind === "oauth" || provider.signIn ? (
                            <Button
                              variant="ghost"
                              disabled={!api || api.platform !== "darwin"}
                              title={api?.platform === "darwin" ? undefined : "Open the provider CLI in your own terminal on Windows or Linux."}
                              onClick={() => api && void runAction(`Start ${provider.displayName} sign-in`, () => api.connectProvider(provider.id))}
                            >
                              <LogIn aria-hidden size={14} strokeWidth={1.7} />
                              {configured ? "Reconnect in terminal" : provider.cliInstalled === false ? "Install and open sign-in" : "Open sign-in"}
                            </Button>
                          ) : null}
                          {provider.kind === "api" && !isLocal ? (
                            <Button variant="ghost" disabled={!api} onClick={() => setCredentialProvider(provider)}>
                              <KeyRound aria-hidden size={14} strokeWidth={1.7} />
                              {configured ? "Replace key" : "Add key"}
                            </Button>
                          ) : null}
                          {provider.kind === "api" && configured && provider.id !== "local" ? (
                            <Button
                              variant="ghost"
                              disabled={!api}
                              aria-label={`Remove ${provider.displayName} credential`}
                              title="Remove credential"
                              onClick={() => setRemoveProvider(provider)}
                            >
                              <Trash2 aria-hidden size={14} strokeWidth={1.7} />
                            </Button>
                          ) : null}
                        </div>
                        <div className="pm-provider-enable">
                          <span>{isEnabled ? configured ? "Enabled for installed clients" : "Selected, needs credential" : "Disabled for installed clients"}</span>
                          <Toggle
                            checked={isEnabled}
                            disabled={!api || !configured}
                            label={`Enable ${provider.displayName} for installed clients`}
                            onChange={(checked) => api && void runAction(`${checked ? "Enable" : "Disable"} ${provider.displayName}`, () => api.setProviderEnabled(provider.id, checked))}
                          />
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState icon={<SearchX size={20} />} title="No matching providers" body="Clear the search or change the connection filter." />
          )}
        </section>
      </div>

      <CredentialDialog provider={credentialProvider} api={api} runAction={runAction} onClose={() => setCredentialProvider(null)} />
      <Dialog
        open={Boolean(removeProvider)}
        title="Remove provider credential"
        description="The provider is withdrawn from installed clients before its managed credential is deleted."
        onClose={() => setRemoveProvider(null)}
      >
        <div className="pm-credential-warning">
          <ShieldCheck aria-hidden size={17} strokeWidth={1.7} />
          <p>If a credential also exists in the environment or Keychain, the router will still report it as connected.</p>
        </div>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setRemoveProvider(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => {
            const provider = removeProvider;
            setRemoveProvider(null);
            if (provider && api) void runAction(`Remove ${provider.displayName} credential`, () => api.removeProviderCredential(provider.id));
          }}>
            <Trash2 aria-hidden size={14} strokeWidth={1.7} /> Remove credential
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function CredentialDialog({ provider, api, runAction, onClose }: {
  provider: ProviderSetup | null;
  api?: RouterControlApi;
  runAction: RunAction;
  onClose: () => void;
}) {
  const [credential, setCredential] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!provider || !api || !credential.trim()) return;
    const secret = credential;
    setCredential("");
    onClose();
    await runAction(`Save ${provider.displayName} credential`, () => api.saveProviderCredential(provider.id, secret));
  }
  function close() {
    setCredential("");
    onClose();
  }
  return (
    <Dialog
      open={Boolean(provider)}
      title={provider?.configured ? `Replace ${provider.displayName} credential` : `Connect ${provider?.displayName || "provider"}`}
      description="The secret is sent once to the router's hidden standard-input prompt. It is never added to a command."
      onClose={close}
    >
      <form className="pm-credential-form" onSubmit={(event) => void submit(event)}>
        {provider ? (
          <div className="pm-credential-provider">
            <ProviderLogo providerId={provider.id} displayName={provider.displayName} size="large" />
            <div><strong>{provider.displayName}</strong><small>{provider.id}</small></div>
          </div>
        ) : null}
        <label htmlFor="provider-credential">{provider?.credentialLabel || "API key"}</label>
        <input
          id="provider-credential"
          type="password"
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="Enter credential"
          autoFocus
        />
        <p><Link2 aria-hidden size={13} strokeWidth={1.7} /> The value is not placed in logs, command arguments, localStorage, or saved renderer state.</p>
        <div className="dialog-actions">
          <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!credential.trim()}>Save credential</Button>
        </div>
      </form>
    </Dialog>
  );
}

function connectionMethod(provider: ProviderSetup): string {
  if (provider.id === "local") return "Local runtime";
  if (provider.kind === "oauth") return "OAuth";
  if (provider.signIn) return "Key or sign-in";
  return provider.credentialLabel || "API key";
}

function connectionDetail(provider: ProviderSetup, accountStatus?: string, accountMessage?: string, needsCuration?: boolean, canOpenTerminal?: boolean): string {
  if (needsCuration) return "The credential is ready, but this catalog-only provider has no locally selected models.";
  if (accountStatus === "unavailable") return accountMessage || "Account usage is unavailable. Reconnect if the session expired.";
  if (provider.configured) return "Credential ready. You can disable routing without disconnecting the account.";
  if (provider.kind === "oauth") {
    if (!canOpenTerminal) return "Run the official provider sign-in command in your own terminal, then refresh this page.";
    return provider.cliInstalled === false
      ? "The official CLI will be installed, then sign-in will open in your system terminal."
      : "Sign in through the official provider CLI in your system terminal, then refresh to enable it.";
  }
  if (provider.signIn) return `Add ${provider.credentialLabel || "an API key"}, or use the provider's browser sign-in.`;
  return `Add ${provider.credentialLabel || "an API key"} to connect this provider.`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
