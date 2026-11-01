import SwiftUI
import GRDB

/// iOS port of the web mobile drawer (and the macOS `SidebarView`): the
/// slide-in overlay that holds the workspace rail plus the active workspace's
/// channel/DM list, layered over a dimmed conversation. Mirrors the design-3a
/// violet sidebar — a workspace-colored gradient, section headers, unread
/// badges, presence dots — and a profile/status footer pinned to the bottom.
///
/// Selecting anything (channel, DM, activity) drives `AppState` the same way
/// macOS does, then calls `onSelect` so `MainView` can close the drawer and let
/// the conversation take the full screen (matching the web's mobile behavior).
/// Just enough of the roster to answer "is this workspace down to one person?"
/// — plus the name, which the Agents section (#361) lists agents by.
struct WorkspaceRosterEntry: Decodable, FetchableRecord, Equatable, Sendable, WorkspaceRosterMember {
    var userId: String
    var displayName: String
    var isAgent: Bool?
    var isBot: Bool?
}

extension WorkspaceRosterEntry: SidebarAgentMemberInfo {}

struct SidebarDrawer: View {
    /// Called after a selection so the host can dismiss the drawer.
    var onSelect: () -> Void = {}

    @EnvironmentObject private var app: AppState
    /// Raises the workspace/server switcher owned by `RootView` (#563).
    @Environment(\.openConnections) private var openConnections
    @StateObject private var workspaces = DBObserved<[Workspace]>(initial: [])
    @StateObject private var channels = DBObserved<[Channel]>(initial: [])
    @StateObject private var users = DBObserved<[User]>(initial: [])
    /// The current workspace's roster, for the sole-human check behind Delete
    /// workspace (#340). `users` is every user we've ever cached, which is not
    /// the same question.
    @StateObject private var roster = DBObserved<[WorkspaceRosterEntry]>(initial: [])

    @State private var showCreateChannel = false
    @State private var showNewDm = false
    @State private var showAddWorkspace = false
    @State private var showInvite = false
    /// The channel whose "Invite to Channel…" sheet is open (long-press a row).
    @State private var inviteChannel: Channel?
    @State private var showFeatures = false
    @State private var confirmLeaveWorkspace = false
    @State private var confirmDeleteWorkspace = false
    /// One-shot guard so the persistent self-DM upsert fires once per workspace.
    @State private var ensuredSelfDmWs: String?
    /// Agents section collapsed? Remembered per device, like macOS and web.
    @AppStorage("flow.sidebarAgentsCollapsed") private var agentsCollapsed = false

    private var usersById: [String: User] {
        Dictionary(users.value.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }
    private var userNames: [String: String] {
        usersById.mapValues { $0.displayNameWithBadge }
    }

    private var currentWorkspace: Workspace? {
        workspaces.value.first { $0.id == app.selectedWorkspaceId }
    }
    private var palette: SidebarPalette {
        SidebarPalette.palette(for: currentWorkspace?.sidebarColor)
    }


    /// Which way out this workspace offers — see `WorkspaceExit`, which is
    /// shared with macOS and holds the "empty roster means don't know" rule.
    private var workspaceExit: WorkspaceExit {
        WorkspaceExit.offered(
            role: currentWorkspace?.role,
            roster: roster.value,
            me: app.currentUser?.id
        )
    }

    /// Joined standard channels in sidebar order — sub-channels (#118) follow
    /// their parent and render indented.
    private var standard: [(channel: Channel, isNested: Bool)] {
        Channel.nested(joinedStandard)
    }

    private var joinedStandard: [Channel] {
        let dmIds = joinedDmIds
        return channels.value.filter {
            $0.isMember && !$0.isDM && $0.archivedAt == nil
                && !($0.parentId.map(dmIds.contains) ?? false)
        }
    }

    /// Ids of the DMs I'm in — a sub-channel of one belongs to that conversation,
    /// so it renders under the DM row and never in Channels (#118).
    private var joinedDmIds: Set<String> {
        Set(channels.value.filter { $0.isMember && $0.isDM }.map(\.id))
    }

    /// Sub-channels hanging off a DM, keyed by that DM's id.
    private var dmChildren: [String: [Channel]] {
        let dmIds = joinedDmIds
        return Dictionary(
            grouping: channels.value.filter {
                $0.isMember && !$0.isDM && $0.archivedAt == nil
                    && ($0.parentId.map(dmIds.contains) ?? false)
            },
            by: { $0.parentId! }
        )
    }
    /// Agents (#361) and the DMs left over once their 1:1s move up with them.
    private var agentSplit: (agents: [AgentSection.Entry<WorkspaceRosterEntry>], rest: [Channel]) {
        AgentSection.split(
            dms: channels.value.filter { $0.isMember && $0.isDM },
            members: roster.value,
            currentUserId: app.currentUser?.id
        )
    }

    private var dms: [Channel] {
        // Direct messages sort alphabetically by display title, case-insensitive
        // (ui_nits — matches web/macOS). DM channels have a null `name`, so sort
        // by the resolved member-name title rather than the channel row order.
        // The self-DM ("<you> (you)") is a scratchpad, not a conversation — it's
        // always pinned to the bottom regardless of name.
        let me = app.currentUser?.id
        let names = userNames
        func isSelf(_ c: Channel) -> Bool {
            c.kind == "dm" && (c.memberIds ?? []).allSatisfy { $0 == me }
        }
        return agentSplit.rest
            .sorted {
                if isSelf($0) != isSelf($1) { return !isSelf($0) }
                return $0.displayTitle(userNames: names, currentUserId: me)
                    .localizedCaseInsensitiveCompare(
                        $1.displayTitle(userNames: names, currentUserId: me)
                    ) == .orderedAscending
            }
    }
    var body: some View {
        HStack(spacing: 0) {
            WorkspaceRail(
                workspaces: workspaces.value,
                palette: palette,
                onAdd: { showAddWorkspace = true }
            )
            sidebar
        }
        // Bleed the rail + gradient under the status bar and home indicator so
        // the drawer reads as one full-height panel; the columns' own content
        // stays within the safe area.
        .background(alignment: .leading) {
            HStack(spacing: 0) {
                palette.rail.frame(width: 64)
                palette.gradient
            }
            .ignoresSafeArea()
        }
        .task {
            workspaces.start(db: app.db) { db in
                try Workspace.order(Column("name").collating(.nocase)).fetchAll(db)
            }
            users.start(db: app.db) { try User.fetchAll($0) }
            reloadRoster()
            reloadChannels()
        }
        .onChange(of: app.selectedWorkspaceId) { _, _ in
            reloadRoster()
            reloadChannels()
        }
        // Default channel + persistent self-DM (macOS SidebarView parity): a
        // workspace opened with nothing selected lands on #general; every
        // workspace gets a "<Name> (you)" DM (idempotent server upsert).
        .onChange(of: channels.value) { _, chans in defaultSelectionAndSelfDm(chans) }
        .sheet(isPresented: $showCreateChannel) {
            if let wsId = app.selectedWorkspaceId {
                NewChannelSheet(workspaceId: wsId, onCreated: { open($0) })
            }
        }
        .sheet(isPresented: $showNewDm) {
            if let wsId = app.selectedWorkspaceId {
                NewDmSheet(workspaceId: wsId, onCreated: { open($0) })
            }
        }
        .sheet(isPresented: $showAddWorkspace) { AddWorkspaceSheet() }
        .sheet(isPresented: $showInvite) {
            if let wsId = app.selectedWorkspaceId {
                InviteSheet(workspaceId: wsId)
            }
        }
        .sheet(item: $inviteChannel) { InviteToChannelSheet(channel: $0) }
        .modifier(DebugOpenNewDm { showNewDm = true })
        .sheet(isPresented: $showFeatures) { FeaturesSheet() }
        // `.alert`, not `.confirmationDialog`: hung off the drawer the dialog
        // adapts to a *popover*, which drops the cancel button entirely and
        // leaves tapping outside as the only way back (#340). An alert always
        // renders both choices.
        .alert(
            "Leave \(currentWorkspace?.name ?? "workspace")?",
            isPresented: $confirmLeaveWorkspace
        ) {
            Button("Cancel", role: .cancel) {}
            Button("Leave Workspace", role: .destructive) { leaveWorkspace() }
        } message: {
            Text("Leave as \(app.currentUser?.email ?? "this account") on \(app.serverOrigin). You'll lose access to all its channels. Your past messages will remain.")
        }
        .alert(
            "Delete \(currentWorkspace?.name ?? "workspace")?",
            isPresented: $confirmDeleteWorkspace
        ) {
            Button("Cancel", role: .cancel) {}
            Button("Delete Workspace", role: .destructive) { deleteWorkspace() }
        } message: {
            Text(
                "You're the only one left, so there's nobody to hand it to. "
                    + "Deleting removes the workspace and every channel, message and file in it, "
                    + "for good. This cannot be undone."
            )
        }
    }

    // MARK: - Sidebar column

    private var sidebar: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 14)
                .padding(.top, 14)
                .padding(.bottom, 6)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    // Capability gating (#546), as on web: creating and browsing
                    // conversations, agents, scheduling and admin are hidden
                    // where the connection cannot do them.
                    sectionHeader("Channels") {
                        addButton(id: "channel.create", label: "New channel") {
                            showCreateChannel = true
                        }
                        .hiddenUnless(.channelManagement, in: app.capabilities)
                    }
                    ForEach(standard, id: \.channel.id) { channelRow($0.channel, isNested: $0.isNested) }
                    // Channel browser (#590): one nav row at the end of
                    // Channels replaces the inline Browse list, as on web.
                    if app.can(.channelManagement) {
                        browseAllRow
                    }

                    // Agents (#361): one row per workspace agent, between
                    // Channels and Direct Messages, whether or not a DM exists
                    // yet. An agent with a DM brings it up here, so it is never
                    // listed twice.
                    let agents = agentSplit.agents
                    if !agents.isEmpty, app.can(.agents) {
                        sectionHeader("Agents", collapsed: agentsCollapsed) {
                            agentsCollapsed.toggle()
                        } action: {
                            EmptyView()
                        }
                        if !agentsCollapsed {
                            ForEach(agents) { entry in
                                if let dm = entry.channel {
                                    dmRow(dm, label: entry.member.displayName)
                                    ForEach(dmChildren[dm.id] ?? []) { channelRow($0, isNested: true) }
                                } else {
                                    agentRow(entry.member)
                                }
                            }
                        }
                    }

                    // The header renders whether or not there are DMs yet: its
                    // "+" is the only way in to a first conversation (#257), so
                    // it must not be the thing that disappears when the list is
                    // empty. Channels behaves the same way.
                    sectionHeader("Direct Messages") {
                        addButton(id: "dm.create", label: "New direct message") {
                            showNewDm = true
                        }
                        .hiddenUnless(.channelManagement, in: app.capabilities)
                    }
                    // Directory (#432): a nav entry, not a DM row — it
                    // highlights when active and opens the member grid rather
                    // than a conversation. Directly under the header, as on
                    // web and macOS.
                    directoryRow
                    ForEach(dms) { dm in
                        dmRow(dm)
                        ForEach(dmChildren[dm.id] ?? []) { channelRow($0, isNested: true) }
                    }
                    if joinedStandard.isEmpty && agentSplit.rest.isEmpty && agents.isEmpty {
                        Text("No channels yet")
                            .font(.system(size: 14))
                            .foregroundStyle(.white.opacity(0.6))
                            .padding(.horizontal, 8)
                            .padding(.top, 8)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 10)
            }

            DrawerStatusFooter(palette: palette)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(palette.gradient)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 6) {
            workspaceMenu
            scheduledClock
                .hiddenUnless(.scheduledMessages, in: app.capabilities)
            activityBell
                .hiddenUnless(.notifications, in: app.capabilities)
        }
    }

    private var workspaceMenu: some View {
        Menu {
            ForEach(workspaces.value) { ws in
                // The switcher spells the count out (#345): the rail badge is a
                // 10pt number on a 40pt icon, and this menu is the accessible
                // way to the same information.
                let title = unreadBadgeLabel(ws.unreadCount).map { "\(ws.name) (\($0))" } ?? ws.name
                Button {
                    app.selectWorkspace(ws.id)
                } label: {
                    if ws.id == app.selectedWorkspaceId {
                        Label(title, systemImage: "checkmark")
                    } else {
                        Text(title)
                    }
                }
            }
            Divider()
            // Workspaces & servers (#563). Workspace-level navigation lives at
            // the top of the sidebar — the Slack/Discord idiom — not in the
            // composer's "+", which is for composing; #561 parked it there and
            // it came straight back out.
            Button { openConnections() } label: {
                Label("Workspaces & servers…", systemImage: "server.rack")
            }
            .accessibilityIdentifier("sidebar.connections")
            // Invite People (web + macOS parity, #283). Disabled with no
            // workspace selected — there'd be nothing to invite anyone to.
            Button("Invite People…") { showInvite = true }
                .disabled(app.selectedWorkspaceId == nil)
                .accessibilityIdentifier("sidebar.invitePeople")
                .hiddenUnless(.channelManagement, in: app.capabilities)
            // Directory (#432), directly under Invite People… as on web + macOS.
            Button("Directory") {
                app.showDirectoryPanel()
                onSelect()
            }
            .disabled(app.selectedWorkspaceId == nil)
            .accessibilityIdentifier("sidebar.directoryMenuItem")
            Button("Add Workspace…") { showAddWorkspace = true }
                .hiddenUnless(.channelManagement, in: app.capabilities)
            if currentWorkspace != nil, app.can(.channelManagement) {
                switch workspaceExit {
                case .delete:
                    Button("Delete Workspace…", role: .destructive) { confirmDeleteWorkspace = true }
                        .accessibilityIdentifier("sidebar.deleteWorkspace")
                case .leave, .transferFirst:
                    // Destructive, and disabled for the owner with the reason in
                    // the label — a menu item has nowhere else to put a hint
                    // (web + macOS parity, #340).
                    let blocked = workspaceExit == .transferFirst
                    Button(
                        blocked ? "Leave Workspace — transfer ownership first" : "Leave Workspace…",
                        role: .destructive
                    ) { confirmLeaveWorkspace = true }
                        .disabled(blocked)
                        .accessibilityIdentifier("sidebar.leaveWorkspace")
                }
            }
            Divider()
            // Version tag + release notes (web + macOS parity: macOS hangs the
            // sheet off the version label at the foot of this same menu).
            Button { showFeatures = true } label: {
                Text("What's new")
                Text(BuildInfo.label)
                Image(systemName: "sparkles")
            }
            .accessibilityIdentifier("sidebar.buildNumber")
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(currentWorkspace?.name ?? "Flow")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    // Which server this workspace is on — a phone can hold
                    // several now (#542), and this row is the way to the rest
                    // of them (#563).
                    SidebarServerLabel(connections: app.connections, connectionId: app.connectionId)
                }
                Image(systemName: "chevron.down")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.55))
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .accessibilityIdentifier("sidebar.workspaceMenu")
    }

    /// A section title, optionally a collapse toggle (#361): pass `collapsed`
    /// and `onToggle` and the label becomes a button with a disclosure chevron.
    private func sectionHeader(
        _ label: String,
        collapsed: Bool? = nil,
        onToggle: (() -> Void)? = nil,
        @ViewBuilder action: () -> some View
    ) -> some View {
        HStack {
            if let collapsed, let onToggle {
                Button(action: onToggle) {
                    HStack(spacing: 3) {
                        Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                        Text(label.uppercased())
                            .font(.system(size: 11, weight: .semibold))
                            .tracking(0.7)
                    }
                    .foregroundStyle(.white.opacity(0.55))
                    // A tap target the size of the header strip, not of the text.
                    .frame(height: 28)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("sidebar.section.\(label.lowercased())")
                .accessibilityValue(collapsed ? "collapsed" : "expanded")
            } else {
                Text(label.uppercased())
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(0.7)
                    .foregroundStyle(.white.opacity(0.55))
            }
            Spacer()
            action()
        }
        .padding(.horizontal, 8)
        .padding(.top, 14)
        .padding(.bottom, 3)
    }

    /// The "+" that hangs off a section header. One helper so Channels and
    /// Direct Messages can't drift apart in weight or tap target.
    private func addButton(id: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white.opacity(0.6))
                .frame(width: 28, height: 28)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
        .accessibilityLabel(label)
    }

    // MARK: - Rows

    private func rowBackground(_ active: Bool) -> some View {
        RoundedRectangle(cornerRadius: 8).fill(active ? Color.white : Color.clear)
    }

    /// The channel's own emoji (#396), drawn after its name. On macOS this slot
    /// is shared with the activity spinner (#137) and needs a precedence rule;
    /// iOS draws no spinner, so the emoji is its only tenant and simply shows
    /// whenever the column is set. Read straight off the cached `Channel` row,
    /// which is what makes it survive a relaunch.
    @ViewBuilder
    private func channelEmoji(_ channel: Channel) -> some View {
        if let emoji = channel.emoji, !emoji.isEmpty {
            Text(emoji)
                .font(.system(size: 14))
                .accessibilityHidden(true)
        }
    }

    /// The Activity feed's bell (#385) — fixed in the drawer header rather than
    /// sitting at the top of the channel list, so it can never scroll out of
    /// view and the list holds only real channels. Carries the notification
    /// unread badge and highlights while the feed is the open view.
    private var activityBell: some View {
        let active = app.showActivity
        let unread = app.notificationUnread
        return Button {
            app.showActivityFeed()
            onSelect()
        } label: {
            Image(systemName: "bell")
                .font(.system(size: 16))
                .foregroundStyle(active ? MC.accentDeep.opacity(0.75) : .white.opacity(0.7))
                .frame(width: 30, height: 28)
                .background(rowBackground(active))
                .overlay(alignment: .topTrailing) {
                    if unread > 0 {
                        unreadBadge(min(unread, 99))
                            .offset(x: 6, y: -6)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Activity")
        .accessibilityIdentifier("sidebar.activity")
        .accessibilityValue(unread > 0 ? "\(unread) unread" : "read")
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    /// The Scheduled list's entry point (#424) — a clock beside the Activity
    /// bell, since both open a workspace-wide view rather than a channel. No
    /// badge: a scheduled message that fired is already a message in a
    /// conversation, and that is where it should be noticed.
    private var scheduledClock: some View {
        let active = app.showScheduled
        return Button {
            app.showScheduledPanel()
            onSelect()
        } label: {
            Image(systemName: "clock")
                .font(.system(size: 16))
                .foregroundStyle(active ? MC.accentDeep.opacity(0.75) : .white.opacity(0.7))
                .frame(width: 30, height: 28)
                .background(rowBackground(active))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Scheduled messages")
        .accessibilityIdentifier("sidebar.scheduled")
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    private func channelRow(_ channel: Channel, isNested: Bool = false) -> some View {
        let active = app.selectedChannelId == channel.id && !app.showActivity && !app.showScheduled
            && !app.showDirectory && !app.showChannelBrowser
        return Button {
            open(channel)
        } label: {
            HStack(spacing: 9) {
                Group {
                    if channel.isPrivate {
                        Image(systemName: "lock")
                    } else {
                        Text("#")
                    }
                }
                .font(.system(size: 15))
                .foregroundStyle(active ? MC.accentDeep.opacity(0.6) : .white.opacity(0.6))
                .frame(width: 18)
                Text(channel.name ?? "")
                    .font(.system(size: 15, weight: active || channel.unreadCount > 0 ? .semibold : .regular))
                    .foregroundStyle(active ? MC.accentDeep : .white.opacity(channel.unreadCount > 0 ? 1 : 0.82))
                    .lineLimit(1)
                channelEmoji(channel)
                if channel.notifyLevel == 0 {
                    Image(systemName: "bell.slash")
                        .font(.caption2)
                        .foregroundStyle(active ? MC.accentDeep.opacity(0.5) : .white.opacity(0.5))
                }
                Spacer(minLength: 0)
                // A number means "this needs you" — unread notifications, not
                // unread messages (operator ruling 2026-07-26).
                if channel.unreadNotifications > 0 { unreadBadge(channel.unreadNotifications) }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 9)
            .background(rowBackground(active))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Long-press: the channel context actions web + macOS hang off a
        // right-click. Only "invite" so far — see the CHANGELOG Parity note.
        .contextMenu {
            Button {
                inviteChannel = channel
            } label: {
                Label("Invite to Channel…", systemImage: "person.badge.plus")
            }
            .accessibilityIdentifier("sidebar.channel.invite")
            .hiddenUnless(.channelManagement, in: app.capabilities)
        }
        // Indent outside the background, so the pill insets with the row.
        .padding(.leading, isNested ? 12 : 0)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sidebar.channel.\(channel.name ?? channel.id)")
        .accessibilityValue(
            channel.unreadNotifications > 0 ? "\(channel.unreadNotifications) notifications"
            : channel.unreadCount > 0 ? "unread" : "read"
        )
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    /// `label` overrides the resolved DM title — the Agents section (#361)
    /// passes the agent's plain name, since a 🤖 badge under a header that
    /// already says AGENTS is noise.
    private func dmRow(_ channel: Channel, label: String? = nil) -> some View {
        let title = label
            ?? channel.displayTitle(userNames: userNames, currentUserId: app.currentUser?.id)
        let active = app.selectedChannelId == channel.id && !app.showActivity && !app.showScheduled
            && !app.showDirectory && !app.showChannelBrowser
        let otherId = (channel.memberIds ?? []).first { $0 != app.currentUser?.id }
        let otherStatus = otherId.flatMap { usersById[$0] }
        return Button {
            open(channel)
        } label: {
            HStack(spacing: 9) {
                if channel.kind == "dm", app.can(.presence) {
                    // self-DM (no other member): online by definition
                    presenceDot(online: otherId.map { app.isOnline($0, in: app.selectedWorkspaceId) } ?? true)
                        .frame(width: 18)
                } else if channel.kind == "dm" {
                    // No presence from this provider (#546): a person glyph,
                    // never a dot that would read as "offline".
                    Image(systemName: "person")
                        .font(.caption)
                        .foregroundStyle(active ? MC.accentDeep.opacity(0.6) : .white.opacity(0.6))
                        .frame(width: 18)
                } else {
                    Image(systemName: "person.2")
                        .font(.caption)
                        .foregroundStyle(active ? MC.accentDeep.opacity(0.6) : .white.opacity(0.6))
                        .frame(width: 18)
                }
                Text(title)
                    .font(.system(size: 15, weight: active || channel.unreadCount > 0 ? .semibold : .regular))
                    .foregroundStyle(active ? MC.accentDeep : .white.opacity(channel.unreadCount > 0 ? 1 : 0.82))
                    .lineLimit(1)
                if channel.kind == "dm", let emoji = otherStatus?.statusEmoji, !emoji.isEmpty {
                    Text(emoji).font(.system(size: 15))
                }
                channelEmoji(channel)
                if channel.notifyLevel == 0 {
                    Image(systemName: "bell.slash")
                        .font(.caption2)
                        .foregroundStyle(active ? MC.accentDeep.opacity(0.5) : .white.opacity(0.5))
                }
                Spacer(minLength: 0)
                // A number means "this needs you" — unread notifications, not
                // unread messages (operator ruling 2026-07-26).
                if channel.unreadNotifications > 0 { unreadBadge(channel.unreadNotifications) }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 9)
            .background(rowBackground(active))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sidebar.dm.\(title.replacingOccurrences(of: " 🤖", with: ""))")
        .accessibilityValue(
            channel.unreadNotifications > 0 ? "\(channel.unreadNotifications) notifications"
            : channel.unreadCount > 0 ? "unread" : "read"
        )
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    /// The Directory entry under the Direct Messages header (#432) — the same
    /// nav-item shape as a channel row, minus everything that belongs to a
    /// conversation (unread badge, long-press menu). Selecting it closes the
    /// drawer, like any other selection.
    private var directoryRow: some View {
        let active = app.showDirectory
        return Button {
            app.showDirectoryPanel()
            onSelect()
        } label: {
            HStack(spacing: 9) {
                Text("👥")
                    .font(.system(size: 15))
                    .opacity(active ? 0.7 : 0.6)
                    .frame(width: 18)
                Text("Directory")
                    .font(.system(size: 15, weight: active ? .semibold : .regular))
                    .foregroundStyle(active ? MC.accentDeep : .white.opacity(0.82))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 9)
            .background(rowBackground(active))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sidebar.directory")
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    /// An agent with no DM yet (#361) — tapping creates one and opens it. Same
    /// shape as a DM row minus the unread badge, which needs a channel to count.
    private func agentRow(_ member: WorkspaceRosterEntry) -> some View {
        let online = app.isOnline(member.userId, in: app.selectedWorkspaceId)
        let status = usersById[member.userId]
        return Button {
            guard let wsId = app.selectedWorkspaceId else { return }
            Task {
                if let dm = try? await app.engine.createDm(workspaceId: wsId, userIds: [member.userId]) {
                    open(dm.id)
                }
            }
        } label: {
            HStack(spacing: 9) {
                presenceDot(online: online)
                    .frame(width: 18)
                Text(member.displayName)
                    .font(.system(size: 15))
                    .foregroundStyle(.white.opacity(0.82))
                    .lineLimit(1)
                if let emoji = status?.statusEmoji, !emoji.isEmpty {
                    Text(emoji).font(.system(size: 15))
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        // Same id shape as a real DM row, so an agent is targetable by name
        // whether or not the conversation exists yet.
        .accessibilityIdentifier("sidebar.dm.\(member.displayName)")
        .accessibilityValue(online ? "online" : "offline")
    }

    /// "Browse all" at the end of Channels (#590) — opens the channel browser.
    /// Muted, so it reads as a nav affordance rather than a channel. Selecting
    /// it closes the drawer, like any other selection.
    private var browseAllRow: some View {
        let active = app.showChannelBrowser
        return Button {
            app.showChannelBrowserPanel()
            onSelect()
        } label: {
            HStack(spacing: 9) {
                Text("⋯")
                    .font(.system(size: 15))
                    .foregroundStyle(active ? MC.accentDeep.opacity(0.7) : .white.opacity(0.5))
                    .frame(width: 18)
                Text("Browse all")
                    .font(.system(size: 15, weight: active ? .semibold : .regular))
                    .foregroundStyle(active ? MC.accentDeep : .white.opacity(0.6))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 9)
            .background(rowBackground(active))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sidebar.browseAll")
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    private func presenceDot(online: Bool) -> some View {
        Circle()
            .fill(online ? MC.online : Color.clear)
            .overlay(Circle().strokeBorder(online ? Color.clear : .white.opacity(0.4), lineWidth: 1.5))
            .frame(width: 8, height: 8)
    }

    private func unreadBadge(_ n: Int) -> some View {
        Text("\(n)")
            .font(.system(size: 11, weight: .bold))
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(Capsule().fill(MC.unread))
            .foregroundStyle(.white)
    }

    // MARK: - Actions

    /// Select a channel and dismiss the drawer (the web mobile behavior).
    private func open(_ channelId: String) {
        app.selectChannel(channelId)
        onSelect()
    }

    /// Tapping a row in the list: same thing, except that a channel whose
    /// oldest unread is a thread reply opens on that reply inside its thread
    /// (#441). The id-only version above is for channels we just created or
    /// joined, which have nothing unread to jump to.
    private func open(_ channel: Channel) {
        app.openChannelFromSidebar(channel)
        onSelect()
    }

    /// Confirmed departure (#340): the engine leaves, clears the local mirror
    /// and reports where to land; `workspaceBecameUnavailable` moves the
    /// window. Closing the drawer afterwards puts the new workspace on screen.
    private func leaveWorkspace() {
        guard let ws = currentWorkspace else { return }
        Task {
            do {
                let next = try await app.engine.leaveWorkspace(ws.id)
                app.workspaceBecameUnavailable(ws.id, landOn: next)
                onSelect()
            } catch {
                app.showError(error.localizedDescription)
            }
        }
    }

    /// Confirmed deletion (#340 follow-up). Same landing as leaving — the
    /// workspace is gone for us either way.
    private func deleteWorkspace() {
        guard let ws = currentWorkspace else { return }
        Task {
            do {
                let next = try await app.engine.deleteWorkspace(ws.id)
                app.workspaceBecameUnavailable(ws.id, landOn: next)
                onSelect()
            } catch {
                app.showError(error.localizedDescription)
            }
        }
    }

    private func reloadRoster() {
        guard let wsId = app.selectedWorkspaceId else { return }
        // Fetch the roster directly rather than waiting for `selectWorkspace`'s
        // channels → members → artifacts chain to reach it. The workspace menu
        // decides between Leave and Delete from this list, and a SwiftUI `Menu`
        // snapshots its contents when it opens — so a roster that arrives late
        // doesn't correct an already-open menu, it just makes the next one
        // right (#340 follow-up).
        Task { await app.engine.refreshMembers(workspaceId: wsId) }
        roster.start(db: app.db, reset: []) { db in
            try WorkspaceRosterEntry.fetchAll(
                db,
                sql: """
                    SELECT m.userId AS userId, u.displayName AS displayName,
                           u.isAgent AS isAgent, u.isBot AS isBot
                    FROM member m JOIN user u ON u.id = m.userId
                    WHERE m.workspaceId = ?
                    """,
                arguments: [wsId]
            )
        }
    }

    private func reloadChannels() {
        guard let wsId = app.selectedWorkspaceId else { return }
        // Non-member rows are kept too — they're what Browse shows.
        channels.start(db: app.db, reset: []) { db in
            try Channel
                .filter(Column("workspaceId") == wsId)
                .order(Column("name").collating(.nocase))
                .fetchAll(db)
        }
    }

    private func defaultSelectionAndSelfDm(_ chans: [Channel]) {
        guard let wsId = app.selectedWorkspaceId, !chans.isEmpty else { return }
        if app.selectedChannelId == nil && !app.showActivity && !app.showScheduled
            && !app.showDirectory && !app.showChannelBrowser {
            let target = chans.first { $0.isMember && $0.name == "general" }
                ?? chans.first { $0.isMember && !$0.isDM }
            if let target { app.selectChannel(target.id) }
        }
        if let me = app.currentUser?.id, ensuredSelfDmWs != wsId {
            ensuredSelfDmWs = wsId
            let hasSelfDm = chans.contains {
                $0.kind == "dm" && $0.isMember && ($0.memberIds ?? []).allSatisfy { $0 == me }
            }
            if !hasSelfDm {
                Task { _ = try? await app.engine.createDm(workspaceId: wsId, userIds: [me]) }
            }
        }
    }
}

/// The server line under the sidebar's workspace name (#563). Observes the
/// connection manager rather than reading it once, so a label the switcher
/// sheet changes — a rename, a discovery that canonicalizes the origin —
/// shows up behind the sheet instead of at the next drawer open.
private struct SidebarServerLabel: View {
    @ObservedObject var connections: ConnectionManager
    let connectionId: String

    var body: some View {
        Text(
            connections.registry.connections
                .first { $0.connectionId == connectionId }?.displayLabel ?? Server.displayName
        )
        .font(.system(size: 11))
        .foregroundStyle(.white.opacity(0.55))
        .lineLimit(1)
        .accessibilityIdentifier("sidebar.serverLabel")
    }
}

/// The 64px workspace rail (web/macOS design column 1): the active workspace's
/// siblings as initial chips, plus a "+" that offers create/accept-invite.
/// The workspace identity mark: its avatar image when one is set (#336),
/// otherwise the initial on a color chip. Display-only on iOS — the avatar is
/// managed from web/macOS. Active is a white fill for the initial mark and a
/// white ring for an avatar, since an image can't be tinted.
private struct WorkspaceMark: View {
    let workspace: Workspace
    let size: CGFloat
    var cornerRadius: CGFloat = 12
    var active: Bool = true

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius)
        Group {
            if let path = workspace.avatarImagePath {
                AuthImage(path: path) { shape.fill(Color.white.opacity(0.15)) }
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(shape)
                    .opacity(active ? 1 : 0.7)
                    .overlay(active ? shape.strokeBorder(Color.white, lineWidth: 2) : nil)
            } else {
                shape
                    .fill(active ? Color.white : Color.white.opacity(0.15))
                    .frame(width: size, height: size)
                    .overlay(
                        Text(String(workspace.name.prefix(1)).uppercased())
                            .font(.system(size: size * 0.4, weight: .heavy))
                            .foregroundStyle(active ? MC.accent : .white)
                    )
            }
        }
    }
}

private struct WorkspaceRail: View {
    let workspaces: [Workspace]
    let palette: SidebarPalette
    let onAdd: () -> Void

    @EnvironmentObject private var app: AppState

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 14) {
                ForEach(workspaces) { ws in
                    let active = ws.id == app.selectedWorkspaceId
                    Button {
                        if !active { app.selectWorkspace(ws.id) }
                    } label: {
                        WorkspaceMark(workspace: ws, size: 40, cornerRadius: 12, active: active)
                            // Unread across this workspace's channels (#345) —
                            // the overlay sits outside the mark's clip shape,
                            // so it can overhang the corner as designed.
                            .overlay(alignment: .topTrailing) {
                                WorkspaceUnreadBadge(count: ws.unreadCount, ringColor: palette.rail)
                                    .offset(x: 7, y: -7)
                                    .accessibilityIdentifier("rail.unread.\(ws.slug)")
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("rail.workspace.\(ws.slug)")
                    .accessibilityLabel(ws.name)
                    .accessibilityValue((ws.unreadCount ?? 0) > 0 ? "\(ws.unreadCount!) unread" : "read")
                    .accessibilityAddTraits(active ? [.isSelected] : [])
                }
                Button(action: onAdd) {
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4]))
                        .foregroundStyle(.white.opacity(0.4))
                        .frame(width: 40, height: 40)
                        .overlay(
                            Image(systemName: "plus")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(.white.opacity(0.7))
                        )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("rail.addWorkspace")
                .accessibilityLabel("Add a workspace")
            }
            .padding(.vertical, 16)
            // The scroll content is clipped to its own width, and the unread
            // badge (#345) overhangs its icon — without this the content sizes
            // to the 40pt marks and the badge loses its right-hand edge.
            .frame(maxWidth: .infinity)
        }
        .frame(width: 64)
        .frame(maxHeight: .infinity)
        .background(palette.rail)
    }
}

/// Profile/status footer pinned to the drawer bottom (macOS `StatusFooterView`
/// parity). Reuses the existing `AccountSheet` for the status picker, profile,
/// and sign-out — tapping anywhere in the footer opens it.
private struct DrawerStatusFooter: View {
    let palette: SidebarPalette
    @EnvironmentObject private var app: AppState
    @State private var showAccount = false

    private var statusEmoji: String { app.currentUser?.statusEmoji ?? "" }
    private var statusText: String { app.currentUser?.statusText ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(.white.opacity(0.14)).frame(height: 1)
            Button {
                showAccount = true
            } label: {
                HStack(spacing: 10) {
                    AvatarChip(
                        userId: app.currentUser?.id ?? "",
                        name: app.currentUser?.displayName ?? "?",
                        avatarPath: app.myAvatarPath,
                        size: 34,
                        radius: 10
                    )
                    .overlay(alignment: .bottomTrailing) {
                        if !statusEmoji.isEmpty {
                            Text(statusEmoji)
                                .font(.system(size: 11))
                                .frame(width: 20, height: 20)
                                .background(Circle().fill(palette.rail))
                                .overlay(Circle().strokeBorder(palette.bottom, lineWidth: 2))
                                .offset(x: 6, y: 6)
                        }
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 5) {
                            Text(app.currentUser?.displayName ?? "You")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                            Circle()
                                .fill(app.connection == .connected ? MC.online : .orange)
                                .frame(width: 6, height: 6)
                        }
                        Text(statusText.isEmpty ? "Set a status" : statusText)
                            .font(.system(size: 12))
                            .foregroundStyle(.white.opacity(0.7))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.55))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("sidebar.statusFooter")
        }
        .sheet(isPresented: $showAccount) { AccountSheet() }
        // QA: FLOW_DEBUG_OPEN_PROFILE=1 opens the account sheet on launch; the
        // sheet then pushes My Profile itself. FLOW_DEBUG_OPEN_NOTIFICATIONS=1
        // (#251) does the same for the notification prefs.
        .onAppear {
            let env = ProcessInfo.processInfo.environment
            if env["FLOW_DEBUG_OPEN_PROFILE"] == "1" || env["FLOW_DEBUG_OPEN_NOTIFICATIONS"] == "1" {
                showAccount = true
            }
        }
    }
}

/// iOS workspace onboarding sheet: create a new workspace, or join one by
/// pasting an invite link/token. The macOS clients split these into two sheets;
/// on a phone they share one form reached from the rail's "+".
struct AddWorkspaceSheet: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var slug = ""
    @State private var inviteToken = ""
    @State private var busy = false
    @State private var error: String?

    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }
    private var trimmedToken: String { inviteToken.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section("Join with an invite") {
                    TextField("flow://invite/… or token", text: $inviteToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("addWorkspace.inviteToken")
                    Button("Accept Invite") {
                        app.acceptInvite(trimmedToken)
                        dismiss()
                    }
                    .disabled(trimmedToken.isEmpty)
                    .accessibilityIdentifier("addWorkspace.accept")
                }

                Section("Create a workspace") {
                    TextField("Name (e.g. Acme Inc)", text: $name)
                        .accessibilityIdentifier("addWorkspace.name")
                        .onChange(of: name) { _, new in slug = Self.slugify(new) }
                    TextField("Slug (url-safe)", text: $slug)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("addWorkspace.slug")
                    Button("Create Workspace") { create() }
                        .disabled(busy || trimmedName.isEmpty || slug.isEmpty)
                        .accessibilityIdentifier("addWorkspace.create")
                }

                if let error {
                    Section { Text(error).font(.callout).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Add Workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func create() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let ws = try await app.engine.createWorkspace(name: trimmedName, slug: slug)
                dismiss()
                app.selectWorkspace(ws.id)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// Mirror of macOS `CreateWorkspaceSheet.slugify`.
    static func slugify(_ s: String) -> String {
        s.lowercased()
            .map { $0.isLetter || $0.isNumber ? String($0) : "-" }
            .joined()
            .replacingOccurrences(of: "-+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}

/// Create-channel form, the iOS counterpart of macOS's `CreateChannelSheet`.
/// Name normalization matches it exactly (lowercased, spaces to dashes) so the
/// two clients can't produce differently-shaped names.
struct NewChannelSheet: View {
    let workspaceId: String
    let onCreated: (String) -> Void

    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var topic = ""
    @State private var isPrivate = false
    @State private var busy = false
    @State private var error: String?

    private var normalized: String {
        name.trimmingCharacters(in: .whitespaces)
            .lowercased()
            .replacingOccurrences(of: " ", with: "-")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("general", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("newChannel.name")
                    if !normalized.isEmpty, normalized != name {
                        Text("Will be created as #\(normalized)")
                            .font(.caption)
                            .foregroundStyle(MC.faint)
                    }
                }
                Section("Topic") {
                    TextField("Optional", text: $topic)
                        .accessibilityIdentifier("newChannel.topic")
                }
                Section {
                    Toggle("Private channel", isOn: $isPrivate)
                        .accessibilityIdentifier("newChannel.private")
                } footer: {
                    Text("Private channels are visible only to people who are invited.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("New Channel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Create") { create() }
                        .disabled(busy || normalized.isEmpty)
                        .accessibilityIdentifier("newChannel.create")
                }
            }
        }
    }

    private func create() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let ch = try await app.engine.createChannel(
                    workspaceId: workspaceId,
                    name: normalized,
                    topic: topic.isEmpty ? nil : topic,
                    isPrivate: isPrivate
                )
                dismiss()
                onCreated(ch.id)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
