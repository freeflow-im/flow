import SwiftUI
import GRDB

/// Root of the signed-in experience. Mirrors the web client's *mobile* layout:
/// the conversation fills the screen, and the channel list lives in a slide-in
/// drawer (workspace rail + sidebar) that overlays it, opened from the header's
/// hamburger and dismissed by the backdrop or a selection.
///
/// The visible pane is driven by `AppState` (`selectedChannelId` / `showActivity`),
/// the same selection model macOS and web use — not a navigation stack of
/// channel ids. Threads still push onto the content pane's own `NavigationStack`.
struct MainView: View {
    @EnvironmentObject var app: AppState
    @StateObject private var workspaces = DBObserved<[Workspace]>(initial: [])
    @StateObject private var allChannels = DBObserved<[Channel]>(initial: [])
    @StateObject private var agentCall = AgentCallCoordinator()
    @State private var drawerOpen = false

    var body: some View {
        GeometryReader { geo in
            let drawerWidth = min(geo.size.width * 0.86, 320)
            ZStack(alignment: .leading) {
                VStack(spacing: 0) {
                    content
                    AgentCallBar()
                }
                // The ring floats over everything — it is the one thing that
                // has to be answerable from wherever you are looking (#436).
                .overlay(alignment: .bottom) {
                    IncomingHuddleView().padding(.bottom, 90)
                }

                // Zero-sized: it owns the automatic voice loop while the call
                // sheet is minimized or another channel is on screen.
                AgentCallRuntimeView()

                if drawerOpen {
                    Color.black.opacity(0.4)
                        .ignoresSafeArea()
                        .transition(.opacity)
                        .onTapGesture { closeDrawer() }
                        .accessibilityIdentifier("nav.drawerBackdrop")
                        .accessibilityLabel("Close menu")

                    SidebarDrawer(onSelect: { closeDrawer() })
                        .frame(width: drawerWidth)
                        .frame(maxHeight: .infinity)
                        .shadow(color: .black.opacity(0.35), radius: 18, x: 6, y: 0)
                        .transition(.move(edge: .leading))
                }
            }
            .animation(.easeInOut(duration: 0.22), value: drawerOpen)
        }
        .task {
            workspaces.start(db: app.db) { try Workspace.order(Column("name")).fetchAll($0) }
            allChannels.start(db: app.db) { try Channel.fetchAll($0) }
            app.restoreActiveWorkspace()
            #if DEBUG
            // QA: FLOW_DEBUG_OPEN_DRAWER=1 slides the channel drawer open on
            // launch so the simulator can be screenshot-verified without a tap
            // tool (compiled out of release).
            if ProcessInfo.processInfo.environment["FLOW_DEBUG_OPEN_DRAWER"] == "1" {
                drawerOpen = true
            }
            debugShowPanel()
            #endif
        }
        .onChange(of: workspaces.value) { _, list in
            if app.selectedWorkspaceId == nil, let first = list.first {
                app.selectWorkspace(first.id)
                // Picking a workspace clears every panel flag (it is a move to
                // somewhere else entirely), so a launch hook set before the
                // first workspace arrived — which is every first launch after
                // an install — has to be re-applied here or it is silently lost.
                #if DEBUG
                debugShowPanel()
                #endif
            }
        }
        .onChange(of: allChannels.value) { _, list in
            debugAutoOpen(list)
            restoreLastChannel(list)
        }
        // The workspace and the cached channel rows arrive in either order on a
        // cold launch, and the restore needs both — so try again from this side.
        .onChange(of: app.selectedWorkspaceId) { _, _ in restoreLastChannel(allChannels.value) }
        .onDisappear { agentCall.end() }
        .sheet(isPresented: $agentCall.showingCall) {
            if let call = agentCall.activeCall {
                AgentCallView(call: call, session: agentCall.session)
                    .environmentObject(app)
                    .environmentObject(agentCall)
            }
        }
        .environmentObject(app)
        .environmentObject(agentCall)
    }

    /// The full-screen conversation pane. A `NavigationStack` so a channel can
    /// push a thread (`ChannelScreen` owns that destination); its root swaps
    /// when the selection changes. The leading hamburger opens the drawer.
    private var content: some View {
        NavigationStack {
            Group {
                if app.showActivity {
                    ActivityFeedView(onOpenChannel: { app.selectChannel($0) })
                } else if app.showScheduled {
                    // Scheduled list (#424) — same treatment as the feed above.
                    ScheduledListView(onOpenChannel: { app.selectChannel($0) })
                } else if app.showDirectory {
                    // Directory (#432) — the workspace member grid, same again.
                    DirectoryScreen()
                } else if app.showChannelBrowser {
                    // Channel browser (#590) — every public channel, same again.
                    ChannelBrowserScreen()
                } else if let channelId = app.selectedChannelId {
                    ChannelScreen(channelId: channelId, onOpenDrawer: { openDrawer() })
                        .id(channelId)
                } else {
                    emptyState
                }
            }
            .flowBarToolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        openDrawer()
                    } label: {
                        Image(systemName: "line.3.horizontal")
                    }
                    .accessibilityIdentifier("nav.menu")
                    .accessibilityLabel("Channels")
                }
            }
        }
    }

    private var emptyState: some View {
        Text("Select a channel")
            .foregroundStyle(MC.faint)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(MC.base)
            .navigationTitle(workspaceName)
            .navigationBarTitleDisplayMode(.inline)
    }

    private var workspaceName: String {
        workspaces.value.first { $0.id == app.selectedWorkspaceId }?.name ?? "Flow"
    }

    // The drawer slides over the whole screen, so a raised composer keyboard
    // would sit on top of it — put it away before opening (#69).
    private func openDrawer() {
        dismissKeyboard()
        drawerOpen = true
    }
    private func closeDrawer() { drawerOpen = false }

    /// Reopen the channel this device was last reading (#242). Runs whenever
    /// the channel list changes, because on a cold launch the workspace, the
    /// cached rows and the first sync all land at different moments — the
    /// first pass that has a usable row wins, and the rest no-op.
    ///
    /// It only ever fills an *empty* selection (the guard lives in
    #if DEBUG
    /// QA: the `FLOW_DEBUG_SHOW_*` hooks land the app on a panel at launch, so
    /// the simulator can be screenshot-verified without a tap tool. Compiled
    /// out of release.
    private func debugShowPanel() {
        let env = ProcessInfo.processInfo.environment
        if env["FLOW_DEBUG_SHOW_ACTIVITY"] == "1" { app.showActivity = true }
        if env["FLOW_DEBUG_SHOW_SCHEDULED"] == "1" { app.showScheduled = true }
        if env["FLOW_DEBUG_SHOW_DIRECTORY"] == "1" { app.showDirectory = true }
        if env["FLOW_DEBUG_SHOW_CHANNEL_BROWSER"] == "1" { app.showChannelBrowser = true }
    }
    #endif

    /// `restorableLastChannel`), which is what keeps the priority order right:
    /// a deep link, a tapped notification or the debug hook has already put
    /// something on screen, so restoring is skipped — and if one of those
    /// arrives later it simply navigates over the restored channel.
    private func restoreLastChannel(_ channels: [Channel]) {
        #if DEBUG
        // A launch-hook destination outranks the restore and may land on a
        // later pass than this one, so don't take the slot from it.
        let env = ProcessInfo.processInfo.environment
        if let key = env["FLOW_DEBUG_OPEN_CHANNEL"], !key.isEmpty { return }
        if env["FLOW_DEBUG_SHOW_ACTIVITY"] == "1" { return }
        if env["FLOW_DEBUG_SHOW_SCHEDULED"] == "1" { return }
        if env["FLOW_DEBUG_SHOW_DIRECTORY"] == "1" { return }
        if env["FLOW_DEBUG_SHOW_CHANNEL_BROWSER"] == "1" { return }
        #endif
        guard let id = app.window.restorableLastChannel(from: channels) else { return }
        app.selectChannel(id)
    }

    // DEBUG QA: FLOW_DEBUG_OPEN_CHANNEL=<name or channel id> auto-selects that
    // channel so the simulator can be screenshot-verified without a UI tap
    // tool. Ids are accepted too because a DM has no name — and agent
    // conversations, which is where the interrupt affordance lives, are DMs.
    private func debugAutoOpen(_ channels: [Channel]) {
        #if DEBUG
        guard app.selectedChannelId == nil, !app.showActivity, !app.showScheduled,
              !app.showDirectory, !app.showChannelBrowser,
              let key = ProcessInfo.processInfo.environment["FLOW_DEBUG_OPEN_CHANNEL"], !key.isEmpty,
              let ch = channels.first(where: {
                  ($0.name == key || $0.id == key) && $0.workspaceId == app.selectedWorkspaceId
              })
        else { return }
        app.selectChannel(ch.id)
        #endif
    }
}
