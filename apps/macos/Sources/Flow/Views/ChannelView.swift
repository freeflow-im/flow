import GRDB
import SwiftUI

struct ChannelView: View {
    let channelId: String
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var win: WindowState

    @StateObject private var channel = DBObserved<Channel?>(initial: nil)
    @StateObject private var messages = DBObserved<[Message]>(initial: [])
    @StateObject private var pinnedMessages = DBObserved<[Message]>(initial: [])
    @StateObject private var currentRole = DBObserved<String?>(initial: nil)
    /// One roster observer for the whole header + list: names, status and the
    /// agent flag all come off the same User records (#70 needs status *text*,
    /// which the old name/emoji maps dropped).
    @StateObject private var users = DBObserved<[String: User]>(initial: [:])
    @State private var editingMessage: Message?
    @State private var profileUserId: String?
    @State private var showChannelEdit = false
    /// This channel's real membership (#70) — fetched, since the DTO only
    /// carries memberIds for DMs. Tagged with the channel it was fetched for,
    /// so a switch shows this channel's members (or none) rather than the
    /// previous channel's while the request is in flight (#447).
    @State private var loadedMembers: LoadedMembers?
    @State private var showMembers = false
    @State private var showPins = false
    /// Inline find (#518). A `StateObject` rather than plain `@State` so the
    /// Edit ▸ Find menu item can reach it through `focusedSceneValue`.
    @StateObject private var find = ChatFindModel()
    /// Rendered-body match texts, cached per message so a keystroke re-matches
    /// strings instead of re-parsing every body's markdown.
    @State private var findIndex = ChatSearchIndex()
    /// How many of the newest cached messages the transcript shows. A hot
    /// channel accumulates thousands of rows in SQLite, and rendering them
    /// all is both slow and — worse — pushes the list onto the LazyVStack
    /// path, whose row-height estimates are the root of every parked/blank
    /// open and misplaced restore. One window's worth keeps every ordinary
    /// open on the exact, eager path; "Load earlier" widens it.
    /// Tagged with its channel for the same reason as `loadedMembers`: on the
    /// first frame after a switch the window is this channel's, not the width
    /// "Load earlier" left behind in the one before it.
    @State private var window = LoadedWindow(channelId: "", count: ChannelView.windowStep)
    private var transcriptWindow: Int {
        window.channelId == channelId ? window.count : Self.windowStep
    }
    private func widenWindow() {
        window = LoadedWindow(channelId: channelId, count: transcriptWindow + Self.windowStep)
    }

    static let windowStep = 100

    /// The observed queries, as builders, so the frame-one read in
    /// `DBObserved.value(for:)` and the observation `.task` starts afterwards
    /// run the same query. Everything this view renders goes through the
    /// accessors below rather than `observer.value`, which is what makes a
    /// channel switch atomic: the pane never draws a frame from the channel
    /// the sidebar just left (#447).
    private static func channelQuery(_ channelId: String) -> @Sendable (Database) throws -> Channel? {
        { try Channel.fetchOne($0, key: channelId) }
    }

    private static func messagesQuery(_ key: TranscriptKey) -> @Sendable (Database) throws -> [Message] {
        { db in
            try Array(
                Message
                    .filter(Column("channelId") == key.channelId && Column("threadRootId") == nil)
                    .order(Column("id").desc)
                    .limit(key.limit)
                    .fetchAll(db)
                    .reversed()
            )
        }
    }

    private static func pinnedQuery(_ channelId: String) -> @Sendable (Database) throws -> [Message] {
        { db in
            try Message
                .filter(Column("channelId") == channelId && Column("pinnedAt") != nil)
                .order(Column("pinnedAt").desc)
                .fetchAll(db)
        }
    }

    /// Widening the window is as much a re-key as switching channel — both
    /// change which rows the transcript should be showing.
    private var transcriptKey: TranscriptKey {
        TranscriptKey(channelId: channelId, limit: transcriptWindow + 1)
    }

    private var currentChannel: Channel? {
        channel.value(for: channelId, db: app.db, fallback: nil, Self.channelQuery(channelId))
            // An archived channel opened from the channel browser (#590) is
            // never cached — it resolves from the browser's in-memory list.
            ?? app.archivedChannels[channelId]
    }

    /// Archived (#590): full history, read-only — banner, no composer, and the
    /// transcript's write actions gated off through its capabilities.
    private var isArchived: Bool { currentChannel?.archivedAt != nil }

    private var currentMessages: [Message] {
        messages.value(
            for: transcriptKey, db: app.db, fallback: [], Self.messagesQuery(transcriptKey)
        )
    }

    private var currentPinned: [Message] {
        pinnedMessages.value(for: channelId, db: app.db, fallback: [], Self.pinnedQuery(channelId))
    }

    /// This channel's membership: the fetched list once it has landed, the
    /// DTO's DM-only ids until then.
    private var channelMemberIds: [String] {
        if let loadedMembers, loadedMembers.channelId == channelId { return loadedMembers.ids }
        return []
    }

    /// The fetch grabs one row beyond the window, so "is there more in the
    /// cache" needs no second query.
    private var hasMoreCached: Bool { currentMessages.count > transcriptWindow }
    private var transcript: [Message] {
        let msgs = currentMessages
        return msgs.count > transcriptWindow ? Array(msgs.dropFirst()) : msgs
    }

    /// Every match in the loaded transcript, top to bottom — the list the find
    /// bar's cursor indexes into. Nothing here reads the network or the
    /// database: what is on screen is what is searchable (#518).
    private var findMatches: [ChatSearch.Match] {
        guard find.isOpen, !find.query.isEmpty else { return [] }
        return findIndex.matches(in: transcript, names: userNames, query: find.query)
    }

    /// The current match, if there is one — the row to scroll to, and the
    /// occurrence inside it to paint in the stronger colour.
    private var findCursor: ChatSearch.Match? {
        let matches = findMatches
        guard find.index >= 0, find.index < matches.count else { return nil }
        return matches[find.index]
    }

    /// Move the cursor and let `MessageListView` do the scrolling. Enter with
    /// nothing found leaves everything alone, deliberately.
    private func stepFind(_ direction: Int) {
        find.index = ChatSearch.step(
            current: find.index, total: findMatches.count, direction: direction
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            // #518: the find bar sits under the header and above the
            // transcript, pushing the list down rather than floating over the
            // newest message.
            if find.isOpen {
                FindBarView(find: find, total: findMatches.count, onStep: stepFind)
            }
            SyncBar(syncing: app.isSyncing)
            if isArchived {
                Text(ChannelBrowser.archivedBanner(archivedAt: currentChannel?.archivedAt))
                    .flowFont(.caption)
                    .foregroundStyle(Color.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 6)
                    .background(Color.orange.opacity(0.08))
                    .accessibilityIdentifier("channel.archivedBanner")
            }
            MessageListView(
                messages: transcript,
                userNames: userNames,
                userStatuses: userStatuses,
                currentUserId: app.currentUser?.id,
                canPermanentlyDelete: currentRole.value == "owner" || currentRole.value == "admin",
                context: TranscriptContext(
                    engine: app.engine,
                    avatarPaths: app.avatarPaths,
                    agentIds: app.agentIds,
                    onError: { app.showError($0) },
                    onSelectArtifact: { win.selectArtifact($0) },
                    onOpenScheduled: { win.showScheduledPanel() },
                    capabilities: isArchived ? app.capabilities.archivedReadOnly() : app.capabilities
                ),
                hasMore: hasMoreCached || (app.hasMore[channelId] ?? false),
                isLoadingHistory: app.loadingHistory.contains(channelId),
                showThreadAffordances: true,
                unreadThreadRootIds: Set(currentChannel?.unreadThreadRootIds ?? []),
                onLoadOlder: {
                    // Widen the window first (instant, from cache); go to the
                    // server only once the cache is exhausted.
                    let cacheHadMore = hasMoreCached
                    widenWindow()
                    if !cacheHadMore {
                        Task { await app.engine.loadOlder(channelId: channelId) }
                    }
                },
                onOpenThread: { rootId in
                    win.openThread(rootId)
                },
                onEdit: { message in
                    editingMessage = message
                },
                onDelete: { message, permanently in
                    Task { await app.engine.deleteMessage(id: message.id, permanently: permanently) }
                },
                onOpenProfile: { userId in
                    profileUserId = userId
                },
                scrollKey: app.sessionScope.key("scroll:\(channelId)"),
                // Jump-to-message (phase 12): the main list owns the target
                // unless it's a thread reply (ThreadPanelView handles those).
                focusMessageId: win.openThreadRootId == nil ? win.focusMessageId : nil,
                onFocused: { win.focusMessageId = nil },
                searchQuery: find.isOpen ? find.query : "",
                searchCursor: findCursor
            )

            TypingIndicatorView(channelId: channelId, userNames: userNames)

            if isArchived {
                Text("This channel is archived and read-only.")
                    .flowFont(.callout)
                    .foregroundStyle(.secondary)
                    .padding(12)
            } else {
                ComposerView(
                    channelId: channelId,
                    workspaceId: currentChannel?.workspaceId,
                    threadRootId: nil,
                    placeholder: "Message \(headerTitle)",
                    onEditLast: { startEditingLastMessage() }
                )
            }
        }
        // Lets Edit > Find in Conversation reach this window's bar.
        .focusedSceneValue(\.chatFind, find)
        // A new query starts at the first match; the cursor only moves on
        // purpose after that (Enter, the arrows).
        .onChange(of: find.query) { _, _ in find.index = findMatches.isEmpty ? -1 : 0 }
        .task(id: channelId) {
            // Switching channels leaves no stale query searching a transcript
            // it was never typed against.
            find.close()
            window = LoadedWindow(channelId: channelId, count: Self.windowStep)
            channel.start(db: app.db, key: channelId, reset: nil, Self.channelQuery(channelId))
            startMessages()
            pinnedMessages.start(
                db: app.db, key: channelId, reset: [], Self.pinnedQuery(channelId)
            )
            users.start(db: app.db, reset: [:]) { db in
                try Dictionary(uniqueKeysWithValues: User.fetchAll(db).map { ($0.id, $0) })
            }
            currentRole.start(db: app.db, reset: nil) { db in
                try String.fetchOne(
                    db,
                    sql: "SELECT w.role FROM workspace w JOIN channel c ON c.workspaceId = w.id WHERE c.id = ?",
                    arguments: [channelId]
                )
            }
            if let wsId = win.selectedWorkspaceId {
                await app.engine.resolveUncachedChannel(channelId, workspaceId: wsId)
            }
            await loadChannelMembers()
            // A transcript on screen must have been asked for at least once —
            // the selection-driven fetch alone can leave this one blank (#269).
            await app.engine.ensureHistory(channelId: channelId)
            await app.engine.loadPinnedMessages(channelId: channelId)
        }
        // Jump-to-message (phase 12): a target from the Activity feed may sit
        // beyond the loaded page — page older history until it's in the list,
        // then MessageListView scrolls to it. Give up once history is exhausted.
        .onChange(of: transcriptWindow) { _, _ in startMessages() }
        .onChange(of: win.focusMessageId) { _, _ in pageToFocusIfNeeded() }
        .onChange(of: currentMessages.count) { _, _ in pageToFocusIfNeeded() }
        .sheet(item: $editingMessage) { message in
            EditMessageSheet(message: message)
        }
        .sheet(item: Binding(
            get: { profileUserId.map { ProfileTarget(userId: $0) } },
            set: { profileUserId = $0?.userId }
        )) { target in
            MemberProfileSheet(userId: target.userId)
        }
        .sheet(isPresented: $showChannelEdit) {
            if let c = currentChannel {
                ChannelEditSheet(channel: c)
            }
        }
        .sheet(isPresented: $showPins) {
            PinnedMessagesSheet(
                messages: currentPinned,
                userNames: userNames,
                onSelect: { message in
                    guard let workspaceId = currentChannel?.workspaceId else { return }
                    win.openNotification(
                        workspaceId: workspaceId,
                        channelId: message.channelId,
                        messageId: message.id,
                        threadRootId: message.threadRootId
                    )
                    showPins = false
                }
            )
        }
    }

    /// Display names (agents badged) for the message list, typing line and header.
    private var userNames: [String: String] {
        users.value.mapValues { $0.displayNameWithBadge }
    }

    /// Status emoji only where one is set — the message list skips empties.
    private var userStatuses: [String: String] {
        users.value.compactMapValues { ($0.statusEmoji?.isEmpty == false) ? $0.statusEmoji : nil }
    }

    /// Refresh this channel's membership. Falls back to the DTO's DM-only
    /// memberIds if the request fails, so the header never empties out.
    private func loadChannelMembers() async {
        let channelId = channelId
        let ids = await app.engine.channelMemberIds(channelId: channelId)
        guard !ids.isEmpty else { return } // keep the DTO's DM-only fallback
        loadedMembers = LoadedMembers(channelId: channelId, ids: ids)
    }

    /// (Re)start the windowed transcript observation: the newest
    /// `transcriptWindow` + 1 rows, ascending (the +1 is the has-more probe).
    private func startMessages() {
        let key = transcriptKey
        messages.start(db: app.db, key: key, reset: [], Self.messagesQuery(key))
    }

    /// Page older history toward a jump-to-message target until it's loaded
    /// (thread-reply targets are handled by ThreadPanelView, not here).
    private func pageToFocusIfNeeded() {
        guard win.openThreadRootId == nil, let fid = win.focusMessageId else { return }
        if transcript.contains(where: { $0.id == fid }) { return } // loaded — list scrolls to it
        if hasMoreCached {
            widenWindow() // cached but outside the window
        } else if app.hasMore[channelId] ?? false {
            widenWindow()
            Task { await app.engine.loadOlder(channelId: channelId) }
        } else {
            win.focusMessageId = nil // not in this channel's history
        }
    }

    /// ↑-to-edit (ui_nits item 4): only when my message is the newest.
    private func startEditingLastMessage() -> Bool {
        guard let last = currentMessages.last,
              last.userId == app.currentUser?.id,
              !last.isDeleted, !last.pending else { return false }
        editingMessage = last
        return true
    }

    /// The non-me member of a 1:1 DM (falls back to me for a self-DM).
    private var dmOtherUserId: String? {
        guard currentChannel?.kind == "dm" else { return nil }
        let ids = currentChannel?.memberIds ?? []
        return ids.first { $0 != app.currentUser?.id } ?? ids.first
    }

    private var headerTitle: String {
        guard let c = currentChannel else { return "" }
        return c.isDM
            ? c.displayTitle(userNames: userNames, currentUserId: app.currentUser?.id)
            : "#\(c.name ?? "")"
    }

    /// The header topic, run through the same inline renderer as a message body
    /// (#194) so a URL in it is a real link that opens in the system browser
    /// instead of inert grey text.
    ///
    /// The colours are set per run rather than with a view-level
    /// `.foregroundStyle`, which would paint the link muted grey too and leave
    /// it looking exactly as unclickable as before. Runs that already carry a
    /// colour are mention pills — `MentionRendering` owns those.
    private var headerTopic: AttributedString? {
        guard let raw = currentChannel?.topic, !raw.isEmpty else { return nil }
        var topic = MentionRendering.attributed(
            raw, names: userNames, currentUserId: app.currentUser?.id
        )
        let uncoloured = topic.runs.filter { $0.foregroundColor == nil }.map { ($0.range, $0.link) }
        for (range, link) in uncoloured {
            topic[range].foregroundColor = link == nil ? MC.muted : MC.accent
        }
        return topic
    }

    private var header: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Image(systemName: headerIcon)
                        .flowFont(size: 13)
                        .foregroundStyle(MC.muted)
                    // Ruling 4: a 1:1 DM's header title opens the other
                    // member's profile card.
                    if let otherId = dmOtherUserId {
                        Button {
                            profileUserId = otherId
                        } label: {
                            Text(headerTitle)
                                .flowFont(size: 15, weight: .bold)
                                .foregroundStyle(MC.ink)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("View profile")
                    } else if currentChannel?.kind == "standard", !isArchived, app.can(.channelManagement) {
                        // Clicking a channel's name opens the name/topic editor
                        // (ui_nits item 5).
                        Button {
                            showChannelEdit = true
                        } label: {
                            Text(currentChannel?.name ?? "")
                                .flowFont(size: 15, weight: .bold)
                                .foregroundStyle(MC.ink)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("Edit name & topic")
                        .accessibilityIdentifier("channel.editHeader")
                    } else if isArchived {
                        // Same bare name the editable header shows; the icon
                        // already says it's a channel.
                        Text(currentChannel?.name ?? "")
                            .flowFont(size: 15, weight: .bold)
                            .foregroundStyle(MC.ink)
                    } else {
                        Text(headerTitle)
                            .flowFont(size: 15, weight: .bold)
                            .foregroundStyle(MC.ink)
                    }
                }
                if let topic = headerTopic {
                    Text(topic)
                        .flowFont(size: 12)
                        .lineLimit(1)
                        // A topic URL is a real link (#194), so it gets the
                        // hand cursor like any other (#276).
                        .linkCursor(topic, size: 12)
                        // #392: the header's topic is one truncated line, so
                        // hovering shows the whole thing — raw text, matching
                        // the sidebar tooltip and the web client.
                        .topicHelp(currentChannel?.topic)
                        .accessibilityIdentifier("channel.topic")
                }
            }
            Spacer()
            huddleButton
            headerAvatars
            channelMenu
        }
        .padding(.horizontal, 22)
        .frame(height: 60)
        .background(MC.chat)
    }

    /// Huddles run in any entity now — channel, DM or group DM (#436) — just
    /// not in an archived one. In a channel the button joins something ambient
    /// and nobody is rung; in a DM the same button *rings* the other
    /// member(s), so it says so. The participant count is the ambient
    /// indicator for a huddle that's live but not yet joined.
    @ViewBuilder
    private var huddleButton: some View {
        if let channel = currentChannel, channel.archivedAt == nil, app.can(.huddles) {
            let isDm = channel.kind != "standard"
            let inThisHuddle = app.activeHuddleChannelId == channelId
            let roster = app.huddleRosters[channelId] ?? []
            Button {
                if inThisHuddle {
                    app.leaveHuddle()
                } else if let workspaceId = currentChannel?.workspaceId {
                    app.joinHuddle(channelId: channelId, workspaceId: workspaceId)
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "mic.fill")
                    Text(inThisHuddle ? "Leave Huddle" : isDm ? "Huddle" : "Join Huddle")
                    if !inThisHuddle, !roster.isEmpty {
                        Text("\(roster.count)")
                            .flowFont(size: 11, weight: .bold)
                            .padding(.horizontal, 5)
                            .background(Capsule().fill(MC.accent.opacity(0.15)))
                    }
                }
                .flowFont(size: 12, weight: .semibold)
                .foregroundStyle(inThisHuddle ? MC.accent : MC.muted)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(app.huddleConnecting)
            .help(inThisHuddle ? "Leave huddle" : isDm ? "Start a huddle — this rings them" : "Join huddle")
            .accessibilityIdentifier(inThisHuddle ? "huddle.leave" : "huddle.join")
        }
    }

    /// The header's "⋯" menu (#188): the channel's shared files (#347), pinned
    /// messages, its artifacts and channel options in one place, matching web
    /// and iOS. Replaces the
    /// standalone pin button that used to sit next to the avatars.
    private var channelMenu: some View {
        Menu {
            // Each entry is a Flow feature a provider may lack (#546): the
            // item is disabled with the reason rather than removed, so the
            // menu keeps its shape.
            Button {
                win.openFiles(true)
            } label: {
                Label("Files", systemImage: "paperclip")
            }
            .capability(.files)
            .accessibilityIdentifier("channel.files")

            Button {
                showPins = true
            } label: {
                Label(
                    currentPinned.isEmpty
                        ? "Pinned Messages"
                        : "Pinned Messages (\(currentPinned.count))",
                    systemImage: currentPinned.isEmpty ? "pin" : "pin.fill"
                )
            }
            .capability(.pins)
            .accessibilityIdentifier("channel.pins")

            let artifacts = win.artifacts(inChannel: channelId)
            Menu {
                if artifacts.isEmpty {
                    Text("No artifacts yet")
                } else {
                    ForEach(artifacts) { artifact in
                        Button {
                            win.selectArtifact(artifact.id)
                        } label: {
                            Text("\(artifact.glyph)  \(artifact.name)")
                        }
                        .accessibilityIdentifier("artifact.row.\(artifact.name)")
                    }
                }
            } label: {
                Label(artifacts.isEmpty ? "Artifacts" : "Artifacts (\(artifacts.count))",
                      systemImage: "doc.text")
            }
            .capability(.artifacts)
            .accessibilityIdentifier("channel.artifacts")

            if currentChannel?.kind == "standard", !isArchived, app.can(.channelManagement) {
                Divider()
                Button {
                    showChannelEdit = true
                } label: {
                    Label("Channel Options…", systemImage: "gearshape")
                }
                .accessibilityIdentifier("channel.options")
            }
        } label: {
            Image(systemName: "ellipsis")
                .flowFont(size: 13)
                .foregroundStyle(MC.muted)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(width: 20)
        .help("Channel menu")
        .accessibilityIdentifier("channel.menu")
    }

    /// Design 3a: overlapping member avatars + "+N" at the header's right edge —
    /// this channel's members for every kind (#70; it used to show the whole
    /// workspace roster for standard channels). Clicking opens the member list.
    private var headerAvatars: some View {
        let ids = orderedMembers.map(\.id)
        let shown = Array(ids.prefix(3))
        let extra = ids.count - shown.count
        return Button {
            showMembers.toggle()
        } label: {
            HStack(spacing: 4) {
                HStack(spacing: -10) {
                    ForEach(shown, id: \.self) { id in
                        AvatarChip(
                            userId: id,
                            name: users.value[id]?.displayName ?? "?",
                            avatarPath: app.avatarPaths[id],
                            size: 26,
                            radius: 13
                        )
                        .overlay(RoundedRectangle(cornerRadius: 13).strokeBorder(MC.chat, lineWidth: 2))
                    }
                }
                if extra > 0 {
                    Text("+\(extra)")
                        .flowFont(size: 12)
                        .foregroundStyle(MC.muted)
                }
                // Nothing to stack yet (fetch in flight) — keep a click target.
                if shown.isEmpty {
                    Image(systemName: "person.2")
                        .flowFont(size: 13)
                        .foregroundStyle(MC.muted)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("View members")
        .accessibilityElement(children: .ignore)
        .accessibilityIdentifier("channel.memberAvatars")
        .accessibilityValue("\(ids.count) members")
        .popover(isPresented: $showMembers, arrowEdge: .bottom) {
            membersPopover
        }
        .onChange(of: showMembers) { _, opening in
            if opening { Task { await loadChannelMembers() } } // catch joins/leaves
        }
    }

    /// This channel's members, online first then alphabetical (web parity).
    private var orderedMembers: [User] {
        let ids = channelMemberIds.isEmpty ? (currentChannel?.memberIds ?? []) : channelMemberIds
        return ids
            .map { id in
                users.value[id]
                    ?? User(id: id, email: "", displayName: "Unknown", avatarUrl: nil, timezone: nil)
            }
            .sorted { a, b in
                let aOn = isOnline(a.id), bOn = isOnline(b.id)
                if aOn != bOn { return aOn }
                return a.displayName.localizedCaseInsensitiveCompare(b.displayName) == .orderedAscending
            }
    }

    /// You're online by definition — this client is the one connected.
    private func isOnline(_ userId: String) -> Bool {
        userId == app.currentUser?.id || app.isOnline(userId, in: win.selectedWorkspaceId)
    }

    private var membersPopover: some View {
        let rows = orderedMembers
        return VStack(alignment: .leading, spacing: 0) {
            Text(rows.count == 1 ? "1 MEMBER" : "\(rows.count) MEMBERS")
                .flowFont(size: 11, weight: .bold)
                .kerning(0.5)
                .foregroundStyle(MC.muted)
                .padding(.horizontal, 10)
                .padding(.bottom, 6)
            if rows.isEmpty {
                Text("No members.")
                    .flowFont(size: 13)
                    .foregroundStyle(MC.faint)
                    .padding(.horizontal, 10)
            }
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(rows) { user in
                        memberRow(user)
                    }
                }
            }
            .frame(maxHeight: 320)
        }
        .padding(.vertical, 10)
        .frame(width: 260)
        // Without this the popover uses the system vibrant material, which
        // samples whatever is behind it — gray over the message list, violet
        // over the sidebar — and washes out the ink-on-paper row text.
        .presentationBackground(MC.base)
        .accessibilityIdentifier("channel.membersPopover")
    }

    private func memberRow(_ user: User) -> some View {
        Button {
            showMembers = false
            profileUserId = user.id
        } label: {
            HStack(spacing: 9) {
                AvatarChip(
                    userId: user.id,
                    name: user.displayName,
                    avatarPath: app.avatarPaths[user.id],
                    size: 26,
                    radius: 9
                )
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(user.displayName)
                            .flowFont(size: 13.5, weight: .semibold)
                            .foregroundStyle(MC.ink)
                            .lineLimit(1)
                        if user.id == app.currentUser?.id {
                            Text("(you)")
                                .flowFont(size: 13.5)
                                .foregroundStyle(MC.faint)
                        }
                        if user.isAgent == true { Text("🤖").flowFont(size: 12) }
                        if let emoji = user.statusEmoji, !emoji.isEmpty {
                            Text(emoji).flowFont(size: 12)
                        }
                    }
                    if let status = user.statusText, !status.isEmpty {
                        Text(status)
                            .flowFont(size: 11)
                            .foregroundStyle(MC.faint)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                if app.can(.presence) {
                    Circle()
                        .fill(isOnline(user.id) ? MC.online : Color.clear)
                        .overlay(
                            Circle().strokeBorder(
                                isOnline(user.id) ? Color.clear : MC.hairline2, lineWidth: 1.5
                            )
                        )
                        .frame(width: 8, height: 8)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("channel.member.\(user.displayName)")
        .accessibilityValue(isOnline(user.id) ? "online" : "offline")
    }

    private var headerIcon: String {
        guard let c = currentChannel else { return "number" }
        if c.kind == "dm" { return "person" }
        if c.kind == "group_dm" { return "person.2" }
        return c.isPrivate ? "lock" : "number"
    }
}

struct PinnedMessagesSheet: View {
    let messages: [Message]
    let userNames: [String: String]
    let onSelect: (Message) -> Void
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var win: WindowState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Pinned Messages").font(.headline)
                Spacer()
                Button("Done") { dismiss() }
            }

            if messages.isEmpty {
                ContentUnavailableView(
                    "No Pinned Messages",
                    systemImage: "pin",
                    description: Text("Pin an important message to keep it easy to find.")
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(messages) { message in
                            HStack(alignment: .top, spacing: 8) {
                                Button {
                                    onSelect(message)
                                } label: {
                                    VStack(alignment: .leading, spacing: 3) {
                                        HStack {
                                            Text(userNames[message.userId] ?? "Unknown")
                                                .font(.system(size: 12, weight: .bold))
                                            Spacer()
                                            if let at = message.pinnedAt {
                                                Text(ISO8601.parse(at)?.formatted(date: .abbreviated, time: .shortened) ?? "")
                                                    .font(.system(size: 10))
                                                    .foregroundStyle(MC.faint)
                                            }
                                        }
                                        Text(message.body.isEmpty ? (message.files.first?.name ?? "Message") : message.body)
                                            .font(.system(size: 13))
                                            .foregroundStyle(MC.inkSoft)
                                            .lineLimit(3)
                                        if message.threadRootId != nil {
                                            Text("Reply in thread")
                                                .font(.system(size: 10, weight: .semibold))
                                                .foregroundStyle(MC.accentSoft)
                                        }
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)

                                Button {
                                    Task { await app.engine.togglePin(message) }
                                } label: {
                                    Image(systemName: "pin.slash")
                                        .foregroundStyle(MC.accentSoft)
                                }
                                .buttonStyle(.plain)
                                .help("Unpin message")
                            }
                            .padding(10)
                            .background(RoundedRectangle(cornerRadius: 10).fill(MC.daypill.opacity(0.45)))
                            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(MC.hairline, lineWidth: 1))
                        }
                    }
                }
            }
        }
        .padding(18)
        .frame(width: 480, height: 440)
    }
}

struct TypingIndicatorView: View {
    let channelId: String
    /// nil = the channel's main composer; set = that thread's composer, so the
    /// two never show each other's typists.
    var threadRootId: String? = nil
    let userNames: [String: String]
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var win: WindowState

    var body: some View {
        // No typing events from a provider that has none (#546); the strip
        // keeps its height so the composer never shifts between workspaces.
        let ids = app.can(.typing) ? app.typingUserIds(channelId: channelId, threadRootId: threadRootId) : []
        HStack {
            if !ids.isEmpty {
                Text(typingText(ids))
                    .flowFont(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("typing.indicator")
            }
            Spacer()
        }
        .frame(height: 16)
        .padding(.horizontal, 16)
    }

    /// An agent at work "thinks" rather than "types" (ui_nits).
    private func typingText(_ ids: [String]) -> String {
        let names = ids.map { userNames[$0] ?? "Someone" }
        switch ids.count {
        case 1:
            let verb = app.agentIds.contains(ids[0]) ? "thinking" : "typing"
            return "\(names[0]) is \(verb)…"
        case 2: return "\(names[0]) and \(names[1]) are typing…"
        default: return "Several people are typing…"
        }
    }
}

struct EditMessageSheet: View {
    let message: Message
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var win: WindowState
    @Environment(\.dismiss) private var dismiss
    @State private var text: String

    init(message: Message) {
        self.message = message
        _text = State(initialValue: message.body)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Edit Message").flowFont(.headline)
            TextField("Message", text: $text, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(3...10)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction) // Esc cancels (ui_nits item 4)
                Button("Save") {
                    Task { await app.engine.editMessage(id: message.id, body: text) }
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}

/// Channel options (#188): name, topic and delete, reached from the header's
/// "⋯" menu — the same three on every client. Empty topic clears the
/// sub-headline; #general can be neither renamed nor deleted. "Delete" is the
/// server's archive (soft: the channel leaves the sidebar and goes read-only).
struct ChannelEditSheet: View {
    let channel: Channel
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var win: WindowState
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var topic: String
    @State private var error: String?
    @State private var saving = false
    @State private var confirmDelete = false

    init(channel: Channel) {
        self.channel = channel
        _name = State(initialValue: channel.name ?? "")
        _topic = State(initialValue: channel.topic ?? "")
    }

    private var isGeneral: Bool { channel.name == "general" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Channel options").flowFont(.headline)
            VStack(alignment: .leading, spacing: 4) {
                Text("Name").flowFont(.caption).foregroundStyle(.secondary)
                TextField("name (lowercase, a-z 0-9 - _)", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isGeneral)
                    .help(isGeneral ? "#general cannot be renamed" : "")
                    .accessibilityIdentifier("channel.edit.name")
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Topic").flowFont(.caption).foregroundStyle(.secondary)
                TextField("What's this channel about?", text: $topic)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("channel.edit.topic")
            }
            if let error {
                Text(error).flowFont(.caption).foregroundStyle(.red)
            }
            HStack {
                if !isGeneral {
                    Button("Delete Channel…", role: .destructive) { confirmDelete = true }
                        .disabled(saving)
                        .accessibilityIdentifier("channel.edit.delete")
                }
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save") { save() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving || (!isGeneral && name.trimmingCharacters(in: .whitespaces).isEmpty))
                    .accessibilityIdentifier("channel.edit.save")
            }
        }
        .padding(20)
        .frame(width: 420)
        .confirmationDialog(
            "Delete #\(channel.name ?? "")?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button("Delete Channel", role: .destructive) { remove() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It leaves everyone's sidebar and becomes read-only. Its history is kept.")
        }
    }

    /// Archive — the server's delete for a channel (see the type comment).
    private func remove() {
        saving = true
        Task {
            defer { saving = false }
            do {
                try await app.engine.archiveChannel(channel.id)
                if win.selectedChannelId == channel.id { win.selectChannel(nil) }
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func save() {
        saving = true
        let newName = name.lowercased().replacingOccurrences(of: " ", with: "-")
        Task {
            defer { saving = false }
            do {
                try await app.engine.updateChannel(
                    channelId: channel.id,
                    name: isGeneral ? nil : newName,
                    topic: topic // "" clears
                )
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// Which channel a fetched member list belongs to (#447).
private struct LoadedMembers {
    let channelId: String
    let ids: [String]
}

/// Which channel a "Load earlier" widening belongs to (#447).
private struct LoadedWindow {
    let channelId: String
    let count: Int
}

/// Identity of the transcript query — channel plus how far back it reaches.
private struct TranscriptKey: Hashable {
    let channelId: String
    let limit: Int
}

