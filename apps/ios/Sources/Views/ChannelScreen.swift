import SwiftUI
import GRDB

/// A single channel: message list + composer. Selecting the channel triggers
/// the SyncEngine to load history; GRDB observation feeds the list live.
struct ChannelScreen: View {
    let channelId: String
    /// Opens the channel drawer. The header pill owns the hamburger now that
    /// the system bar is hidden, and the drawer state lives in `MainView`.
    var onOpenDrawer: () -> Void = {}
    @EnvironmentObject var app: AppState
    @EnvironmentObject private var agentCall: AgentCallCoordinator
    @StateObject private var messages = DBObserved<[Message]>(initial: [])
    @StateObject private var pinnedMessages = DBObserved<[Message]>(initial: [])
    @StateObject private var users = DBObserved<[User]>(initial: [])
    @StateObject private var channel = DBObserved<Channel?>(initial: nil)
    @StateObject private var currentRole = DBObserved<String?>(initial: nil)
    @State private var editingMessage: Message?
    @State private var threadRoute: ThreadRoute?
    /// The parked-thread restore (#89) must run only on the *first* appearance
    /// of this screen — entering the channel. `.task` re-runs every time a
    /// popped thread reveals this screen again, and re-pushing there races the
    /// pop itself: with slow fetches the stale `openThreadRootId` pushes a
    /// destination mid-pop, which corrupts the NavigationStack and leaves the
    /// whole content pane unable to push, pop, or even hit-test (nav "stuck").
    @State private var restoredParkedThread = false
    @State private var showPins = false
    /// Channel Files list (#348) — pushed, not presented.
    @State private var filesRoute: FilesRoute?
    /// How many of the newest cached messages the transcript shows (see the
    /// macOS twin in ChannelView: one window keeps every ordinary open on the
    /// exact, eager path; "Load earlier" widens it). The fetch grabs one row
    /// beyond the window as the has-more probe.
    @State private var transcriptWindow = ChannelScreen.windowStep

    static let windowStep = 100
    @State private var showChannelOptions = false
    /// Invite to Channel… (web + macOS parity): add workspace members here.
    @State private var showInviteToChannel = false
    /// The member whose profile card is open (#223). One sheet for the whole
    /// transcript, driven by whichever row was tapped.
    @State private var profileRoute: ProfileRoute?
    @State private var startingAgentCall = false

    /// In-channel search (#570): open state, the live query, a tick that pulls
    /// focus back when the header is tapped again, and its own observation of
    /// the channel's cached messages. Search deliberately does not reuse the
    /// transcript's windowed observation — the window is what the reader has
    /// scrolled into, and a search that could only see the last 100 messages
    /// would be a search of the screen rather than of the channel.
    @State private var searchOpen = false
    @State private var searchQuery = ""
    @State private var searchFocusTick = 0
    @StateObject private var searchable = DBObserved<[Message]>(initial: [])
    /// Rendered-body cache shared by every keystroke, so typing re-matches
    /// strings instead of re-parsing every body's markdown (the same object
    /// macOS's find bar holds).
    @State private var searchIndex = ChatSearchIndex()

    /// The open artifact (#157), presented as a sheet over the conversation.
    /// Driven by `AppState.selectedArtifactId` — the same selection macOS uses
    /// for its side panel — so an agent-created artifact auto-opens here too
    /// (`maybeAutoOpenArtifact`), and switching channel closes it for free.
    private var artifactRoute: Binding<ArtifactRoute?> {
        Binding(
            get: { app.selectedArtifactId.map(ArtifactRoute.init) },
            set: { if $0 == nil { app.selectArtifact(nil) } }
        )
    }

    /// The cached row, or — for an archived channel opened from the channel
    /// browser (#590), which is never cached — the browser's in-memory copy.
    private var resolvedChannel: Channel? {
        channel.value ?? app.archivedChannels[channelId]
    }

    /// Archived (#590): full history, read-only — banner, no composer, and the
    /// transcript's write actions gated off through its capabilities.
    private var isArchived: Bool { resolvedChannel?.archivedAt != nil }

    /// What this screen's controls may do: the connection's capabilities,
    /// narrowed to reading in an archived channel.
    private var capabilities: Capabilities {
        isArchived ? app.capabilities.archivedReadOnly() : app.capabilities
    }

    private var usersById: [String: User] {
        Dictionary(users.value.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }

    private var statusesById: [String: String] {
        Dictionary(uniqueKeysWithValues: users.value.compactMap { u in
            (u.statusEmoji?.isEmpty == false) ? (u.id, u.statusEmoji!) : nil
        })
    }

    private var title: String {
        guard let ch = resolvedChannel else { return "" }
        if ch.isDM {
            return ch.displayTitle(userNames: usersById.mapValues { $0.displayNameWithBadge },
                                   currentUserId: app.currentUser?.id)
        }
        return "# \(ch.name ?? "channel")"
    }

    /// An agent call is deliberately one-to-one. Group DMs keep their normal
    /// LiveKit huddle because a spoken turn cannot be paired safely with one
    /// responding agent when several people or agents share the room.
    private var agentParticipantId: String? {
        guard let ch = resolvedChannel else { return nil }
        return AgentCallEligibility.participantId(
            channelKind: ch.kind,
            memberIds: ch.memberIds,
            currentUserId: app.currentUser?.id,
            agentIds: app.agentIds
        )
    }

    private var agentParticipant: User? {
        agentParticipantId.flatMap { usersById[$0] }
    }

    /// The topic, when there is one worth a line. DMs have none, and an empty
    /// or whitespace topic means "cleared" — not "blank second line".
    private var topic: String? {
        guard let ch = resolvedChannel, !ch.isDM else { return nil }
        let text = ch.topic?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }

    /// Huddles run in any entity now — channel, DM or group DM (#436) — just
    /// not in an archived one. In a channel the button joins something ambient
    /// and nobody is rung; in a DM it *rings* the other member(s). The
    /// participant count is the ambient indicator for a huddle that's live but
    /// not yet joined. Sits in the pill's trailing slot alongside the "⋯" menu
    /// (#298 moved the whole header into the pill).
    private var huddleButton: some View {
        Group {
            if let ch = resolvedChannel, ch.archivedAt == nil {
                // Provider gating (#546): no agent call without agents, no
                // huddle without huddles. Flow has both.
                if agentParticipantId != nil {
                    if !app.can(.agents) {
                        EmptyView()
                    } else if let agent = agentParticipant {
                        let inThisCall = agentCall.activeCall?.channelId == channelId
                        Button {
                            startAgentCall(with: agent)
                        } label: {
                            Image(systemName: inThisCall ? "waveform" : "mic.fill")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(minWidth: 32, minHeight: 32)
                                .padding(.horizontal, 6)
                                .background(Capsule().fill(.white.opacity(inThisCall ? 0.35 : 0.2)))
                        }
                        .buttonStyle(.plain)
                        .disabled(startingAgentCall || app.huddleConnecting)
                        .accessibilityLabel(inThisCall ? "Open agent call" : "Call agent")
                        .accessibilityIdentifier("agentCall.start")
                    } else {
                        ProgressView()
                            .tint(.white)
                            .frame(width: 44, height: 32)
                    }
                } else if app.can(.huddles) {
                    let isDm = ch.kind != "standard"
                    let inThisHuddle = app.activeHuddleChannelId == channelId
                    let roster = app.huddleRosters[channelId] ?? []
                    Button {
                        agentCall.end()
                        if inThisHuddle {
                            app.leaveHuddle()
                        } else {
                            app.joinHuddle(channelId: channelId, workspaceId: ch.workspaceId)
                        }
                    } label: {
                        HStack(spacing: 3) {
                            Image(systemName: "mic.fill")
                                .font(.system(size: 15, weight: .semibold))
                            if !inThisHuddle, !roster.isEmpty {
                                Text("\(roster.count)")
                                    .font(.system(size: 12, weight: .bold))
                            }
                        }
                        .foregroundStyle(.white)
                        .frame(minWidth: 32, minHeight: 32)
                        .padding(.horizontal, 6)
                        .background(Capsule().fill(.white.opacity(inThisHuddle ? 0.35 : 0.2)))
                    }
                    .buttonStyle(.plain)
                    .disabled(app.huddleConnecting)
                    .accessibilityLabel(inThisHuddle ? "Leave huddle" : isDm ? "Start a huddle" : "Join huddle")
                    .accessibilityIdentifier(inThisHuddle ? "huddle.leave" : "huddle.join")
                }
            }
        }
    }

    private func startAgentCall(with agent: User) {
        if agentCall.activeCall?.channelId == channelId {
            agentCall.show()
            return
        }
        guard let workspaceId = resolvedChannel?.workspaceId, !startingAgentCall else { return }
        startingAgentCall = true
        Task {
            if app.activeHuddleChannelId != nil {
                await app.leaveHuddleAndWait()
            }
            agentCall.start(channelId: channelId, workspaceId: workspaceId, agent: agent)
            startingAgentCall = false
        }
    }

    /// The floating header (#298). The topic rides in the pill as a subtitle —
    /// the macOS header shape (`ChannelView.swift:227`) as a phone allows, and
    /// no longer a strip under the bar. The system navigation bar is hidden on this
    /// screen, so the hamburger comes from `MainView` as a closure and the "⋯"
    /// menu moves out of `.toolbar` and into the pill — the huddle button
    /// joins it there (Phase 1: voice huddle).
    private var headerPill: some View {
        FloatingHeaderPill(
            title: title,
            subtitle: topic,
            leadingSystemImage: "line.3.horizontal",
            leadingAction: onOpenDrawer,
            leadingAccessibilityIdentifier: "nav.menu",
            leadingAccessibilityLabel: "Channels",
            subtitleAccessibilityIdentifier: "channel.header.topic",
            // Tapping the name toggles in-channel search (#570) — the ticket
            // asks for the header to dismiss it as well as open it.
            titleAction: toggleSearch,
            trailing: {
                HStack(spacing: 6) {
                    huddleButton
                    channelMenu
                }
            }
        )
    }

    private var channelMenu: some View {
        Menu {
            // The header tap is the quick way into search (#570), but a bare
            // tap gesture is invisible to VoiceOver and to anyone who never
            // thinks to try it — so the action lives here as a real button too.
            //
            // Not gated on `.search`: like the macOS and web find bars, this
            // searches messages already on the device, so it needs nothing from
            // the provider. `.search` is about a backend's own search API.
            Button {
                openSearch()
            } label: {
                Label("Search in Channel…", systemImage: "magnifyingglass")
            }
            .accessibilityIdentifier("channel.search")

            // Provider gating (#546): an unavailable item is not in the menu,
            // as on web and macOS. Flow keeps every item.
            Button {
                filesRoute = FilesRoute(channelId: channelId)
            } label: {
                Label("Files", systemImage: "paperclip")
            }
            .accessibilityIdentifier("channel.files")
            .hiddenUnless(.files, in: app.capabilities)

            Button {
                showPins = true
            } label: {
                Label(
                    pinnedMessages.value.isEmpty
                        ? "Pinned Messages"
                        : "Pinned Messages (\(pinnedMessages.value.count))",
                    systemImage: pinnedMessages.value.isEmpty ? "pin" : "pin.fill"
                )
            }
            .accessibilityIdentifier("channel.pins")
            .hiddenUnless(.pins, in: app.capabilities)

            ArtifactsMenu(channelId: channelId)
                .hiddenUnless(.artifacts, in: app.capabilities)

            if resolvedChannel?.kind == "standard", !isArchived, app.can(.channelManagement) {
                Divider()
                Button {
                    showInviteToChannel = true
                } label: {
                    Label("Invite to Channel…", systemImage: "person.badge.plus")
                }
                .accessibilityIdentifier("channel.invite")
                Button {
                    showChannelOptions = true
                } label: {
                    Label("Channel Options…", systemImage: "gearshape")
                }
                .accessibilityIdentifier("channel.options")
            }
        } label: {
            PillGlyph(systemImage: "ellipsis")
        }
        .accessibilityIdentifier("channel.menu")
        .accessibilityLabel("Channel menu")
    }

    private var hasMoreCached: Bool { messages.value.count > transcriptWindow }
    private var transcript: [Message] {
        hasMoreCached ? Array(messages.value.dropFirst()) : messages.value
    }

    var body: some View {
        ZStack(alignment: .top) {
            chatStack
                // The transcript runs behind the pill and up to the very top of
                // the viewport. The pill is the only thing left in the safe
                // area, so it lands just under the status bar for free.
                .ignoresSafeArea(.container, edges: .top)
                .fadesAboveFloatingHeader(floatingHeaderTopInset)
            // Pill, then — when open — the search field and its results, all in
            // one top-aligned stack (#570). Stacking them rather than insetting
            // the results by hand is what keeps the header from moving a pixel
            // when search opens: the pill is the first element either way.
            // With search closed the stack holds only the pill and hugs the top;
            // the results view is greedy, so it fills the rest when it appears.
            VStack(spacing: 0) {
                headerPill
                // Archived (#590): the banner floats under the pill — the
                // transcript runs behind the pill, so a strip at the top of
                // the chat stack would sit hidden beneath it.
                if isArchived, !searchOpen {
                    Text(ChannelBrowser.archivedBanner(archivedAt: resolvedChannel?.archivedAt))
                        .font(.system(size: 13))
                        .foregroundStyle(Color.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background {
                            // Opaque, so the transcript scrolling behind it
                            // never shows through the tint.
                            ZStack {
                                RoundedRectangle(cornerRadius: 12).fill(MC.base)
                                RoundedRectangle(cornerRadius: 12).fill(Color.orange.opacity(0.1))
                            }
                        }
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.orange.opacity(0.3), lineWidth: 1))
                        .padding(.horizontal, 12)
                        .padding(.top, 6)
                        .accessibilityIdentifier("channel.archivedBanner")
                }
                if searchOpen {
                    // No gap anywhere below the pill: the bar's own background
                    // runs right up to the pill's bottom edge and carries the
                    // breathing room as internal padding instead. A spacer here
                    // would show a sliver of half-drawn transcript between the
                    // two, which reads as a glitch rather than as depth.
                    VStack(spacing: 0) {
                        searchField
                        searchResults
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
        }
        // No system bar on this screen any more — the pill replaces it.
        .toolbar(.hidden, for: .navigationBar)
    }

    private var searchField: some View {
        ChannelSearchField(
            placeholder: "Search in \(title)",
            query: $searchQuery,
            focusTick: searchFocusTick,
            onCancel: closeSearch
        )
    }

    private var searchResults: some View {
        // One dictionary for both the matching and the drawing: `ChatSearch`
        // resolves mention tokens to `@name` before matching, so the two have
        // to agree on the names or the highlight lands on other characters
        // than the count was taken from.
        let names = usersById.mapValues { $0.displayNameWithBadge }
        return ChannelSearchResults(
            results: ChannelSearch.results(
                in: searchable.value, index: searchIndex, names: names, query: searchQuery
            ),
            query: searchQuery,
            userNames: names,
            index: searchIndex,
            canLoadOlder: app.hasMore[channelId] ?? false,
            isLoadingOlder: app.loadingHistory.contains(channelId),
            onLoadOlder: { Task { await app.engine.loadOlder(channelId: channelId) } },
            onSelect: jumpToSearchResult
        )
    }

    /// Everything the channel screen scrolls or types into, plus the sheets and
    /// observations that hang off it. Split out of `body` so the pill can float
    /// over it (#298).
    private var chatStack: some View {
        VStack(spacing: 0) {
            SyncBar(syncing: app.isSyncing)
            // The chat area — everything above the composer. Tapping or
            // scrolling any of it puts the keyboard away (#139); the composer
            // is deliberately outside, since tapping it means "type".
            VStack(spacing: 0) {
                MessageListView(
                    messages: transcript,
                    userNames: usersById.mapValues { $0.displayNameWithBadge },
                    userStatuses: statusesById,
                    currentUserId: app.currentUser?.id,
                    canPermanentlyDelete: currentRole.value == "owner" || currentRole.value == "admin",
                    context: TranscriptContext(
                        engine: app.engine,
                        avatarPaths: app.avatarPaths,
                        agentIds: app.agentIds,
                        onOpenScheduled: { app.showScheduledPanel() },
                        capabilities: capabilities
                    ),
                    hasMore: hasMoreCached || (app.hasMore[channelId] ?? false),
                    isLoadingHistory: app.loadingHistory.contains(channelId),
                    showThreadAffordances: true,
                    unreadThreadRootIds: Set(resolvedChannel?.unreadThreadRootIds ?? []),
                    onLoadOlder: {
                        // Widen the window first (instant, from cache); go to
                        // the server only once the cache is exhausted.
                        let cacheHadMore = hasMoreCached
                        transcriptWindow += Self.windowStep
                        if !cacheHadMore {
                            Task { await app.engine.loadOlder(channelId: channelId) }
                        }
                    },
                    onOpenThread: { rootId in
                        threadRoute = ThreadRoute(rootId: rootId)
                    },
                    onEdit: { editingMessage = $0 },
                    onDelete: { msg, permanently in
                        Task { await app.engine.deleteMessage(id: msg.id, permanently: permanently) }
                    },
                    // Jump-to-message (phase 12): the Activity feed only sets a
                    // target for top-level messages on iOS (thread replies live
                    // in a separate pushed screen — see CHANGELOG Parity).
                    focusMessageId: app.focusMessageId,
                    onFocused: { app.focusMessageId = nil },
                    scrollKey: app.sessionScope.key("scroll:\(channelId)"),
                    onOpenProfile: { profileRoute = ProfileRoute(userId: $0) },
                    capabilities: capabilities
                )
                TypingIndicatorView(channelId: channelId, userNames: usersById.mapValues { $0.displayNameWithBadge })
                    .hiddenUnless(.typing, in: app.capabilities)
            }
            .dismissesKeyboardOnChatInteraction()
            // Search owns the keyboard while it is open, so the composer steps
            // out of the way (#570). Left in place it would sit between the
            // results and the keyboard, inviting a tap that types into a box
            // nobody can see.
            if isArchived {
                Divider()
                Text("This channel is archived and read-only.")
                    .font(.system(size: 14))
                    .foregroundStyle(MC.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .accessibilityIdentifier("channel.archivedNote")
            } else if !searchOpen {
                Divider()
                ComposerView(channelId: channelId)
            }
        }
        .sheet(item: $editingMessage) { message in
            EditMessageSheet(message: message)
        }
        .sheet(item: artifactRoute) { route in
            ArtifactSheet(artifactId: route.id)
        }
        .sheet(item: $profileRoute) { route in
            MemberProfileSheet(userId: route.userId)
        }
        .sheet(isPresented: $showChannelOptions) {
            if let c = resolvedChannel {
                ChannelOptionsSheet(channel: c)
            }
        }
        .sheet(isPresented: $showInviteToChannel) {
            if let c = resolvedChannel {
                InviteToChannelSheet(channel: c)
            }
        }
        .sheet(isPresented: $showPins) {
            PinnedMessagesSheet(
                messages: pinnedMessages.value,
                userNames: usersById.mapValues { $0.displayNameWithBadge },
                onSelect: { message in
                    showPins = false
                    if let rootId = message.threadRootId {
                        app.openThread(rootId)
                        threadRoute = ThreadRoute(rootId: rootId)
                    } else {
                        app.openThread(nil)
                        threadRoute = nil
                    }
                    app.focusMessageId = message.id
                }
            )
        }
        .navigationDestination(item: $threadRoute) { route in
            ThreadScreen(rootId: route.rootId)
        }
        // Channel Files (#348) pushes full-screen — the phone's answer to the
        // side panel web and macOS open for the same list.
        .navigationDestination(item: $filesRoute) { route in
            FilesScreen(channelId: route.channelId)
        }
        // This binding is the single owner of the app-level thread state: a
        // set pushes and records the open thread, a pop clears it. It used to
        // be split — ThreadScreen recorded the open on *its* appearance — and
        // the two halves raced around a pop (see `restoredParkedThread`).
        //
        // Popping the thread (Back/swipe) closes it for real — issue #89 parks
        // an open thread per channel, and only this screen knows the difference
        // between "the user went back" and "the whole channel screen was
        // replaced by a channel switch", which must leave the parked thread be.
        .onChange(of: threadRoute) { _, route in
            if let route {
                app.openThread(route.rootId)
            } else if app.selectedChannelId == channelId {
                app.openThread(nil)
            }
        }
        // …and the other direction (#476): a jump that arrives while this
        // channel is *already* on screen. A tapped push for a thread reply in
        // the visible channel sets `openThreadRootId` and nothing else — the
        // `.task` below seeds `$threadRoute` on first appearance only, so the
        // tap opened the channel and stopped there. A tap for a different
        // channel was never affected: that remounts this screen.
        //
        // Guarded on the selection for the same reason the pop branch above is:
        // a channel switch changes `openThreadRootId` for the channel replacing
        // this one, and pushing a destination from a screen on its way out is
        // exactly what corrupts the NavigationStack (see `restoredParkedThread`).
        // Assigning the same route back is a no-op, so this cannot loop with
        // the handler above.
        .onChange(of: app.openThreadRootId) { _, rootId in
            guard app.selectedChannelId == channelId else { return }
            threadRoute = rootId.map(ThreadRoute.init)
        }
        // Jump-to-message (phase 12): page older history until the target is
        // loaded, then MessageListView scrolls to it; give up when exhausted.
        .onChange(of: transcriptWindow) { _, _ in startMessages() }
        .onChange(of: app.focusMessageId) { _, _ in pageToFocusIfNeeded() }
        .onChange(of: messages.value.count) { _, _ in pageToFocusIfNeeded() }
        .modifier(DebugTestSend(channelId: channelId, app: app))
        .modifier(DebugMessageActions(channelId: channelId, app: app) { threadRoute = ThreadRoute(rootId: $0) })
        .modifier(DebugOpenProfile(app: app) { profileRoute = ProfileRoute(userId: $0) })
        .background(MC.base)
        // No `.navigationTitle` / `.toolbar` here any more: the pill in `body`
        // carries the name, the topic, the hamburger and the "⋯" menu (#188's
        // three items are unchanged, they just moved) — the huddle button
        // (Phase 1: voice huddle) joins them in the pill's trailing slot.
        .task {
            app.selectChannel(channelId)
            // Re-push the thread this channel had open before we left it (#89)
            // — first appearance only; see `restoredParkedThread`.
            if !restoredParkedThread {
                restoredParkedThread = true
                if let rootId = app.openThreadRootId {
                    threadRoute = ThreadRoute(rootId: rootId)
                }
            }
            users.start(db: app.db) { try User.fetchAll($0) }
            channel.start(db: app.db) { try Channel.filter(key: channelId).fetchOne($0) }
            currentRole.start(db: app.db, reset: nil) { db in
                try String.fetchOne(
                    db,
                    sql: "SELECT w.role FROM workspace w JOIN channel c ON c.workspaceId = w.id WHERE c.id = ?",
                    arguments: [channelId]
                )
            }
            // No `reset:` — this screen's identity is the channel id (MainView
            // keys it), so anything already rendered belongs to *this* channel
            // and must survive the observation restarting. Clearing it first
            // was a self-inflicted blank (#191).
            startMessages()
            pinnedMessages.start(db: app.db, reset: []) { db in
                try Message
                    .filter(Column("channelId") == channelId && Column("pinnedAt") != nil)
                    .order(Column("pinnedAt").desc)
                    .fetchAll(db)
            }
            // An archived channel restored by navigation isn't cached (#590).
            if let wsId = app.selectedWorkspaceId {
                await app.engine.resolveUncachedChannel(channelId, workspaceId: wsId)
            }
            // A transcript on screen must have been asked for at least once —
            // the selection-driven fetch alone can leave this one blank (#269).
            await app.engine.ensureHistory(channelId: channelId)
            await app.engine.loadPinnedMessages(channelId: channelId)
        }
    }

    /// (Re)start the windowed transcript observation: the newest
    /// `transcriptWindow` + 1 rows, ascending. No `reset:` — see the note at
    /// the old call site (#191): anything rendered belongs to this channel.
    private func startMessages() {
        let channelId = channelId
        let limit = transcriptWindow + 1
        messages.start(db: app.db) { db in
            try Array(
                Message
                    .filter(Column("channelId") == channelId && Column("threadRootId") == nil)
                    .order(Column("id").desc)
                    .limit(limit)
                    .fetchAll(db)
                    .reversed()
            )
        }
    }

    // MARK: - In-channel search (#570)

    /// The header's tap: open the field, or close it if it is already open.
    private func toggleSearch() {
        if searchOpen { closeSearch() } else { openSearch() }
    }

    private func openSearch() {
        guard !searchOpen else {
            searchFocusTick += 1
            return
        }
        startSearchable()
        searchFocusTick += 1
        withAnimation(.easeOut(duration: 0.18)) { searchOpen = true }
    }

    /// Cancel: field gone, keyboard down, query forgotten. The transcript is
    /// never unmounted while search is open, so "scroll position preserved"
    /// needs no restore — it was never lost.
    private func closeSearch() {
        withAnimation(.easeOut(duration: 0.18)) { searchOpen = false }
        searchQuery = ""
        // Nothing reads these until the next open, and the corpus observation
        // is the expensive one to leave running on every channel ever visited.
        searchable.stop()
    }

    /// The channel's cached messages, newest first. Thread replies are in
    /// scope — a search of "this channel" that skipped the reply someone
    /// actually wrote would be lying about what it searched — and tapping one
    /// opens its thread, the same route the pins sheet takes.
    ///
    /// "Cached" is the real boundary, and it bites hardest on replies: the sync
    /// engine fetches a thread's replies when that thread is first opened, so
    /// until then only the root message is findable. The root carries the reply
    /// count, so the trail is still there — but this is why the empty state
    /// offers to page in more history rather than asserting "not here".
    private func startSearchable() {
        let channelId = channelId
        searchable.start(db: app.db, reset: []) { db in
            try Message
                .filter(Column("channelId") == channelId)
                .order(Column("id").desc)
                .limit(ChannelSearch.corpusLimit)
                .fetchAll(db)
        }
    }

    /// Tapping a result: close search and hand the message to the existing
    /// jump-to-message path, which pages history until the target is loaded and
    /// then scrolls to it — in the thread screen when the hit is a reply.
    private func jumpToSearchResult(_ message: Message) {
        closeSearch()
        if let rootId = message.threadRootId {
            app.openThread(rootId)
            threadRoute = ThreadRoute(rootId: rootId)
        } else {
            app.openThread(nil)
            threadRoute = nil
        }
        app.focusMessageId = message.id
    }

    /// Page older history toward a jump-to-message target until it's loaded.
    private func pageToFocusIfNeeded() {
        // An empty transcript can't tell you anything about whether the target
        // is reachable (#332). This runs on the first `messages.value.count`
        // change, which on a fully-cached channel is still 0 — and with
        // `app.hasMore` false by then, the exhausted branch below threw the
        // target away before a single row had arrived. Re-opening a channel
        // you had already read was exactly that shape, and the jump did
        // nothing.
        guard let fid = app.focusMessageId, !messages.value.isEmpty else { return }
        if transcript.contains(where: { $0.id == fid }) { return } // loaded — list scrolls to it
        if hasMoreCached {
            transcriptWindow += Self.windowStep // cached but outside the window
        } else if app.hasMore[channelId] ?? false {
            transcriptWindow += Self.windowStep
            Task { await app.engine.loadOlder(channelId: channelId) }
        } else if threadRoute == nil, app.openThreadRootId == nil {
            // Never clear it while a thread is pushed (#332): this transcript
            // is filtered to `threadRootId == nil`, so a jump to a *reply* can
            // never become "loaded" here, and exhausting the channel's history
            // would throw away a target that belongs to ThreadScreen — usually
            // before that screen's replies had arrived to claim it. Paging
            // above still runs, so a jump to a root message is unaffected by a
            // thread that happens to be parked open (#89).
            //
            // `openThreadRootId` is checked as well as the local route (#476):
            // a notification tap sets the app-level root and the focus id in
            // one pass, and the push it triggers is a view update behind — so
            // for that one pass `threadRoute` is still nil here while the
            // target already belongs to the thread about to appear.
            app.focusMessageId = nil // not in this channel's loaded history
        }
    }
}

private struct PinnedMessagesSheet: View {
    let messages: [Message]
    let userNames: [String: String]
    let onSelect: (Message) -> Void
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if messages.isEmpty {
                    ContentUnavailableView(
                        "No Pinned Messages",
                        systemImage: "pin",
                        description: Text("Pin an important message to keep it easy to find.")
                    )
                } else {
                    List(messages) { message in
                        HStack(alignment: .top, spacing: 10) {
                            Button {
                                onSelect(message)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(userNames[message.userId] ?? "Unknown")
                                            .font(.caption.weight(.bold))
                                        Spacer()
                                        if let at = message.pinnedAt {
                                            Text(ISO8601.parse(at)?.formatted(date: .abbreviated, time: .shortened) ?? "")
                                                .font(.caption2)
                                                .foregroundStyle(MC.faint)
                                        }
                                    }
                                    Text(message.body.isEmpty ? (message.files.first?.name ?? "Message") : message.body)
                                        .font(.callout)
                                        .foregroundStyle(MC.inkSoft)
                                        .lineLimit(3)
                                    if message.threadRootId != nil {
                                        Text("Reply in thread")
                                            .font(.caption2.weight(.semibold))
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
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Unpin message")
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Pinned Messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// Channel options (#188): name, topic and delete, reached from the header's
/// "⋯" menu — the same three on every client, and the first time iOS could
/// rename a channel or set its topic at all. "Delete" is the server's archive
/// (soft: the channel leaves the sidebar and goes read-only); #general can be
/// neither renamed nor deleted.
struct ChannelOptionsSheet: View {
    let channel: Channel
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var topic: String
    @State private var busy = false
    @State private var confirmDelete = false
    @State private var error: String?

    init(channel: Channel) {
        self.channel = channel
        _name = State(initialValue: channel.name ?? "")
        _topic = State(initialValue: channel.topic ?? "")
    }

    private var isGeneral: Bool { channel.name == "general" }

    private var normalized: String {
        name.trimmingCharacters(in: .whitespaces)
            .lowercased()
            .replacingOccurrences(of: " ", with: "-")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("name (lowercase, a-z 0-9 - _)", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(isGeneral)
                        .accessibilityIdentifier("channel.edit.name")
                    if isGeneral {
                        Text("#general cannot be renamed.")
                            .font(.caption)
                            .foregroundStyle(MC.faint)
                    }
                }
                Section("Topic") {
                    TextField("What's this channel about?", text: $topic)
                        .accessibilityIdentifier("channel.edit.topic")
                }
                if !isGeneral {
                    Section {
                        Button("Delete Channel", role: .destructive) { confirmDelete = true }
                            .disabled(busy)
                            .accessibilityIdentifier("channel.edit.delete")
                    } footer: {
                        Text("It leaves everyone's sidebar and becomes read-only. Its history is kept.")
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Channel Options")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") { save() }
                        .disabled(busy || (!isGeneral && normalized.isEmpty))
                        .accessibilityIdentifier("channel.edit.save")
                }
            }
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
    }

    private func save() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await app.engine.updateChannel(
                    channelId: channel.id,
                    name: isGeneral ? nil : normalized,
                    topic: topic // "" clears
                )
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func remove() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await app.engine.archiveChannel(channel.id)
                if app.selectedChannelId == channel.id { app.selectChannel(nil) }
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
