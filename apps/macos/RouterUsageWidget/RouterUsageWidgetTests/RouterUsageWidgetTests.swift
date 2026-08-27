import AppKit
import SwiftUI
import WidgetKit
import XCTest

final class RouterUsageWidgetTests: XCTestCase {
  func testPreviewUsesSafeCompleteData() {
    let preview = RouterWidgetSnapshot.preview
    XCTAssertEqual(preview.schemaVersion, 1)
    XCTAssertEqual(preview.daily.count, 7)
    XCTAssertEqual(preview.quotas.count, 3)
    XCTAssertEqual(preview.availableUsageSources.count, 2)
    XCTAssertEqual(RouterUsageWidgetView.fullTokens(preview.todayTokens), "1,284,730")
    XCTAssertEqual(
      preview.usageSource(id: "openai").cumulativeDaily.last?.tokens,
      preview.usageSource(id: "openai").periodTokens
    )
  }

  func testSampleDataIsRestrictedToTheWidgetGallery() {
    let stored = RouterWidgetSnapshot.preview
    XCTAssertEqual(
      RouterUsageProvider.snapshotPayload(stored: stored, isPreview: false),
      stored
    )
    XCTAssertNil(RouterUsageProvider.snapshotPayload(stored: nil, isPreview: false))
    let gallery = RouterUsageProvider.snapshotPayload(stored: nil, isPreview: true)
    XCTAssertEqual(gallery?.todayTokens, 1_284_730)
    XCTAssertEqual(gallery?.daily.count, 7)
  }

  func testSnapshotURLUsesRegisteredContainerFirstAndLocalFallbackSecond() {
    let registered = URL(fileURLWithPath: "/registered/group", isDirectory: true)
    let sandbox = URL(fileURLWithPath: "/sandbox/Data", isDirectory: true)
    XCTAssertEqual(
      RouterUsageProvider.snapshotURLs(
        configuredGroup: RouterWidgetSnapshot.defaultAppGroup,
        registeredContainer: registered,
        sandboxHomeDirectory: sandbox
      ),
      [
        registered.appendingPathComponent(RouterWidgetSnapshot.fileName),
        sandbox
          .appendingPathComponent("Library/Application Support", isDirectory: true)
          .appendingPathComponent(RouterWidgetSnapshot.supportDirectoryName, isDirectory: true)
          .appendingPathComponent(RouterWidgetSnapshot.fileName),
      ]
    )
  }

  func testSnapshotURLRejectsUnexpectedGroupAndDeduplicatesContainer() {
    let sandbox = URL(fileURLWithPath: "/sandbox/Data", isDirectory: true)
    XCTAssertTrue(RouterUsageProvider.snapshotURLs(
      configuredGroup: "group.example.invalid",
      registeredContainer: URL(fileURLWithPath: "/tmp/invalid"),
      sandboxHomeDirectory: sandbox
    ).isEmpty)
    let local = RouterWidgetSnapshotStore.widgetSandboxSnapshotURL(
      sandboxDataDirectory: sandbox
    )
    XCTAssertEqual(RouterUsageProvider.snapshotURLs(
      configuredGroup: RouterWidgetSnapshot.defaultAppGroup,
      registeredContainer: local.deletingLastPathComponent(),
      sandboxHomeDirectory: sandbox
    ).count, 1)
  }

  func testSnapshotDecoderAcceptsCurrentSchemaAndRejectsOtherSchemas() throws {
    let encoder = JSONEncoder.routerWidget
    let decoded = RouterUsageProvider.decodeSnapshot(
      try encoder.encode(RouterWidgetSnapshot.preview)
    )
    XCTAssertEqual(decoded?.schemaVersion, RouterWidgetSnapshot.schemaVersion)
    XCTAssertEqual(decoded?.todayTokens, RouterWidgetSnapshot.preview.todayTokens)
    XCTAssertEqual(decoded?.daily.count, RouterWidgetSnapshot.preview.daily.count)
    XCTAssertEqual(decoded?.quotas.count, RouterWidgetSnapshot.preview.quotas.count)
    XCTAssertEqual(decoded?.quotas.first?.providerName, "Codex")
    let invalid = "{\"schemaVersion\":999}".data(using: .utf8)!
    XCTAssertNil(RouterUsageProvider.decodeSnapshot(invalid))
  }

  func testNewestSnapshotWinsAcrossRegisteredAndFallbackLocations() {
    let preview = RouterWidgetSnapshot.preview
    let older = RouterWidgetSnapshot(
      schemaVersion: preview.schemaVersion,
      generatedAt: preview.generatedAt.addingTimeInterval(-60),
      activityState: preview.activityState,
      activeChatCount: preview.activeChatCount,
      selectedProviderID: preview.selectedProviderID,
      selectedProviderName: preview.selectedProviderName,
      todayTokens: preview.todayTokens,
      daily: preview.daily,
      quotas: preview.quotas,
      usageSources: preview.usageSources
    )
    XCTAssertEqual(
      RouterUsageProvider.newestSnapshot([preview, older])?.generatedAt,
      preview.generatedAt
    )
    XCTAssertEqual(
      RouterUsageProvider.newestSnapshot([older, preview])?.generatedAt,
      preview.generatedAt
    )
    XCTAssertNil(RouterUsageProvider.newestSnapshot([]))
  }

  func testUsageSourcePickerDefaultsToCodexAndListsConnectedSources() {
    let choices = RouterUsageSourceQuery.availableEntities(snapshot: .preview)
    XCTAssertEqual(choices.map(\.id), ["openai", "deepseek"])
    XCTAssertEqual(RouterUsageConfigurationIntent().sourceID, "openai")
    XCTAssertEqual(RouterWidgetSnapshot.preview.usageSource(id: "deepseek").name, "DeepSeek")
  }

  func testLegacySingleSourceSnapshotRemainsSelectable() {
    let preview = RouterWidgetSnapshot.preview
    let legacy = RouterWidgetSnapshot(
      schemaVersion: preview.schemaVersion,
      generatedAt: preview.generatedAt,
      activityState: preview.activityState,
      activeChatCount: preview.activeChatCount,
      selectedProviderID: preview.selectedProviderID,
      selectedProviderName: preview.selectedProviderName,
      todayTokens: preview.todayTokens,
      daily: preview.daily,
      quotas: preview.quotas,
      usageSources: nil
    )
    XCTAssertEqual(legacy.availableUsageSources.map(\.id), ["openai"])
    XCTAssertEqual(legacy.usageSource(id: "missing").id, "openai")
  }

  func testRemovedConfiguredSourceUsesTheDisplayedFallbackForDeepLinks() {
    let preview = RouterWidgetSnapshot.preview
    let codexOnly = RouterWidgetSnapshot(
      schemaVersion: preview.schemaVersion,
      generatedAt: preview.generatedAt,
      activityState: preview.activityState,
      activeChatCount: preview.activeChatCount,
      selectedProviderID: "openai",
      selectedProviderName: "Codex",
      todayTokens: preview.todayTokens,
      daily: preview.daily,
      quotas: preview.quotas.filter { $0.providerID == "openai" },
      usageSources: preview.usageSources?.filter { $0.id == "openai" }
    )
    let entry = RouterUsageEntry(
      date: preview.generatedAt,
      snapshot: codexOnly,
      sourceID: "deepseek"
    )
    XCTAssertEqual(codexOnly.usageSource(id: entry.sourceID).id, "openai")
    XCTAssertEqual(entry.effectiveSourceID, "openai")
    XCTAssertEqual(
      RouterWidgetDestination.usage.url(sourceID: entry.effectiveSourceID).absoluteString,
      "codex-router://control-center/usage?source=openai"
    )
    XCTAssertEqual(
      RouterWidgetDestination.usageResets.url(sourceID: entry.effectiveSourceID).absoluteString,
      "codex-router://control-center/usage-resets?source=openai"
    )
  }

  func testTokenWordingDistinguishesAccountUsageFromRoutedProviderTraffic() {
    let preview = RouterWidgetSnapshot.preview
    XCTAssertEqual(
      RouterUsageWidgetView.todayTokenLabel(for: preview.usageSource(id: "openai")),
      "account tokens"
    )
    XCTAssertEqual(
      RouterUsageWidgetView.todayTokenLabel(for: preview.usageSource(id: "deepseek")),
      "tokens routed"
    )
  }

  func testResetCountdownUsesCompactStableUnits() {
    let now = Date(timeIntervalSince1970: 1_000)
    XCTAssertEqual(RouterResetWidgetView.countdown(to: now.addingTimeInterval(59), now: now), "<1m")
    XCTAssertEqual(RouterResetWidgetView.countdown(to: now.addingTimeInterval(2 * 3600 + 35 * 60), now: now), "2h 35m")
    XCTAssertEqual(RouterResetWidgetView.countdown(to: now.addingTimeInterval(2 * 86_400 + 3 * 3600), now: now), "2d 3h")
  }

  func testWidgetsDeepLinkToFixedControlCenterDestinations() {
    XCTAssertEqual(
      RouterWidgetDestination.usage.url().absoluteString,
      "codex-router://control-center/usage"
    )
    XCTAssertEqual(
      RouterWidgetDestination.usageResets.url().absoluteString,
      "codex-router://control-center/usage-resets"
    )
    XCTAssertEqual(
      RouterWidgetDestination.usage.url(sourceID: "deepseek").absoluteString,
      "codex-router://control-center/usage?source=deepseek"
    )
    XCTAssertEqual(
      RouterWidgetDestination.usage.url(sourceID: "deep_seek").absoluteString,
      "codex-router://control-center/usage"
    )
  }

  @MainActor
  func testRenderVisualFixturesWhenRequested() throws {
    guard let output = ProcessInfo.processInfo.environment["ROUTER_WIDGET_SCREENSHOT_DIR"],
          !output.isEmpty
    else { return }
    let directory = URL(fileURLWithPath: output, isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    let now = Date()
    try render(
      name: "router-widget-small",
      family: .systemSmall,
      size: CGSize(width: 170, height: 170),
      entry: RouterUsageEntry(date: now, snapshot: .preview),
      colorScheme: .light,
      directory: directory
    )
    try render(
      name: "router-widget-medium",
      family: .systemMedium,
      size: CGSize(width: 364, height: 170),
      entry: RouterUsageEntry(date: now, snapshot: .preview),
      colorScheme: .light,
      directory: directory
    )
    try render(
      name: "router-widget-small-dark",
      family: .systemSmall,
      size: CGSize(width: 170, height: 170),
      entry: RouterUsageEntry(date: now, snapshot: .preview),
      colorScheme: .dark,
      directory: directory
    )
    try render(
      name: "router-widget-medium-dark",
      family: .systemMedium,
      size: CGSize(width: 364, height: 170),
      entry: RouterUsageEntry(date: now, snapshot: .preview),
      colorScheme: .dark,
      directory: directory
    )
    try render(
      name: "router-widget-empty",
      family: .systemMedium,
      size: CGSize(width: 364, height: 170),
      entry: RouterUsageEntry(date: now, snapshot: nil),
      colorScheme: .light,
      directory: directory
    )
    let preview = RouterWidgetSnapshot.preview
    let stale = RouterWidgetSnapshot(
      schemaVersion: preview.schemaVersion,
      generatedAt: now.addingTimeInterval(-60 * 60),
      activityState: preview.activityState,
      activeChatCount: preview.activeChatCount,
      selectedProviderID: preview.selectedProviderID,
      selectedProviderName: preview.selectedProviderName,
      todayTokens: preview.todayTokens,
      daily: preview.daily,
      quotas: preview.quotas,
      usageSources: preview.usageSources
    )
    try render(
      name: "router-widget-stale",
      family: .systemMedium,
      size: CGSize(width: 364, height: 170),
      entry: RouterUsageEntry(date: now, snapshot: stale),
      colorScheme: .light,
      directory: directory
    )
    try render(
      name: "router-reset-small",
      family: .systemSmall,
      size: CGSize(width: 170, height: 170),
      entry: RouterUsageEntry(date: now, snapshot: .preview),
      colorScheme: .light,
      directory: directory,
      kind: .reset
    )
    try render(
      name: "router-reset-medium",
      family: .systemMedium,
      size: CGSize(width: 364, height: 170),
      entry: RouterUsageEntry(date: now, snapshot: .preview),
      colorScheme: .light,
      directory: directory,
      kind: .reset
    )
    try render(
      name: "router-reset-medium-dark",
      family: .systemMedium,
      size: CGSize(width: 364, height: 170),
      entry: RouterUsageEntry(date: now, snapshot: .preview),
      colorScheme: .dark,
      directory: directory,
      kind: .reset
    )
  }

  @MainActor
  private func render(
    name: String,
    family: WidgetFamily,
    size: CGSize,
    entry: RouterUsageEntry,
    colorScheme: ColorScheme,
    directory: URL,
    kind: RouterWidgetPreviewKind = .usage
  ) throws {
    let renderer = ImageRenderer(content: RouterWidgetPreviewCanvas(
      family: family,
      entry: entry,
      size: size,
      kind: kind
    ).environment(\.colorScheme, colorScheme))
    renderer.scale = 2
    guard let image = renderer.nsImage,
          let representation = NSBitmapImageRep(data: image.tiffRepresentation ?? Data()),
          let png = representation.representation(using: .png, properties: [:])
    else {
      XCTFail("Could not render \(name)")
      return
    }
    try png.write(to: directory.appendingPathComponent("\(name).png"), options: .atomic)
  }
}
