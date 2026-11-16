import SwiftUI

struct RootView: View {
    @EnvironmentObject private var initial: AppState
    @State private var selected: AppState?
    @State private var showConnections = false
    @State private var incomingAddress = ""
    @State private var workspace: String?
    /// The phone's single window, named so the manager can tell which
    /// connection is on screen — see `ConnectionManager.noteShowing` (#542).
    @State private var windowId = UUID()
    private var active: AppState { selected ?? initial }

    /// Tell the manager this window is now showing `app`'s connection.
    private func showing(_ app: AppState) {
        app.connections.noteShowing(app.connectionId, window: windowId)
    }
    var body: some View {
        SessionRootView()
            .environmentObject(active)
            // The switcher used to be a floating capsule pinned to the
            // bottom-right — which is exactly where the composer's send button
            // lives, so typing a message put the pill on top of send (#561).
            // The sheet still belongs to the root; its trigger now travels down
            // as an action, and the composer's "+" menu raises it.
            .environment(\.openConnections, OpenConnectionsAction { showConnections = true })
            .id("\(active.connectionId):\(workspace ?? "")")
            // A connection nobody is showing must not suppress its own
            // notifications or mark its channel read: its `WindowState`
            // outlives the switch to another server (#542).
            .onAppear { showing(active) }
            .onReceive(NotificationCenter.default.publisher(for: .init("flow.selectConnection"))) { event in
                if let app = event.object as? AppState { selected = app; workspace = nil; showing(app) }
            }
            .onOpenURL { url in
                if url.scheme == "https" || url.scheme == "http" {
                    incomingAddress = url.absoluteString
                    showConnections = true
                } else { active.handleDeepLink(url) }
            }
            .sheet(isPresented: $showConnections) {
                ServerConnectionsView(current: active, initialAddress: incomingAddress) { app, workspaceId in
                    if let workspaceId { app.selectWorkspace(workspaceId) }
                    workspace = workspaceId
                    selected = app
                    showing(app)
                }
            }
    }
}

private struct SessionRootView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        Group {
            switch app.phase {
            case .loading:
                ProgressView().controlSize(.large)
            case .signedOut:
                AuthView()
            case .signedIn:
                MainView()
            }
        }
        .animation(.default, value: app.phase)
        // Confetti overlay for 🎉 reactions (#524) — same host modifier the
        // macOS root mounts; the overlay and the rule are shared code.
        .confettiHost()
        .debugAutoLogin(app)
        // Port of the macOS `RootView` alert. `showError` has always set
        // `errorMessage` on iOS too, but nothing rendered it — every failure on
        // the phone was silent, which is how a refused workspace delete looked
        // like a no-op (#340 follow-up).
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

/// Opens the workspace/server switcher (#561). Published by `RootView`, which
/// owns the sheet, so a view as deep as the composer can raise it without a
/// control floating over the conversation.
struct OpenConnectionsAction: Sendable {
    private let open: @MainActor @Sendable () -> Void

    init(_ open: @escaping @MainActor @Sendable () -> Void) { self.open = open }

    @MainActor func callAsFunction() { open() }
}

private struct OpenConnectionsKey: EnvironmentKey {
    /// No-op above the root, so a preview or a detached host renders rather
    /// than trapping — the same shape the confetti controller uses on macOS.
    static let defaultValue = OpenConnectionsAction {}
}

extension EnvironmentValues {
    var openConnections: OpenConnectionsAction {
        get { self[OpenConnectionsKey.self] }
        set { self[OpenConnectionsKey.self] = newValue }
    }
}
