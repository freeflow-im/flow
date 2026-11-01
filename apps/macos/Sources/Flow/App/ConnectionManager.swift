import Foundation
import Combine

/// Owns one session runtime per connection (docs/specs/multi-server-workspaces.md,
/// "Runtime architecture"). A runtime is everything that belongs to one backend
/// session: its API client bound to that origin, its socket, its GRDB cache, its
/// sync engine, its identity, and the storage scopes those live in.
///
/// One connection exists today — the migrated default. The switcher that adds
/// more is phase 3; what this ticket delivers is that nothing in the app talks
/// to "the server" any more. It talks to *a runtime*, and an operation that
/// captured one at start cannot be retargeted by a later switch.
@MainActor
final class ConnectionRuntime {
    let connection: ServerConnection
    /// Scope that rotates with identity: credentials, defaults, sync cursors,
    /// navigation entries, read markers.
    private(set) var sessionScope: StorageScope
    /// Scope stable for the life of the connection: the GRDB cache directory.
    var connectionScope: StorageScope { connection.connectionScope }

    let api: APIClient
    let socket: SocketClient
    let db: AppDatabase
    let engine: SyncEngine

    init(connection: ServerConnection, sessionScope: StorageScope, db: AppDatabase) {
        self.connection = connection
        self.sessionScope = sessionScope
        self.db = db
        let origin = connection.canonicalOrigin
        let baseURL = origin?.url ?? connection.url
        self.api = APIClient(baseURL: baseURL)
        self.socket = SocketClient(url: origin?.socketURL ?? Server.wsURL)
        self.engine = SyncEngine(
            db: db, api: api, socket: socket,
            connectionId: connection.connectionId, scope: sessionScope
        )
    }

    func adopt(sessionScope: StorageScope) {
        self.sessionScope = sessionScope
    }
}

@MainActor
final class ConnectionManager: ObservableObject {
    static let shared = ConnectionManager()

    @Published private(set) var registry: ConnectionRegistry
    private var runtimes: [String: ConnectionRuntime] = [:]
    private var appStates: [String: AppState] = [:]
    var presentNotification: ((AppState, NavigationTarget) -> Void)?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Reads the *configured* server (env var, Info.plist, or the local dev
        // default) — the native equivalent of the web client's page origin.
        self.registry = ConnectionStore.loadOrMigrate(
            from: defaults,
            server: Server.baseURL,
            hasLegacyCredential: Keychain.hasToken(account: StorageScope.legacy.keychainAccount)
        )
    }

    /// How many connections may be *bootstrapping* at once (#542).
    ///
    /// The bound is on start-up work, not on how many sessions end up live —
    /// every connected server does stay subscribed while the app runs, which is
    /// the feature. What it prevents is launching with six servers and firing
    /// six `/v1/me` round trips, six socket upgrades and six workspace refreshes
    /// in the same instant, which is the moment every one of them is slowest.
    nonisolated static let maxConcurrentStarts = 3

    /// Split the connections waiting to start into bounded waves. Pure, so the
    /// bound itself is testable without a server to bootstrap against.
    nonisolated static func startWaves(_ pending: [String], limit: Int = maxConcurrentStarts) -> [[String]] {
        guard limit > 0 else { return pending.isEmpty ? [] : [pending] }
        return stride(from: 0, to: pending.count, by: limit).map {
            Array(pending[$0 ..< min($0 + limit, pending.count)])
        }
    }

    private var backgroundSync: Task<Void, Never>?

    /// Bring every *authenticated* connection online and keep it there while
    /// the app runs (docs/specs/multi-server-workspaces.md, "Runtime
    /// architecture"). Each one gets its own runtime, socket, cache and sync
    /// engine — and only its own: an unreachable or de-authorised server costs
    /// exactly one connection.
    ///
    /// This is not an eager download. `bootstrap()` is `/v1/me`, the workspace
    /// list and the notification total; transcripts are still fetched by
    /// `selectChannel` when a window actually shows a channel, so a server you
    /// never open never pages a message.
    ///
    /// macOS only. iOS keeps its foreground/background lifecycle and push, and
    /// the spec promises no continuously running background sockets there.
    func startBackgroundSync() {
        backgroundSync?.cancel()
        backgroundSync = Task { @MainActor [weak self] in
            guard let self else { return }
            // Already-running connections are skipped, so this is safe to call
            // from every window and after every registry change.
            let pending = self.registry.sessions
                .filter { $0.status == .authenticated && self.appStates[$0.connectionId] == nil }
                .map(\.connectionId)
            let waves = Self.startWaves(pending)
            for (index, wave) in waves.enumerated() {
                if Task.isCancelled { return }
                await withTaskGroup(of: Void.self) { group in
                    for connectionId in wave {
                        guard let app = self.appState(connectionId) else { continue }
                        group.addTask { await app.awaitBootstrap() }
                    }
                }
                // Jittered, so a wake-from-sleep does not restart every wave in
                // lockstep with every other client on the network.
                if index + 1 < waves.count && !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(Double.random(in: 0.25...0.75)))
                }
            }
            self.refreshAggregateBadge()
        }
    }

    /// The dock badge is the sum of the connections' own last-known counts —
    /// there is no server that can compute it, because no server knows about
    /// the others (spec, "Notifications and native extensions").
    func refreshAggregateBadge() {
        var totals: [String: Int] = [:]
        var byWorkspace: [String: [String: Int]] = [:]
        for app in appStates.values where registry.session(app.connectionId)?.status == .authenticated {
            totals[app.connectionId] = app.notificationUnreadTotal
            byWorkspace[app.connectionId] = app.notificationUnreadByWorkspace
        }
        unreadByConnection = totals
        unreadByWorkspace = byWorkspace
        Banners.setBadge(totals.values.reduce(0, +))
    }

    /// connectionId -> its own last-known unread total, republished here so the
    /// switcher redraws when any connection's count moves. A view observing one
    /// `AppState` would only ever see that connection's.
    @Published private(set) var unreadByConnection: [String: Int] = [:]
    /// connectionId -> workspaceId -> unread, same reason.
    @Published private(set) var unreadByWorkspace: [String: [String: Int]] = [:]

    private var badgeReconcile: Task<Void, Never>?

    /// Re-ask every running connection for its unread total, then re-aggregate.
    ///
    /// The icon badge is a *client-side sum* for multi-server registrations —
    /// independent backends cannot each write a correct absolute `aps.badge`,
    /// because the last push would overwrite the others, so V1 asks for alert
    /// delivery without one (spec, "Notifications and native extensions").
    /// While the app is suspended that sum can only drift; coming back to the
    /// foreground is the moment to reconcile it. Bounded by the same wave
    /// limit as start-up, for the same reason.
    func reconcileBadge() {
        badgeReconcile?.cancel()
        badgeReconcile = Task { @MainActor [weak self] in
            guard let self else { return }
            let running = self.registry.sessions
                .filter { $0.status == .authenticated && self.appStates[$0.connectionId] != nil }
                .map(\.connectionId)
            for wave in Self.startWaves(running) {
                if Task.isCancelled { return }
                await withTaskGroup(of: Void.self) { group in
                    for connectionId in wave {
                        guard let app = self.appStates[connectionId] else { continue }
                        group.addTask { await app.engine.refreshNotificationBadge() }
                    }
                }
            }
            if !Task.isCancelled { self.refreshAggregateBadge() }
        }
    }

    func register(_ app: AppState) {
        appStates[app.connectionId] = app
        applyVisibility()
    }

    /// "Is the user actually looking at us?" — for *every* connection, not just
    /// the one the front window happens to be showing (#542).
    ///
    /// The foreground rule ("don't banner what I'm already reading") is decided
    /// per connection against that connection's own windows. A session that
    /// never hears the app went away keeps claiming its channel is on screen
    /// and swallows its own notifications; with colliding channel ids across
    /// servers that is not a hypothetical.
    func setAppActive(_ active: Bool) {
        appIsActive = active
        for app in appStates.values { app.setAppActive(active) }
        if active { reconcileBadge() }
    }

    private var appIsActive = true
    /// What each open window is currently showing, keyed by the window's own
    /// identity. A window that switches server replaces its entry, and that is
    /// what tells the connection it left to stop counting itself as on screen.
    private var showing: [UUID: String] = [:]

    /// A window is now displaying `connectionId`. Idempotent — called from
    /// every render pass that changes the window's connection.
    func noteShowing(_ connectionId: String, window: UUID) {
        guard showing[window] != connectionId else { return }
        showing[window] = connectionId
        applyVisibility()
    }

    func windowClosed(_ window: UUID) {
        guard showing.removeValue(forKey: window) != nil else { return }
        applyVisibility()
    }

    /// Until some window has said what it is showing, every session behaves as
    /// it always did — on screen. Only once a window reports does the question
    /// have an answer worth acting on, and from then on it is exact.
    private func applyVisibility() {
        guard !showing.isEmpty else { return }
        let onScreen = Set(showing.values)
        for (connectionId, app) in appStates {
            app.setOnScreen(onScreen.contains(connectionId))
        }
    }


    func appState(_ connectionId: String) -> AppState? {
        if let existing = appStates[connectionId] { return existing }
        guard runtime(connectionId) != nil else { return nil }
        let app = AppState(connections: self, connectionId: connectionId)
        appStates[connectionId] = app
        return app
    }

    /// Resolve only locally issued routing identifiers; unknown or expired routes
    /// cannot choose a server or inherit a replacement identity.
    func notificationApp(routingId: String?) -> AppState? {
        let sessions = registry.sessions.filter { $0.status == .authenticated }
        if let routingId {
            guard let session = sessions.first(where: {
                defaults.string(forKey: StorageScope(storageKey: $0.storageKey).key("pushRoutingId")) == routingId
            }) else { return nil }
            return appState(session.connectionId)
        }
        guard registry.connections.count == 1, let session = sessions.first,
              session.storageKey == StorageScope.legacy.storageKey else { return nil }
        return appState(session.connectionId)
    }

    func add(origin: CanonicalOrigin) -> ServerConnection {
        var next = registry
        let connection = next.addFlowConnection(origin: origin)
        commit(next)
        return connection
    }

    private func commit(_ registry: ConnectionRegistry) {
        self.registry = registry
        ConnectionStore.save(registry, to: defaults)
    }

    var activeConnection: ServerConnection? {
        registry.activeConnectionId.flatMap { registry.connection($0) }
            ?? registry.connections.first
    }

    /// Scope every *view-level* stored preference that belongs to the signed-in
    /// session uses (`WindowState`'s navigation entries, collapsed images). The
    /// engine and the runtime hold their own copy rather than reading this, so
    /// a background operation cannot pick up a scope that changed under it.
    var activeSessionScope: StorageScope {
        guard let id = activeConnection?.connectionId,
              let session = registry.session(id)
        else { return .legacy }
        return StorageScope(storageKey: session.storageKey)
    }

    /// The runtime for a connection, built on first use.
    func runtime(_ connectionId: String) -> ConnectionRuntime? {
        if let existing = runtimes[connectionId] { return existing }
        guard let connection = registry.connection(connectionId),
              let session = registry.session(connectionId)
        else { return nil }
        let db: AppDatabase
        do {
            db = try AppDatabase.open(scope: connection.connectionScope)
        } catch {
            fatalError("Cannot open local database for \(connection.label): \(error)")
        }
        let runtime = ConnectionRuntime(
            connection: connection,
            sessionScope: StorageScope(storageKey: session.storageKey),
            db: db
        )
        runtimes[connectionId] = runtime
        return runtime
    }

    /// The runtime the app is currently pointed at.
    func active() -> ConnectionRuntime {
        if let id = activeConnection?.connectionId, let runtime = runtime(id) { return runtime }
        // Only reachable if the registry was emptied under us; rebuilding the
        // default connection beats refusing to launch.
        var next = registry
        let connection = next.addFlowConnection(
            origin: CanonicalOrigin.originOf(Server.baseURL)
                ?? CanonicalOrigin.originOf(Server.defaultLocal)!
        )
        next.activeConnectionId = connection.connectionId
        commit(next)
        return runtime(connection.connectionId)!
    }

    /// Commit a *validated* identity for a connection. A different identity
    /// rotates the session scope and discards the previous one's credential and
    /// defaults; the cache is wiped in place by the sign-out that preceded it.
    func bindIdentity(connectionId: String, userId: String) {
        var next = registry
        let abandoned = next.bindIdentity(connectionId, userId: userId)
        commit(next)
        if let session = next.session(connectionId) {
            runtimes[connectionId]?.adopt(sessionScope: StorageScope(storageKey: session.storageKey))
        }
        guard let abandoned else { return }
        ConnectionStore.clear(scope: abandoned, in: defaults)
        Keychain.deleteToken(account: abandoned.keychainAccount)
    }

    func markSignedOut(connectionId: String) {
        var next = registry
        next.updateSession(connectionId) { $0.status = .signedOut }
        commit(next)
    }

    /// The backend rejected this connection's bearer. The runtime only reports
    /// it when the auth generation still matches, so a 401 answering a
    /// pre-refresh request never reaches here.
    func markUnauthorized(connectionId: String) {
        var next = registry
        next.updateSession(connectionId) { $0.status = .unauthorized }
        commit(next)
    }

    func noteTokenReplaced(connectionId: String, generation: Int) {
        var next = registry
        next.updateSession(connectionId) { $0.authGeneration = generation }
        commit(next)
    }

    /// Remember where a connection+identity is parked, so each session lands
    /// where it was rather than sharing one global "last channel".
    func rememberNavigation(_ target: NavigationTarget) {
        var next = registry
        next.setNavigationTarget(target)
        commit(next)
    }

    func navigationTarget(connectionId: String, userId: String) -> NavigationTarget? {
        registry.navigationTarget(connectionId: connectionId, userId: userId)
    }

    func forgetWorkspace(connectionId: String, workspaceId: String) {
        var next = registry
        next.bindings.removeAll { $0.connectionId == connectionId && $0.workspaceId == workspaceId }
        commit(next)
    }

    /// Every workspace this client can open, across connections: the rail, the
    /// sidebar's workspace menu and the chooser all draw this one list.
    /// `foregroundWorkspaces` is the live list of the connection on screen.
    func switcherEntries(foreground: String?, foregroundWorkspaces: [Workspace]? = nil) -> [SwitcherEntry] {
        registry.switcherEntries(
            foregroundConnectionId: foreground,
            foregroundWorkspaces: foregroundWorkspaces,
            unreadByWorkspace: unreadByWorkspace
        )
    }

    /// Record a connection's live workspace list in its bindings, so the other
    /// connections' switchers name and draw it correctly. A no-op when nothing
    /// moved — this runs after every workspace refresh.
    func syncBindings(connectionId: String, userId: String, workspaces: [Workspace]) {
        guard let bindings = registry.syncedBindings(connectionId: connectionId, userId: userId, workspaces: workspaces) else { return }
        var next = registry
        next.bindings = bindings
        commit(next)
    }

    func setBinding(_ binding: WorkspaceBinding) {
        var next = registry
        next.setBinding(binding)
        commit(next)
    }

    /// Forget a connection entirely: its runtime, its credential, its defaults,
    /// its cache and its registry records. Every other connection is untouched.
    func remove(connectionId: String) {
        guard let connection = registry.connection(connectionId) else { return }
        let session = registry.session(connectionId)
        appStates.removeValue(forKey: connectionId)
        runtimes.removeValue(forKey: connectionId)
        var next = registry
        next.removeConnection(connectionId)
        commit(next)
        if let session {
            let scope = StorageScope(storageKey: session.storageKey)
            ConnectionStore.clear(scope: scope, in: defaults)
            Keychain.deleteToken(account: scope.keychainAccount)
        }
        AppDatabase.destroy(scope: connection.connectionScope)
    }
}
