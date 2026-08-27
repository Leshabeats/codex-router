import Foundation
import Testing

@testable import ModelRouterTray

@Suite("Router Widget snapshot")
struct RouterWidgetSnapshotTests {
  private func snapshot(generatedAt: Date, todayTokens: Int64 = 42) -> RouterWidgetSnapshot {
    let contentDate = Date(timeIntervalSince1970: 1_700_000_000)
    return RouterWidgetSnapshot(
      schemaVersion: 1,
      generatedAt: generatedAt,
      activityState: "idle",
      activeChatCount: 0,
      selectedProviderID: "openai",
      selectedProviderName: "ChatGPT",
      todayTokens: todayTokens,
      daily: [RouterWidgetDailyPoint(date: contentDate, tokens: todayTokens)],
      quotas: [RouterWidgetQuota(
        id: "openai-primary",
        providerID: "openai",
        providerName: "ChatGPT",
        label: "5-hour limit",
        remainingPercent: 58,
        resetAt: contentDate.addingTimeInterval(3600)
      )],
      usageSources: [RouterWidgetUsageSource(
        id: "openai",
        name: "Codex",
        todayTokens: todayTokens,
        daily: [RouterWidgetDailyPoint(date: contentDate, tokens: todayTokens)]
      )]
    )
  }

  @Test("snapshot contains only the Widget projection")
  func safeProjection() throws {
    let data = try JSONEncoder.routerWidget.encode(snapshot(generatedAt: .now))
    let text = String(decoding: data, as: UTF8.self)
    #expect(text.contains("todayTokens"))
    #expect(text.contains("remainingPercent"))
    #expect(text.contains("usageSources"))
    #expect(!text.localizedCaseInsensitiveContains("token" + "="))
    #expect(!text.localizedCaseInsensitiveContains("credential"))
    #expect(!text.localizedCaseInsensitiveContains("dashboardUrl"))
  }

  @Test("atomic writer skips unchanged content and refreshes stale snapshots")
  func atomicWriteAndFingerprint() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("router-widget-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let destination = root.appendingPathComponent("snapshot.json")
    let now = Date(timeIntervalSince1970: 1_770_000_000)

    #expect(try RouterWidgetSnapshotStore.write(snapshot(generatedAt: now), to: destination, now: now))
    #expect(
      try RouterWidgetSnapshotStore.write(
        snapshot(generatedAt: now.addingTimeInterval(30)),
        to: destination,
        now: now.addingTimeInterval(30)
      ) == false
    )
    #expect(
      try RouterWidgetSnapshotStore.write(
        snapshot(generatedAt: now.addingTimeInterval(601)),
        to: destination,
        now: now.addingTimeInterval(601)
      )
    )

    let decoded = try JSONDecoder.routerWidget.decode(
      RouterWidgetSnapshot.self,
      from: Data(contentsOf: destination)
    )
    #expect(decoded.generatedAt == now.addingTimeInterval(601))
    let permissions = try FileManager.default.attributesOfItem(atPath: destination.path)[.posixPermissions] as? NSNumber
    #expect(permissions?.intValue == 0o600)
  }

  @Test("local-build fallback stays inside the widget sandbox")
  func localWidgetSandboxPath() {
    let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)
    let data = RouterWidgetSnapshotStore.widgetSandboxDataURL(homeDirectory: home)
    #expect(data.path == "/Users/example/Library/Containers/io.github.codex-router.tray.widget/Data")
    #expect(
      RouterWidgetSnapshotStore.widgetSandboxSnapshotURL(sandboxDataDirectory: data).path
        == "/Users/example/Library/Containers/io.github.codex-router.tray.widget/Data/Library/Application Support/Codex Router Widget/usage-widget.json"
    )
  }
}
