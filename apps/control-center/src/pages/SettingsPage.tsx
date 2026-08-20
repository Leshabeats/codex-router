import { useState } from "react";
import { AppWindow, Eye, Moon, RefreshCw, Server, Sun } from "lucide-react";
import { Badge, Button, Dialog, InlineNotice, PageHeader, SectionHeading, Toggle } from "../components";
import { compactNumber } from "../lib";
import { LANGUAGE_OPTIONS, type LanguageId, type Translate } from "../i18n";
import type { PresenceSnapshot, RouterControlApi, RouterHealth, RouterTarget, VisionEngine } from "../types";

type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;

// Mirrors RETENTION_MIN/MAX/DEFAULT_TTL_DAYS in src/tool-result-retention.mjs.
// `0` is not "no retention" -- it is the stored answer meaning "keep the
// archived originals until I say otherwise", so it gets its own option rather
// than being folded in with the default.
const RETENTION_DEFAULT_TTL_DAYS = 7;
const RETENTION_CHOICES = [1, 3, 7, 14, 30, 90];

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function SettingsPage({ target, health, presence, api, theme, onTheme, language, onLanguage, t, refreshing, onRefresh, runAction }: {
  target?: RouterTarget;
  health?: RouterHealth;
  presence?: PresenceSnapshot;
  api?: RouterControlApi;
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  language: LanguageId;
  onLanguage: (language: LanguageId) => void;
  t: Translate;
  refreshing: boolean;
  onRefresh: () => void;
  runAction: RunAction;
}) {
  const [confirmTrayDisable, setConfirmTrayDisable] = useState(false);

  const aging = target?.modelSettings?.toolResultAging;
  const agingLocked = aging?.environmentOverride === true;
  const stats = aging?.stats;
  const hasSavings = typeof stats?.estimatedTokensSaved === "number" && stats.estimatedTokensSaved > 0;
  // `retentionTtlDays` is absent only when nobody has answered, which is a
  // different state from a stored 0. Keep them apart in the select.
  const ttlValue = aging?.retentionTtlDays === undefined ? "default" : String(aging.retentionTtlDays);
  const ttlChoices = aging?.retentionTtlDays !== undefined && aging.retentionTtlDays > 0
      && !RETENTION_CHOICES.includes(aging.retentionTtlDays)
    ? [...RETENTION_CHOICES, aging.retentionTtlDays].sort((left, right) => left - right)
    : RETENTION_CHOICES;

  const bridge = target?.modelSettings?.visionBridge;
  const engines: Array<VisionEngine & { group: string }> = [
    ...(bridge?.nativeEngines ?? []).map((engine) => ({ ...engine, group: "native" })),
    ...(bridge?.paidEngines ?? []).map((engine) => ({ ...engine, group: "paid" })),
  ];
  const selectedEngine = bridge?.engine || "auto";
  const selectedEngineMeta = engines.find((engine) => engine.slug === selectedEngine);
  const effortOptions = selectedEngineMeta?.efforts?.length
    ? selectedEngineMeta.efforts
    : bridge?.availableEfforts ?? [];

  return (
    <>
      <PageHeader eyebrow={t("settings.eyebrow")} title={t("settings.title")} description={t("settings.description")} onRefresh={onRefresh} refreshing={refreshing} />
      <div className="settings-columns">
        <div className="page-stack">
          <section className="panel-section">
            <SectionHeading title={t("settings.routing.title")} description={t("settings.routing.description")} />
            <div className="settings-list">
              <div className="setting-row">
                <div><strong>{t("settings.signedRouting.title")}</strong><small>{t("settings.signedRouting.detail")}</small></div>
                <Toggle checked={target?.signedRouting === true} disabled={!api || !target} label={t("settings.signedRouting.title")} onChange={(enabled) => api && void runAction("Change signed routing", () => api.setSignedRouting(enabled))} />
              </div>
            </div>
            <InlineNotice tone="neutral" title={t("settings.restart.title")}>{t("settings.restart.body")}</InlineNotice>
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.service.title")} description={t("settings.service.description")} />
            <div className="settings-list">
              <div className="setting-row">
                <div><strong>{t("settings.presence.title")}</strong><small>{t("settings.presence.detail")}</small></div>
                <select
                  aria-label={t("settings.presence.title")}
                  value={presence?.mode || "always"}
                  disabled={!api}
                  onChange={(event) => api && void runAction("Change presence mode", () => api.setPresence(event.target.value as "always" | "follow-codex"))}
                >
                  <option value="always">{t("settings.presence.always")}</option>
                  <option value="follow-codex">{t("settings.presence.followCodex")}</option>
                </select>
              </div>
              <div className="setting-row static-row">
                <div><strong>{t("settings.serviceState.title")}</strong><small>{t("settings.serviceState.detail")}</small></div>
                <Badge tone={health?.ok ? "success" : "danger"}>{health?.ok ? t("settings.serviceState.running") : t("settings.serviceState.offline")}</Badge>
              </div>
            </div>
            <div className="settings-actions">
              <Button variant="secondary" disabled={!api} onClick={() => api && void runAction("Start router service", () => api.controlService("start"))}><Server aria-hidden size={14} strokeWidth={1.7} /> {t("settings.action.start")}</Button>
            </div>
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.context.title")} description={t("settings.context.description")} />
            {aging ? (
              <>
                <div className="settings-list">
                  <div className="setting-row">
                    <div><strong>{t("settings.context.enable.title")}</strong><small>{t("settings.context.enable.detail")}</small></div>
                    <Toggle checked={aging.enabled === true} disabled={!api || agingLocked} label={t("settings.context.enable.title")} onChange={(enabled) => api && void runAction("Change tool result compaction", () => api.setToolResultAging(enabled))} />
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.context.native.title")}</strong><small>{t("settings.context.native.detail")}</small></div>
                    <Toggle checked={aging.nativeEnabled === true} disabled={!api || agingLocked || aging.enabled !== true} label={t("settings.context.native.title")} onChange={(enabled) => api && void runAction("Change native tool result compaction", () => api.setNativeToolResultAging(enabled))} />
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.context.ttl.title")}</strong><small>{t("settings.context.ttl.detail")}</small></div>
                    <select
                      aria-label={t("settings.context.ttl.title")}
                      value={ttlValue}
                      disabled={!api || agingLocked}
                      onChange={(event) => {
                        const raw = event.target.value;
                        const days = raw === "default" ? "default" : Number(raw);
                        if (api) void runAction("Change retention window", () => api.setToolResultRetentionTtl(days));
                      }}
                    >
                      <option value="default">{t("settings.context.ttl.default", { days: RETENTION_DEFAULT_TTL_DAYS })}</option>
                      {ttlChoices.map((days) => <option key={days} value={String(days)}>{t("settings.context.ttl.days", { days })}</option>)}
                      <option value="0">{t("settings.context.ttl.forever")}</option>
                    </select>
                  </div>
                </div>
                {agingLocked ? (
                  <InlineNotice tone="warning" title={t("settings.context.envOverride.title")}>{t("settings.context.envOverride.body")}</InlineNotice>
                ) : null}
                <p className="section-footnote">
                  {hasSavings
                    ? t("settings.context.savings", {
                        tokens: compactNumber(stats?.estimatedTokensSaved),
                        size: formatBytes(stats?.bytesSaved),
                        requests: compactNumber(stats?.requests),
                      })
                    : t("settings.context.noSavings")}
                </p>
              </>
            ) : <InlineNotice tone="neutral" title={t("settings.context.title")}>{t("settings.context.unavailable")}</InlineNotice>}
          </section>
        </div>

        <div className="page-stack">
          <section className="panel-section">
            <SectionHeading title={t("settings.vision.title")} description={t("settings.vision.description")} />
            {bridge ? (
              <>
                <div className="settings-list">
                  <div className="setting-row">
                    <div><strong>{t("settings.vision.enable.title")}</strong><small>{t("settings.vision.enable.detail")}</small></div>
                    <Toggle checked={bridge.enabled === true} disabled={!api} label={t("settings.vision.enable.title")} onChange={(enabled) => api && void runAction("Change vision bridge", () => api.setVisionBridgeEnabled(enabled))} />
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.vision.engine.title")}</strong><small>{t("settings.vision.engine.detail")}</small></div>
                    <select
                      aria-label={t("settings.vision.engine.title")}
                      value={selectedEngine}
                      disabled={!api}
                      onChange={(event) => api && void runAction("Change vision engine", () => api.setVisionBridgeEngine(event.target.value))}
                    >
                      <option value="auto">{t("settings.vision.engine.auto", { name: bridge.resolvedEngineName || bridge.resolvedEngine || "—" })}</option>
                      {engines.map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                      {bridge.local ? <option value="local">{t("settings.vision.engine.local", { name: bridge.local.model || "runtime" })}</option> : null}
                    </select>
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.vision.effort.title")}</strong><small>{effortOptions.length ? t("settings.vision.effort.detail") : t("settings.vision.effort.none")}</small></div>
                    <select
                      aria-label={t("settings.vision.effort.title")}
                      value={bridge.effort || "default"}
                      disabled={!api || !effortOptions.length}
                      onChange={(event) => api && void runAction("Change vision effort", () => api.setVisionBridgeEffort(event.target.value))}
                    >
                      <option value="default">{t("settings.vision.effort.default")}</option>
                      {effortOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                    </select>
                  </div>
                </div>
                <div className="surface-summary">
                  <Eye aria-hidden size={20} strokeWidth={1.6} />
                  <div><strong>{bridge.resolvedEngineName || bridge.resolvedEngine || "—"}</strong><small>{t("settings.vision.localNote")}</small></div>
                </div>
              </>
            ) : <InlineNotice tone="neutral" title={t("settings.vision.title")}>{t("settings.vision.unavailable")}</InlineNotice>}
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.desktop.title")} description={t("settings.desktop.description")} />
            <div className="surface-summary">
              <AppWindow aria-hidden size={20} strokeWidth={1.6} />
              <div><strong>{t("settings.desktop.tray.title")}</strong><small>{t("settings.desktop.tray.detail")}</small></div>
            </div>
            <div className="settings-actions">
              <Button variant="secondary" disabled={!api} onClick={() => api && void runAction("Enable desktop tray", () => api.controlTray("enable"))}>{t("settings.desktop.enable")}</Button>
              <Button variant="secondary" disabled={!api} onClick={() => api && void runAction("Restart desktop tray", () => api.controlTray("restart"))}>{t("settings.desktop.restart")}</Button>
              <Button variant="ghost" disabled={!api} onClick={() => setConfirmTrayDisable(true)}>{t("settings.desktop.disable")}</Button>
            </div>
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.appearance.title")} description={t("settings.appearance.description")} />
            <div className="theme-picker" role="radiogroup" aria-label={t("settings.appearance.aria")}>
              <button role="radio" aria-checked={theme === "light"} className={theme === "light" ? "is-active" : ""} onClick={() => onTheme("light")}><Sun aria-hidden size={16} strokeWidth={1.7} /><span><strong>{t("settings.appearance.light")}</strong><small>{t("settings.appearance.lightDetail")}</small></span></button>
              <button role="radio" aria-checked={theme === "dark"} className={theme === "dark" ? "is-active" : ""} onClick={() => onTheme("dark")}><Moon aria-hidden size={16} strokeWidth={1.7} /><span><strong>{t("settings.appearance.dark")}</strong><small>{t("settings.appearance.darkDetail")}</small></span></button>
            </div>
            <div className="settings-list">
              <div className="setting-row">
                <div><strong>{t("settings.language.title")}</strong><small>{t("settings.language.detail")}</small></div>
                <select
                  aria-label={t("settings.language.aria")}
                  value={language}
                  onChange={(event) => onLanguage(event.target.value as LanguageId)}
                >
                  {LANGUAGE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </div>
            </div>
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.maintenance.title")} description="Updates and repairs are terminal-only during the beta." />
            <InlineNotice tone="neutral" title="Run maintenance in an interactive terminal">
              Use <code>bin/model-router codex doctor --fix</code> to repair the installation, or the documented update command for your install method. The Control Center keeps Doctor read-only.
            </InlineNotice>
          </section>
        </div>
      </div>

      <Dialog open={confirmTrayDisable} title={t("settings.desktop.confirm.title")} description={t("settings.desktop.confirm.description")} onClose={() => setConfirmTrayDisable(false)}>
        <p className="dialog-copy">{t("settings.desktop.confirm.body")}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfirmTrayDisable(false)}>{t("settings.desktop.confirm.cancel")}</Button>
          <Button variant="danger" onClick={() => {
            setConfirmTrayDisable(false);
            if (api) void runAction("Disable desktop tray", () => api.controlTray("disable"));
          }}>{t("settings.desktop.disable")}</Button>
        </div>
      </Dialog>
    </>
  );
}
