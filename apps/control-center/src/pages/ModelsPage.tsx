import { useMemo, useState } from "react";
import { ChevronDown, SearchX } from "lucide-react";
import { Badge, Button, EmptyState, PageHeader, SearchField, SectionHeading, StatStrip, Toggle } from "../components";
import { BrandLogo, ProviderLogo, brandForModel, brandForProvider } from "../provider-branding";
import { formatContext } from "../lib";
import type { RouterControlApi, RouterTarget } from "../types";
import "./providers-models.css";

type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;

interface ModelsPageProps {
  target?: RouterTarget;
  api?: RouterControlApi;
  refreshing: boolean;
  onRefresh: () => void;
  runAction: RunAction;
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

export function ModelsPage({ target, api, refreshing, onRefresh, runAction }: ModelsPageProps) {
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [enabledOnly, setEnabledOnly] = useState(true);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);

  const models = target?.models ?? [];
  // The default routed model only applies to login-free routing, so the list is
  // the external models that are actually enabled -- native ones are not
  // selectable targets for `control model-set`.
  const externalModels = models.filter((model) => !model.native && model.enabled);
  const selectedExternalModel = externalModels.some((model) => model.slug === target?.selectedModel)
    ? target?.selectedModel
    : "";
  const providerNames = useMemo(
    () => new Map((target?.providers ?? []).map((entry) => [entry.id, entry.displayName])),
    [target?.providers],
  );
  const providers = useMemo(
    () => [...new Set(models.map((model) => model.provider))]
      .sort((left, right) => providerDisplayName(left, providerNames).localeCompare(providerDisplayName(right, providerNames))),
    [models, providerNames],
  );
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return models.filter((model) => {
      if (enabledOnly && !model.enabled && !model.native) return false;
      if (provider !== "all" && model.provider !== provider) return false;
      const company = brandForModel(model).name;
      return !needle || `${model.displayName} ${model.slug} ${model.provider} ${company}`.toLowerCase().includes(needle);
    });
  }, [models, search, provider, enabledOnly]);
  const grouped = useMemo(() => {
    const map = new Map<string, typeof models>();
    for (const model of filtered) map.set(model.provider, [...(map.get(model.provider) ?? []), model]);
    return [...map.entries()].sort(([left], [right]) =>
      providerDisplayName(left, providerNames).localeCompare(providerDisplayName(right, providerNames))
    );
  }, [filtered, providerNames]);

  if (!target) {
    return <EmptyState icon={<SearchX size={22} />} title="Router snapshot unavailable" body="Start the router or refresh after setup completes." />;
  }

  const visibleCount = models.filter((model) => model.visible).length;
  const enabledCount = models.filter((model) => model.enabled || model.native).length;
  const v2Count = models.filter((model) => model.multiAgentVersion === "v2" && model.enabled).length;
  const connectedProviderCount = new Set(models.filter((model) => model.enabled || model.native).map((model) => model.provider)).size;

  const updatePicker = (slug: string, visible: boolean) =>
    api ? runAction(`${visible ? "Show" : "Hide"} ${slug}`, () => api.setPickerModel(slug, visible)) : Promise.resolve();
  const updateSubagent = (slug: string, enabled: boolean) =>
    api ? runAction(`${enabled ? "Enable" : "Disable"} ${slug} as subagent`, () => api.setSubagentModel(slug, enabled)) : Promise.resolve();

  return (
    <div className="providers-models-page models-page">
      <PageHeader
        eyebrow="Catalog"
        title="Models"
        description="Choose which connected models appear in Codex and which proven models can run as subagents."
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      <StatStrip items={[
        { label: "Available", value: enabledCount, detail: `${models.length} registered` },
        { label: "In picker", value: visibleCount, detail: `${models.length - visibleCount} hidden` },
        { label: "Agent-ready", value: v2Count, detail: "Native v2 relay" },
        { label: "Providers", value: connectedProviderCount, detail: "Connected catalogs" },
      ]} />

      <div className="pm-model-layout">
        <section className="panel-section pm-model-policy">
          <SectionHeading
            title="Default routed model"
            description="The model Codex starts new tasks on while it routes without an OpenAI login."
          />
          <div className="settings-list">
            <div className="setting-row">
              <div>
                <strong>Default model</strong>
                <small>{target.loginFree
                  ? "Choose from the external models you have enabled."
                  : "Selectable once “Use without OpenAI login” is on in Settings."}</small>
              </div>
              {target.loginFree ? (
                <select
                  aria-label="Default routed model"
                  value={selectedExternalModel}
                  disabled={!api || !externalModels.length}
                  onChange={(event) => api && void runAction("Change default model", () => api.setDefaultModel(event.target.value))}
                >
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
            description="Select which proven models Codex can delegate work to. Picker visibility is managed separately."
            action={
              <select
                aria-label="Subagent selection mode"
                value={target.modelSettings?.subagents.mode ?? "selected"}
                disabled={!api}
                onChange={(event) => api && void runAction("Change subagent mode", () => api.setSubagentMode(event.target.value as "all" | "selected" | "proven"))}
              >
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

        <section className="panel-section pm-model-catalog">
          <div className="pm-model-toolbar">
            <SearchField value={search} onChange={setSearch} placeholder="Search models or companies" />
            <select aria-label="Filter provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="all">All providers</option>
              {providers.map((id) => <option key={id} value={id}>{providerDisplayName(id, providerNames)}</option>)}
            </select>
            <label className="check-label"><input type="checkbox" checked={enabledOnly} onChange={(event) => setEnabledOnly(event.target.checked)} /> Connected only</label>
            <span className="pm-toolbar-spacer" />
            <span className="pm-results-count" aria-live="polite">{filtered.length} models</span>
            <Button variant="ghost" disabled={!api} onClick={() => api && void runAction("Show all picker models", () => api.setPickerModels(true))}>Show all</Button>
            <Button variant="ghost" disabled={!api} onClick={() => api && void runAction("Hide all picker models", () => api.setPickerModels(false))}>Hide all</Button>
          </div>

          {grouped.length ? grouped.map(([providerId, providerModels]) => {
            const providerName = providerDisplayName(providerId, providerNames);
            const providerBrand = brandForProvider(providerId, providerName);
            const expanded = expandedProviderId === providerId;
            const triggerId = `model-provider-trigger-${safeId(providerId)}`;
            const panelId = `model-provider-panel-${safeId(providerId)}`;
            return (
              <section className="pm-model-group" key={providerId} data-expanded={expanded} aria-labelledby={`provider-${safeId(providerId)}`}>
                <header>
                  <button
                    id={triggerId}
                    className="pm-model-group-trigger"
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    onClick={() => setExpandedProviderId(expanded ? null : providerId)}
                  >
                    <div className="pm-model-group-brand">
                      <ProviderLogo providerId={providerId} displayName={providerName} size="medium" />
                      <div>
                        <h2 id={`provider-${safeId(providerId)}`}>{providerName}</h2>
                        <small>{providerBrand.name}{providerBrand.name.toLowerCase() === providerName.toLowerCase() ? "" : ` provider`}</small>
                      </div>
                    </div>
                    <span className="pm-model-group-meta">
                      {providerModels.length} model{providerModels.length === 1 ? "" : "s"}
                      <ChevronDown className="pm-accordion-chevron" aria-hidden size={16} strokeWidth={1.7} />
                    </span>
                  </button>
                </header>
                <div
                  id={panelId}
                  className="pm-model-list"
                  role="list"
                  aria-labelledby={triggerId}
                  hidden={!expanded}
                >
                  {providerModels.map((model) => {
                    const eligible = model.multiAgentVersion === "v2";
                    const maker = brandForModel(model);
                    return (
                      <article className="pm-model-row" role="listitem" key={model.slug}>
                        <div className="pm-model-identity">
                          <BrandLogo brand={maker} size="medium" />
                          <div>
                            <strong>{model.displayName}</strong>
                            <span>{maker.name}</span>
                            <small title={model.slug}>{model.slug}</small>
                          </div>
                        </div>
                        <div className="pm-model-meta">
                          <span>{formatContext(model.contextWindow)}</span>
                          <span>{model.inputModalities?.includes("image") ? "Text + image" : "Text"}</span>
                          <Badge tone={eligible ? "accent" : "neutral"}>{eligible ? "v2 relay" : "v1 relay"}</Badge>
                        </div>
                        <div className="pm-model-controls">
                          <div className="pm-model-control">
                            <span>Picker</span>
                            <Toggle checked={model.visible} disabled={!api} label={`Show ${model.displayName} in picker`} onChange={(checked) => void updatePicker(model.slug, checked)} />
                          </div>
                          <div className="pm-model-control" title={eligible ? "Expose as a native v2 subagent" : "This model uses the conservative v1 relay"}>
                            <span>Subagent</span>
                            <Toggle checked={eligible && subagentEnabled(target, model.slug)} disabled={!api || !eligible} label={`Use ${model.displayName} as subagent`} onChange={(checked) => void updateSubagent(model.slug, checked)} />
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          }) : (
            <EmptyState icon={<SearchX size={20} />} title="No models match" body="Clear a filter or connect another provider." />
          )}
        </section>
      </div>
    </div>
  );
}

function providerDisplayName(providerId: string, names: Map<string, string>): string {
  if (providerId === "openai") return "OpenAI native";
  return names.get(providerId) || brandForProvider(providerId).name;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
