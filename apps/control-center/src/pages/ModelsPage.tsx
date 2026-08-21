import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ChevronDown, KeyRound, Link2, LogIn, SearchX, ShieldCheck, Trash2 } from "lucide-react";
import { Badge, Button, Dialog, EmptyState, PageHeader, SearchField, SectionHeading, StatStrip, Toggle } from "../components";
import { BrandLogo, ProviderLogo, brandForModel } from "../provider-branding";
import { formatContext } from "../lib";
import type {
  ModelViewFocusRequest,
  ProviderSetup,
  ProviderSetupSnapshot,
  ProviderUsageSnapshot,
  RouterControlApi,
  RouterModel,
  RouterTarget,
} from "../types";
import "./providers-models.css";

type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;
type ConnectionFilter = "all" | "connected" | "available";

interface ModelsPageProps {
  target?: RouterTarget;
  setup?: ProviderSetupSnapshot;
  usage?: ProviderUsageSnapshot;
  api?: RouterControlApi;
  refreshing: boolean;
  onRefresh: () => void;
  runAction: RunAction;
  focusRequest?: ModelViewFocusRequest;
}

interface ProviderDirectoryEntry {
  id: string;
  displayName: string;
  setup?: ProviderSetup;
  models: RouterModel[];
}

function subagentEnabled(target: RouterTarget, slug: string): boolean {
  const settings = target.modelSettings?.subagents;
  if (!settings) return false;
  if (settings.disabled.includes(slug)) return false;
  if (settings.mode === "all") return true;
  if (settings.mode === "proven") {
    return target.models.find((model) => model.slug === slug)?.multiAgentVersion === "v2";
  }
  return settings.enabled.includes(slug);
}

export function ModelsPage({ target, setup, usage, api, refreshing, onRefresh, runAction, focusRequest }: ModelsPageProps) {
  const [search, setSearch] = useState("");
  const [connectionFilter, setConnectionFilter] = useState<ConnectionFilter>("all");
  const [enabledModelsOnly, setEnabledModelsOnly] = useState(true);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [credentialProvider, setCredentialProvider] = useState<ProviderSetup | null>(null);
  const [removeProvider, setRemoveProvider] = useState<ProviderSetup | null>(null);

  const models = target?.models ?? [];
  const enabledProviders = useMemo(() => new Set(target?.enabledProviders ?? []), [target?.enabledProviders]);
  const usageById = useMemo(
    () => new Map((usage?.providers ?? []).map((provider) => [provider.id, provider])),
    [usage?.providers],
  );
  const directory = useMemo<ProviderDirectoryEntry[]>(() => {
    const entries = new Map<string, ProviderDirectoryEntry>();
    for (const provider of setup?.providers ?? []) {
      entries.set(provider.id, { id: provider.id, displayName: provider.displayName, setup: provider, models: [] });
    }
    for (const provider of target?.providers ?? []) {
      const current = entries.get(provider.id);
      entries.set(provider.id, {
        id: provider.id,
        displayName: current?.displayName || provider.displayName,
        setup: current?.setup,
        models: current?.models ?? [],
      });
    }
    for (const model of models) {
      const current = entries.get(model.provider);
      entries.set(model.provider, {
        id: model.provider,
        displayName: current?.displayName || providerDisplayName(model.provider),
        setup: current?.setup,
        models: [...(current?.models ?? []), model],
      });
    }
    return [...entries.values()].sort((left, right) => {
      const leftConnected = providerConnected(left, enabledProviders);
      const rightConnected = providerConnected(right, enabledProviders);
      return Number(rightConnected) - Number(leftConnected) || left.displayName.localeCompare(right.displayName);
    });
  }, [enabledProviders, models, setup?.providers, target?.providers]);

  const filteredDirectory = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return directory.flatMap((entry) => {
      const connected = providerConnected(entry, enabledProviders);
      if (connectionFilter === "connected" && !connected) return [];
      if (connectionFilter === "available" && connected) return [];
      const providerMatch = !needle || `${entry.displayName} ${entry.id} ${entry.setup?.kind || ""}`.toLowerCase().includes(needle);
      const visibleModels = entry.models.filter((model) => {
        if (enabledModelsOnly && !model.enabled && !model.native) return false;
        if (providerMatch) return true;
        const maker = brandForModel(model).name;
        return `${model.displayName} ${model.slug} ${maker}`.toLowerCase().includes(needle);
      });
      if (!providerMatch && !visibleModels.length) return [];
      return [{ ...entry, visibleModels }];
    });
  }, [connectionFilter, directory, enabledModelsOnly, enabledProviders, search]);

  useEffect(() => {
    if (!focusRequest) return;
    const id = focusRequest.region === "providers" ? "model-provider-directory" : "model-catalog-controls";
    const frame = window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);

  if (!target) {
    return <EmptyState icon={<SearchX size={22} />} title="Router snapshot unavailable" body="Start the router or refresh after setup completes." />;
  }

  const externalModels = models.filter((model) => !model.native && model.enabled);
  const selectedExternalModel = externalModels.some((model) => model.slug === target.selectedModel) ? target.selectedModel : "";
  const visibleCount = models.filter((model) => model.visible).length;
  const enabledCount = models.filter((model) => model.enabled || model.native).length;
  const v2Count = models.filter((model) => model.multiAgentVersion === "v2" && model.enabled).length;
  const connectedProviderCount = directory.filter((entry) => providerConnected(entry, enabledProviders)).length;
  const shownModelCount = filteredDirectory.reduce((total, entry) => total + entry.visibleModels.length, 0);

  const updatePicker = (slug: string, visible: boolean) =>
    api ? runAction(`${visible ? "Show" : "Hide"} ${slug}`, () => api.setPickerModel(slug, visible)) : Promise.resolve();
  const updateSubagent = (slug: string, enabled: boolean) =>
    api ? runAction(`${enabled ? "Enable" : "Disable"} ${slug} as subagent`, () => api.setSubagentModel(slug, enabled)) : Promise.resolve();

  return (
    <>
      <div className="providers-models-page models-page">
        <PageHeader
          eyebrow="Connections and catalog"
          title="Models"
          description="Connect each provider and manage its Codex picker and subagent models in one directory."
          onRefresh={onRefresh}
          refreshing={refreshing}
        />

        <StatStrip items={[
          { label: "Providers", value: connectedProviderCount, detail: `${directory.length} registered` },
          { label: "Available", value: enabledCount, detail: `${models.length} models registered` },
          { label: "In picker", value: visibleCount, detail: `${models.length - visibleCount} hidden` },
          { label: "Agent-ready", value: v2Count, detail: "Native v2 relay" },
        ]} />

        <div className="pm-model-layout" id="model-catalog-controls">
          <section className="panel-section pm-model-policy">
            <SectionHeading title="Default routed model" description="The model Codex starts new tasks on while it routes without an OpenAI login." />
            <div className="settings-list">
              <div className="setting-row">
                <div>
                  <strong>Default model</strong>
                  <small>{target.loginFree ? "Choose from the external models you have enabled." : "Selectable once “Use without OpenAI login” is on in Settings."}</small>
                </div>
                {target.loginFree ? (
                  <select aria-label="Default routed model" value={selectedExternalModel} disabled={!api || !externalModels.length} onChange={(event) => api && void runAction("Change default model", () => api.setDefaultModel(event.target.value))}>
                    {!selectedExternalModel ? <option value="">Choose a model</option> : null}
                    {externalModels.map((model) => <option key={model.slug} value={model.slug}>{model.displayName}</option>)}
                  </select>
                ) : <code>{target.selectedModel || "Codex default"}</code>}
              </div>
            </div>
          </section>

          <section className="panel-section pm-model-policy">
            <SectionHeading
              title="Subagent catalog"
              description="Select which proven models Codex can delegate work to. Picker visibility is managed per provider below."
              action={
                <select aria-label="Subagent selection mode" value={target.modelSettings?.subagents.mode ?? "selected"} disabled={!api} onChange={(event) => api && void runAction("Change subagent mode", () => api.setSubagentMode(event.target.value as "all" | "selected" | "proven"))}>
                  <option value="selected">Selected models</option>
                  <option value="proven">All proven v2 models</option>
                  <option value="all">All available models</option>
                </select>
              }
            />
            <div className="pm-policy-actions">
              <Button variant="ghost" disabled={!api} onClick={() => api && void runAction("Select all subagent models", () => api.setSubagentSelection(true))}>Select all</Button>
              <Button variant="ghost" disabled={!api} onClick={() => api && void runAction("Clear subagent selection", () => api.setSubagentSelection(false))}>Clear selection</Button>
              <span>Restart Codex after catalog changes.</span>
            </div>
          </section>

          <section className="panel-section pm-provider-directory pm-unified-directory" id="model-provider-directory">
            <div className="pm-provider-toolbar">
              <SearchField value={search} onChange={setSearch} placeholder="Search providers, models, or companies" />
              <label className="check-label"><input type="checkbox" checked={enabledModelsOnly} onChange={(event) => setEnabledModelsOnly(event.target.checked)} /> Enabled models only</label>
              <span className="pm-toolbar-spacer" />
              <span className="pm-results-count" aria-live="polite">{filteredDirectory.length} providers · {shownModelCount} models</span>
              <Button variant="ghost" disabled={!api} onClick={() => api && void runAction("Show all picker models", () => api.setPickerModels(true))}>Show all</Button>
              <Button variant="ghost" disabled={!api} onClick={() => api && void runAction("Hide all picker models", () => api.setPickerModels(false))}>Hide all</Button>
              <div className="segmented-control compact" role="radiogroup" aria-label="Provider connection filter">
                {(["all", "connected", "available"] as const).map((value) => (
                  <button key={value} type="button" role="radio" aria-checked={connectionFilter === value} className={connectionFilter === value ? "is-active" : ""} onClick={() => setConnectionFilter(value)}>
                    {value === "available" ? "Needs setup" : value[0].toUpperCase() + value.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {filteredDirectory.length ? (
              <div className="pm-provider-list">
                {filteredDirectory.map((entry) => {
                  const providerUsage = usageById.get(entry.id);
                  const configured = providerConnected(entry, enabledProviders);
                  const isEnabled = enabledProviders.has(entry.id) || entry.models.some((model) => model.native);
                  const needsCuration = configured && entry.models.length === 0 && entry.id !== "local" && entry.id !== "openai";
                  const expanded = expandedProviderId === entry.id;
                  const triggerId = `provider-trigger-${safeId(entry.id)}`;
                  const panelId = `provider-panel-${safeId(entry.id)}`;
                  return (
                    <article className="pm-provider-row" key={entry.id} data-connection={configured ? "connected" : "setup"} data-expanded={expanded}>
                      <button id={triggerId} className="pm-provider-summary" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpandedProviderId(expanded ? null : entry.id)}>
                        <ProviderLogo providerId={entry.id} displayName={entry.displayName} size="large" />
                        <div className="pm-provider-main">
                          <div className="pm-provider-title-line">
                            <strong>{entry.displayName}</strong>
                            <Badge tone={configured ? "success" : "neutral"}>{configured ? "connected" : "not connected"}</Badge>
                            <Badge tone="neutral">{connectionMethod(entry)}</Badge>
                          </div>
                          <small>{entry.id}</small>
                        </div>
                        <dl className="pm-provider-facts">
                          <div><dt>Models</dt><dd>{entry.models.length}</dd></div>
                          <div><dt>Requests</dt><dd>{providerUsage?.requests || 0}</dd></div>
                        </dl>
                        <ChevronDown className="pm-accordion-chevron" aria-hidden size={16} strokeWidth={1.7} />
                      </button>
                      <div id={panelId} className="pm-provider-detail" role="region" aria-labelledby={triggerId} hidden={!expanded}>
                        <div className="pm-provider-connection">
                          <div className="pm-provider-panel-copy">
                            <p>{entry.setup?.planNote || connectionDetail(entry, providerUsage?.account?.status, providerUsage?.account?.message, needsCuration, api?.platform === "darwin")}</p>
                            {needsCuration ? <span className="pm-curation-note">No models selected yet. Curate this catalog from an interactive terminal.</span> : null}
                          </div>
                          {entry.setup ? (
                            <div className="pm-provider-controls">
                              <div className="pm-provider-actions">
                                {entry.setup.kind === "oauth" || entry.setup.signIn ? (
                                  <Button variant="ghost" disabled={!api || api.platform !== "darwin"} title={api?.platform === "darwin" ? undefined : "Open the provider CLI in your own terminal on Windows or Linux."} onClick={() => api && void runAction(`Start ${entry.displayName} sign-in`, () => api.connectProvider(entry.id))}>
                                    <LogIn aria-hidden size={14} strokeWidth={1.7} />
                                    {entry.setup.configured ? "Reconnect in terminal" : entry.setup.cliInstalled === false ? "Install and open sign-in" : "Open sign-in"}
                                  </Button>
                                ) : null}
                                {entry.setup.kind === "api" && entry.id !== "local" ? (
                                  <Button variant="ghost" disabled={!api} onClick={() => setCredentialProvider(entry.setup!)}>
                                    <KeyRound aria-hidden size={14} strokeWidth={1.7} /> {entry.setup.configured ? "Replace key" : "Add key"}
                                  </Button>
                                ) : null}
                                {entry.setup.kind === "api" && entry.setup.configured && entry.id !== "local" ? (
                                  <Button variant="ghost" disabled={!api} aria-label={`Remove ${entry.displayName} credential`} title="Remove credential" onClick={() => setRemoveProvider(entry.setup!)}>
                                    <Trash2 aria-hidden size={14} strokeWidth={1.7} />
                                  </Button>
                                ) : null}
                              </div>
                              <div className="pm-provider-enable">
                                <span>{isEnabled ? "Enabled for installed clients" : "Disabled for installed clients"}</span>
                                <Toggle checked={isEnabled} disabled={!api || !entry.setup.configured} label={`Enable ${entry.displayName} for installed clients`} onChange={(checked) => api && void runAction(`${checked ? "Enable" : "Disable"} ${entry.displayName}`, () => api.setProviderEnabled(entry.id, checked))} />
                              </div>
                            </div>
                          ) : null}
                        </div>

                        {entry.visibleModels.length ? (
                          <div className="pm-model-list" role="list" aria-label={`${entry.displayName} models`}>
                            {entry.visibleModels.map((model) => {
                              const eligible = model.multiAgentVersion === "v2";
                              const maker = brandForModel(model);
                              return (
                                <article className="pm-model-row" role="listitem" key={model.slug}>
                                  <div className="pm-model-identity">
                                    <BrandLogo brand={maker} size="medium" />
                                    <div><strong>{model.displayName}</strong><span>{maker.name}</span><small title={model.slug}>{model.slug}</small></div>
                                  </div>
                                  <div className="pm-model-meta">
                                    <span>{formatContext(model.contextWindow)}</span>
                                    <span>{model.inputModalities?.includes("image") ? "Text + image" : "Text"}</span>
                                    <Badge tone={eligible ? "accent" : "neutral"}>{eligible ? "v2 relay" : "v1 relay"}</Badge>
                                  </div>
                                  <div className="pm-model-controls">
                                    <div className="pm-model-control"><span>Picker</span><Toggle checked={model.visible} disabled={!api} label={`Show ${model.displayName} in picker`} onChange={(checked) => void updatePicker(model.slug, checked)} /></div>
                                    <div className="pm-model-control" title={eligible ? "Expose as a native v2 subagent" : "This model uses the conservative v1 relay"}><span>Subagent</span><Toggle checked={eligible && subagentEnabled(target, model.slug)} disabled={!api || !eligible} label={`Use ${model.displayName} as subagent`} onChange={(checked) => void updateSubagent(model.slug, checked)} /></div>
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        ) : <div className="pm-provider-model-empty">{entry.models.length ? "No enabled models match the current filter." : "No models are selected for this provider yet."}</div>}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : <EmptyState icon={<SearchX size={20} />} title="No providers or models match" body="Clear a filter or connect another provider." />}
          </section>
        </div>
      </div>

      <CredentialDialog provider={credentialProvider} api={api} runAction={runAction} onClose={() => setCredentialProvider(null)} />
      <Dialog open={Boolean(removeProvider)} title="Remove provider credential" description="The provider is withdrawn from installed clients before its managed credential is deleted." onClose={() => setRemoveProvider(null)}>
        <div className="pm-credential-warning"><ShieldCheck aria-hidden size={17} strokeWidth={1.7} /><p>If a credential also exists in the environment or Keychain, the router will still report it as connected.</p></div>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setRemoveProvider(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { const provider = removeProvider; setRemoveProvider(null); if (provider && api) void runAction(`Remove ${provider.displayName} credential`, () => api.removeProviderCredential(provider.id)); }}><Trash2 aria-hidden size={14} strokeWidth={1.7} /> Remove credential</Button>
        </div>
      </Dialog>
    </>
  );
}

function CredentialDialog({ provider, api, runAction, onClose }: { provider: ProviderSetup | null; api?: RouterControlApi; runAction: RunAction; onClose: () => void }) {
  const [credential, setCredential] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!provider || !api || !credential.trim()) return;
    const secret = credential;
    setCredential("");
    onClose();
    await runAction(`Save ${provider.displayName} credential`, () => api.saveProviderCredential(provider.id, secret));
  }
  function close() { setCredential(""); onClose(); }
  return (
    <Dialog open={Boolean(provider)} title={provider?.configured ? `Replace ${provider.displayName} credential` : `Connect ${provider?.displayName || "provider"}`} description="The secret is sent once to the router's hidden standard-input prompt. It is never added to a command." onClose={close}>
      <form className="pm-credential-form" onSubmit={(event) => void submit(event)}>
        {provider ? <div className="pm-credential-provider"><ProviderLogo providerId={provider.id} displayName={provider.displayName} size="large" /><div><strong>{provider.displayName}</strong><small>{provider.id}</small></div></div> : null}
        <label htmlFor="provider-credential">{provider?.credentialLabel || "API key"}</label>
        <input id="provider-credential" type="password" value={credential} onChange={(event) => setCredential(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Enter credential" autoFocus />
        <p><Link2 aria-hidden size={13} strokeWidth={1.7} /> The value is not placed in logs, command arguments, localStorage, or saved renderer state.</p>
        <div className="dialog-actions"><Button type="button" variant="secondary" onClick={close}>Cancel</Button><Button type="submit" variant="primary" disabled={!credential.trim()}>Save credential</Button></div>
      </form>
    </Dialog>
  );
}

function providerConnected(entry: ProviderDirectoryEntry, enabledProviders: Set<string>): boolean {
  if (entry.setup) return entry.setup.configured;
  return entry.models.some((model) => model.native) || enabledProviders.has(entry.id);
}

function providerDisplayName(providerId: string): string {
  return providerId === "openai" ? "OpenAI native" : providerId;
}

function connectionMethod(entry: ProviderDirectoryEntry): string {
  if (entry.id === "openai") return "ChatGPT session";
  if (entry.id === "local") return "Local runtime";
  if (!entry.setup) return "Managed catalog";
  if (entry.setup.kind === "oauth") return "OAuth";
  if (entry.setup.signIn) return "Key or sign-in";
  return entry.setup.credentialLabel || "API key";
}

function connectionDetail(entry: ProviderDirectoryEntry, accountStatus?: string, accountMessage?: string, needsCuration?: boolean, canOpenTerminal?: boolean): string {
  if (entry.id === "openai") return "Uses the signed-in ChatGPT session available to this Codex installation.";
  if (!entry.setup) return "This provider catalog is managed by the router and has no separate credential action here.";
  if (needsCuration) return "The credential is ready, but this catalog-only provider has no locally selected models.";
  if (accountStatus === "unavailable") return accountMessage || "Account usage is unavailable. Reconnect if the session expired.";
  if (entry.setup.configured) return "Credential ready. You can disable routing without disconnecting the account.";
  if (entry.setup.kind === "oauth") {
    if (!canOpenTerminal) return "Run the official provider sign-in command in your own terminal, then refresh this page.";
    return entry.setup.cliInstalled === false ? "The official CLI will be installed, then sign-in will open in your system terminal." : "Sign in through the official provider CLI in your system terminal, then refresh to enable it.";
  }
  if (entry.setup.signIn) return `Add ${entry.setup.credentialLabel || "an API key"}, or use the provider's browser sign-in.`;
  return `Add ${entry.setup.credentialLabel || "an API key"} to connect this provider.`;
}

function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "-"); }
