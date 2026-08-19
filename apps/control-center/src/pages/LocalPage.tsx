import { useMemo, useState, type FormEvent } from "react";
import {
  Box,
  ChevronDown,
  Download,
  Eye,
  Gauge,
  HardDrive,
  Play,
  RefreshCw,
  SearchX,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  InlineNotice,
  PageHeader,
  SearchField,
  SectionHeading,
  StatStrip,
  Toggle,
} from "../components";
import { compactNumber, formatBytesGb } from "../lib";
import type { LocalModel, LocalModelsSnapshot, RouterControlApi, RouterTarget, VisionEngine } from "../types";
import "./local-harness-context.css";

type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;

interface LocalPageProps {
  target?: RouterTarget;
  api?: RouterControlApi;
  refreshing: boolean;
  onRefresh: () => void;
  runAction: RunAction;
}

export function LocalPage({ target, api, refreshing, onRefresh, runAction }: LocalPageProps) {
  const [installRef, setInstallRef] = useState("");
  const [forceInstall, setForceInstall] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(new Set());
  const local = target?.modelSettings?.localModels;
  const bridge = target?.modelSettings?.visionBridge;
  const installed = local?.models?.filter((model) => model.installed !== false) ?? [];
  const installedCount = typeof local?.installed === "number"
    ? local.installed
    : Array.isArray(local?.installed)
      ? local.installed.length
      : installed.length;
  const enabledTags = Array.isArray(local?.enabled)
    ? local.enabled
    : installed.filter((model) => model.enabled === true).map((model) => model.tag);
  const enabledCount = typeof local?.enabled === "number" ? local.enabled : enabledTags.length;
  const localReaders = bridge?.localModels ?? local?.availableVision ?? [];
  const readerDownloadActive = bridge?.download?.status === "downloading";
  const engines: Array<VisionEngine & { group: string }> = [
    ...(bridge?.nativeEngines ?? []).map((engine) => ({ ...engine, group: "ChatGPT plan" })),
    ...(bridge?.paidEngines ?? []).map((engine) => ({ ...engine, group: "Connected provider" })),
  ];
  const selectedEngine = bridge?.engine || "auto";
  const selectedEngineMeta = engines.find((engine) => engine.slug === selectedEngine);
  const effortOptions = selectedEngineMeta?.efforts?.length
    ? selectedEngineMeta.efforts
    : bridge?.availableEfforts ?? [];
  const catalogModels = local?.availableExplore ?? [];
  const quickPicks = useMemo(
    () => [
      ...(Array.isArray(local?.available) ? local.available : []),
      ...(local?.availableVision ?? []),
    ].slice(0, 8),
    [local?.available, local?.availableVision],
  );
  const catalogFamilies = useMemo(
    () => groupCatalogModels(catalogModels, local?.families, catalogQuery),
    [catalogModels, catalogQuery, local?.families],
  );

  async function installLocal(event: FormEvent) {
    event.preventDefault();
    const model = installRef.trim();
    if (!model || !api) return;
    setInstallRef("");
    await runAction(`Install ${model}`, () => api.installLocalModel(model, forceInstall));
  }

  if (!target) {
    return <EmptyState icon={<SearchX size={22} />} title="Local runtime unavailable" body="Start the router or refresh after setup completes." />;
  }

  return (
    <div className="local-page">
      <PageHeader
        eyebrow="On-device inference"
        title="Local"
        description="Run, install, measure, and expose Ollama models without leaving the control center."
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      <StatStrip items={[
        { label: "Runtime", value: local?.runtime?.running ? "Online" : "Offline", detail: local?.runtime?.version ? `Ollama ${local.runtime.version}` : "Ollama" },
        { label: "Installed", value: installedCount, detail: `${enabledCount} in Codex` },
        { label: "Model storage", value: formatBytesGb(local?.totalGb), detail: local?.runtime?.modelsPath || "Location managed by Ollama" },
        { label: "Image reader", value: bridge?.engine === "local" ? "Local" : bridge?.resolvedEngineName || "Automatic", detail: bridge?.enabled ? "Bridge enabled" : "Bridge disabled" },
      ]} />

      <InlineNotice tone={local?.runtime?.running ? "success" : "warning"} title={local?.runtime?.running ? "Ollama is ready" : "Ollama is not running"}>
        {local?.machine || "Machine capacity has not been measured yet."}
      </InlineNotice>

      <div className="lhc-local-grid">
        <section className="panel-section lhc-local-installed">
          <SectionHeading
            title="Installed models"
            description="Enabled models appear in Codex after the picker catalog refreshes."
            action={
              <div className="row-actions">
                {!local?.runtime?.running ? (
                  <Button variant="ghost" disabled={!api} onClick={() => api && void runAction("Start local runtime", () => api.controlLocalRuntime("start"))}>
                    <Play aria-hidden size={13} strokeWidth={1.7} /> Start runtime
                  </Button>
                ) : null}
                {local?.runtime?.installed ? (
                  <Button variant="ghost" disabled={!api} onClick={() => api && void runAction("Update local runtime", () => api.controlLocalRuntime("update"))}>
                    <RefreshCw aria-hidden size={13} strokeWidth={1.7} /> Update Ollama
                  </Button>
                ) : null}
              </div>
            }
          />
          {installed.length ? (
            <div className="table-list">
              {installed.map((model) => (
                <LocalModelRow
                  key={model.tag}
                  model={model}
                  enabled={enabledTags.includes(model.tag) || model.enabled === true}
                  disabled={!api}
                  onToggle={(next) => api && void runAction(`${next ? "Enable" : "Disable"} ${model.tag}`, () => api.setLocalModelEnabled(model.tag, next))}
                  onBenchmark={() => api && void runAction(`Benchmark ${model.tag}`, () => api.benchmarkLocalModel(model.tag))}
                  onRemove={() => setPendingRemoval(model.tag)}
                />
              ))}
            </div>
          ) : (
            <EmptyState icon={<HardDrive size={21} />} title="No local models installed" body="Install an Ollama model below. Progress remains visible while the download runs." />
          )}
        </section>

        <section className="panel-section lhc-runtime-facts">
          <SectionHeading title="Runtime details" description="Read-only facts reported by the router and Ollama." />
          <dl>
            <div><dt>State</dt><dd>{local?.runtime?.running ? "Running" : local?.runtime?.installed ? "Stopped" : "Not installed"}</dd></div>
            <div><dt>Version</dt><dd>{local?.runtime?.version || "Not reported"}</dd></div>
            <div><dt>Managed</dt><dd>{local?.runtime?.managed ? "Router managed" : "External runtime"}</dd></div>
            <div><dt>Models path</dt><dd title={local?.runtime?.modelsPath}>{local?.runtime?.modelsPath || "Ollama default"}</dd></div>
          </dl>
        </section>
      </div>

      <section className="panel-section">
        <SectionHeading title="Install a model" description="Enter an Ollama tag or an HTTPS ollama.com model page. The runtime is installed only after this explicit action." />
        <form className="install-form" onSubmit={(event) => void installLocal(event)}>
          <label htmlFor="local-model-ref">Model tag or Ollama URL</label>
          <div>
            <input id="local-model-ref" value={installRef} onChange={(event) => setInstallRef(event.target.value)} placeholder="qwen3.5:9b" spellCheck={false} />
            <Button variant="primary" disabled={!api || !installRef.trim()} type="submit"><Download aria-hidden size={14} strokeWidth={1.7} /> Install</Button>
          </div>
        </form>
        <label className="check-label install-override"><input type="checkbox" checked={forceInstall} onChange={(event) => setForceInstall(event.target.checked)} /> Allow a model larger than the router recommends for this machine</label>
        {local?.download?.status && local.download.status !== "done" ? (
          <DownloadProgress tag={local.download.tag} percent={local.download.percent} detail={local.download.detail || local.download.status} />
        ) : null}
        {quickPicks.length ? (
          <div className="lhc-local-quick-picks">
            <div className="lhc-local-subheading"><strong>Quick picks</strong><span>Shortlist for this machine</span></div>
            <div className="lhc-recommendations">
              {quickPicks.map((model) => (
                <button key={model.tag} type="button" disabled={model.downloadable === false} onClick={() => setInstallRef(model.tag)}>
                  <Box aria-hidden size={14} strokeWidth={1.7} />
                  <span><strong>{model.displayName || model.label || model.tag}</strong><small>{formatBytesGb(model.sizeGb)} · {model.fit || "fit unknown"}</small></span>
                  {model.downloadable === false ? <Badge tone="neutral">Cloud only</Badge> : model.recommended ? <Badge tone="accent">Recommended</Badge> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {catalogModels.length ? (
          <div className="lhc-catalog-browser">
            <div className="lhc-catalog-toolbar">
              <SearchField value={catalogQuery} onChange={setCatalogQuery} placeholder="Search Ollama families or tags" />
              <span>{catalogFamilies.length} famil{catalogFamilies.length === 1 ? "y" : "ies"} · {catalogVisibleTagCount(catalogFamilies)} {catalogQuery.trim() ? "matches" : "tags"}</span>
            </div>
            {catalogFamilies.length ? catalogFamilies.map((family) => {
              const expanded = expandedFamilies.has(family.id);
              return (
                <section className="lhc-catalog-family" key={family.id} data-expanded={expanded}>
                  <button
                    type="button"
                    className="lhc-catalog-family-trigger"
                    aria-expanded={expanded}
                    onClick={() => setExpandedFamilies((current) => {
                      const next = new Set(current);
                      if (next.has(family.id)) next.delete(family.id);
                      else next.add(family.id);
                      return next;
                    })}
                  >
                    <div>
                      <strong>{family.displayName}</strong>
                      <small>{family.models.length} tags · {familySummary(family.models)}</small>
                    </div>
                    <ChevronDown aria-hidden size={15} strokeWidth={1.7} />
                  </button>
                  {expanded ? (
                    <div className="lhc-catalog-family-panel">
                      {family.researchStatus ? <small className="lhc-catalog-research">{family.researchStatus}{family.researchCapabilities.length ? ` · ${family.researchCapabilities.join(" · ")}` : ""}</small> : null}
                      {family.researchNote ? <p className="lhc-catalog-note">{family.researchNote}</p> : null}
                      <div className="lhc-catalog-model-list">
                        {family.models.map((model) => (
                          <CatalogModelRow key={model.tag} model={model} onSelect={() => setInstallRef(model.tag)} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </section>
              );
            }) : (
              <EmptyState icon={<SearchX size={18} />} title="No Ollama tags match" body="Try a family name, size, or exact tag." />
            )}
          </div>
        ) : null}
      </section>

      <section className="panel-section">
        <SectionHeading title="Image reading" description="Choose how text-only models read pasted images. Local readers stay on this machine." />
        <div className="lhc-vision-settings">
          <div className="setting-row">
            <div><strong>Read pasted images</strong><small>The selected reader runs only when the target model cannot accept images.</small></div>
            <Toggle checked={bridge?.enabled === true} disabled={!api || !bridge} label="Enable vision bridge" onChange={(next) => api && void runAction(`${next ? "Enable" : "Disable"} vision bridge`, () => api.setVisionBridgeEnabled(next))} />
          </div>
          <div className="form-grid">
            <label>
              <span>Reader</span>
              <select value={selectedEngine} disabled={!api || !bridge} onChange={(event) => api && void runAction("Change image reader", () => api.setVisionBridgeEngine(event.target.value))}>
                <option value="auto">Automatic</option>
                {engines.filter((engine) => engine.group === "ChatGPT plan").length ? (
                  <optgroup label="ChatGPT plan">
                    {engines.filter((engine) => engine.group === "ChatGPT plan").map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                  </optgroup>
                ) : null}
                {engines.filter((engine) => engine.group === "Connected provider").length ? (
                  <optgroup label="Connected providers">
                    {engines.filter((engine) => engine.group === "Connected provider").map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                  </optgroup>
                ) : null}
                {bridge?.local ? <option value="local">Local: {bridge.local.model || "configured runtime"}</option> : null}
              </select>
            </label>
            <label>
              <span>Reasoning effort</span>
              <select value={bridge?.effort || "default"} disabled={!api || !bridge} onChange={(event) => api && void runAction("Change image-reader effort", () => api.setVisionBridgeEffort(event.target.value))}>
                <option value="default">Reader default</option>
                {effortOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
          </div>
          <InlineNotice tone={bridge?.resolvedEngine ? "success" : "warning"} title={bridge?.resolvedEngine ? "Reader resolved" : "No reader available"}>
            {bridge?.resolvedEngineName ? `${bridge.resolvedEngineName} will transcribe images.` : "Connect a vision provider or download a local image reader."}
          </InlineNotice>
        </div>

        {readerDownloadActive ? <DownloadProgress tag={bridge?.download?.tag} percent={bridge?.download?.percent} detail={bridge?.download?.detail || "Downloading local reader"} /> : null}
        {localReaders.length ? (
          <div className="local-reader-grid lhc-reader-grid">
            {localReaders.map((reader) => {
              const active = bridge?.engine === "local" && bridge.local?.model === reader.tag;
              return (
                <article className="reader-card" key={reader.tag}>
                  <header>
                    <span className="model-glyph"><HardDrive aria-hidden size={14} strokeWidth={1.7} /></span>
                    <div><strong>{reader.label || reader.displayName || reader.tag}</strong><small>{formatBytesGb(reader.sizeGb)} · {reader.accuracy || "untested"}</small></div>
                    {active ? <Badge tone="success">Active</Badge> : reader.recommended ? <Badge tone="accent">Recommended</Badge> : null}
                  </header>
                  <p>{reader.note || "Local model for pasted-image transcription."}</p>
                  {reader.measured?.percent !== undefined ? <small className="reader-score">Reference score {Math.round(reader.measured.percent)}%{reader.measuredLocally ? " · measured here" : ""}</small> : null}
                  <footer>
                    {reader.installed ? (
                      <>
                        <Button variant="ghost" disabled={!api || active} onClick={() => api && void runAction(`Use ${reader.tag} as image reader`, () => api.useLocalVisionModel(reader.tag))}><Eye aria-hidden size={13} strokeWidth={1.7} /> {active ? "In use" : "Use reader"}</Button>
                        <Button variant="ghost" disabled={!api} onClick={() => api && void runAction(`Measure ${reader.tag}`, () => api.benchmarkVisionModel(reader.tag))}><Gauge aria-hidden size={13} strokeWidth={1.7} /> Measure</Button>
                      </>
                    ) : (
                      <Button variant="secondary" disabled={!api || readerDownloadActive || reader.fits === false} onClick={() => api && void runAction(`Download ${reader.tag}`, () => api.downloadVisionModel(reader.tag))}><Download aria-hidden size={13} strokeWidth={1.7} /> Download</Button>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
        ) : <EmptyState title="No local image readers listed" body="Refresh after Ollama and the local vision catalog are available." />}
      </section>

      <Dialog open={Boolean(pendingRemoval)} title="Remove local model" description="This deletes the model weights from this machine." onClose={() => setPendingRemoval(null)}>
        <p className="dialog-copy">Remove <strong>{pendingRemoval}</strong>? You can download it again later.</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setPendingRemoval(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => {
            const tag = pendingRemoval;
            setPendingRemoval(null);
            if (tag && api) void runAction(`Remove ${tag}`, () => api.uninstallLocalModel(tag));
          }}><Trash2 aria-hidden size={14} strokeWidth={1.7} /> Remove</Button>
        </div>
      </Dialog>
    </div>
  );
}

interface CatalogFamily {
  id: string;
  displayName: string;
  models: LocalModel[];
  researchStatus?: string;
  researchCapabilities: string[];
  researchNote?: string;
}

function groupCatalogModels(
  models: LocalModel[],
  knownFamilies: LocalModelsSnapshot["families"] | undefined,
  query: string,
): CatalogFamily[] {
  const needle = query.trim().toLocaleLowerCase();
  const groups = new Map<string, CatalogFamily>();
  for (const model of models) {
    const familyId = model.family || model.tag.split(":", 1)[0] || model.tag;
    const searchable = `${model.tag} ${model.displayName || ""} ${model.family || ""}`.toLocaleLowerCase();
    if (needle && !searchable.includes(needle)) continue;
    const known = knownFamilies?.find((family) => family.family === familyId);
    const current = groups.get(familyId) || {
      id: familyId,
      displayName: (known?.displayName || model.displayName || familyId).split(" · ")[0],
      models: [],
      researchStatus: model.researchStatus,
      researchCapabilities: model.researchCapabilities || [],
      researchNote: model.researchNote,
    };
    current.models.push(model);
    if (!current.researchStatus && model.researchStatus) current.researchStatus = model.researchStatus;
    if (!current.researchCapabilities.length && model.researchCapabilities?.length) current.researchCapabilities = model.researchCapabilities;
    if (!current.researchNote && model.researchNote) current.researchNote = model.researchNote;
    groups.set(familyId, current);
  }
  return [...groups.values()]
    .map((family) => ({
      ...family,
      models: [...family.models].sort(catalogModelSort),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function catalogModelSort(left: LocalModel, right: LocalModel): number {
  const leftLatest = left.variant === "latest";
  const rightLatest = right.variant === "latest";
  if (leftLatest !== rightLatest) return leftLatest ? -1 : 1;
  const leftFit = localModelFits(left);
  const rightFit = localModelFits(right);
  if (leftFit !== rightFit) return leftFit ? -1 : 1;
  return (left.tag || "").localeCompare(right.tag || "");
}

function localModelFits(model: LocalModel): boolean {
  return model.downloadable !== false && model.fit !== "too-large" && model.diskFit !== "too-large";
}

function catalogVisibleTagCount(families: CatalogFamily[]): number {
  return families.reduce((count, family) => count + family.models.length, 0);
}

function familySummary(models: LocalModel[]): string {
  const fit = models.filter(localModelFits).length;
  const cloud = models.filter((model) => model.downloadable === false).length;
  if (cloud === models.length) return "cloud only";
  if (fit === models.length) return "all fit this machine";
  if (fit && cloud) return `${fit} fit · ${cloud} cloud`;
  if (fit) return `${fit} fit`;
  if (cloud) return `${cloud} cloud`;
  return "no local variant fits";
}

function CatalogModelRow({ model, onSelect }: { model: LocalModel; onSelect: () => void }) {
  const downloadable = model.downloadable !== false;
  const tooLarge = model.fit === "too-large" || model.diskFit === "too-large";
  const fitLabel = model.downloadable === false
    ? "Cloud only"
    : tooLarge
      ? "Too large"
      : model.fit === "tight" || model.diskFit === "tight"
        ? "Memory tight"
        : "Fits this machine";
  const tone = model.downloadable === false ? "neutral" : tooLarge ? "danger" : model.fit === "tight" ? "warning" : "success";
  return (
    <article className="lhc-catalog-model">
      <Box aria-hidden size={14} strokeWidth={1.7} />
      <div className="lhc-catalog-model-identity">
        <strong>{model.displayName || model.label || model.tag}</strong>
        <small>{model.tag}{model.sizeGb !== undefined ? ` · ${formatBytesGb(model.sizeGb)}` : ""}{model.context ? ` · ${compactNumber(model.context)} context` : ""}</small>
      </div>
      <Badge tone={tone}>{fitLabel}</Badge>
      <Button variant="ghost" disabled={!downloadable || tooLarge} onClick={onSelect}>
        <Download aria-hidden size={13} strokeWidth={1.7} /> Select
      </Button>
    </article>
  );
}

function DownloadProgress({ tag, percent, detail }: { tag?: string; percent?: number; detail?: string }) {
  return (
    <div className="download-progress">
      <div><strong>{tag || "Local model"}</strong><span>{Math.round(percent || 0)}%</span></div>
      <progress max="100" value={percent || 0} />
      <small>{detail || "Preparing download"}</small>
    </div>
  );
}

function LocalModelRow({ model, enabled, disabled, onToggle, onBenchmark, onRemove }: {
  model: LocalModel;
  enabled: boolean;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onBenchmark: () => void;
  onRemove: () => void;
}) {
  const speed = model.observedTokensPerSecond ?? model.speed;
  return (
    <article className="local-model-row">
      <div className="model-identity">
        <span className="model-glyph"><HardDrive aria-hidden size={15} strokeWidth={1.7} /></span>
        <div><strong>{model.displayName || model.label || model.tag}</strong><small>{model.tag}</small></div>
      </div>
      <div className="local-model-facts">
        <span>{formatBytesGb(model.sizeGb)}</span>
        <span>{model.context ? `${compactNumber(model.context)} context` : "Context unreported"}</span>
        <span>{Number.isFinite(Number(speed)) ? `${Number(speed).toFixed(1)} tok/s` : "Speed unmeasured"}</span>
      </div>
      <div className="row-actions">
        <Button variant="ghost" disabled={disabled} onClick={onBenchmark}><Gauge aria-hidden size={14} strokeWidth={1.7} /> Measure</Button>
        <Button variant="ghost" disabled={disabled} aria-label={`Remove ${model.tag}`} onClick={onRemove}><Trash2 aria-hidden size={14} strokeWidth={1.7} /></Button>
        <Toggle checked={enabled} disabled={disabled} label={`Enable ${model.tag} for Codex`} onChange={onToggle} />
      </div>
    </article>
  );
}
