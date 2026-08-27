import Foundation

struct RouterWidgetDailyPoint: Codable, Equatable, Identifiable {
  let date: Date
  let tokens: Int64

  var id: Date { date }
}

struct RouterWidgetUsageSource: Codable, Equatable, Identifiable {
  let id: String
  let name: String
  let todayTokens: Int64
  let daily: [RouterWidgetDailyPoint]

  var cumulativeDaily: [RouterWidgetDailyPoint] {
    var total: Int64 = 0
    return daily.map { point in
      total += max(0, point.tokens)
      return RouterWidgetDailyPoint(date: point.date, tokens: total)
    }
  }

  var periodTokens: Int64 {
    daily.reduce(0) { $0 + max(0, $1.tokens) }
  }
}

struct RouterWidgetQuota: Codable, Equatable, Identifiable {
  let id: String
  let providerID: String
  let providerName: String
  let label: String
  let remainingPercent: Double
  let resetAt: Date?
}

struct RouterWidgetSnapshot: Codable, Equatable {
  static let schemaVersion = 1
  static let fileName = "usage-widget.json"
  static let kind = "io.github.codex-router.usage-widget"
  static let resetKind = "io.github.codex-router.reset-widget"
  static let defaultUsageSourceID = "openai"
  static let defaultAppGroup = "group.io.github.codex-router"
  static let extensionBundleIdentifier = "io.github.codex-router.tray.widget"
  static let supportDirectoryName = "Codex Router Widget"

  let schemaVersion: Int
  let generatedAt: Date
  let activityState: String
  let activeChatCount: Int
  let selectedProviderID: String
  let selectedProviderName: String
  let todayTokens: Int64
  let daily: [RouterWidgetDailyPoint]
  let quotas: [RouterWidgetQuota]
  let usageSources: [RouterWidgetUsageSource]?

  var availableUsageSources: [RouterWidgetUsageSource] {
    if let usageSources, !usageSources.isEmpty { return usageSources }
    return [RouterWidgetUsageSource(
      id: selectedProviderID,
      name: selectedProviderName,
      todayTokens: todayTokens,
      daily: daily
    )]
  }

  func usageSource(id requestedID: String?) -> RouterWidgetUsageSource {
    let sources = availableUsageSources
    if let requestedID,
       let requested = sources.first(where: { $0.id == requestedID }) {
      return requested
    }
    if let codex = sources.first(where: { $0.id == Self.defaultUsageSourceID }) {
      return codex
    }
    return sources[0]
  }

  func quotas(for sourceID: String) -> [RouterWidgetQuota] {
    quotas.filter { $0.providerID == sourceID }
  }

  var content: Content {
    Content(
      activityState: activityState,
      activeChatCount: activeChatCount,
      selectedProviderID: selectedProviderID,
      selectedProviderName: selectedProviderName,
      todayTokens: todayTokens,
      daily: daily,
      quotas: quotas,
      usageSources: usageSources
    )
  }

  struct Content: Codable, Equatable {
    let activityState: String
    let activeChatCount: Int
    let selectedProviderID: String
    let selectedProviderName: String
    let todayTokens: Int64
    let daily: [RouterWidgetDailyPoint]
    let quotas: [RouterWidgetQuota]
    let usageSources: [RouterWidgetUsageSource]?
  }
}

enum RouterWidgetSnapshotStore {
  static var appGroup: String {
    let configured = Bundle.main.object(forInfoDictionaryKey: "ModelRouterWidgetAppGroup") as? String
    if let configured {
      let trimmed = configured.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty { return trimmed }
    }
    return RouterWidgetSnapshot.defaultAppGroup
  }

  static func groupContainerURL(
    appGroup: String = appGroup,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
  ) -> URL {
    // The host app is not sandboxed, so it writes the same group-container
    // location directly. The Widget extension resolves this directory through
    // FileManager.containerURL(forSecurityApplicationGroupIdentifier:).
    homeDirectory
      .appendingPathComponent("Library/Group Containers", isDirectory: true)
      .appendingPathComponent(appGroup, isDirectory: true)
  }

  static func snapshotURL(
    appGroup: String = appGroup,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
  ) -> URL {
    groupContainerURL(appGroup: appGroup, homeDirectory: homeDirectory)
      .appendingPathComponent(RouterWidgetSnapshot.fileName, isDirectory: false)
  }

  static func widgetSandboxDataURL(
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
  ) -> URL {
    homeDirectory
      .appendingPathComponent("Library/Containers", isDirectory: true)
      .appendingPathComponent(RouterWidgetSnapshot.extensionBundleIdentifier, isDirectory: true)
      .appendingPathComponent("Data", isDirectory: true)
  }

  static func widgetSandboxSnapshotURL(sandboxDataDirectory: URL) -> URL {
    sandboxDataDirectory
      .appendingPathComponent("Library/Application Support", isDirectory: true)
      .appendingPathComponent(RouterWidgetSnapshot.supportDirectoryName, isDirectory: true)
      .appendingPathComponent(RouterWidgetSnapshot.fileName, isDirectory: false)
  }

  @discardableResult
  static func write(
    _ snapshot: RouterWidgetSnapshot,
    to destination: URL = snapshotURL(),
    now: Date = Date(),
    fileManager: FileManager = .default
  ) throws -> Bool {
    let decoder = JSONDecoder.routerWidget
    if let previousData = try? Data(contentsOf: destination),
       let previous = try? decoder.decode(RouterWidgetSnapshot.self, from: previousData),
       previous.schemaVersion == snapshot.schemaVersion,
       previous.content == snapshot.content,
       now.timeIntervalSince(previous.generatedAt) >= 0,
       now.timeIntervalSince(previous.generatedAt) < 10 * 60 {
      return false
    }

    let directory = destination.deletingLastPathComponent()
    if !fileManager.fileExists(atPath: directory.path) {
      try fileManager.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
    }
    let data = try JSONEncoder.routerWidget.encode(snapshot)
    try data.write(to: destination, options: .atomic)
    try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
    return true
  }
}

extension JSONEncoder {
  static var routerWidget: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys]
    return encoder
  }
}

extension JSONDecoder {
  static var routerWidget: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }
}
