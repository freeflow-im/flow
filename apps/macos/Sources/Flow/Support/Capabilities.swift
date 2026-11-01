import Foundation

/// Capabilities — what the controls of a conversation may do. Mirrors
/// `packages/shared/src/backend.ts` field for field so web, macOS and iOS gate
/// the same control on the same capability with the same wording.
///
/// A Flow server supports everything; the one narrowing in use is an archived
/// channel's read-only set (`Capabilities.archivedReadOnly()` in
/// ChannelBrowser.swift). The provider abstraction this file once carried
/// (`WorkspaceBackend`, the Slack adapter) was removed for the FreeFlow suite,
/// docs/specs/freeflow-suite.md §2.0.
///
/// Shared by macOS and iOS. Nothing here touches storage or the network.

enum CapabilityState: String, Codable, Sendable {
    case supported, limited, unavailable
}

/// A control's state plus the sentence the client shows for it.
struct Capability: Codable, Equatable, Sendable {
    var state: CapabilityState
    var reason: String?

    static let supported = Capability(state: .supported, reason: nil)
    static func limited(_ reason: String) -> Capability { Capability(state: .limited, reason: reason) }
    static func unavailable(_ reason: String) -> Capability { Capability(state: .unavailable, reason: reason) }

    var usable: Bool { state != .unavailable }
}

enum CapabilityName: String, Codable, CaseIterable, Sendable {
    case conversations, history, threads, send, edit, delete, reactions, files, search
    case readState, liveUpdates, typing, presence, pins, huddles, artifacts, agents, apps
    case admin, scheduledMessages, notifications, channelManagement, status
}

struct Capabilities: Codable, Equatable, Sendable {
    private var values: [CapabilityName: Capability]

    init(_ values: [CapabilityName: Capability]) { self.values = values }

    /// Every capability supported — a Flow server's baseline.
    static let allSupported = Capabilities(Dictionary(uniqueKeysWithValues: CapabilityName.allCases.map { ($0, Capability.supported) }))

    /// Every capability set to `base`, then overridden per name.
    static func from(_ base: Capability, overrides: [CapabilityName: Capability]) -> Capabilities {
        var all = Dictionary(uniqueKeysWithValues: CapabilityName.allCases.map { ($0, base) })
        for (name, value) in overrides { all[name] = value }
        return Capabilities(all)
    }

    subscript(_ name: CapabilityName) -> Capability { values[name] ?? .unavailable("Not available for this workspace.") }
    func canUse(_ name: CapabilityName) -> Bool { self[name].usable }

    /// A copy with one capability replaced.
    func overriding(_ name: CapabilityName, with value: Capability) -> Capabilities {
        var copy = self
        copy.values[name] = value
        return copy
    }
}
