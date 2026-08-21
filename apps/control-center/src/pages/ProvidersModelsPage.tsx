import { type KeyboardEvent } from "react";
import { Boxes, KeyRound } from "lucide-react";
import { PageHeader } from "../components";
import type {
  ProviderSetupSnapshot,
  ProviderUsageSnapshot,
  RouterControlApi,
  RouterTarget,
  CatalogSection,
} from "../types";
import { ModelsPage } from "./ModelsPage";
import { ProvidersPage } from "./ProvidersPage";
import "./providers-models.css";

type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;
interface ProvidersModelsPageProps {
  target?: RouterTarget;
  setup?: ProviderSetupSnapshot;
  usage?: ProviderUsageSnapshot;
  api?: RouterControlApi;
  refreshing: boolean;
  onRefresh: () => void;
  runAction: RunAction;
  section: CatalogSection;
  onSectionChange: (section: CatalogSection) => void;
}

export function ProvidersModelsPage({
  target,
  setup,
  usage,
  api,
  refreshing,
  onRefresh,
  runAction,
  section,
  onSectionChange,
}: ProvidersModelsPageProps) {
  const shared = { target, api, refreshing, onRefresh, runAction, embedded: true };
  function moveSection(event: KeyboardEvent<HTMLButtonElement>, next: CatalogSection) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const destination = event.key === "Home"
      ? "providers"
      : event.key === "End"
        ? "models"
        : next;
    onSectionChange(destination);
    document.getElementById(`${destination}-tab`)?.focus();
  }

  return (
    <div className="providers-models-hub">
      <PageHeader
        eyebrow="Routing catalog"
        title="Providers & models"
        description="Connect model networks, then choose what Codex offers in its picker and to subagents."
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      <div className="pm-section-switcher" role="tablist" aria-label="Providers and models">
        <button
          id="providers-tab"
          type="button"
          role="tab"
          aria-selected={section === "providers"}
          aria-controls="providers-panel"
          tabIndex={section === "providers" ? 0 : -1}
          className={section === "providers" ? "is-active" : ""}
          onClick={() => onSectionChange("providers")}
          onKeyDown={(event) => moveSection(event, "models")}
        >
          <KeyRound aria-hidden size={14} strokeWidth={1.7} />
          <span><strong>Providers</strong><small>Accounts and credentials</small></span>
        </button>
        <button
          id="models-tab"
          type="button"
          role="tab"
          aria-selected={section === "models"}
          aria-controls="models-panel"
          tabIndex={section === "models" ? 0 : -1}
          className={section === "models" ? "is-active" : ""}
          onClick={() => onSectionChange("models")}
          onKeyDown={(event) => moveSection(event, "providers")}
        >
          <Boxes aria-hidden size={14} strokeWidth={1.7} />
          <span><strong>Models</strong><small>Catalog and availability</small></span>
        </button>
      </div>

      <div
        id="providers-panel"
        role="tabpanel"
        aria-labelledby="providers-tab"
        hidden={section !== "providers"}
      >
        <ProvidersPage {...shared} setup={setup} usage={usage} />
      </div>
      <div
        id="models-panel"
        role="tabpanel"
        aria-labelledby="models-tab"
        hidden={section !== "models"}
      >
        <ModelsPage {...shared} />
      </div>
    </div>
  );
}
