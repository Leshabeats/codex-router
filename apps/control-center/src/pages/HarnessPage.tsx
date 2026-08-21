import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AppWindow,
  BookOpen,
  Boxes,
  CheckCircle2,
  Download,
  ExternalLink,
  Route,
  ShieldAlert,
  SquareTerminal,
} from "lucide-react";
import { Badge, Button, InlineNotice, PageHeader, PanelSkeleton, SectionHeading, StatStrip } from "../components";
import type { HarnessDescriptor, HarnessSnapshot, RouterControlApi, RouterTarget } from "../types";
import "./local-harness-context.css";

type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;

interface HarnessPageProps {
  target?: RouterTarget;
  api?: RouterControlApi;
  refreshing: boolean;
  onRefresh: () => void;
  runAction: RunAction;
}

export function HarnessPage({ target, api, refreshing, onRefresh, runAction }: HarnessPageProps) {
  const [snapshot, setSnapshot] = useState<HarnessSnapshot>();
  const [error, setError] = useState<string>();
  const loadHarnesses = useCallback(async () => {
    if (!api) return;
    try {
      setSnapshot(await api.getHarnesses());
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Harness detection failed.");
    }
  }, [api]);

  useEffect(() => { void loadHarnesses(); }, [loadHarnesses]);

  const codex = snapshot?.harnesses.find((harness) => harness.id === "codex");
  const deepcode = snapshot?.harnesses.find((harness) => harness.id === "deepcode");
  const deepseekModels = useMemo(
    () => (target?.models ?? []).filter((model) => (model.enabled || model.native) && `${model.provider}/${model.slug}`.toLowerCase().includes("deepseek")),
    [target],
  );
  const provenModels = target?.models.filter((model) => model.enabled && model.multiAgentVersion === "v2") ?? [];

  const refresh = () => {
    onRefresh();
    void loadHarnesses();
  };
  const act = async (label: string, action: () => Promise<unknown>) => {
    await runAction(label, action);
    await loadHarnesses();
  };

  return (
    <>
      <PageHeader
        eyebrow="Coding environments"
        title="Harness"
        description="Launch each coding environment in the surface it actually supports."
        onRefresh={refresh}
        refreshing={refreshing}
      />
      <StatStrip items={[
        { label: "Detected", value: snapshot?.harnesses.filter((harness) => harness.cliInstalled || harness.appInstalled).length ?? 0, detail: "Supported harnesses" },
        { label: "Codex app", value: codex?.appInstalled ? "Ready" : "Not found", detail: codex?.cliVersion || "Desktop task links" },
        { label: "DeepSeek routes", value: deepseekModels.length, detail: target?.enabledProviders.includes("deepseek") ? "Provider connected" : "Via enabled providers" },
        { label: "Subagent relay", value: provenModels.length, detail: "Proven v2 models" },
      ]} />

      {error ? <InlineNotice tone="warning" title="Harness detection is incomplete">{error}</InlineNotice> : null}

      <div className="lhc-harness-grid">
        {!snapshot && !error ? <PanelSkeleton label="Detecting harnesses" variant="cards" count={2} /> : null}
        {codex ? (
          <HarnessCard
            harness={codex}
            accent="codex"
            status={codex.cliInstalled ? "CLI detected" : codex.appInstalled ? "App detected" : "Not installed"}
            facts={[
              codex.appInstalled ? "Desktop task links available" : "Desktop app not detected",
              codex.cliInstalled ? codex.cliVersion || "Codex CLI available" : "Codex CLI not detected",
              `${target?.models.filter((model) => model.enabled || model.native).length ?? 0} routed models available`,
            ]}
            actions={
              <>
                {codex.appInstalled ? (
                  <Button variant="primary" disabled={!api} onClick={() => api && void act("Open Codex app", () => api.launchHarness("codex", "app"))}>
                    <AppWindow aria-hidden size={14} strokeWidth={1.7} /> Open app
                  </Button>
                ) : (
                  <Button variant="primary" disabled={!api} onClick={() => api && void act("Open official Codex download", () => api.openExternal(codex.docsUrl))}>
                    <Download aria-hidden size={14} strokeWidth={1.7} /> Get Codex
                  </Button>
                )}
                <Button variant="secondary" disabled={!api || !codex.cliInstalled || !snapshot?.terminalAvailable} onClick={() => api && void act("Open Codex terminal", () => api.launchHarness("codex", "terminal"))}>
                  <SquareTerminal aria-hidden size={14} strokeWidth={1.7} /> Open terminal
                </Button>
                <Button variant="ghost" disabled={!api} onClick={() => api && void act("Open Codex documentation", () => api.openExternal(codex.docsUrl))}>
                  <BookOpen aria-hidden size={14} strokeWidth={1.7} /> Docs
                </Button>
              </>
            }
          />
        ) : null}

        {deepcode ? (
          <HarnessCard
            harness={deepcode}
            accent="deepcode"
            status={deepcode.cliInstalled ? "CLI detected" : "Optional install"}
            facts={[
              deepcode.configured ? "Settings file detected" : "Configuration not detected",
              deepcodeModelsLabel(deepseekModels.length),
              "Sessions resume in a real terminal",
            ]}
            notice="Deep Code is a third-party reference integration listed by DeepSeek. It is not an official DeepSeek desktop app."
            actions={
              <>
                {deepcode.cliInstalled ? (
                  <Button variant="primary" disabled={!api || !snapshot?.terminalAvailable} onClick={() => api && void act("Open Deep Code terminal", () => api.launchHarness("deepcode", "terminal"))}>
                    <SquareTerminal aria-hidden size={14} strokeWidth={1.7} /> Open terminal
                  </Button>
                ) : (
                  <Button variant="primary" disabled={!api || !deepcode.canInstall} title={deepcode.installRequirement} onClick={() => api && void act("Open Deep Code installer", () => api.installHarness("deepcode"))}>
                    <Download aria-hidden size={14} strokeWidth={1.7} /> Install in Terminal
                  </Button>
                )}
                <Button variant="ghost" disabled={!api} onClick={() => api && void act("Open Deep Code reference", () => api.openExternal(deepcode.docsUrl))}>
                  <ExternalLink aria-hidden size={14} strokeWidth={1.7} /> Reference
                </Button>
              </>
            }
          />
        ) : null}
      </div>

      <section className="panel-section">
        <SectionHeading title="Routing shared by the harnesses" description="The router exposes models to Codex. Deep Code keeps its own provider settings and session store." />
        <div className="lhc-continuity-map">
          <article>
            <Route aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>Codex Router catalog</strong><small>{target?.models.filter((model) => model.enabled || model.native).length ?? 0} models are available to new Codex tasks.</small></div>
            <Badge tone={target?.active ? "success" : "neutral"}>{target?.active ? "Active" : "Inactive"}</Badge>
          </article>
          <article>
            <Boxes aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>DeepSeek models</strong><small>{deepseekModels.length ? deepseekModels.map((model) => model.displayName).slice(0, 3).join(", ") : "Connect a DeepSeek-capable provider to expose models in Codex."}</small></div>
            <Badge tone={deepseekModels.length ? "success" : "neutral"}>{deepseekModels.length ? `${deepseekModels.length} ready` : "None"}</Badge>
          </article>
          <article>
            <ShieldAlert aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>Credential boundary</strong><small>The control center never copies a credential from one harness into another.</small></div>
            <Badge tone="accent">Isolated</Badge>
          </article>
        </div>
      </section>

    </>
  );
}

function HarnessCard({ harness, accent, status, facts, notice, actions }: {
  harness: HarnessDescriptor;
  accent: "codex" | "deepcode";
  status: string;
  facts: string[];
  notice?: string;
  actions: ReactNode;
}) {
  return (
    <section className={`lhc-harness-card is-${accent}`}>
      <header>
        <span className="lhc-harness-mark" aria-hidden>{accent === "codex" ? <Boxes size={21} strokeWidth={1.6} /> : <Route size={21} strokeWidth={1.6} />}</span>
        <div><h2>{harness.displayName}</h2><p>{harness.description}</p></div>
        <Badge tone={harness.cliInstalled || harness.appInstalled ? "success" : "neutral"}>{status}</Badge>
      </header>
      <div className="lhc-harness-facts">
        {facts.map((fact) => <div key={fact}><CheckCircle2 aria-hidden size={13} strokeWidth={1.8} /><span>{fact}</span></div>)}
      </div>
      {notice ? <p className="lhc-harness-notice">{notice}</p> : null}
      <footer>{actions}</footer>
    </section>
  );
}

function deepcodeModelsLabel(count: number): string {
  if (!count) return "No DeepSeek route is enabled in Codex";
  return `${count} DeepSeek model${count === 1 ? "" : "s"} available in Codex`;
}
