import AppKit
import SwiftUI

struct RootView: View {
    let initial: AppState
    @State private var selected: AppState?
    @State private var showConnections = false
    @State private var incomingAddress = ""
    @State private var workspace: String?
    @State private var notificationTarget: NavigationTarget?
    /// This window's identity, so the manager can tell which connection each
    /// window is showing — and which one a window stopped showing (#542).
    @State private var windowId = UUID()
    init(app: AppState) { initial = app }
    private var active: AppState { selected ?? initial }

    /// Tell the manager this window is now showing `app`'s connection.
    private func showing(_ app: AppState) {
        app.connections.noteShowing(app.connectionId, window: windowId)
    }
    var body: some View {
        SessionRootView(app: active, workspaceId: workspace, notification: notificationTarget)
            .environmentObject(active)
            // The way into the workspace/server switcher (#566). The sheet stays
            // here, where the window's selection lives; the control moved into
            // the sidebar's workspace menu, so nothing floats over the composer
            // any more — the same move iOS (#563) and web (#565) already made.
            .environment(\.openConnections, OpenConnectionsAction { showConnections = true })
            // Opening a workspace on *another* connection (#592 on web): the
            // rail, the workspace menu and the chooser list every connection's
            // workspaces, and this window owns which connection it shows — so
            // they ask it to switch rather than switching themselves.
            .environment(\.openWorkspace, OpenWorkspaceAction { connectionId, workspaceId in
                guard let app = active.connections.appState(connectionId) else { return }
                UserDefaults.standard.set(workspaceId, forKey: app.sessionScope.key("activeWorkspaceId"))
                notificationTarget = nil
                workspace = workspaceId
                selected = app
                showing(app)
            })
            .id("\(active.connectionId):\(workspace ?? ""):\(notificationTarget?.messageId ?? "")")
            // Every connected server syncs while the app runs, not just the one
            // this window shows (#542). Bounded and idempotent, so a second
            // window calling it again costs nothing.
            .task { active.connections.startBackgroundSync() }
            // Which server this window is looking at. A connection nobody is
            // showing must not suppress its own banners or mark its channel
            // read — its `WindowState` outlives the switch (#542). Recorded on
            // appearance *and* at every site that changes `selected`, because
            // the two have to agree before the first event arrives.
            .onAppear { showing(active) }
            .background(WindowKeyObserver {
                active.connections.presentNotification = { app, target in
                    selected = app
                    workspace = target.workspaceId
                    notificationTarget = target
                    showing(app)
                }
            })
            .onOpenURL { url in
                if url.scheme == "https" || url.scheme == "http" {
                    incomingAddress = url.absoluteString
                    showConnections = true
                } else { active.handleDeepLink(url) }
            }
            .sheet(isPresented: $showConnections) {
                ServerConnectionsView(current: active, initialAddress: incomingAddress) { app, workspaceId in
                    if let workspaceId { UserDefaults.standard.set(workspaceId, forKey: app.sessionScope.key("activeWorkspaceId")) }
                    notificationTarget = nil
                    workspace = workspaceId
                    selected = app
                    showing(app)
                }
            }
    }
}

/// Opens a workspace on any connection. Published by `RootView`, which owns
/// this window's foreground connection; a session view asks it to switch.
struct OpenWorkspaceAction: Sendable {
    private let open: @MainActor @Sendable (String, String) -> Void

    init(_ open: @escaping @MainActor @Sendable (String, String) -> Void) { self.open = open }

    @MainActor func callAsFunction(connectionId: String, workspaceId: String) {
        open(connectionId, workspaceId)
    }
}

private struct OpenWorkspaceKey: EnvironmentKey {
    /// No-op above the root, like `openConnections`.
    static let defaultValue = OpenWorkspaceAction { _, _ in }
}

extension EnvironmentValues {
    var openWorkspace: OpenWorkspaceAction {
        get { self[OpenWorkspaceKey.self] }
        set { self[OpenWorkspaceKey.self] = newValue }
    }
}

/// Opens the workspace/server switcher (#566). Published by `RootView`, which
/// owns the sheet, so the sidebar menu — or a screen with no sidebar at all —
/// can raise it without a button floating over the conversation.
struct OpenConnectionsAction: Sendable {
    private let open: @MainActor @Sendable () -> Void

    init(_ open: @escaping @MainActor @Sendable () -> Void) { self.open = open }

    @MainActor func callAsFunction() { open() }
}

private struct OpenConnectionsKey: EnvironmentKey {
    /// No-op above the root, so a preview or a detached host renders rather
    /// than trapping — the same shape the confetti controller uses.
    static let defaultValue = OpenConnectionsAction {}
}

extension EnvironmentValues {
    var openConnections: OpenConnectionsAction {
        get { self[OpenConnectionsKey.self] }
        set { self[OpenConnectionsKey.self] = newValue }
    }
}

struct SessionRootView: View {
    @EnvironmentObject private var app: AppState
    /// This window's own selection state (workspace/channel/thread/…) — a
    /// `@StateObject` here is per window, unlike one on the `App` struct,
    /// which is what used to make every window mirror the same selection.
    @StateObject private var win: WindowState

    init(app: AppState, workspaceId: String?, notification: NavigationTarget?) {
        // Inside the autoclosure, which SwiftUI evaluates once per window
        // identity. This init runs on every parent re-render (FlowApp observes
        // the app state), and selecting a workspace starts its whole network
        // load — done here, a non-nil `workspaceId` turned every state change
        // into another load, whose results changed state again: a request
        // storm that starved message sends (macOS 2.2.108, after the rail
        // began setting `workspaceId` on every cross-connection open).
        _win = StateObject(wrappedValue: Self.makeWindow(app: app, workspaceId: workspaceId, notification: notification))
    }

    private static func makeWindow(app: AppState, workspaceId: String?, notification: NavigationTarget?) -> WindowState {
        let window = WindowState(app: app)
        if let workspaceId { window.selectWorkspace(workspaceId) }
        if let notification, let channel = notification.channelId, let message = notification.messageId {
            window.openNotification(workspaceId: notification.workspaceId, channelId: channel,
                                    messageId: message, threadRootId: notification.threadRootId)
        }
        return window
    }

    var body: some View {
        Group {
            switch app.phase {
            case .loading:
                ProgressView("Loading…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .signedOut:
                AuthView()
            case .signedIn:
                if win.selectedWorkspaceId == nil {
                    WorkspaceSwitcherView(manager: app.connections)
                        .onAppear { win.restoreActiveWorkspace() }
                } else {
                    MainView()
                }
            }
        }
        .environmentObject(win)
        // Confetti overlay for 🎉 reactions (#524). Per window, so a burst
        // lands in the window whose pill was reacted to and nowhere else.
        .confettiHost()
        .debugAutoLogin(app)
        // Banner taps and accepted invites navigate the key window — tell the
        // shared state which one that is.
        .background(WindowKeyObserver { app.noteKeyWindow(win) })

        .alert(
            "Error",
            isPresented: Binding(
                get: { app.errorMessage != nil },
                set: { if !$0 { app.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(app.errorMessage ?? "")
        }
    }
}

/// Reports when this view's window becomes key. SwiftUI has no per-window
/// key-status hook, so a zero-size AppKit view listens for the window's
/// `didBecomeKeyNotification` (and fires once on attach if already key).
private struct WindowKeyObserver: NSViewRepresentable {
    let onKey: () -> Void

    func makeNSView(context: Context) -> KeyObserverView {
        let view = KeyObserverView()
        view.onKey = onKey
        return view
    }

    func updateNSView(_ nsView: KeyObserverView, context: Context) {
        nsView.onKey = onKey
    }

    final class KeyObserverView: NSView {
        var onKey: (() -> Void)?
        private var observer: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            // Leaving a window (including window close, which strips its views
            // before dealloc) is where the observer is released — a deinit
            // cleanup would race Swift 6's nonisolated-deinit rules.
            if let observer {
                NotificationCenter.default.removeObserver(observer)
                self.observer = nil
            }
            guard let window else { return }
            if window.isKeyWindow { onKey?() }
            observer = NotificationCenter.default.addObserver(
                forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main
            ) { [weak self] _ in
                // Delivery is pinned to the main queue above, but
                // NotificationCenter's callback is `@Sendable`; make that
                // runtime guarantee explicit to Swift 6's actor checker.
                MainActor.assumeIsolated {
                    self?.onKey?()
                }
            }
        }
    }
}
