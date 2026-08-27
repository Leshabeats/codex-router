import Foundation
import WidgetKit

@MainActor
extension RouterStore {
  func widgetSnapshot(now: Date = Date()) -> RouterWidgetSnapshot {
    var availableProviders = visibleUsageProviders
    if !availableProviders.contains(where: { $0.id == RouterWidgetSnapshot.defaultUsageSourceID }),
       let codex = usageProviderChoices.first(where: {
         $0.id == RouterWidgetSnapshot.defaultUsageSourceID
       }) {
      availableProviders.insert(codex, at: 0)
    }
    let usageSources = availableProviders.map { provider in
      let daily = dailyUsage(for: provider.id, days: 7).map {
        RouterWidgetDailyPoint(date: $0.date, tokens: Int64(max(0, $0.tokens).rounded()))
      }
      return RouterWidgetUsageSource(
        id: provider.id,
        name: provider.id == RouterWidgetSnapshot.defaultUsageSourceID
          ? "Codex"
          : provider.shortName,
        todayTokens: daily.last?.tokens ?? 0,
        daily: daily
      )
    }
    return RouterWidgetSnapshot(
      schemaVersion: RouterWidgetSnapshot.schemaVersion,
      generatedAt: now,
      activityState: activityState.rawValue,
      activeChatCount: activeChatCount,
      selectedProviderID: selectedUsageProviderID,
      selectedProviderName: selectedUsageProvider.shortName,
      todayTokens: Int64(max(0, selectedTodayTokens).rounded()),
      daily: dailyUsage(days: 7).map {
        RouterWidgetDailyPoint(date: $0.date, tokens: Int64(max(0, $0.tokens).rounded()))
      },
      quotas: desktopQuotaRows.map {
        RouterWidgetQuota(
          id: $0.id,
          providerID: $0.providerID,
          providerName: $0.providerName,
          label: $0.label,
          remainingPercent: max(0, min(100, $0.remainingPercent)),
          resetAt: $0.resetAt.map(Date.init(timeIntervalSince1970:))
        )
      },
      usageSources: usageSources
    )
  }

  func publishWidgetSnapshot(now: Date = Date()) {
    let snapshot = widgetSnapshot(now: now)
    var didWrite = false
    let sharedDestination = RouterWidgetSnapshotStore.snapshotURL()
    if (try? RouterWidgetSnapshotStore.write(
      snapshot,
      to: sharedDestination,
      now: now
    )) == true {
      didWrite = true
    }

    // An ad-hoc extension has no provisioning profile, so macOS refuses its
    // App Group entitlement. Once the system has created the extension's own
    // sandbox, the unsandboxed host mirrors the same redacted snapshot there.
    // The widget can read that file without any additional entitlement.
    let sandboxData = RouterWidgetSnapshotStore.widgetSandboxDataURL()
    if FileManager.default.fileExists(atPath: sandboxData.path) {
      let localDestination = RouterWidgetSnapshotStore.widgetSandboxSnapshotURL(
        sandboxDataDirectory: sandboxData
      )
      if (try? RouterWidgetSnapshotStore.write(
        snapshot,
        to: localDestination,
        now: now
      )) == true {
        didWrite = true
      }
    }

    if didWrite {
      WidgetCenter.shared.reloadTimelines(ofKind: RouterWidgetSnapshot.kind)
      WidgetCenter.shared.reloadTimelines(ofKind: RouterWidgetSnapshot.resetKind)
    }
  }
}
