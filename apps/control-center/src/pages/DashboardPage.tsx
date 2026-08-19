import { useMemo } from "react";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Boxes,
  BrainCircuit,
  CircleGauge,
  Clock3,
  Gauge,
  KeyRound,
  Server,
  Settings,
  Waypoints,
} from "lucide-react";
import { Badge, Button, EmptyState, InlineNotice, PageHeader, SectionHeading } from "../components";
import { ProviderLogo } from "../provider-branding";
import {
  classNames,
  compactNumber,
  exactNumber,
  formatDateTime,
  formatDuration,
  remainingPercent,
} from "../lib";
import type {
  AccountUsage,
  ActiveRequest,
  PresenceSnapshot,
  ProviderSetupSnapshot,
  ProviderUsageSnapshot,
  RouterControlApi,
  RouterHealth,
  RouterTarget,
  UsageEvent,
  UsageMetric,
  ViewId,
} from "../types";
import "./dashboard.css";

type Tone = "success" | "warning" | "danger" | "accent";

interface SummaryTile {
  id: string;
  label: string;
  icon: typeof Activity;
  value: string;
  detail: string;
  tone?: Tone;
  meter?: number;
  view: ViewId;
  viewLabel: string;
}

interface MetricEntry {
  provider: string;
  label: string;
  metric: UsageMetric;
}

interface Chip {
  key: string;
  label: string;
  value: string;
  tone?: Tone;
}

interface TrafficBucket {
  key: string;
  label: string;
  fullLabel: string;
  tokens: number;
  requests: number;
  measuredTokens: boolean;
  regularInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  measuredBreakdown: boolean;
}

interface TrafficBreakdownRow {
  id: string;
  label: string;
  provider?: string;
  tokens: number;
  requests: number;
  measuredTokens: boolean;
  share: number;
  scope?: "rolling 24h" | "90-day ledger";
}

const RECENT_EVENT_LIMIT = 5;
const PROVIDER_LOGO_LIMIT = 8;

export function DashboardPage({
  target,
  health,
  account,
  providerUsage,
  setup,
  presence,
  api,
  refreshing,
  onRefresh,
  onNavigate,
}: {
  target?: RouterTarget;
  health?: RouterHealth;
  account?: AccountUsage;
  providerUsage?: ProviderUsageSnapshot;
  setup?: ProviderSetupSnapshot;
  presence?: PresenceSnapshot;
  api?: RouterControlApi;
  refreshing: boolean;
  onRefresh: () => void;
  onNavigate: (view: ViewId) => void;
}) {
  // Every prop can be undefined on first paint and after a failed refresh, so
  // each tile below separates three cases: still loading, reported-but-absent,
  // and a genuine zero. A missing field must never render as 0.
  const pending = refreshing ? "Checking" : "Unavailable";

  const activity = health?.activity;
  const active: ActiveRequest[] = activity?.active ?? [];
  const activityMeasured = Boolean(health && activity);
  const liveCount = activityMeasured ? activity?.activeCount ?? active.length : null;
  const chatCount = uniqueCount(active.map((request) =>
    request.sessionId ?? request.sessionName ?? request.threadId ?? request.id,
  ));
  const subagents = active.filter((request) =>
    request.isSubagent === true
    || Boolean(request.agentName)
    || Boolean(request.agentNickname),
  );
  const routerState = health
    ? health.ok ? activity?.state || "idle" : "offline"
    : refreshing ? "starting" : "offline";

  const providers = providerUsage?.providers ?? [];
  const telemetryEvents24h = recentWindowEvents(target?.usageEvents, Date.now());
  const eventTokens24h = sumEventTokens(telemetryEvents24h);
  const eventRequests24h = eventsCountOrNull(target?.usageEvents, telemetryEvents24h);
  const reportedTokens24h = sumReported(providers.map((provider) => provider.last24hTokens));
  const reportedRequests24h = sumReported(providers.map((provider) => provider.last24hRequests));
  // Older installed routers expose the same bounded event stream but predate
  // the provider-level rolling counters. Use it as a presentation fallback so
  // a real day of traffic is not painted as empty during an app/router update.
  const tokens24h = reportedTokens24h ?? eventTokens24h;
  const requests24h = reportedRequests24h ?? eventRequests24h;
  const usageMeasured = Boolean(providerUsage || target?.usageEvents);

  const metrics = useMemo(() => collectMetrics(account, providerUsage), [account, providerUsage]);
  const quotaLoaded = Boolean(account || providerUsage);
  const nextReset = useMemo(() => {
    const now = Date.now();
    return metrics
      .map((entry) => ({ entry, resetAt: resetAtOf(entry.metric) }))
      .filter((row): row is { entry: MetricEntry; resetAt: number | string } =>
        row.resetAt !== undefined && timestampFor(row.resetAt) > now,
      )
      .sort((left, right) => timestampFor(left.resetAt) - timestampFor(right.resetAt))[0];
  }, [metrics]);
  const lowestAllowance = useMemo(() => {
    return metrics
      .map((entry) => ({ entry, percent: remainingPercent(entry.metric) }))
      .filter((row): row is { entry: MetricEntry; percent: number } => row.percent !== null)
      .sort((left, right) => left.percent - right.percent)[0];
  }, [metrics]);
  const allowanceTone: Tone | undefined = lowestAllowance
    ? lowestAllowance.percent < 15 ? "danger" : lowestAllowance.percent < 35 ? "warning" : undefined
    : undefined;

  const models = target?.models ?? [];
  const availableModels = models.filter((model) => model.enabled || model.native).length;
  const pickerModels = models.filter((model) => model.visible).length;
  const agentReadyModels = models.filter((model) =>
    model.enabled && model.multiAgentVersion === "v2",
  ).length;

  const configuredProviders = setup ? setup.providers.filter((provider) => provider.configured).length : null;
  const totalProviders = setup ? setup.providers.length : null;
  const routedProviderIds = target?.enabledProviders ?? [];

  const cachedInput = providerUsage?.contextEfficiency?.last24hCachedInputTokens;
  const events: UsageEvent[] | undefined = target?.usageEvents;
  const observedInput = events
    ? events.reduce((sum, event) => sum + (event.inputTokens || 0), 0)
    : null;
  const reuseShare = cachedInput !== undefined && observedInput !== null && observedInput > 0
    ? Math.min(100, (cachedInput / observedInput) * 100)
    : null;
  const recentEvents = events ? [...events].reverse().slice(0, RECENT_EVENT_LIMIT) : [];

  // The provider snapshot gives us accurate rolling totals, while the bounded
  // event stream gives the dashboard an honest hourly shape. Keep this local to
  // the renderer: it is a presentation view and must not become a second
  // accounting ledger in the router.
  const trafficBuckets = buildTrafficBuckets(events, Date.now());
  const providerBreakdown = buildProviderBreakdown(providerUsage, events, Date.now());
  const modelBreakdown = buildModelBreakdown(providerUsage, events, Date.now());
  const trafficHasRequests = trafficBuckets.some((bucket) => bucket.requests > 0);
  const trafficHasTokens = trafficBuckets.some((bucket) => bucket.measuredTokens);

  const tiles: SummaryTile[] = [
    {
      id: "router",
      label: "Router state",
      icon: Activity,
      value: health ? health.ok ? "Online" : "Offline" : pending,
      detail: health
        ? health.ok
          ? `${activityLabel(routerState)}${health.version ? ` · version ${health.version}` : ""}`
          : health.error || "The local health endpoint did not answer"
        : refreshing ? "Contacting the local health endpoint" : "Router health has not been read",
      tone: health ? health.ok ? "success" : "danger" : undefined,
      view: "status",
      viewLabel: "Status",
    },
    {
      id: "live",
      label: "Live now",
      icon: Waypoints,
      value: !health ? pending : activityMeasured ? exactNumber(liveCount) : "Not measured",
      detail: !health
        ? "Waiting for the first health response"
        : activityMeasured
          ? `${exactNumber(chatCount)} ${plural(chatCount, "chat")} · ${exactNumber(subagents.length)} ${plural(subagents.length, "subagent")}`
          : "This router build does not report live activity",
      tone: activityMeasured && (liveCount || 0) > 0 ? "accent" : undefined,
      view: "status",
      viewLabel: "Status",
    },
    {
      id: "tokens",
      label: "Tokens, last 24h",
      icon: CircleGauge,
      value: !usageMeasured ? pending : tokens24h === null ? "Not measured" : compactNumber(tokens24h),
      detail: !usageMeasured
        ? "Waiting for router usage telemetry"
        : tokens24h === null
          ? "No provider or event reports a rolling 24-hour window"
          : `${exactNumber(tokens24h)} router tokens${requests24h === null ? "" : ` · ${exactNumber(requests24h)} ${plural(requests24h, "request")}`} · ${reportedTokens24h !== null ? "sum of provider rows" : "sum of recent event details"}`,
      view: "usage",
      viewLabel: "Usage",
    },
    {
      id: "reset",
      label: "Next quota reset",
      icon: Clock3,
      value: !quotaLoaded ? pending : nextReset ? resetCountdown(nextReset.resetAt) : "Not reported",
      detail: !quotaLoaded
        ? "Waiting for account and provider usage"
        : nextReset
          ? `${nextReset.entry.provider}, ${nextReset.entry.label} · ${formatDateTime(nextReset.resetAt)}`
          : "No connected account exposed a reset timestamp",
      view: "usage",
      viewLabel: "Usage",
    },
    {
      id: "allowance",
      label: "Lowest allowance",
      icon: Gauge,
      value: !quotaLoaded
        ? pending
        : lowestAllowance ? `${Math.round(lowestAllowance.percent)}% left` : "Not measured",
      detail: !quotaLoaded
        ? "Waiting for account and provider usage"
        : lowestAllowance
          ? `${lowestAllowance.entry.provider}, ${lowestAllowance.entry.label}${account?.planType ? ` · ${friendlyPlanName(account.planType)} plan` : ""}`
          : "No connected account reports a remaining share",
      tone: allowanceTone,
      meter: lowestAllowance ? lowestAllowance.percent : undefined,
      view: "usage",
      viewLabel: "Usage",
    },
  ];

  const routingChips: Chip[] = [
    {
      key: "login-free",
      label: "Login-free",
      value: target ? target.loginFree === true ? "On" : "Off" : pending,
      tone: target ? target.loginFree === true ? "accent" : undefined : undefined,
    },
    {
      key: "signed-routing",
      label: "Signed routing",
      value: target ? target.signedRouting === true ? "On" : "Off" : pending,
      tone: target ? target.signedRouting === true ? "success" : undefined : undefined,
    },
    {
      key: "default-model",
      label: "Default model",
      value: target
        ? target.selectedModel
          ? modelName(target, target.selectedModel)
          : "Codex default"
        : pending,
    },
    {
      key: "presence",
      label: "Presence",
      value: presence ? presenceLabel(presence.mode) : pending,
    },
  ];

  const routedProviders = routedProviderIds
    .map((id) => ({
      id,
      displayName: target?.providers.find((provider) => provider.id === id)?.displayName || id,
    }));

  return (
    <div className="dashboard-page page-stack">
      <PageHeader
        eyebrow="At a glance"
        title="Dashboard"
        description="Router health, live work, recent traffic, and the accounts closest to running out. Every tile opens the page that owns the detail."
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      {!api ? (
        <InlineNotice tone="warning" title="Desktop bridge unavailable">
          Open this window through the Codex Router desktop app to read live router data.
        </InlineNotice>
      ) : health && !health.ok && health.error ? (
        <InlineNotice tone="danger" title="Router health check failed">{health.error}</InlineNotice>
      ) : null}

      <div className="db-summary-grid" role="list" aria-label="Router summary">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <button
              key={tile.id}
              type="button"
              role="listitem"
              className={classNames("db-summary-cell", tile.tone && `tone-${tile.tone}`)}
              aria-label={`${tile.label}: ${tile.value}. ${tile.detail}. Open ${tile.viewLabel}.`}
              onClick={() => onNavigate(tile.view)}
            >
              <span className="db-summary-label">
                <Icon aria-hidden size={12} strokeWidth={1.8} />
                {tile.label}
              </span>
              <strong className="db-summary-value">{tile.value}</strong>
              {tile.meter === undefined ? null : (
                <span className="db-summary-meter" aria-hidden="true">
                  <i style={{ width: `${Math.max(2, Math.min(100, tile.meter))}%` }} />
                </span>
              )}
              <small className="db-summary-detail">{tile.detail}</small>
              <span className="db-summary-link" aria-hidden="true">
                View {tile.viewLabel}
                <ArrowUpRight aria-hidden size={11} strokeWidth={1.9} />
              </span>
            </button>
          );
        })}
      </div>

      <div className="db-panel-grid">
        <section className="panel-section db-panel">
          <SectionHeading
            title="Routing mode"
            description="How requests leave this machine."
            action={(
              <Button variant="ghost" aria-label="Open Settings" onClick={() => onNavigate("settings")}>
                <Settings aria-hidden size={13} strokeWidth={1.7} />
                Settings
              </Button>
            )}
          />
          <div className="db-chip-row">
            {routingChips.map((chip) => (
              <span key={chip.key} className={classNames("db-chip", chip.tone && `tone-${chip.tone}`)}>
                <small>{chip.label}</small>
                <strong title={chip.value}>{chip.value}</strong>
              </span>
            ))}
          </div>
        </section>

        <section className="panel-section db-panel">
          <SectionHeading
            title="Providers"
            description="Credentials on file and routes in use."
            action={(
              <Button variant="ghost" aria-label="Open Providers" onClick={() => onNavigate("providers")}>
                <KeyRound aria-hidden size={13} strokeWidth={1.7} />
                Providers
              </Button>
            )}
          />
          <dl className="db-mini-stats">
            <div>
              <dt>Connected</dt>
              <dd>{setup ? `${exactNumber(configuredProviders)} of ${exactNumber(totalProviders)}` : pending}</dd>
              <small>{setup ? "Providers holding a usable credential" : "Waiting for the provider setup snapshot"}</small>
            </div>
            <div>
              <dt>Routing</dt>
              <dd>{target ? exactNumber(routedProviderIds.length) : pending}</dd>
              <small>{target ? "Providers currently eligible for routing" : "Waiting for the router snapshot"}</small>
            </div>
          </dl>
          {routedProviders.length ? (
            <div className="db-provider-logos" aria-label="Providers currently routing">
              {routedProviders.slice(0, PROVIDER_LOGO_LIMIT).map((provider) => (
                <ProviderLogo
                  key={provider.id}
                  providerId={provider.id}
                  displayName={provider.displayName}
                  size="small"
                />
              ))}
              {routedProviders.length > PROVIDER_LOGO_LIMIT ? (
                <span className="db-more-count">+{routedProviders.length - PROVIDER_LOGO_LIMIT}</span>
              ) : null}
            </div>
          ) : target ? (
            <p className="db-panel-note">No provider is routing yet. Connect an account to start.</p>
          ) : null}
        </section>

        <section className="panel-section db-panel">
          <SectionHeading
            title="Catalog readiness"
            description="What the model picker and subagents can reach."
            action={(
              <Button variant="ghost" aria-label="Open Models" onClick={() => onNavigate("models")}>
                <Boxes aria-hidden size={13} strokeWidth={1.7} />
                Models
              </Button>
            )}
          />
          {target ? (
            <dl className="db-mini-stats">
              <div>
                <dt>Available</dt>
                <dd>{exactNumber(availableModels)}</dd>
                <small>Enabled or natively routed, of {exactNumber(models.length)} curated</small>
              </div>
              <div>
                <dt>In picker</dt>
                <dd>{exactNumber(pickerModels)}</dd>
                <small>{exactNumber(models.length - pickerModels)} hidden from the Codex picker</small>
              </div>
              <div>
                <dt>Agent-ready</dt>
                <dd>{exactNumber(agentReadyModels)}</dd>
                <small>Enabled models on the native v2 subagent path</small>
              </div>
            </dl>
          ) : (
            <EmptyState
              icon={<Boxes size={20} />}
              title={refreshing ? "Reading the catalog" : "Catalog unavailable"}
              body="Model counts appear once the router snapshot loads."
            />
          )}
        </section>

        <section className="panel-section db-panel">
          <SectionHeading
            title="Context reused, 24h"
            description="Prefix cache the router did not have to resend."
            action={(
              <Button variant="ghost" aria-label="Open Status" onClick={() => onNavigate("status")}>
                <BrainCircuit aria-hidden size={13} strokeWidth={1.7} />
                Status
              </Button>
            )}
          />
          <dl className="db-mini-stats">
            <div>
              <dt>Cached input</dt>
              <dd>{!providerUsage ? pending : cachedInput === undefined ? "Not measured" : compactNumber(cachedInput)}</dd>
              <small>
                {!providerUsage
                  ? "Waiting for the provider usage snapshot"
                  : cachedInput === undefined
                    ? "This router build does not report cached input"
                    : `${exactNumber(cachedInput)} tokens reused`}
              </small>
            </div>
            <div>
              <dt>Input observed</dt>
              <dd>{observedInput === null ? pending : compactNumber(observedInput)}</dd>
              <small>
                {observedInput === null
                  ? "Waiting for the router snapshot"
                  : `Across ${exactNumber(events?.length)} recent events`}
              </small>
            </div>
            <div>
              <dt>Reuse share</dt>
              <dd>{reuseShare === null ? "Not measured" : `${reuseShare.toFixed(1)}%`}</dd>
              <small>Cached input divided by observed input</small>
            </div>
          </dl>
        </section>
      </div>

      <div className="db-traffic-grid">
        <section className="panel-section db-traffic-panel">
          <SectionHeading
            title="Traffic, last 24 hours"
            description="Hourly local buckets from router request telemetry. This is observed traffic, not provider billing."
            action={(
              <Button variant="ghost" aria-label="Open Usage" onClick={() => onNavigate("usage")}>
                <BarChart3 aria-hidden size={13} strokeWidth={1.7} />
                Usage
              </Button>
            )}
          />
          {!events ? (
            <EmptyState
              icon={<BarChart3 size={20} />}
              title={refreshing ? "Reading router telemetry" : "Router telemetry unavailable"}
              body="Hourly traffic appears once the router snapshot loads."
            />
          ) : trafficHasRequests ? (
            <TrafficTrend buckets={trafficBuckets} hasTokens={trafficHasTokens} />
          ) : (
            <EmptyState
              icon={<BarChart3 size={20} />}
              title="No requests in the last 24 hours"
              body="The chart will fill as a request passes through the local router."
            />
          )}
          {events ? (
            <p className="db-panel-note db-traffic-note">
              {trafficHasTokens
                ? `${exactNumber(trafficBuckets.reduce((sum, bucket) => sum + bucket.tokens, 0))} measured tokens across ${exactNumber(trafficBuckets.reduce((sum, bucket) => sum + bucket.requests, 0))} requests in this rolling window. The chart uses the latest 1,000 event details; provider rows use rolling counters when available.`
                : trafficHasRequests
                  ? `${exactNumber(trafficBuckets.reduce((sum, bucket) => sum + bucket.requests, 0))} requests observed, but token counts were not reported by the upstream responses. The chart uses the latest 1,000 event details.`
                  : "The router returned an empty telemetry window; this is different from a failed health check."}
            </p>
          ) : null}
        </section>

        <section className="panel-section db-breakdown-panel">
          <SectionHeading
            title="Provider and model mix"
            description={providerUsage ? "Rolling provider totals and the busiest models on this router." : "Breakdowns appear with the provider usage snapshot."}
            action={(
              <Button variant="ghost" aria-label="Open Status" onClick={() => onNavigate("status")}>
                <Activity aria-hidden size={13} strokeWidth={1.7} />
                Details
              </Button>
            )}
          />
          <div className="db-breakdown-stack">
            <BreakdownGroup
              title="Providers"
              emptyTitle={providerUsage ? "No metered provider traffic" : refreshing ? "Reading providers" : "Provider usage unavailable"}
              emptyBody={providerUsage ? "Connected providers have not served a metered request in the rolling window." : "Refresh after the provider usage snapshot becomes available."}
              rows={providerBreakdown}
              providerRows
            />
            <BreakdownGroup
              title={modelBreakdownScopeTitle(modelBreakdown)}
              emptyTitle={events === undefined && providerUsage === undefined ? "No model usage yet" : "No model traffic"}
              emptyBody={modelBreakdown.length ? "" : "A model appears after it serves a request with usage metadata."}
              rows={modelBreakdown}
            />
          </div>
        </section>
      </div>

      <section className="panel-section db-events-panel">
        <SectionHeading
          title="Recent activity"
          description="The last few routed requests from the rolling 24-hour telemetry window. Request metadata only."
          action={(
            <Button variant="ghost" aria-label="Open Status" onClick={() => onNavigate("status")}>
              <Activity aria-hidden size={13} strokeWidth={1.7} />
              Status
            </Button>
          )}
        />
        {recentEvents.length ? (
          <div className="db-event-list">
            {recentEvents.map((event, index) => (
              <DashboardEventRow key={`${event.at}-${event.model || "model"}-${index}`} event={event} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Server size={20} />}
            title={events ? "No recent router traffic" : refreshing ? "Reading router telemetry" : "Router telemetry unavailable"}
            body={events
              ? "This list fills after a request passes through the local router."
              : "Recent requests appear once the router snapshot loads."}
          />
        )}
      </section>
    </div>
  );
}

function TrafficTrend({ buckets, hasTokens }: { buckets: TrafficBucket[]; hasTokens: boolean }) {
  const maxTokens = Math.max(...buckets.map((bucket) => bucket.tokens), 1);
  const maxRequests = Math.max(...buckets.map((bucket) => bucket.requests), 1);
  const hasBreakdown = buckets.some((bucket) => bucket.measuredBreakdown);
  return (
    <div
      className="db-trend"
      role="img"
      aria-label={`Hourly router traffic for the last 24 hours${hasTokens ? hasBreakdown ? " split into regular input, cached input, and output" : " by tokens" : " by requests"}`}
    >
      <div className="db-trend-scale" aria-hidden="true">
        <span>{hasTokens ? compactNumber(maxTokens) : exactNumber(maxRequests)}</span>
        <span>0</span>
      </div>
      <div className="db-trend-bars">
        {buckets.map((bucket, index) => {
          const ratio = hasTokens
            ? bucket.tokens / maxTokens
            : bucket.requests / maxRequests;
          const height = ratio > 0 ? Math.max(4, ratio * 100) : 0;
          const parts = trafficParts(bucket);
          const breakdown = bucket.measuredBreakdown
            ? parts.filter((part) => part.tokens > 0).map((part) => `${part.label}: ${exactNumber(part.tokens)}`)
            : [];
          const label = [
            `${bucket.fullLabel}.`,
            bucket.measuredTokens ? `Total: ${exactNumber(bucket.tokens)} tokens.` : "Token count not reported.",
            ...breakdown.map((item) => `${item}.`),
            `Requests: ${exactNumber(bucket.requests)}.`,
          ].join(" ");
          const edge = index === 0 ? "start" : index === buckets.length - 1 ? "end" : undefined;
          return (
            <span
              className="db-trend-slot"
              key={bucket.key}
              aria-label={label}
              data-edge={edge}
              role="img"
              tabIndex={0}
            >
              {hasBreakdown ? (
                <span className="db-trend-stack" style={{ height: `${height}%` }}>
                  {trafficParts(bucket).map((part) => (
                    <i
                      key={part.tone}
                      className={part.tone}
                      style={{ height: `${bucket.tokens > 0 ? (part.tokens / bucket.tokens) * 100 : 0}%` }}
                    />
                  ))}
                </span>
              ) : <i style={{ height: `${height}%` }} />}
              <TrafficTooltip bucket={bucket} parts={parts} />
            </span>
          );
        })}
      </div>
      <div className="db-trend-axis" aria-hidden="true">
        <span>{buckets[0]?.label}</span>
        <span>{buckets[Math.floor(buckets.length / 2)]?.label}</span>
        <span>{buckets.at(-1)?.label}</span>
      </div>
      <div className="db-trend-legend" aria-hidden="true">
        {hasBreakdown ? (
          <>
            <span className="is-regular">Regular input</span>
            <span className="is-cached">Cached input</span>
            <span className="is-output">Output</span>
          </>
        ) : <span className="is-token">{hasTokens ? "Tokens" : "Requests"}</span>}
        <span className="is-request">Request volume</span>
      </div>
    </div>
  );
}

function TrafficTooltip({ bucket, parts }: { bucket: TrafficBucket; parts: TrafficPart[] }) {
  const visibleParts = bucket.measuredBreakdown ? parts.filter((part) => part.tokens > 0) : [];
  return (
    <span className="db-trend-tooltip" aria-hidden="true">
      <span className="db-trend-tooltip-date">{bucket.fullLabel}</span>
      {bucket.measuredTokens ? (
        <>
          <strong className="db-trend-tooltip-total">{compactNumber(bucket.tokens).toUpperCase()} tokens</strong>
          <span className="db-trend-tooltip-exact">{exactNumber(bucket.tokens)} total tokens</span>
        </>
      ) : (
        <strong className="db-trend-tooltip-total">Token count not reported</strong>
      )}
      <span className="db-trend-tooltip-rows">
        {visibleParts.map((part) => (
          <span className={`db-trend-tooltip-row is-${part.tone}`} key={part.tone}>
            <i aria-hidden="true" />
            <span>{part.label}</span>
            <strong>{exactNumber(part.tokens)}</strong>
          </span>
        ))}
        <span className="db-trend-tooltip-row is-requests">
          <i aria-hidden="true" />
          <span>Requests</span>
          <strong>{exactNumber(bucket.requests)}</strong>
        </span>
      </span>
      {!bucket.measuredTokens ? (
        <span className="db-trend-tooltip-note">The upstream response did not include token counts.</span>
      ) : !bucket.measuredBreakdown ? (
        <span className="db-trend-tooltip-note">Input and output details were not reported for this hour.</span>
      ) : null}
    </span>
  );
}

function BreakdownGroup({
  title,
  rows,
  providerRows = false,
  emptyTitle,
  emptyBody,
}: {
  title: string;
  rows: TrafficBreakdownRow[];
  providerRows?: boolean;
  emptyTitle: string;
  emptyBody: string;
}) {
  const visibleRows = rows.slice(0, 5);
  const max = Math.max(...visibleRows.map((row) => row.tokens), 1);
  return (
    <div className="db-breakdown-group">
      <div className="db-breakdown-heading">
        <h3>{title}</h3>
        {rows.length > visibleRows.length ? <small>Top {visibleRows.length} of {rows.length}</small> : null}
      </div>
      {visibleRows.length ? (
        <div className="db-breakdown-list" role="list" aria-label={`${title} usage breakdown`}>
          {visibleRows.map((row) => (
            <div className="db-breakdown-row" role="listitem" key={row.id}>
              {providerRows ? (
                <ProviderLogo providerId={row.id.replace(/^provider:/, "")} displayName={row.label} size="small" />
              ) : <span className="db-model-glyph" aria-hidden="true"><Activity size={12} strokeWidth={1.8} /></span>}
              <div className="db-breakdown-label">
                <strong title={row.label}>{row.label}</strong>
                <small>{row.provider ? `${row.provider} · ` : ""}{exactNumber(row.requests)} {plural(row.requests, "request")}{row.measuredTokens ? ` · ${compactNumber(row.tokens)} tok` : " · tokens not reported"}</small>
                <span className="db-breakdown-meter" aria-hidden="true"><i style={{ width: `${row.tokens > 0 ? Math.max(2, (row.tokens / max) * 100) : 0}%` }} /></span>
              </div>
              <strong className="db-breakdown-value">{row.measuredTokens ? compactNumber(row.tokens) : "—"}</strong>
            </div>
          ))}
        </div>
      ) : (
        <div className="db-breakdown-empty">
          <strong>{emptyTitle}</strong>
          <p>{emptyBody}</p>
        </div>
      )}
    </div>
  );
}

function DashboardEventRow({ event }: { event: UsageEvent }) {
  const status = event.status;
  const tone: Tone | "neutral" = status === undefined
    ? "neutral"
    : status >= 400 ? "danger" : status >= 200 ? "success" : "neutral";
  return (
    <article>
      <ProviderLogo
        providerId={event.provider || "router"}
        displayName={event.provider}
        size="small"
        className="db-event-logo"
      />
      <span className="db-event-model">
        <strong>{shortModelName(event.model || "Unknown model")}</strong>
        <small>{event.provider || "router"}</small>
      </span>
      <span className="db-event-duration">
        <strong>{event.durationMs === undefined ? "No duration" : formatDuration(event.durationMs)}</strong>
        <small>{formatDateTime(event.at)}</small>
      </span>
      <Badge tone={tone === "neutral" ? "neutral" : tone}>
        {status === undefined ? "no status" : String(status)}
      </Badge>
    </article>
  );
}

function collectMetrics(
  account?: AccountUsage,
  providerUsage?: ProviderUsageSnapshot,
): MetricEntry[] {
  const entries: MetricEntry[] = [];
  for (const [index, metric] of [account?.primary, account?.secondary].entries()) {
    if (!metric) continue;
    entries.push({
      provider: "ChatGPT",
      label: limitWindowLabel(metric.windowDurationMins, index),
      metric,
    });
  }
  for (const provider of providerUsage?.providers ?? []) {
    for (const metric of provider.account?.metrics ?? []) {
      entries.push({
        provider: provider.displayName,
        label: metric.label || "Usage limit",
        metric,
      });
    }
  }
  return entries;
}

const HOUR_MS = 60 * 60 * 1_000;

function buildTrafficBuckets(events: UsageEvent[] | undefined, now: number): TrafficBucket[] {
  const anchor = new Date(now);
  anchor.setMinutes(0, 0, 0);
  const first = anchor.getTime() - (23 * HOUR_MS);
  const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric" });
  const fullFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
  });
  const buckets = Array.from({ length: 24 }, (_, index) => {
    const start = new Date(first + index * HOUR_MS);
    return {
      key: start.toISOString(),
      label: formatter.format(start),
      fullLabel: fullFormatter.format(start),
      tokens: 0,
      requests: 0,
      measuredTokens: false,
      regularInputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      measuredBreakdown: false,
    };
  });
  for (const event of events ?? []) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < first || at >= anchor.getTime() + HOUR_MS) continue;
    const index = Math.floor((at - first) / HOUR_MS);
    if (index < 0 || index >= buckets.length) continue;
    const bucket = buckets[index];
    bucket.requests += 1;
    const tokens = tokenCountFromEvent(event);
    if (tokens !== null) {
      bucket.tokens += tokens;
      bucket.measuredTokens = true;
    }
    const breakdown = trafficPartsFromEvent(event);
    if (breakdown) {
      bucket.regularInputTokens += breakdown.regularInputTokens;
      bucket.cachedInputTokens += breakdown.cachedInputTokens;
      bucket.outputTokens += breakdown.outputTokens;
      bucket.measuredBreakdown = true;
    }
  }
  return buckets;
}

type TrafficPart = {
  tone: "regular-input" | "cached-input" | "output" | "other";
  label: string;
  tokens: number;
};

function trafficParts(bucket: TrafficBucket): TrafficPart[] {
  const known = bucket.regularInputTokens + bucket.cachedInputTokens + bucket.outputTokens;
  return [
    { tone: "regular-input", label: "regular input", tokens: bucket.regularInputTokens },
    { tone: "cached-input", label: "cached input", tokens: bucket.cachedInputTokens },
    { tone: "output", label: "output", tokens: bucket.outputTokens },
    { tone: "other", label: "unattributed tokens", tokens: Math.max(0, bucket.tokens - known) },
  ];
}

function trafficPartsFromEvent(event: UsageEvent): Omit<TrafficBucket, "key" | "label" | "fullLabel" | "tokens" | "requests" | "measuredTokens" | "measuredBreakdown"> | null {
  const input = optionalNumber(event.billedInputTokens ?? event.inputTokens);
  const cached = optionalNumber(event.cachedInputTokens);
  const output = optionalNumber(event.billedOutputTokens ?? event.outputTokens);
  if (input === null && cached === null && output === null) return null;
  const inputTokens = input ?? 0;
  const cachedInputTokens = input === null ? cached ?? 0 : Math.min(inputTokens, cached ?? 0);
  return {
    regularInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    cachedInputTokens,
    outputTokens: output ?? 0,
  };
}

function buildProviderBreakdown(
  providerUsage: ProviderUsageSnapshot | undefined,
  events: UsageEvent[] | undefined,
  now: number,
): TrafficBreakdownRow[] {
  const eventRows = new Map<string, { requests: number; tokens: number; measuredTokens: boolean }>();
  for (const event of recentWindowEvents(events, now)) {
    const id = event.provider || "unknown";
    const previous = eventRows.get(id) ?? { requests: 0, tokens: 0, measuredTokens: false };
    previous.requests += 1;
    const tokens = tokenCountFromEvent(event);
    if (tokens !== null) {
      previous.tokens += tokens;
      previous.measuredTokens = true;
    }
    eventRows.set(id, previous);
  }
  const names = new Map((providerUsage?.providers ?? []).map((provider) => [provider.id, provider.displayName]));
  const rows = new Map<string, TrafficBreakdownRow>();
  for (const provider of providerUsage?.providers ?? []) {
    const eventRow = eventRows.get(provider.id);
    const snapshotRequests = optionalNumber(provider.last24hRequests);
    const snapshotTokens = optionalNumber(provider.last24hTokens);
    // A health snapshot and the event stream can be sampled a few milliseconds
    // apart. Preserve the larger observed value instead of briefly painting a
    // provider as idle while the other source already has its latest request.
    const requests = Math.max(snapshotRequests ?? 0, eventRow?.requests ?? 0);
    const measuredTokens = snapshotTokens !== null || Boolean(eventRow?.measuredTokens);
    const tokens = Math.max(snapshotTokens ?? 0, eventRow?.tokens ?? 0);
    if (requests <= 0 && tokens <= 0 && !eventRow?.measuredTokens) continue;
    rows.set(provider.id, {
      id: `provider:${provider.id}`,
      label: provider.displayName,
      tokens,
      requests,
      measuredTokens,
      share: 0,
      scope: "rolling 24h",
    });
  }
  for (const [providerId, eventRow] of eventRows) {
    if (rows.has(providerId) || (eventRow.requests <= 0 && !eventRow.measuredTokens)) continue;
    rows.set(providerId, {
      id: `provider:${providerId}`,
      label: names.get(providerId) || providerId,
      tokens: eventRow.tokens,
      requests: eventRow.requests,
      measuredTokens: eventRow.measuredTokens,
      share: 0,
      scope: "rolling 24h",
    });
  }
  return withBreakdownShares([...rows.values()]);
}

function buildModelBreakdown(
  providerUsage: ProviderUsageSnapshot | undefined,
  events: UsageEvent[] | undefined,
  now: number,
): TrafficBreakdownRow[] {
  const names = new Map((providerUsage?.providers ?? []).map((provider) => [provider.id, provider.displayName]));
  const eventRows = new Map<string, TrafficBreakdownRow>();
  for (const event of recentWindowEvents(events, now)) {
    const model = event.model || "unknown";
    const provider = event.provider || "unknown";
    const id = `${provider}:${model}`;
    const previous = eventRows.get(id) ?? {
      id,
      label: shortModelName(model),
      provider: names.get(provider) || provider,
      tokens: 0,
      requests: 0,
      measuredTokens: false,
      share: 0,
      scope: "rolling 24h",
    };
    previous.requests += 1;
    const tokens = tokenCountFromEvent(event);
    if (tokens !== null) {
      previous.tokens += tokens;
      previous.measuredTokens = true;
    }
    eventRows.set(id, previous);
  }
  if (eventRows.size) return withBreakdownShares([...eventRows.values()]);

  // The event stream may be empty while the provider snapshot still has a
  // useful long-window model ledger (for example after the app was reopened).
  // Keep that fallback explicitly labelled so the UI never implies it is a
  // rolling 24-hour figure.
  const fallback = (providerUsage?.providers ?? []).flatMap((provider) =>
    (provider.models ?? [])
      .filter((model) => (model.requests || 0) > 0 || (model.totalTokens || 0) > 0)
      .map((model) => ({
        id: `${provider.id}:${model.slug || model.displayName || "unknown"}`,
        label: model.displayName || shortModelName(model.slug || "unknown"),
        provider: provider.displayName,
        tokens: Number(model.totalTokens) || 0,
        requests: Number(model.requests) || 0,
        measuredTokens: Number.isFinite(Number(model.totalTokens)),
        share: 0,
        scope: "90-day ledger" as const,
      })),
  );
  return withBreakdownShares(fallback);
}

function modelBreakdownScopeTitle(rows: TrafficBreakdownRow[]): string {
  return rows[0]?.scope === "90-day ledger" ? "Models, 90-day ledger" : "Models, last 24 hours";
}

function recentWindowEvents(events: UsageEvent[] | undefined, now: number): UsageEvent[] {
  if (!events) return [];
  const cutoff = now - 24 * HOUR_MS;
  return events.filter((event) => {
    const at = Date.parse(event.at);
    return Number.isFinite(at) && at >= cutoff && at <= now;
  });
}

function tokenCountFromEvent(event: UsageEvent): number | null {
  const explicit = optionalNumber(event.totalTokens);
  if (explicit !== null) return explicit;
  const input = optionalNumber(event.billedInputTokens ?? event.inputTokens);
  const output = optionalNumber(event.billedOutputTokens ?? event.outputTokens);
  return input !== null || output !== null ? (input || 0) + (output || 0) : null;
}

function optionalNumber(value: number | string | null | undefined): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sumEventTokens(events: UsageEvent[]): number | null {
  let total = 0;
  let measured = false;
  for (const event of events) {
    const tokens = tokenCountFromEvent(event);
    if (tokens === null) continue;
    total += tokens;
    measured = true;
  }
  return measured ? total : null;
}

function eventsCountOrNull(
  events: UsageEvent[] | undefined,
  recent: UsageEvent[],
): number | null {
  return events === undefined ? null : recent.length;
}

function withBreakdownShares(rows: TrafficBreakdownRow[]): TrafficBreakdownRow[] {
  const measuredTotal = rows.reduce((sum, row) => sum + (row.measuredTokens ? row.tokens : 0), 0);
  const requestTotal = rows.reduce((sum, row) => sum + row.requests, 0);
  return rows
    .map((row) => ({
      ...row,
      share: measuredTotal > 0
        ? (row.measuredTokens ? row.tokens : 0) / measuredTotal
        : requestTotal > 0 ? row.requests / requestTotal : 0,
    }))
    .sort((left, right) => right.tokens - left.tokens || right.requests - left.requests);
}

function resetAtOf(metric: UsageMetric): number | string | undefined {
  return metric.resetAt ?? metric.resetsAt;
}

// Returns null when no source reported the field at all, so a build that cannot
// measure a value never renders as a confident zero.
function sumReported(values: Array<number | undefined>): number | null {
  const reported = values.filter((value): value is number => Number.isFinite(Number(value)));
  return reported.length ? reported.reduce((sum, value) => sum + value, 0) : null;
}

function uniqueCount(values: Array<string | undefined>): number {
  // An older health payload may omit identifiers. Count those requests by
  // position instead of silently turning a busy router into "0 chats".
  return new Set(values.map((value, index) => value || `unknown-${index}`)).size;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function modelName(target: RouterTarget, slug: string): string {
  return target.models.find((model) => model.slug === slug)?.displayName || slug;
}

function presenceLabel(mode: string): string {
  if (mode === "follow-codex") return "Follows Codex";
  if (mode === "always") return "Always on";
  return mode;
}

function activityLabel(state: string): string {
  if (state === "generating") return "Thinking";
  if (state === "starting") return "Starting";
  if (state === "error") return "Error";
  if (state === "offline") return "Offline";
  return "Idle";
}

function shortModelName(model: string): string {
  return model.split("/").filter(Boolean).at(-1) || model;
}

function friendlyPlanName(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function limitWindowLabel(minutes: number | undefined, index: number): string {
  if (!Number.isFinite(Number(minutes))) return index === 0 ? "primary limit" : "secondary limit";
  const value = Number(minutes);
  if (value >= 1_440 && value % 1_440 === 0) {
    const days = value / 1_440;
    if (days === 1) return "daily limit";
    if (days === 7) return "weekly limit";
    return `${days}-day limit`;
  }
  if (value >= 60 && value % 60 === 0) return `${value / 60}-hour limit`;
  return `${value}-minute limit`;
}

function timestampFor(value: number | string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric < 10_000_000_000 ? numeric * 1_000 : numeric
    : new Date(value).getTime();
}

function resetCountdown(value: number | string): string {
  const remaining = timestampFor(value) - Date.now();
  if (!Number.isFinite(remaining)) return "Time unavailable";
  if (remaining <= 0) return "Refresh due";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
