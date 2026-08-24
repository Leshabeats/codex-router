import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, Filter, KeyRound, Link2, LogIn, SearchX, ShieldCheck, Trash2 } from "lucide-react";
import { Badge, Button, CatalogSkeleton, Dialog, EmptyState, PageHeader, SearchField, SkeletonBlock, StatStrip, Toggle } from "../components";
import { BrandLogo, ProviderLogo, brandForModel } from "../provider-branding";
import { formatContext, formatDateTime } from "../lib";
import {
  addPendingCatalogModels,
  beginCatalogRequest,
  catalogModelName,
  catalogRequestIsCurrent,
  clearProviderCatalogStates,
  invalidateProviderCatalogRequests,
  modelRouteKind,
  pendingCatalogModelIds,
  removePendingCatalogModels,
  searchLoadedCatalogModels,
  type PendingCatalogModels,
} from "../model-catalog-search.mjs";
import { groupModelFamilies, preferredFamilyRoute } from "../model-families.mjs";
import { useOptimisticValues, type RunAction } from "../useOptimisticValues";
import type {
  ModelViewFocusRequest,
  ProviderCatalog,
  ProviderSetup,
  ProviderSetupSnapshot,
  ProviderUsageSnapshot,
  RouterCatalogSnapshot,
  RouterControlApi,
  RouterModel,
  RouterTarget,
} from "../types";
import "./providers-models.css";

type ConnectionFilter = "all" | "connected" | "available";
type LoadedCatalogModel = ReturnType<typeof searchLoadedCatalogModels>[number];
const CATALOG_ADD_BATCH_LIMIT = 200;

interface ModelsPageProps {
  target?: RouterTarget;
  /** Shared router policy; client probes remain available for native details. */
  catalog?: RouterCatalogSnapshot;
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

interface CatalogViewState {
  status: "idle" | "loading" | "ready" | "error";
  /** A refresh keeps the list on screen instead of replacing it with a skeleton. */
  refreshing: boolean;
  data?: ProviderCatalog;
  error?: string;
  query: string;
  selected: string[];
}

function catalogEligible(entry: ProviderDirectoryEntry): boolean {
  return Boolean(entry.setup?.configured && entry.setup.catalogSources?.length);
}

function subagentCertification(model: RouterModel): "v1" | "v2" | "unknown" | string {
  return model.subagentCertification
    ?? (model.multiAgentVersion === "v2" ? "v2" : model.multiAgentVersion === "v1" ? "v1" : "unknown");
}

function subagentEnabled(target: RouterTarget, slug: string, settings = target.modelSettings?.subagents): boolean {
  if (!settings) return false;
  if (settings.disabled.includes(slug)) return false;
  const model = target.models.find((entry) => entry.slug === slug);
  if (!model || model.visible === false) return false;
  // Certified routes remain active unless explicitly disabled; selected mode
  // does not silently turn off every other registry-v2 route. For an unknown
  // route, a selected-mode entry means only that its compatibility test was
  // requested — it never becomes an active subagent here.
  if (subagentCertification(model) === "v2") {
    return true;
  }
  return settings.mode === "selected" && settings.enabled.includes(slug);
}

function nativeClientManaged(model: RouterModel): boolean {
  return model.native === true && model.nativeClientManaged !== false;
}

export function ModelsPage({ target, catalog, setup, usage, api, refreshing, onRefresh, runAction, focusRequest }: ModelsPageProps) {
  const [providerSearch, setProviderSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [connectionFilter, setConnectionFilter] = useState<ConnectionFilter>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [expandedFamilyId, setExpandedFamilyId] = useState<string | null>(null);
  const [catalogSourceByProvider, setCatalogSourceByProvider] = useState<Record<string, string>>({});
  const [loadingConnectedCatalogs, setLoadingConnectedCatalogs] = useState(false);
  const [credentialProvider, setCredentialProvider] = useState<ProviderSetup | null>(null);
  const [removeProvider, setRemoveProvider] = useState<ProviderSetup | null>(null);
  const [catalogStates, setCatalogStates] = useState<Record<string, CatalogViewState>>({});
  const catalogRequestGenerations = useRef<Record<string, number>>({});
  // Slugs committed to the picker but not yet published, per provider. Adding
  // republishes the whole catalog to every installed client, which is the
  // slowest thing this page starts; without a placeholder the models simply are
  // not there for the length of it and the click reads as having done nothing.
  const [pendingModels, setPendingModels] = useState<PendingCatalogModels>({});

  // External model identity and picker visibility come from the router-owned
  // catalog. Native entries remain a Codex-only adapter concern and are merged
  // in for the convenience of the Codex client view.
  const models = useMemo(() => {
    const clientModels = target?.models ?? [];
    if (!catalog) return clientModels;
    const nativeModels = clientModels.filter((model) => model.native);
    const seen = new Set(nativeModels.map((model) => model.slug));
    return [
      ...nativeModels,
      ...catalog.models.filter((model) => !seen.has(model.slug)),
    ];
  }, [catalog, target?.models]);
  const enabledProviders = useMemo(
    () => new Set(catalog?.enabledProviders ?? target?.enabledProviders ?? []),
    [catalog?.enabledProviders, target?.enabledProviders],
  );
  const subagentSettings = catalog?.subagents ?? target?.modelSettings?.subagents;
  const modelFamilies = useMemo(() => groupModelFamilies(models), [models]);
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
  const providerStates = useMemo(() => new Map(directory.map((entry) => [
    entry.id,
    enabledProviders.has(entry.id) || entry.models.some((model) => model.native),
  ])), [directory, enabledProviders]);
  const providerNames = useMemo(
    () => new Map(directory.map((entry) => [entry.id, entry.displayName])),
    [directory],
  );
  const pickerStates = useMemo(() => new Map(models.map((model) => [model.slug, model.visible])), [models]);
  const subagentStates = useMemo(() => new Map(models.map((model) => [
    model.slug,
    Boolean(target && subagentEnabled(target, model.slug, subagentSettings)),
  ])), [models, subagentSettings, target]);
  const subagentEffortStates = useMemo(() => new Map(models.map((model) => [
    model.slug,
    subagentSettings?.efforts?.[model.slug] ?? "default",
  ])), [models, subagentSettings?.efforts]);
  const optimisticProviders = useOptimisticValues(providerStates, runAction);
  const optimisticPicker = useOptimisticValues(pickerStates, runAction);
  const optimisticSubagents = useOptimisticValues(subagentStates, runAction);
  const optimisticSubagentEfforts = useOptimisticValues(subagentEffortStates, runAction);

  useEffect(() => {
    if (!filterMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!filterMenuRef.current?.contains(event.target as Node)) setFilterMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [filterMenuOpen]);

  const updateCatalogState = (providerId: string, update: (current: CatalogViewState) => CatalogViewState) => {
    setCatalogStates((current) => ({
      ...current,
      [providerId]: update(current[providerId] ?? { status: "idle", refreshing: false, query: "", selected: [] }),
    }));
  };

  const runProviderCredentialAction = async (
    provider: ProviderSetup,
    label: string,
    action: () => Promise<unknown>,
  ) => {
    const invalidateCatalogs = () => {
      invalidateProviderCatalogRequests(catalogRequestGenerations.current, provider.catalogSources);
      setCatalogStates((current) => clearProviderCatalogStates(current, provider.catalogSources));
    };
    // Clear at both boundaries. The command may have changed the credential
    // before a later refresh/publish step rejects, and a discovery that lands
    // while the mutation is running must not show the previous account.
    invalidateCatalogs();
    try {
      await runAction(label, async () => {
        await action();
      });
    } finally {
      invalidateCatalogs();
    }
  };

  const activeCatalogSource = (entry: ProviderDirectoryEntry) => {
    const sources = entry.setup?.catalogSources ?? [];
    const requested = catalogSourceByProvider[entry.id];
    return sources.find((source) => source.id === requested) ?? sources[0];
  };

  const discoverCatalog = async (
    entry: ProviderDirectoryEntry,
    { refresh = false, keepOnFailure = false, sourceId = activeCatalogSource(entry)?.id } = {},
  ) => {
    if (!api || !catalogEligible(entry) || !sourceId) return;
    const generation = beginCatalogRequest(catalogRequestGenerations.current, sourceId);
    updateCatalogState(sourceId, (current) => ({
      ...current,
      status: "loading",
      refreshing: refresh && Boolean(current.data),
      error: undefined,
    }));
    try {
      const data = await api.discoverProviderModels(sourceId, { refresh });
      if (!catalogRequestIsCurrent(catalogRequestGenerations.current, sourceId, generation)) return;
      updateCatalogState(sourceId, (current) => ({
        ...current,
        status: "ready",
        refreshing: false,
        data,
        error: undefined,
        selected: current.selected.filter((id) => (data.addable ?? data.unregistered).includes(id)),
      }));
      // A stored list past its trust window is shown immediately and re-read
      // behind it, so a model the provider shipped since the last visit does
      // not stay invisible until somebody thinks to press Reload. A failed
      // re-read leaves the list that is already on screen in place.
      if (!refresh && data.stale) void discoverCatalog(entry, { refresh: true, keepOnFailure: true, sourceId });
    } catch (error) {
      if (!catalogRequestIsCurrent(catalogRequestGenerations.current, sourceId, generation)) return;
      updateCatalogState(sourceId, (current) => keepOnFailure && current.data
        ? { ...current, status: "ready", refreshing: false }
        : {
          ...current,
          status: "error",
          refreshing: false,
          error: error instanceof Error ? error.message : "Provider catalog could not be loaded.",
        });
    }
  };

  // A provider's list is stored after the first load, so opening a provider can
  // show it immediately instead of making every visit start with a button and a
  // network round trip. Only an explicit refresh re-asks the provider.
  const openProvider = (entry: ProviderDirectoryEntry, expanded: boolean) => {
    setExpandedProviderId(expanded ? null : entry.id);
    if (expanded) return;
    const sourceId = activeCatalogSource(entry)?.id;
    if (!sourceId) return;
    const state = catalogStates[sourceId];
    if (state && state.status !== "idle") return;
    void discoverCatalog(entry, { sourceId });
  };

  const publishCatalogModels = async (entry: ProviderDirectoryEntry, sourceId: string, selectedModels?: string[]) => {
    const selected = selectedModels ?? catalogStates[sourceId]?.selected ?? [];
    if (!api || !sourceId || !selected.length) return;
    let published = false;
    setPendingModels((current) => addPendingCatalogModels(current, entry.id, selected));
    try {
      await runAction(`Add ${selected.length} ${entry.displayName} model${selected.length === 1 ? "" : "s"}`, async () => {
        await api.addProviderModels(sourceId, selected);
        published = true;
      });
      if (!published) return;
      updateCatalogState(sourceId, (current) => ({ ...current, selected: [] }));
      await discoverCatalog(entry, { sourceId });
    } finally {
      // Cleared on failure too: a placeholder left behind after a failed add
      // would claim the model arrived. runAction reports the error itself.
      setPendingModels((current) => removePendingCatalogModels(current, entry.id, selected));
    }
  };

  const loadConnectedCatalogs = async () => {
    if (!api || loadingConnectedCatalogs) return;
    const requests = directory.flatMap((entry) => !catalogEligible(entry)
      ? []
      : (entry.setup?.catalogSources ?? []).map((source) => ({ entry, sourceId: source.id })));
    setLoadingConnectedCatalogs(true);
    try {
      await Promise.all(requests.map(({ entry, sourceId }) => discoverCatalog(entry, { sourceId })));
    } finally {
      setLoadingConnectedCatalogs(false);
    }
  };

  const filteredDirectory = useMemo(() => {
    const needle = providerSearch.trim().toLowerCase();
    return directory.flatMap((entry) => {
      const connected = providerConnected(entry, enabledProviders);
      if (connectionFilter === "connected" && !connected) return [];
      if (connectionFilter === "available" && connected) return [];
      const providerMatch = !needle || `${entry.displayName} ${entry.id} ${entry.setup?.kind || ""}`.toLowerCase().includes(needle);
      const visibleModels = entry.models.filter((model) => {
        if (providerMatch) return true;
        const maker = brandForModel(model).name;
        return `${model.displayName} ${model.slug} ${maker}`.toLowerCase().includes(needle);
      });
      if (!providerMatch && !visibleModels.length) return [];
      return [{ ...entry, visibleModels }];
    });
  }, [connectionFilter, directory, enabledProviders, providerSearch]);
  const filteredFamilies = useMemo(() => {
    const needle = modelSearch.trim().toLowerCase();
    if (!needle) return modelFamilies;
    return modelFamilies.filter((family) =>
      `${family.displayName} ${family.routes.map((model: RouterModel) => `${model.displayName} ${model.slug} ${providerDisplayName(model.provider)}`).join(" ")}`
        .toLowerCase()
        .includes(needle),
    );
  }, [modelFamilies, modelSearch]);
  const loadedCatalogMatches = useMemo(
    () => searchLoadedCatalogModels(directory, catalogStates, modelSearch),
    [catalogStates, directory, modelSearch],
  );
  const directoryById = useMemo(
    () => new Map(directory.map((entry) => [entry.id, entry])),
    [directory],
  );

  useEffect(() => {
    if (!focusRequest) return;
    const id = focusRequest.region === "providers" ? "model-provider-directory" : "model-catalog-controls";
    const frame = window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);

  if (!target) {
    return <EmptyState icon={<SearchX size={22} />} title="Router snapshot unavailable" body="Start the router or refresh after setup completes." />;
  }

  const visibleCount = modelFamilies.filter((family) =>
    family.routes.some((model: RouterModel) => optimisticPicker.value(model.slug, model.visible)),
  ).length;
  const enabledCount = models.filter((model) => model.enabled || model.native).length;
  const v2Count = models.filter((model) => model.multiAgentVersion === "v2" && model.enabled).length;
  const connectedProviderCount = directory.filter((entry) => providerConnected(entry, enabledProviders)).length;

  const updatePicker = (slug: string, visible: boolean) => api
    ? optimisticPicker.mutate(slug, visible, `${visible ? "Show" : "Hide"} ${slug}`, () => api.setPickerModel(slug, visible))
    : Promise.resolve();
  const updateSubagent = (slug: string, enabled: boolean) => api
    ? optimisticSubagents.mutate(slug, enabled, `${enabled ? "Enable" : "Disable"} ${slug} as subagent`, () => api.setSubagentModel(slug, enabled))
    : Promise.resolve();
  const updateSubagentEffort = (slug: string, effort: string) => api
    ? optimisticSubagentEfforts.mutate(slug, effort, `Set ${slug} subagent thinking to ${effortLabel(effort)}`, () => api.setSubagentEffort(slug, effort))
    : Promise.resolve();
  const connectionFilterLabel = connectionFilter === "available" ? "Needs setup" : connectionFilter === "connected" ? "Connected" : "All";

  return (
    <>
      <div className="providers-models-page models-page">
        <PageHeader
          eyebrow="Providers and picker"
          title="Models"
          description="Connect providers and choose which router-managed models appear in installed clients and subagent workflows."
          onRefresh={onRefresh}
          refreshing={refreshing}
        />

        <StatStrip items={[
          { label: "Providers", value: connectedProviderCount, detail: `${directory.length} registered` },
          { label: "Models", value: modelFamilies.length, detail: `${enabledCount} provider routes` },
          { label: "In picker", value: visibleCount, detail: `${modelFamilies.length - visibleCount} families hidden` },
          { label: "Agent-ready", value: v2Count, detail: "Native v2 relay" },
        ]} />

        <section className="panel-section pm-provider-directory pm-unified-directory" id="model-provider-directory">
            <div className="pm-family-heading pm-provider-heading">
              <div>
                <strong>All providers</strong>
                <span>Every supported provider stays visible. Connect one to browse its account-specific model catalog.</span>
              </div>
              <span>{directory.length} providers · {connectedProviderCount} connected</span>
            </div>
            <div className="pm-provider-toolbar">
              <div className="pm-provider-toolbar-primary">
                <SearchField value={providerSearch} onChange={setProviderSearch} placeholder="Search all providers" />
                <span className="pm-results-count" aria-live="polite">{filteredDirectory.length} providers</span>
              </div>
              <div className="pm-provider-toolbar-actions">
                <Button variant="ghost" disabled={!api || loadingConnectedCatalogs} onClick={() => void loadConnectedCatalogs()}>
                  {loadingConnectedCatalogs ? "Loading catalogs" : "Load connected catalogs"}
                </Button>
                <div className="pm-filter-menu-wrap" ref={filterMenuRef}>
                  <button
                    type="button"
                    className="pm-filter-trigger"
                    aria-haspopup="menu"
                    aria-expanded={filterMenuOpen}
                    onClick={() => setFilterMenuOpen((open) => !open)}
                  >
                    <Filter aria-hidden size={14} strokeWidth={1.7} />
                    <span>Filter</span>
                    <strong>{connectionFilterLabel}</strong>
                    <ChevronDown aria-hidden size={14} strokeWidth={1.7} className={filterMenuOpen ? "is-open" : ""} />
                  </button>
                  {filterMenuOpen ? (
                    <div className="pm-filter-menu" role="menu" aria-label="Filter providers">
                      <span className="pm-filter-menu-label">Show providers</span>
                      {(["all", "connected", "available"] as const).map((value) => {
                        const label = value === "available" ? "Needs setup" : value === "connected" ? "Connected" : "All";
                        return (
                          <button
                            key={value}
                            type="button"
                            role="menuitemradio"
                            aria-checked={connectionFilter === value}
                            className={connectionFilter === value ? "is-selected" : ""}
                            onClick={() => {
                              setConnectionFilter(value);
                              setFilterMenuOpen(false);
                            }}
                          >
                            <span>{label}</span>
                            {connectionFilter === value ? <Check aria-hidden size={14} strokeWidth={1.9} /> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {filteredDirectory.length ? (
              <div className="pm-provider-list">
                {filteredDirectory.map((entry) => {
                  const providerUsage = usageById.get(entry.id);
                  const configured = providerConnected(entry, enabledProviders);
                  const authoritativeEnabled = enabledProviders.has(entry.id) || entry.models.some((model) => model.native);
                  const isEnabled = optimisticProviders.value(entry.id, authoritativeEnabled);
                  const needsCuration = configured && entry.models.length === 0 && catalogEligible(entry);
                  const expanded = expandedProviderId === entry.id;
                  const catalogSources = entry.setup?.catalogSources ?? [];
                  const catalogSource = activeCatalogSource(entry);
                  const catalog = catalogSource ? catalogStates[catalogSource.id] : undefined;
                  // A slug already in the picker needs no placeholder, so
                  // re-adding one shows the real row rather than a duplicate
                  // ghost beside it.
                  const pending = pendingCatalogModelIds(pendingModels, entry.id)
                    .filter((slug) => !entry.models.some((model) => model.slug === slug));
                  const triggerId = `provider-trigger-${safeId(entry.id)}`;
                  const panelId = `provider-panel-${safeId(entry.id)}`;
                  return (
                    <article className="pm-provider-row" key={entry.id} data-connection={configured ? "connected" : "setup"} data-expanded={expanded}>
                      <button id={triggerId} className="pm-provider-summary" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => openProvider(entry, expanded)}>
                        <ProviderLogo providerId={entry.id} displayName={entry.displayName} size="large" />
                        <div className="pm-provider-main">
                          <div className="pm-provider-title-line">
                            <strong>{entry.displayName}</strong>
                            <div className="pm-provider-tags">
                              <Badge tone={configured ? "success" : "neutral"}>{configured ? "connected" : "not connected"}</Badge>
                              <Badge tone="neutral">{connectionMethod(entry)}</Badge>
                              <Badge tone="accent">{entry.models.length} active {entry.models.length === 1 ? "route" : "routes"}</Badge>
                            </div>
                          </div>
                          <small>{entry.id}</small>
                        </div>
                        <ChevronDown className="pm-accordion-chevron" aria-hidden size={16} strokeWidth={1.7} />
                      </button>
                      <div id={panelId} className="pm-provider-detail" role="region" aria-labelledby={triggerId} hidden={!expanded}>
                        <div className="pm-provider-connection">
                          <div className="pm-provider-panel-copy">
                            <p>{entry.setup?.planNote || connectionDetail(entry, providerUsage?.account?.status, providerUsage?.account?.message, needsCuration, api?.platform === "darwin")}</p>
                            {needsCuration ? <span className="pm-curation-note">No routes selected yet. Browse this provider's model catalog to choose candidates.</span> : null}
                            {providerUsage?.requests ? <small className="pm-provider-requests">{providerUsage.requests} {providerUsage.requests === 1 ? "request" : "requests"}</small> : null}
                          </div>
                          {entry.setup ? (
                            <div className="pm-provider-controls">
                              <div className="pm-provider-actions">
                                {entry.setup.kind === "oauth" || entry.setup.signIn ? (
                                  <Button variant="ghost" disabled={!api || api.platform !== "darwin"} title={api?.platform === "darwin" ? undefined : "Open the provider CLI in your own terminal on Windows or Linux."} onClick={() => api && void runProviderCredentialAction(entry.setup!, `Start ${entry.displayName} sign-in`, () => api.connectProvider(entry.id))}>
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
                                <Toggle checked={isEnabled} disabled={!api || !entry.setup.configured} label={`Enable ${entry.displayName} for installed clients`} onChange={(checked) => api && void optimisticProviders.mutate(entry.id, checked, `${checked ? "Enable" : "Disable"} ${entry.displayName}`, () => api.setProviderEnabled(entry.id, checked))} />
                              </div>
                            </div>
                          ) : null}
                        </div>

                        <div className="pm-selected-models-heading">
                          <div>
                            <strong>Provider catalog</strong>
                            <span>{entry.models.length ? `${entry.models.length} routes selected from this provider` : "No routes selected from this provider"}</span>
                          </div>
                          {catalogEligible(entry) ? (
                            <div className="pm-catalog-source-actions">
                              {catalogSources.length > 1 ? (
                                <label className="pm-catalog-source">
                                  <span>Catalog</span>
                                  <select
                                    aria-label={`${entry.displayName} catalog source`}
                                    value={catalogSource?.id}
                                    onChange={(event) => {
                                      const sourceId = event.target.value;
                                      setCatalogSourceByProvider((current) => ({ ...current, [entry.id]: sourceId }));
                                      if (expanded && !catalogStates[sourceId]) void discoverCatalog(entry, { sourceId });
                                    }}
                                  >
                                    {catalogSources.map((source) => <option key={source.id} value={source.id}>{source.displayName}</option>)}
                                  </select>
                                </label>
                              ) : null}
                              <Button
                                variant="ghost"
                                disabled={!api || !catalogSource || catalog?.status === "loading"}
                                onClick={() => catalogSource && void discoverCatalog(entry, { refresh: Boolean(catalog?.data), sourceId: catalogSource.id })}
                              >
                                {catalog?.status === "loading"
                                  ? catalog.refreshing ? "Asking provider" : "Loading models"
                                  : catalog?.data ? "Reload catalog" : "Browse model catalog"}
                              </Button>
                            </div>
                          ) : null}
                        </div>

                        {pending.length ? (
                          <div className="pm-model-list" role="list" aria-label={`${entry.displayName} models`}>
                            <PendingModelRows slugs={pending} />
                          </div>
                        ) : !entry.models.length ? <div className="pm-provider-model-empty">No models are selected for this provider yet.</div> : null}

                        {catalogEligible(entry) && catalog ? (
                          <ProviderCatalogManager
                            key={catalogSource?.id}
                            entry={entry}
                            state={catalog}
                            disabled={!api}
                            onReload={() => catalogSource && void discoverCatalog(entry, { refresh: true, sourceId: catalogSource.id })}
                            onQuery={(query) => catalogSource && updateCatalogState(catalogSource.id, (current) => ({ ...current, query }))}
                            onSelection={(selected) => catalogSource && updateCatalogState(catalogSource.id, (current) => ({ ...current, selected }))}
                            onPublish={() => catalogSource && void publishCatalogModels(entry, catalogSource.id)}
                          />
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : <EmptyState icon={<SearchX size={20} />} title="No providers or models match" body="Clear a filter or connect another provider." />}
        </section>

        <section className="panel-section pm-model-catalog pm-family-catalog" id="model-catalog-controls">
          <div className="pm-family-heading">
            <div>
              <strong>Model families</strong>
              <span>One model row. Expand it only when you need to choose a provider route.</span>
            </div>
            <span>{filteredFamilies.length} models · {models.length} routes · {loadedCatalogMatches.length} catalog matches</span>
          </div>
          <div className="pm-family-toolbar">
            <SearchField value={modelSearch} onChange={setModelSearch} placeholder="Search selected models or loaded catalogs" />
            <span className="pm-results-count" aria-live="polite">{filteredFamilies.length} families · {loadedCatalogMatches.length} catalog models</span>
            <Button variant="ghost" disabled={!api} onClick={() => api && void optimisticPicker.mutateMany(models.filter((model) => !nativeClientManaged(model)).map((model) => [model.slug, true] as const), "Show all router models", () => api.setPickerModels(true))}>Show all</Button>
            <Button variant="ghost" disabled={!api} onClick={() => api && void optimisticPicker.mutateMany(models.filter((model) => !nativeClientManaged(model)).map((model) => [model.slug, false] as const), "Hide all router models", () => api.setPickerModels(false))}>Hide all</Button>
          </div>
          {loadedCatalogMatches.length ? (
            <LoadedCatalogSearchResults
              models={loadedCatalogMatches}
              disabled={!api}
              pendingModels={pendingModels}
              onAdd={(result) => {
                const entry = directoryById.get(result.providerId);
                if (entry) void publishCatalogModels(entry, result.sourceId, [result.modelId]);
              }}
            />
          ) : null}
          {filteredFamilies.length ? (
            <div className="pm-family-list">
              {filteredFamilies.map((family) => {
                const expanded = expandedFamilyId === family.id;
                const preferred = preferredFamilyRoute(family);
                const maker = brandForModel(preferred);
                const visibleRoutes = family.routes.filter((model: RouterModel) =>
                  optimisticPicker.value(model.slug, model.visible),
                ).length;
                const triggerId = `family-trigger-${safeId(family.id)}`;
                const panelId = `family-panel-${safeId(family.id)}`;
                return (
                  <article className="pm-family-row" key={family.id} data-expanded={expanded}>
                    <button
                      id={triggerId}
                      className="pm-family-summary"
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      onClick={() => setExpandedFamilyId(expanded ? null : family.id)}
                    >
                      <BrandLogo brand={maker} size="large" />
                      <div className="pm-family-main">
                        <strong>{family.displayName}</strong>
                        <small>{maker.name}</small>
                      </div>
                      <div className="pm-family-facts">
                        {family.routes.some((model: RouterModel) => model.isFree) ? <Badge tone="success">Free route</Badge> : null}
                        <Badge tone="neutral">{family.routes.length} {family.routes.length === 1 ? "route" : "routes"}</Badge>
                        <span>{visibleRoutes ? `${visibleRoutes} in picker` : "Hidden"}</span>
                      </div>
                      <ChevronDown className="pm-accordion-chevron" aria-hidden size={16} strokeWidth={1.7} />
                    </button>
                    <div
                      id={panelId}
                      className="pm-family-routes"
                      role="region"
                      aria-labelledby={triggerId}
                      hidden={!expanded}
                    >
                      <div className="pm-family-route-note">
                        These routes use different credentials, quotas, and provider policies. Show only the route you want in the picker.
                      </div>
                      <div className="pm-model-list" role="list" aria-label={`${family.displayName} provider routes`}>
                        {family.routes.map((model: RouterModel) => (
                          <ModelRouteRow
                            key={model.slug}
                            model={model}
                            providerName={providerNames.get(model.provider) || providerDisplayName(model.provider)}
                            subagentSettings={subagentSettings}
                            pickerVisible={optimisticPicker.value(model.slug, model.visible)}
                            selectedInSettings={optimisticSubagents.value(
                              model.slug,
                              Boolean(subagentEnabled(target, model.slug, subagentSettings)),
                            )}
                            subagentEffort={optimisticSubagentEfforts.value(
                              model.slug,
                              subagentSettings?.efforts?.[model.slug] ?? "default",
                            )}
                            apiAvailable={Boolean(api)}
                            onPickerChange={(checked) => void updatePicker(model.slug, checked)}
                            onSubagentChange={(checked) => void updateSubagent(model.slug, checked)}
                            onEffortChange={(effort) => void updateSubagentEffort(model.slug, effort)}
                          />
                        ))}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : loadedCatalogMatches.length ? null : <EmptyState icon={<SearchX size={20} />} title="No models match" body="Load connected catalogs or clear the search to see configured models." />}
        </section>
      </div>

      <CredentialDialog
        provider={credentialProvider}
        onSave={(provider, secret) => api
          ? runProviderCredentialAction(provider, `Save ${provider.displayName} credential`, () => api.saveProviderCredential(provider.id, secret))
          : Promise.resolve()}
        onClose={() => setCredentialProvider(null)}
      />
      <Dialog open={Boolean(removeProvider)} title="Remove provider credential" description="The provider is withdrawn from installed clients before its managed credential is deleted." onClose={() => setRemoveProvider(null)}>
        <div className="pm-credential-warning"><ShieldCheck aria-hidden size={17} strokeWidth={1.7} /><p>If a credential also exists in the environment or Keychain, the router will still report it as connected.</p></div>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setRemoveProvider(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { const provider = removeProvider; setRemoveProvider(null); if (provider && api) void runProviderCredentialAction(provider, `Remove ${provider.displayName} credential`, () => api.removeProviderCredential(provider.id)); }}><Trash2 aria-hidden size={14} strokeWidth={1.7} /> Remove credential</Button>
        </div>
      </Dialog>
    </>
  );
}

function ModelRouteRow({
  model,
  providerName,
  subagentSettings,
  pickerVisible,
  selectedInSettings,
  subagentEffort,
  apiAvailable,
  onPickerChange,
  onSubagentChange,
  onEffortChange,
}: {
  model: RouterModel;
  providerName: string;
  subagentSettings?: NonNullable<RouterTarget["modelSettings"]>["subagents"];
  pickerVisible: boolean;
  selectedInSettings: boolean;
  subagentEffort: string;
  apiAvailable: boolean;
  onPickerChange: (checked: boolean) => void;
  onSubagentChange: (checked: boolean) => void;
  onEffortChange: (effort: string) => void;
}) {
  const certification = subagentCertification(model);
  const certified = certification === "v2";
  const knownV1 = certification === "v1";
  const proof = subagentSettings?.proofs?.[model.slug];
  const checking = !certified && !knownV1 && proof?.status === "checking";
  // Old local probe verdicts remain diagnostic candidates. They are never a
  // repository certificate and never make the route look enabled as v2.
  const candidate = !certified && !knownV1 && ["candidate", "experimental", "proven"].includes(proof?.status ?? "");
  const selectedAsSubagent = certified && selectedInSettings;
  const testActive = !certified && !knownV1 && !candidate && selectedInSettings;
  const effortOptions = model.reasoningLevels ?? [];
  return (
    <article className="pm-model-row pm-route-row" role="listitem" data-subagent={selectedAsSubagent ? "enabled" : "disabled"}>
      <div className="pm-model-identity">
        <ProviderLogo providerId={model.provider} displayName={providerName} size="medium" />
        <div><strong>{providerName}</strong><span>{modelRouteKind(model)}</span><small title={model.slug}>{model.slug}</small></div>
      </div>
      <div className="pm-model-meta">
        <span>{formatContext(model.contextWindow)}</span>
        <span>{model.inputModalities?.includes("image") ? "Text + image" : "Text"}</span>
        {model.isFree ? <Badge tone="success">Free</Badge> : null}
        <Badge tone={certified ? "accent" : proof?.status === "failed" && !knownV1 ? "danger" : "neutral"}>
          {certified ? "v2 relay" : knownV1 ? "v1 only" : checking ? "Checking compatibility" : candidate ? "Certification candidate" : proof?.status === "failed" ? "Compatibility failed" : "Untested"}
        </Badge>
        {selectedAsSubagent ? <Badge tone="accent">Subagent</Badge> : null}
        {selectedAsSubagent && effortOptions.length ? <Badge tone="neutral">{effortLabel(subagentEffort)} thinking</Badge> : null}
      </div>
      <div className="pm-model-controls">
        <div className="pm-model-control"><span>Picker</span><Toggle checked={pickerVisible} disabled={!apiAvailable || nativeClientManaged(model)} label={nativeClientManaged(model) ? `${model.displayName} is managed by Codex` : `Show ${model.displayName} through ${providerName} in picker`} onChange={onPickerChange} /></div>
        <div className="pm-subagent-controls" title={certified ? "Expose this certified v2 route as a subagent" : knownV1 ? "This route is certified v1 and is not retested automatically" : checking ? "Testing low-cost compatibility; this does not enable v2" : candidate ? "Awaiting a reviewed native v2 certification" : "Run the one-time low-cost compatibility test"}>
          <div className="pm-model-control"><span>{certified ? "Subagent" : knownV1 ? "v1 only" : "Test v2"}</span><Toggle checked={certified ? selectedAsSubagent : testActive} disabled={!apiAvailable || candidate || knownV1} label={certified ? `Use ${model.displayName} through ${providerName} as subagent` : knownV1 ? `${model.displayName} is certified v1` : `Test ${model.displayName} through ${providerName} for v2 compatibility`} onChange={onSubagentChange} /></div>
          {!certified && !knownV1 && proof?.status === "failed" && proof.reason ? <small className="pm-subagent-proof-error" title={proof.reason}>Test failed</small> : null}
          {certified && effortOptions.length ? (
            <label className="pm-model-effort">
              <span>Thinking</span>
              <select aria-label={`${model.displayName} ${providerName} subagent thinking effort`} value={subagentEffort} disabled={!apiAvailable || !selectedAsSubagent} onChange={(event) => onEffortChange(event.target.value)}>
                <option value="default">Model default</option>
                {effortOptions.map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
              </select>
            </label>
          ) : null}
        </div>
      </div>
    </article>
  );
}

// Placeholder rows for models being published to the picker. They carry the
// slug rather than a bare shimmer: the operator picked those names a moment
// ago, and seeing them is what says the click landed on the right ones. Only
// the controls that do not exist yet are left as blanks.
function PendingModelRows({ slugs }: { slugs: string[] }) {
  if (!slugs.length) return null;
  return (
    <>
      {slugs.map((slug) => (
        <article className="pm-model-row pm-model-row-pending" role="listitem" key={`pending-${slug}`}>
          <div className="pm-model-identity">
            <SkeletonBlock className="pm-pending-logo" />
            <div>
              <strong>{slug}</strong>
              <small>Adding to the picker…</small>
            </div>
          </div>
          <div className="pm-pending-meta" aria-hidden="true">
            <SkeletonBlock className="pm-pending-line" />
          </div>
          <div className="pm-pending-controls" aria-hidden="true">
            <SkeletonBlock className="pm-pending-control" />
          </div>
        </article>
      ))}
    </>
  );
}

function effortLabel(effort: string): string {
  return effort === "default" ? "Default" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

function LoadedCatalogSearchResults({
  models,
  disabled,
  pendingModels,
  onAdd,
}: {
  models: LoadedCatalogModel[];
  disabled: boolean;
  pendingModels: PendingCatalogModels;
  onAdd: (model: LoadedCatalogModel) => void;
}) {
  return (
    <section className="pm-catalog-search-results" aria-label="Loaded provider catalog matches">
      <div className="pm-catalog-search-heading">
        <div><strong>Available from loaded catalogs</strong><span>These models are not limited to routes already selected in the router.</span></div>
        <span>{models.length} matches</span>
      </div>
      <div className="pm-catalog-search-list" role="list">
        {models.map((model) => {
          const adding = (pendingModels[model.providerId]?.[model.modelId] ?? 0) > 0;
          return (
            <article className="pm-catalog-search-row" role="listitem" key={model.key}>
              <ProviderLogo providerId={model.providerId} displayName={model.providerName} size="medium" />
              <div className="pm-catalog-search-identity">
                <strong>{model.displayName}</strong>
                <small title={model.modelId}>{model.modelId}</small>
                {model.blockedReason ? <small className="pm-catalog-block-reason" title={model.blockedReason}>{model.blockedReason}</small> : null}
              </div>
              <div className="pm-catalog-search-source">
                <span>{model.providerName}</span>
                <small title={model.sourceId}>{model.sourceName} catalog</small>
              </div>
              <div className="pm-catalog-search-meta">
                {model.contextWindow ? <span>{formatContext(model.contextWindow)}</span> : null}
                {model.isFree ? <Badge tone="success">Free</Badge> : null}
              </div>
              {model.registered ? <Badge tone="neutral">Selected</Badge> : (
                <Button
                  variant="primary"
                  disabled={disabled || adding || !model.addable}
                  title={model.blockedReason}
                  onClick={() => onAdd(model)}
                >
                  {adding ? "Adding" : model.addable ? "Add" : model.blockedReason ? "Protocol pending" : "Unavailable"}
                </Button>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ProviderCatalogManager({
  entry,
  state,
  disabled,
  onReload,
  onQuery,
  onSelection,
  onPublish,
}: {
  entry: ProviderDirectoryEntry;
  state?: CatalogViewState;
  disabled: boolean;
  onReload: () => void;
  onQuery: (query: string) => void;
  onSelection: (selected: string[]) => void;
  onPublish: () => void;
}) {
  const [shownLimit, setShownLimit] = useState(120);
  const loading = !state || state.status === "idle" || (state.status === "loading" && !state.refreshing);
  if (loading) {
    return (
      <section className="pm-live-catalog" aria-label={`${entry.displayName} available models`}>
        <div className="pm-live-catalog-heading"><div><strong>Loading models</strong><span>Reading this provider's model list</span></div></div>
        <CatalogSkeleton label={`Loading ${entry.displayName} models`} />
      </section>
    );
  }
  if (state.status === "error" || !state.data) {
    return (
      <section className="pm-live-catalog" aria-label={`${entry.displayName} available models`}>
        <div className="pm-live-catalog-error" role="alert">
          <div><strong>Available models could not load</strong><span>{state.error || "The provider model list could not be loaded."}</span></div>
          <Button variant="ghost" disabled={disabled} onClick={onReload}>Try again</Button>
        </div>
      </section>
    );
  }
  const busy = state.status === "loading";

  const registered = new Set(state.data.registered);
  const addable = new Set(state.data.addable ?? state.data.unregistered);
  const selected = new Set(state.selected.filter((id) => addable.has(id)));
  const needle = state.query.trim().toLowerCase();
  const matching = state.data.discovered.filter((id) => !needle || catalogModelName(id).toLowerCase().includes(needle) || id.toLowerCase().includes(needle));
  const shown = matching.slice(0, shownLimit);
  const selectable = state.data.unregistered.filter((id) => addable.has(id) && (!needle || catalogModelName(id).toLowerCase().includes(needle) || id.toLowerCase().includes(needle)));
  const toggle = (modelId: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked && addable.has(modelId) && next.size < CATALOG_ADD_BATCH_LIMIT) next.add(modelId);
    else next.delete(modelId);
    onSelection([...next]);
  };

  return (
    <section className="pm-live-catalog" aria-label={`${entry.displayName} available models`}>
      <div className="pm-live-catalog-heading">
        <div>
          <strong>Available models</strong>
          <span>
            {state.data.discovered.length} found · {state.data.registered.length} already selected
            {state.data.fetchedAt ? ` · ${state.data.cached ? "saved list from" : "read"} ${formatDateTime(state.data.fetchedAt)}` : ""}
            {state.data.stale && !busy ? " · could not re-read" : ""}
          </span>
        </div>
        <div className="pm-live-catalog-actions">
          <Button variant="ghost" disabled={disabled || busy} onClick={onReload}>
            {busy ? "Asking provider" : "Reload from provider"}
          </Button>
          <Button variant="primary" disabled={disabled || busy || !selected.size} onClick={onPublish}>
            Add {selected.size || "selected"}
          </Button>
        </div>
      </div>
      <div className="pm-live-catalog-toolbar">
        <SearchField value={state.query} onChange={onQuery} placeholder="Search available models" />
        <span>{matching.length} matches</span>
        <Button variant="ghost" disabled={!selectable.length} onClick={() => onSelection(selectable.slice(0, CATALOG_ADD_BATCH_LIMIT))}>Select up to 200</Button>
        <Button variant="ghost" disabled={!selected.size} onClick={() => onSelection([])}>Clear</Button>
      </div>
      {shown.length ? (
        <div className="pm-live-catalog-list" role="list" aria-label={`${entry.displayName} available models`}>
          {shown.map((modelId) => {
            const published = registered.has(modelId);
            const blockedReason = published ? undefined : state.data?.blocked?.[modelId];
            const context = state.data?.contextLengths?.[modelId];
            return (
              <label className="pm-live-catalog-row" data-published={published} data-blocked={Boolean(blockedReason)} title={blockedReason} key={modelId}>
                <input type="checkbox" checked={published || selected.has(modelId)} disabled={published || !addable.has(modelId) || disabled || (!selected.has(modelId) && selected.size >= CATALOG_ADD_BATCH_LIMIT)} onChange={(event) => toggle(modelId, event.target.checked)} />
                <span>
                  <strong>{catalogModelName(modelId)}</strong>
                  <small>{modelId}</small>
                  {blockedReason ? <small className="pm-catalog-block-reason">{blockedReason}</small> : null}
                </span>
                {state.data?.free?.includes(modelId) || modelId === "big-pickle" || modelId.endsWith("-free") ? <Badge tone="success">Free</Badge> : null}
                {context ? <small>{formatContext(context)}</small> : null}
                {published ? <Badge tone="neutral">Selected</Badge> : blockedReason ? <Badge tone="neutral">Protocol pending</Badge> : null}
              </label>
            );
          })}
        </div>
      ) : <div className="pm-live-catalog-empty">No catalog models match this search.</div>}
      {matching.length > shown.length ? (
        <div className="pm-live-catalog-more">
          <span>{matching.length - shown.length} more models</span>
          <Button variant="ghost" onClick={() => setShownLimit((current) => current + 120)}>Show 120 more</Button>
        </div>
      ) : null}
      <p className="pm-live-catalog-note">This list is saved locally, so opening a provider does not re-ask it every time; a list older than a day is re-read in the background. Reload fetches it again now. Candidates are added explicitly in batches of up to 200 because raw provider catalogs may also contain non-chat or protocol-specific models.</p>
    </section>
  );
}

function CredentialDialog({ provider, onSave, onClose }: { provider: ProviderSetup | null; onSave: (provider: ProviderSetup, secret: string) => Promise<void>; onClose: () => void }) {
  const [credential, setCredential] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!provider || !credential.trim()) return;
    const secret = credential;
    setCredential("");
    onClose();
    await onSave(provider, secret);
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
