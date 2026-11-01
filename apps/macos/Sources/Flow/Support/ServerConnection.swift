import Foundation

/// The connection registry's record types
/// (docs/specs/multi-server-workspaces.md, "Connection and identity model").
/// The origin rules they lean on live in `CanonicalOrigin.swift`.
///
/// Shared by macOS and iOS. Nothing here touches storage or the network — it is
/// the value layer that `ConnectionStore` persists and `ConnectionManager` runs.

/// Providers a connection can speak: Flow servers. The field stays in the
/// persisted schema so stored registries keep their shape; a record whose
/// provider this build does not know (the removed Slack provider) is dropped on
/// read, see `ConnectionRegistry.init(from:)`.
enum ConnectionProvider: String, Codable, Sendable {
    case flow
}

enum SessionStatus: String, Codable, Sendable {
    case authenticated
    case unauthorized
    case signedOut
}

struct ServerConnection: Codable, Identifiable, Equatable, Sendable {
    /// Local and stable. Not an authentication claim: a server cannot declare
    /// itself equivalent to another connection through discovery metadata.
    let connectionId: String
    let provider: ConnectionProvider
    /// The canonical origin. Never treated as an authentication claim.
    let providerIdentity: String
    /// Canonical origin / transport endpoint this connection's runtime dials.
    let origin: String
    /// Storage scope stable for the life of the *connection*, as opposed to the
    /// session scope that rotates with identity. It owns the one thing a live
    /// handle cannot follow through a rotation: the GRDB cache directory. An
    /// identity change wipes that cache in place — which every sign-out path
    /// already does — rather than orphaning a directory a `DatabasePool` still
    /// has open. V1 is one account per Flow server, so the two never diverge in
    /// practice; the split exists so neither can leak into the other.
    var connectionStorageKey: String = StorageScope.legacyKey
    var label: String
    /// `protocolVersion` from `GET /v1/client-info`, nil until discovery runs —
    /// the migrated default connection predates discovery.
    var apiVersion: Int?
    var capabilities: [String: Bool]
    let addedAt: Date

    var id: String { connectionId }

    var url: URL { URL(string: origin) ?? Server.defaultLocal }
    var canonicalOrigin: CanonicalOrigin? { CanonicalOrigin.originOf(url) }
    /// How this connection names itself in the UI — the switcher sheet's rows
    /// and the iOS sidebar header both use it, so they can't drift (#563).
    var displayLabel: String {
        canonicalOrigin?.label ?? origin
    }
    var connectionScope: StorageScope { StorageScope(storageKey: connectionStorageKey) }
}

/// Never holds a credential — only the *reference* to where one lives. That is
/// what makes migration a copy-free act and makes "never copy a token to
/// another origin" true by construction.
struct ServerSession: Codable, Equatable, Sendable {
    let connectionId: String
    /// Server-issued user id. Nil until the first `/v1/me` has validated the
    /// token; migration deliberately does not claim one.
    var userId: String?
    /// Keychain account the bearer lives under.
    var credentialRef: String
    /// Namespace for this connection+identity's database, defaults and caches.
    var storageKey: String
    /// Bumped on every token replacement so a 401 from a pre-refresh request
    /// cannot invalidate the session that replaced it.
    var authGeneration: Int
    var status: SessionStatus
}

struct WorkspaceBinding: Codable, Equatable, Sendable {
    let connectionId: String
    let userId: String
    let workspaceId: String
    var name: String
    var hidden: Bool?
    var order: Int?
    /// The workspace's avatar path, recorded so another connection's switcher
    /// can draw this one's mark without opening its database (#592 on web).
    /// Absent on a record written before the unified switcher.
    var avatarUrl: String?
}

struct NavigationTarget: Codable, Equatable, Sendable {
    let connectionId: String
    let userId: String
    var workspaceId: String
    var channelId: String?
    var messageId: String?
    var threadRootId: String?
    var artifactId: String?
}

struct ConnectionRegistry: Codable, Equatable, Sendable {
    static let currentVersion = 1

    var version: Int = ConnectionRegistry.currentVersion
    var connections: [ServerConnection] = []
    var sessions: [ServerSession] = []
    var bindings: [WorkspaceBinding] = []
    var navigation: [NavigationTarget] = []
    var activeConnectionId: String?

    init() {}

    private enum CodingKeys: String, CodingKey {
        case version, connections, sessions, bindings, navigation, activeConnectionId
    }

    /// A registry written by an earlier build may hold connections to a
    /// provider this build no longer speaks (Slack, removed 2026-11-01). Those
    /// records are dropped on read, with every session, binding and navigation
    /// target scoped to them, instead of failing the whole registry and signing
    /// the person out of every server. Their Keychain credential is left for
    /// the next sign-out sweep.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? ConnectionRegistry.currentVersion
        let kept = (try c.decodeIfPresent([Lenient<ServerConnection>].self, forKey: .connections) ?? []).compactMap(\.value)
        let ids = Set(kept.map(\.connectionId))
        connections = kept
        sessions = (try c.decodeIfPresent([ServerSession].self, forKey: .sessions) ?? []).filter { ids.contains($0.connectionId) }
        bindings = (try c.decodeIfPresent([WorkspaceBinding].self, forKey: .bindings) ?? []).filter { ids.contains($0.connectionId) }
        navigation = (try c.decodeIfPresent([NavigationTarget].self, forKey: .navigation) ?? []).filter { ids.contains($0.connectionId) }
        let active = try c.decodeIfPresent(String.self, forKey: .activeConnectionId)
        activeConnectionId = active.flatMap { ids.contains($0) ? $0 : nil } ?? kept.first?.connectionId
    }

    func connection(_ id: String) -> ServerConnection? {
        connections.first { $0.connectionId == id }
    }

    func session(_ id: String) -> ServerSession? {
        sessions.first { $0.connectionId == id }
    }

    mutating func updateSession(_ id: String, _ mutate: (inout ServerSession) -> Void) {
        guard let index = sessions.firstIndex(where: { $0.connectionId == id }) else { return }
        mutate(&sessions[index])
    }

    /// Bind a *validated* identity. A different identity gets a fresh storage
    /// namespace: cached state whose ownership we can no longer establish is
    /// discarded and refetched, never handed to another user. Returns the
    /// namespace that was abandoned, if any.
    @discardableResult
    mutating func bindIdentity(_ id: String, userId: String) -> StorageScope? {
        guard let session = session(id) else { return nil }
        if session.userId == userId {
            updateSession(id) { $0.status = .authenticated }
            return nil
        }
        // First identity on a namespace nobody has used yet: adopt it as-is.
        // That is what keeps the migrated legacy namespace attached to its user.
        if session.userId == nil {
            updateSession(id) {
                $0.userId = userId
                $0.status = .authenticated
            }
            return nil
        }
        bindings.removeAll { $0.connectionId == id }
        navigation.removeAll { $0.connectionId == id }
        let abandoned = StorageScope(storageKey: session.storageKey)
        let scope = StorageScope.fresh()
        updateSession(id) {
            $0.userId = userId
            $0.storageKey = scope.storageKey
            $0.credentialRef = scope.keychainAccount
            $0.status = .authenticated
        }
        return abandoned
    }

    /// Add a Flow connection for `origin`, or return the one already on it.
    /// Changing an origin creates a *new* connection in V1.
    @discardableResult
    mutating func addFlowConnection(origin: CanonicalOrigin, label: String? = nil) -> ServerConnection {
        if let existing = connections.first(where: { $0.provider == .flow && $0.origin == origin.origin }) {
            return existing
        }
        let scope = StorageScope.fresh()
        let connection = ServerConnection(
            connectionId: UUID().uuidString,
            provider: .flow,
            providerIdentity: origin.origin,
            origin: origin.origin,
            connectionStorageKey: StorageScope.fresh().storageKey,
            label: label ?? origin.label,
            apiVersion: nil,
            capabilities: [:],
            addedAt: Date()
        )
        connections.append(connection)
        sessions.append(ServerSession(
            connectionId: connection.connectionId,
            userId: nil,
            credentialRef: scope.keychainAccount,
            storageKey: scope.storageKey,
            authGeneration: 0,
            status: .signedOut
        ))
        if activeConnectionId == nil { activeConnectionId = connection.connectionId }
        return connection
    }

    /// Forget a connection and every record scoped to it. The caller disposes
    /// the live runtime and its storage; this is only the durable half.
    mutating func removeConnection(_ id: String) {
        connections.removeAll { $0.connectionId == id }
        sessions.removeAll { $0.connectionId == id }
        bindings.removeAll { $0.connectionId == id }
        navigation.removeAll { $0.connectionId == id }
        if activeConnectionId == id { activeConnectionId = connections.first?.connectionId }
    }

    mutating func setBinding(_ binding: WorkspaceBinding) {
        bindings.removeAll {
            $0.connectionId == binding.connectionId
                && $0.userId == binding.userId
                && $0.workspaceId == binding.workspaceId
        }
        bindings.append(binding)
    }

    /// One remembered destination per connection+identity — where that session
    /// lands on the next launch.
    mutating func setNavigationTarget(_ target: NavigationTarget) {
        navigation.removeAll { $0.connectionId == target.connectionId && $0.userId == target.userId }
        navigation.append(target)
    }

    func navigationTarget(connectionId: String, userId: String) -> NavigationTarget? {
        navigation.first { $0.connectionId == connectionId && $0.userId == userId }
    }
}

/// Decodes to nil instead of failing, so one unreadable element does not take
/// the whole array with it.
private struct Lenient<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) {
        value = try? Value(from: decoder)
    }
}
