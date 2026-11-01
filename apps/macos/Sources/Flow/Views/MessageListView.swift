import AppKit
import os
import SwiftUI

/// Scroll-memory decision log — release-visible on purpose (ids only, no
/// content), so a "position wasn't remembered" report on a production build
/// can be diagnosed after the fact with:
///   log show --last 1h --predicate 'subsystem == "im.freeflow.follow"'
/// Notice level, deliberately: info-level messages live only in the in-memory
/// buffer and evaporate when the app exits, which made the first field report
/// undiagnosable. Notice persists to the log store.
private let memoryLog = Logger(subsystem: "im.freeflow.follow", category: "memory")

struct MessageListView: View {
    let messages: [Message] // ascending by id
    let userNames: [String: String]
    var userStatuses: [String: String] = [:] // userId -> status emoji
    let currentUserId: String?
    let canPermanentlyDelete: Bool
    /// Engine + per-user lookups for the rows, passed by value so rows don't
    /// observe `AppState` (see `TranscriptContext`).
    let context: TranscriptContext
    let hasMore: Bool
    /// The channel's history page is still in flight (#191, ported from iOS).
    /// Drives the loading states below — an empty transcript with no
    /// explanation reads as a lost conversation on a slow link.
    var isLoadingHistory: Bool = false
    let showThreadAffordances: Bool
    /// Thread roots holding an unread notification for me (#270) — their reply
    /// chips get a dot, so a reply that needs you is visible here and not only
    /// in the sidebar badge.
    var unreadThreadRootIds: Set<String> = []
    let onLoadOlder: () -> Void
    let onOpenThread: (String) -> Void
    let onEdit: (Message) -> Void
    let onDelete: (Message, Bool) -> Void
    /// Tapping a sender's avatar opens their profile (ui_nits).
    var onOpenProfile: (String) -> Void = { _ in }
    /// Identifies whose transcript this is (channels pass their id), so the
    /// first load after a channel switch lands at the bottom exactly once —
    /// a new message later must not re-trigger that landing.
    var scrollKey: String? = nil
    /// Jump-to-message target (phase 12): scroll it into view + flash it once
    /// it's in the list, then call onFocused. Nil in the normal case.
    var focusMessageId: String? = nil
    var onFocused: () -> Void = {}
    /// Inline find (#518): the live query, empty when the bar is closed. Rows
    /// paint every occurrence of it in their own body.
    var searchQuery: String = ""
    /// The one match the find bar's cursor is on — painted stronger, and
    /// scrolled into view when it moves.
    var searchCursor: ChatSearch.Match? = nil

    /// Precomputed rows (grouping, day dividers, parsed markdown) rebuilt only
    /// when the message array actually changes — never per render pass. A
    /// plain class in `@State`: mutating it doesn't touch SwiftUI state, and
    /// its identity is stable across body evaluations.
    @State private var rowCache = TranscriptRowCache()
    /// The scrollKey we've already applied a restore/bottom decision for, so a
    /// new message in the *current* channel doesn't re-trigger a restore.
    @State private var appliedKey: String?
    /// The row currently flashing after a jump (fades out on a timer).
    @State private var flashId: String?
    /// The single owner of every follow/scroll decision (see
    /// `TranscriptFollowModel` — the old `followDecision` rules live there
    /// now, unchanged). All the drivers below feed it events and execute the
    /// one command it returns — nothing else calls `scrollTo` toward the
    /// bottom.
    @State private var followBox = TranscriptFollowBox(style: .topEdge)
    /// Mirror of `followBox.model.showJump`, written only when it changes — the one
    /// follow-model output SwiftUI renders from (see TranscriptFollowBox).
    @State private var jumpSignal = false
    /// The jump pill, debounced: `followBox.model.showJump` must hold for a beat
    /// before the pill mounts, so a transient measurement (a composer resize,
    /// a glue scroll landing a few points short) can never flicker it up.
    @State private var showPill = false
    /// The first message on screen when "Load earlier messages" was clicked.
    /// When the older page prepends, this row is put back at the top of the
    /// viewport — without it the scroll offset stays top-relative and every
    /// visible row shifts down by the height of the new content.
    @State private var loadOlderAnchorId: String?
    /// A scroll-memory restore in its settling window: the remembered row is
    /// re-anchored to the top a few times while attachments above it size.
    @State private var pendingRestoreId: String?

    private static let scrollSpace = "messageScroll"
    /// When to re-assert the bottom after a (re)landing, in nanoseconds from
    /// the previous pass — the same cadence as iOS.
    private static let settleDelays: [UInt64] = [50_000_000, 150_000_000, 400_000_000]

    /// Executes a follow-model command. The one place this list scrolls to
    /// its end.
    /// Mirror the pill signal into SwiftUI state, only on change.
    private func syncSignals() {
        if followBox.model.showJump != jumpSignal { jumpSignal = followBox.model.showJump }
    }

    private func run(_ command: TranscriptFollowModel.Command, _ proxy: ScrollViewProxy) {
        defer { syncSignals() }
        guard case .stick(let animated) = command, let lastKey = messages.lastRowKey else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.15)) {
                proxy.scrollTo(lastKey, anchor: .bottom)
            }
        } else {
            proxy.scrollTo(lastKey, anchor: .bottom)
        }
    }

    /// Below this many messages the transcript renders eagerly (plain
    /// VStack). LazyVStack's row-height *estimates* are the root of the
    /// parked/blank-open family (#280 and descendants): in short channels of
    /// tall messages they ran ~2x off, so the viewport could sit over phantom
    /// estimate space — a blank screen — while the content frame measured as
    /// perfectly bottom-aligned, and every corrective scroll just re-rolled
    /// the estimates (the layout never settled). A fresh channel open loads
    /// one ~50-message page, so eager covers every first paint; only deep
    /// Load-earlier histories stay lazy.
    private static let eagerRowLimit = 100

    /// Eager below `eagerRowLimit`, lazy above (see the limit's comment).
    @ViewBuilder
    private func transcriptStack<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        if messages.count <= Self.eagerRowLimit {
            VStack(alignment: .leading, spacing: 0, content: content)
        } else {
            LazyVStack(alignment: .leading, spacing: 0, content: content)
        }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                transcriptStack {
                    // With something cached, the top of the list says the rest
                    // is still coming, instead of the transcript simply
                    // starting wherever the cache happens to end (#191). With
                    // nothing cached the centered state below speaks instead,
                    // so the two never both appear. Once the page lands this
                    // becomes the ordinary "Load earlier messages" affordance.
                    if isLoadingHistory, !messages.isEmpty {
                        loadingRow("Loading earlier messages…")
                    } else if hasMore {
                        HStack {
                            Spacer()
                            Button("Load earlier messages") {
                                // Reading history is a decision to leave the
                                // end: unpin, remember the current top row,
                                // and restore it once the page lands.
                                loadOlderAnchorId = messages.first?.id
                                followBox.model.positionRestored(atBottom: false)
                                onLoadOlder()
                            }
                            .buttonStyle(.link)
                            .flowFont(.callout)
                            .pointingHandCursor()
                            .accessibilityIdentifier("transcript.loadOlder")
                            Spacer()
                        }
                        .padding(.vertical, 8)
                    }
                    // Keyed on clientMsgId, not TranscriptRow's message id:
                    // the optimistic row and its server echo must be one
                    // element with a changed value, not a delete + insert
                    // sharing an `.id()` — see ThreadPanelView (#328).
                    ForEach(rowCache.rows(for: messages), id: \.message.rowKey) { row in
                        VStack(alignment: .leading, spacing: 0) {
                            if row.startsNewDay {
                                DayDividerView(iso: row.message.createdAt)
                            }
                            if row.message.systemKind != nil {
                                SystemLineView(text: row.message.body)
                            } else {
                                MessageRow(
                                    message: row.message,
                                    segments: row.segments,
                                    userNames: userNames,
                                    userStatuses: userStatuses,
                                    currentUserId: currentUserId,
                                    canPermanentlyDelete: canPermanentlyDelete,
                                    context: context,
                                    showHeader: row.showsHeader,
                                    showThreadAffordances: showThreadAffordances,
                                    threadUnread: unreadThreadRootIds.contains(row.message.id),
                                    highlighted: row.message.id == flashId,
                                    search: searchQuery.isEmpty ? nil : ChatSearch.RowHighlight(
                                        query: searchQuery,
                                        currentOccurrence: searchCursor?.messageId == row.message.id
                                            ? searchCursor?.occurrence : nil
                                    ),
                                    onOpenThread: onOpenThread,
                                    onEdit: onEdit,
                                    onDelete: onDelete,
                                    onOpenProfile: onOpenProfile
                                )
                                // Skip the row's body when nothing it renders
                                // changed — its == ignores the closures, which
                                // are recreated on every list evaluation.
                                .equatable()
                            }
                        }
                        // Keyed on clientMsgId, not id: the optimistic row and
                        // its server echo share a clientMsgId but not an id,
                        // so keying on id remounts the row (and its avatar
                        // image) the moment the echo lands.
                        .id(row.message.rowKey)
                        // Scroll memory's recorder: each row reports itself
                        // when it crosses the viewport top; only one does, so
                        // the preference resolves to the top-visible message.
                        // Passive — it observes geometry and never scrolls, so
                        // it cannot become the second driver the NOTE below
                        // warns about.
                        .background(
                            GeometryReader { geo in
                                let f = geo.frame(in: .named(Self.scrollSpace))
                                Color.clear.preference(
                                    key: TopVisibleMessageKey.self,
                                    // Probed just inside the list's top
                                    // padding, so the first row still counts
                                    // when scrolled all the way up.
                                    value: f.minY <= 16 && f.maxY > 16 ? row.message.id : nil
                                )
                            }
                        )
                    }
                }
                .padding(.vertical, 8)
                // Scroll tracking (#111) + the pinned followBox.model. Every geometry
                // change goes through the follow model, and its commands only
                // ever target the same bottom edge as .defaultScrollAnchor, so
                // the two can't disagree the way the removed
                // scrollPosition(id:) did (see the note below).
                .background(
                    GeometryReader { geo in
                        let frame = geo.frame(in: .named(Self.scrollSpace))
                        Color.clear
                            .onAppear { _ = followBox.model.contentChanged(to: frame) }
                            .onChange(of: frame) { _, new in
                                // Content moved or resized. The model decides:
                                // re-pin near the bottom, unpin on an upward
                                // scroll, glue after growth under a pinned
                                // reader (the id-driven follow below fires
                                // before a new row has a height, and not at
                                // all when an existing row grows late).
                                run(followBox.model.contentChanged(to: new), proxy)
                            }
                    }
                )
            }
            .coordinateSpace(name: Self.scrollSpace)
            .background(
                GeometryReader { geo in
                    Color.clear
                        .onAppear { _ = followBox.model.viewportChanged(to: geo.size.height) }
                        .onChange(of: geo.size.height) { _, new in
                            // The composer growing (a wrapping draft, the
                            // attachment tray, the suggestion bar) shrinks
                            // this viewport. A pinned reader is carried to
                            // the newest message once the numbers are real —
                            // the correction whose absence let the transcript
                            // scroll into empty space and blank mid-typing.
                            run(followBox.model.viewportChanged(to: new), proxy)
                        }
                }
            )
            .overlay { emptyTranscriptState }
            .overlay(alignment: .bottom) { jumpToLatest(proxy) }
            .animation(.easeOut(duration: 0.15), value: showPill)
            // The pill mounts only after the model has wanted it for a beat.
            .task(id: jumpSignal) {
                if jumpSignal {
                    try? await Task.sleep(nanoseconds: 150_000_000)
                    if !Task.isCancelled { showPill = true }
                } else {
                    showPill = false
                }
            }
            // NOTE (scroll-blanking fix): a `.scrollPosition(id:)` modifier
            // used to sit here feeding MessageScrollMemory. It never tracked
            // anything (no `scrollTargetLayout()`), and it installed a second
            // scroll driver alongside .defaultScrollAnchor(.bottom) — when
            // the composer changed height the two disagreed and the list
            // scrolled into empty space, blanking the transcript. Scroll
            // memory is back, built the way that note demanded: the recorder
            // is a passive per-row preference (see the rows above), and the
            // restore below goes through TranscriptFollowModel — there is
            // still exactly one scroll driver.
            .onPreferenceChange(TopVisibleMessageKey.self) { topId in
                // Record only a *back-scrolled* position, in steady state —
                // never mid-restore (appliedKey), never mid-jump. A reader at
                // the bottom clears their entry: bottom is where a return
                // lands by default, and restoring "newest at the top" would
                // push them a viewport up from where they were.
                guard let key = scrollKey, key == appliedKey, focusMessageId == nil else { return }
                if followBox.model.pinned {
                    memoryLog.notice("clear \(key, privacy: .public)")
                    MessageScrollMemory.clear(key)
                } else if let topId {
                    memoryLog.notice("record \(key, privacy: .public) top=\(topId, privacy: .public)")
                    MessageScrollMemory.record(key, topMessageId: topId)
                } else if followBox.model.contentFrame.minY > -24, let firstId = messages.first?.id {
                    // Parked at the very top: no row crosses the probe line —
                    // the Load-earlier control sits there — so the reader's
                    // final position was never captured, and returning to
                    // this channel forgot "I was at the top" (the
                    // #message-search report). The content's own top edge
                    // being at the viewport top is that position.
                    memoryLog.notice("record \(key, privacy: .public) top=first:\(firstId, privacy: .public)")
                    MessageScrollMemory.record(key, topMessageId: firstId)
                }
            }
            .onChange(of: messages.last?.id) { _, newId in
                // A pending jump owns the scroll position — skip both the
                // restore/landing and the follow-to-bottom (tryFocus handles
                // the scroll, and marks appliedKey so this doesn't re-land
                // once the target is cleared).
                guard focusMessageId == nil, let newId else { return }
                if scrollKey != appliedKey {
                    // The channel just (re)loaded: back to where the reader
                    // left off if the memory is fresh (10 min) and the row is
                    // still loaded, else land at the bottom.
                    appliedKey = scrollKey
                    let remembered = scrollKey.flatMap { MessageScrollMemory.fresh($0) }
                    if let remembered, let rememberedKey = messages.rowKey(forMessageId: remembered) {
                        // Mid-history: unpin so no glue fights the restore.
                        memoryLog.notice("restore hit \(remembered, privacy: .public)")
                        followBox.model.positionRestored(atBottom: false)
                        followBox.model.landingIssued()
                        proxy.scrollTo(rememberedKey, anchor: .top)
                        // Re-anchored again below as attachments size — a row
                        // above the target growing late pushes the whole
                        // restore down a viewport (the storms-video effect).
                        pendingRestoreId = remembered
                    } else if remembered != nil, let firstId = messages.first?.id,
                              let firstKey = messages.firstRowKey {
                        // Remembered, but the row slid outside the message
                        // window (a reader parked at the top is one new
                        // message away from this). The top of the window is
                        // the close approximation; the bottom is the worst.
                        memoryLog.notice("restore miss -> window top \(firstId, privacy: .public)")
                        followBox.model.positionRestored(atBottom: false)
                        followBox.model.landingIssued()
                        proxy.scrollTo(firstKey, anchor: .top)
                        pendingRestoreId = firstId
                    } else {
                        memoryLog.notice("restore none -> bottom")
                        followBox.model.positionRestored(atBottom: true)
                        followBox.model.landingIssued()
                        if let lastKey = messages.lastRowKey {
                            proxy.scrollTo(lastKey, anchor: .bottom)
                        }
                    }
                } else {
                    // A genuinely new message in the current channel. The model
                    // follows it down only while pinned — someone reading
                    // back-scroll keeps their place and gets the jump button
                    // instead (#111) — except my own message, which always
                    // re-pins: I just pressed send (web/iOS parity).
                    let own = currentUserId != nil && messages.last?.userId == currentUserId
                    run(followBox.model.lastMessageChanged(isOwn: own), proxy)
                }
            }
            // "Load earlier" landed: put the row the reader was looking at
            // back at the top of the viewport. Consumed once — a later
            // prepend from a reconnect backfill must not scroll anywhere.
            .onChange(of: messages.first?.id) { _, _ in
                guard let anchor = loadOlderAnchorId else { return }
                loadOlderAnchorId = nil
                if let anchorKey = messages.rowKey(forMessageId: anchor) {
                    proxy.scrollTo(anchorKey, anchor: .top)
                }
            }
            // First open must land on the newest message: scrollTo from
            // onAppear runs before the rows are laid out and under-scrolls,
            // so anchor the scroll view at the bottom instead. On macOS 15+
            // the anchor is scoped to initial offset + alignment, exactly as
            // iOS did in #159: the all-roles form also re-anchors on *content
            // size changes*, and an async image or video thumb finishing its
            // load right after a scroll-memory restore yanked the reader back
            // to the bottom — the restore visibly "not working" on any
            // channel with attachments. Growth while pinned is the follow
            // model's job (glue + lastMessageChanged), which respects the pin
            // state; the anchor must not compete. macOS 14 has no role API
            // and keeps the all-roles form.
            .modifier(MacBottomAnchor())
            // A jump target owns the scroll position for its whole lifetime —
            // from set (possibly while older pages load in) to cleared.
            .onChange(of: focusMessageId) { _, new in
                followBox.model.focusActive = new != nil
                tryFocus(proxy)
            }
            // A jump target may arrive only after older history pages in.
            .onChange(of: messages.count) { _, _ in tryFocus(proxy) }
            // The find cursor owns the scroll position exactly like a jump
            // target does, for as long as it exists (#518).
            .onChange(of: searchCursor) { _, new in
                guard let new else {
                    // Bar closed (or query cleared): hand the position back to
                    // the follow model without moving anything.
                    if searchQuery.isEmpty { followBox.model.focusActive = false }
                    return
                }
                guard let key = messages.rowKey(forMessageId: new.messageId) else { return }
                followBox.model.focusEngaged()
                withAnimation(.easeInOut(duration: 0.2)) {
                    proxy.scrollTo(key, anchor: .center)
                }
                appliedKey = scrollKey
            }
            .onAppear {
                followBox.model.focusActive = focusMessageId != nil
                tryFocus(proxy)
            }
            // The settle passes, ported from iOS: with the anchor's
            // size-change role gone (MacBottomAnchor), landings are entirely
            // the model's job, and a landing scroll issued before rows have
            // real heights can come up short with nothing left to correct it.
            // Re-assert the end a few times while layout settles. The model
            // stands down the moment the reader owns the position (unpinned,
            // restore, jump), so this can never fight a back-scroll.
            .task(id: messages.first?.id) {
                guard !messages.isEmpty else { return }
                for delay in Self.settleDelays {
                    try? await Task.sleep(nanoseconds: delay)
                    let command = followBox.model.settleCommand()
                    guard case .stick = command else { return }
                    run(command, proxy)
                }
            }
            // The arrival settle (#334): the follow above fires the instant a
            // new message lands — before its row has a height — so the scroll
            // comes up short and an incoming reply sits below the fold. The
            // glue corrects that when the row sizes, but only if a geometry
            // event actually arrives; this belt re-asserts the end across the
            // settling window either way. Keyed on the row identity, not the
            // message id, so an optimistic row reconciling with its echo
            // doesn't re-run it (#312/#329). Gated entirely on the model —
            // a back-scrolled, focused or mid-drag reader gets `.none`.
            .task(id: messages.lastRowKey) {
                guard !messages.isEmpty else { return }
                for delay in Self.settleDelays {
                    try? await Task.sleep(nanoseconds: delay)
                    let command = followBox.model.arrivalSettleCommand()
                    guard case .stick = command else { return }
                    run(command, proxy)
                }
            }
            // The restore's own settle: a scroll-memory restore is issued
            // before attachments above the target have sized, and a late
            // growth pushes the whole restore down a viewport. Re-anchor the
            // remembered row through the settling window. Stops early if the
            // reader takes over: scrolling back to the end re-pins, and a
            // jump target owns the position outright.
            .task(id: pendingRestoreId) {
                guard let target = pendingRestoreId else { return }
                for delay in Self.settleDelays + [800_000_000] {
                    try? await Task.sleep(nanoseconds: delay)
                    // Deliberately NOT gated on the pin state: the drift this
                    // corrects can itself flip the pin (field trail: content
                    // shrinking above the target slid the reader to within
                    // the re-pin slack, and the old gate read that as
                    // "reader took over" and quit). Only a jump target or
                    // the row leaving the window stops the window.
                    guard !followBox.model.focusActive,
                          let targetKey = messages.rowKey(forMessageId: target) else { break }
                    followBox.model.positionRestored(atBottom: false)
                    followBox.model.landingIssued()
                    proxy.scrollTo(targetKey, anchor: .top)
                }
                pendingRestoreId = nil
            }
        }
    }

    /// A spinner and a line of text, for the two places the list has to say
    /// "still arriving" rather than render nothing (#191).
    private func loadingRow(_ text: String) -> some View {
        HStack(spacing: 8) {
            Spacer()
            ProgressView().controlSize(.small)
            Text(text)
                .flowFont(.callout)
                .foregroundStyle(MC.faint)
            Spacer()
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("msg.loading")
    }

    /// Nothing to show yet. An empty transcript is two different situations —
    /// history still on its way, or a conversation with nothing in it — and
    /// both used to render as bare background here, so a slow link looked
    /// exactly like a lost conversation (#191, ported from iOS).
    @ViewBuilder
    private var emptyTranscriptState: some View {
        if messages.isEmpty {
            if isLoadingHistory {
                loadingRow("Loading conversation…")
            } else {
                Text("No messages yet")
                    .flowFont(.callout)
                    .foregroundStyle(MC.faint)
                    .accessibilityIdentifier("msg.emptyChannel")
            }
        }
    }

    /// Floating "Latest msgs ↓" pill, shown while the reader is above the end
    /// of the transcript (#111) — debounced through `showPill`, so it only
    /// appears once the model has wanted it for a beat. Tapping it returns to
    /// the newest message.
    @ViewBuilder
    private func jumpToLatest(_ proxy: ScrollViewProxy) -> some View {
        if showPill, !messages.isEmpty {
            Button {
                run(followBox.model.jumpTapped(), proxy)
            } label: {
                Text("Latest msgs ↓")
                    .flowFont(size: 12, weight: .semibold)
                    .foregroundStyle(MC.accentSoft)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(.white).shadow(color: MC.ink.opacity(0.14), radius: 4, y: 1))
                    .overlay(Capsule().strokeBorder(MC.hairline, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .pointingHandCursor()
            .padding(.bottom, 10)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
            .accessibilityIdentifier("msg.jumpToLatest")
        }
    }

    /// Center + flash the jump target once it's actually in the list, then
    /// release the target (paging in ChannelView brings it in if it's old).
    private func tryFocus(_ proxy: ScrollViewProxy) {
        guard let fid = focusMessageId, let key = messages.rowKey(forMessageId: fid) else { return }
        followBox.model.focusEngaged() // stop the bottom-glue from fighting the centering scroll
        withAnimation(.easeInOut(duration: 0.25)) {
            proxy.scrollTo(key, anchor: .center)
        }
        // The jump decided this channel's scroll position — mark it applied so
        // the scroll-memory restore doesn't yank away once focus is cleared.
        appliedKey = scrollKey
        flashId = fid
        onFocused()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            withAnimation(.easeOut(duration: 0.6)) {
                if flashId == fid { flashId = nil }
            }
        }
    }

}

/// Centered "Today" / date pill between days (design 3a).
/// Bottom scroll anchor with the size-change role removed on macOS 15+ (see
/// the comment at the use site). The macOS twin of iOS's `BottomAnchor`.
struct MacBottomAnchor: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(.bottom, for: .alignment)
        } else {
            content.defaultScrollAnchor(.bottom)
        }
    }
}

/// The message whose row crosses the viewport's top edge — scroll memory's
/// recorder input. Exactly one row reports a non-nil id (its frame spans the
/// probe line), so the reduction is a plain first-non-nil.
private struct TopVisibleMessageKey: PreferenceKey {
    static let defaultValue: String? = nil
    static func reduce(value: inout String?, nextValue: () -> String?) {
        value = value ?? nextValue()
    }
}

struct DayDividerView: View {
    let iso: String

    var body: some View {
        HStack {
            Spacer()
            Text(label)
                .flowFont(size: 11)
                .foregroundStyle(MC.faint)
                .padding(.horizontal, 12)
                .padding(.vertical, 3)
                .background(Capsule().fill(MC.daypill))
            Spacer()
        }
        .padding(.vertical, 6)
    }

    private var label: String {
        guard let date = ISO8601.parse(iso) else { return "" }
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.month(.wide).day())
    }
}

/// A channel event line (join/leave) — centered, muted, no avatar/header.
/// The text is the pre-rendered sentence ("Alice joined the channel").
struct SystemLineView: View {
    let text: String

    var body: some View {
        HStack {
            Spacer()
            Text(text)
                .flowFont(size: 11)
                .foregroundStyle(MC.faint)
            Spacer()
        }
        .padding(.vertical, 4)
    }
}

struct MessageRow: View, @preconcurrency Equatable {
    let message: Message
    /// Pre-parsed body blocks from the row model; nil (thread panel) falls
    /// back to parsing in place.
    var segments: [MarkdownBlocks.Segment]? = nil
    let userNames: [String: String]
    var userStatuses: [String: String] = [:]
    let currentUserId: String?
    let canPermanentlyDelete: Bool
    /// Engine + per-user lookups, passed by value: the row must not observe
    /// `AppState`, or every publish re-renders every visible row.
    let context: TranscriptContext
    let showHeader: Bool
    let showThreadAffordances: Bool
    /// This thread holds an unread notification for me (#270).
    var threadUnread: Bool = false
    /// Flashing after a jump-to-message (phase 12).
    var highlighted: Bool = false
    /// Inline find (#518): the query to paint, and — when the find bar's
    /// cursor is inside this row — which of its occurrences is the current one.
    var search: ChatSearch.RowHighlight? = nil
    let onOpenThread: (String) -> Void
    let onEdit: (Message) -> Void
    let onDelete: (Message, Bool) -> Void
    var onOpenProfile: (String) -> Void = { _ in }

    /// Everything the row *renders* — and only that. Closures are recreated
    /// on every parent evaluation and deliberately ignored (their behavior is
    /// stable); `segments` is derived from `message.body`, so comparing the
    /// message covers it. Combined with `.equatable()` at the use sites, this
    /// is what stops a 200-row transcript re-running every row body whenever
    /// the list's scroll-tracking state changes.
    static func == (a: MessageRow, b: MessageRow) -> Bool {
        a.message == b.message
            && a.showHeader == b.showHeader
            && a.showThreadAffordances == b.showThreadAffordances
            && a.threadUnread == b.threadUnread
            && a.highlighted == b.highlighted
            && a.search == b.search
            && a.currentUserId == b.currentUserId
            && a.canPermanentlyDelete == b.canPermanentlyDelete
            && a.userNames == b.userNames
            && a.userStatuses == b.userStatuses
            && a.context == b.context
    }

    @Environment(\.textZoom) private var textZoom
    @State private var hovering = false
    @State private var showReactionPicker = false
    @State private var showDeleteConfirm = false
    @State private var hoverHideWork: DispatchWorkItem?
    /// A pending row renders at full strength; it only dims (and shows the
    /// mini spinner) once the send has gone unconfirmed past this window.
    private static let pendingDimDelay: TimeInterval = 3
    @State private var pendingSlow = false

    /// "🕐 SCHEDULED" next to the author name (#424): the scheduler posted this
    /// message rather than its author typing it just now. Deliberately a badge
    /// on an otherwise ordinary message — the author, the mentions and the
    /// notifications are all real, and only the timing was automatic. Clicking
    /// it opens the Scheduled panel, where the row that posted it lives.
    private var scheduledBadge: some View {
        Button(action: context.onOpenScheduled) {
            Text("🕐 SCHEDULED")
                .flowFont(size: 10, weight: .bold)
                .foregroundStyle(MC.accentDeep)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 4).fill(MC.accent.opacity(0.12)))
        }
        .buttonStyle(.plain)
        .help("Posted automatically · runs as \(senderName) · click to open Scheduled")
        .accessibilityIdentifier("message.scheduledBadge.\(message.id)")
    }

    private var senderName: String { userNames[message.userId] ?? "Unknown" }
    private var isMine: Bool { message.userId == currentUserId }
    private var deleteMode: MessageDeleteMode? {
        // A provider that cannot delete gets no delete affordance at all (#546).
        guard caps.canUse(.delete) else { return nil }
        return MessageDeletePolicy.mode(
            isMine: isMine,
            isDeleted: message.isDeleted,
            isSystem: message.systemKind != nil,
            canPermanentlyDelete: canPermanentlyDelete
        )
    }
    /// The backend's capabilities, from the context so rows never observe
    /// `AppState` (#546). Hidden, not disabled, in the hover pill and context
    /// menu — same as the web row.
    private var caps: Capabilities { context.capabilities }
    private var deleteLabel: String {
        deleteMode == .permanent ? "Permanently Delete" : "Delete"
    }

    /// Hover-menu hysteresis (ui_nits: menu "stutters"/blinks while hovering).
    /// The toolbar is an overlay pinned to the row's top-trailing edge, so the
    /// cursor travelling from the message text up onto the pill briefly leaves
    /// the row's hover region. Flipping `hovering` off synchronously unmounts
    /// the pill mid-travel — the cursor is then over empty space, the row
    /// re-hovers, and it flickers back. Debounce the hide (and cancel it the
    /// moment the cursor lands on the pill, which carries its own `.onHover`)
    /// so the menu holds still long enough to aim at.
    private func setHovering(_ inside: Bool) {
        hoverHideWork?.cancel()
        if inside {
            hovering = true
        } else {
            let work = DispatchWorkItem { hovering = false }
            hoverHideWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if showHeader {
                Button {
                    onOpenProfile(message.userId)
                } label: {
                    AvatarChip(
                        userId: message.userId,
                        name: senderName,
                        avatarPath: avatarPath,
                        size: 38,
                        radius: 11
                    )
                }
                .buttonStyle(.plain)
                .help("View \(senderName)'s profile")
                .accessibilityIdentifier("message.avatar.\(message.userId)")
            } else {
                Color.clear.frame(width: 38, height: 1)
            }

            VStack(alignment: .leading, spacing: 2) {
                if showHeader {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(senderName)
                            .flowFont(size: 14, weight: .bold)
                            .foregroundStyle(MC.ink)
                        if let emoji = userStatuses[message.userId], !emoji.isEmpty {
                            Text(emoji).flowFont(size: 14)
                        }
                        Text(ISO8601.displayTime(message.createdAt))
                            .flowFont(size: 11)
                            .foregroundStyle(MC.faint)
                        if message.scheduled { scheduledBadge }
                    }
                }

                if message.pinnedAt != nil, !message.isDeleted {
                    Label("Pinned", systemImage: "pin.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(MC.accentSoft)
                        .help(pinnedHelp)
                        .accessibilityIdentifier("msg.pinned.\(message.id)")
                }

                if message.isDeleted {
                    Text("This message was deleted")
                        .flowFont(.callout)
                        .italic()
                        .foregroundStyle(.tertiary)
                } else {
                    // Parsed once in the row model; the fallback is for the
                    // thread panel, which builds rows directly.
                    let segments = self.segments ?? MarkdownBlocks.segments(message.body)
                    if !segments.isEmpty {
                        bodyContent(segments)
                    } else if pendingSlow {
                        ProgressView().controlSize(.mini)
                    }

                    ForEach(message.files) { file in
                        AttachmentView(file: file)
                    }

                    // Phase 11: link previews sit below the body/attachments
                    // and above reactions. Only the author may remove one.
                    ForEach(message.unfurls) { unfurl in
                        UnfurlCardView(
                            unfurl: unfurl,
                            canRemove: message.userId == currentUserId,
                            onRemove: {
                                Task {
                                    await context.engine.deleteUnfurl(
                                        messageId: message.id, urlHash: unfurl.urlHash)
                                }
                            },
                            onPin: { pinLinkAsArtifact(unfurl.target) }
                        )
                    }

                    if message.failed {
                        sendFailedFooter
                    }

                    if isThinkingRow, caps.canUse(.agents) {
                        interruptButton
                    }

                    if !message.reactions.isEmpty {
                        reactionChips
                    }
                }

                if showThreadAffordances, message.replyCount > 0 {
                    Button {
                        onOpenThread(message.id)
                    } label: {
                        HStack(spacing: 6) {
                            // A reply in here needs you (#270) — the sidebar
                            // badge says the channel has something, this says
                            // which thread.
                            if threadUnread {
                                Circle()
                                    .fill(MC.unread)
                                    .frame(width: 7, height: 7)
                                    .accessibilityIdentifier("msg.threadUnread")
                                    .accessibilityLabel("Unread reply")
                            }
                            // First-4 reply-author avatars (phase 5 item 7).
                            if !message.replyParticipantUserIds.isEmpty {
                                HStack(spacing: -6) {
                                    ForEach(message.replyParticipantUserIds, id: \.self) { uid in
                                        AvatarChip(
                                            userId: uid,
                                            name: userNames[uid] ?? "Unknown",
                                            avatarPath: context.avatarPaths[uid],
                                            size: 20,
                                            radius: 6
                                        )
                                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.white, lineWidth: 1.5))
                                    }
                                }
                                .accessibilityIdentifier("msg.threadParticipants")
                                .accessibilityLabel(
                                    message.replyParticipantUserIds
                                        .map { userNames[$0] ?? "Unknown" }.joined(separator: ", ")
                                )
                            }
                            Label(
                                "\(message.replyCount) \(message.replyCount == 1 ? "reply" : "replies")",
                                systemImage: "bubble.left.and.bubble.right"
                            )
                            .flowFont(.caption)
                        }
                    }
                    .buttonStyle(.link)
                    // Hand cursor on hover (ui_nits).
                    .pointingHandCursor()
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 22)
        .padding(.top, showHeader ? 10 : 1)
        .padding(.bottom, 1)
        .background(highlighted ? MC.unread.opacity(0.16) : Color.clear)
        .animation(.easeOut(duration: 0.6), value: highlighted)
        .opacity(pendingSlow ? 0.55 : 1)
        // Keyed off createdAt so a row remount mid-wait doesn't restart the
        // clock; the id change on pending -> confirmed resets the state.
        .task(id: message.pending) {
            guard message.pending else {
                pendingSlow = false
                return
            }
            let elapsed = ISO8601.parse(message.createdAt)
                .map { Date().timeIntervalSince($0) } ?? 0
            let remaining = Self.pendingDimDelay - elapsed
            if remaining > 0 {
                try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
            }
            if !Task.isCancelled { pendingSlow = true }
        }
        .contentShape(Rectangle())
        .onHover { setHovering($0) }
        // Confetti when a 🎉 lands (#524). On the whole row, so a message with
        // no reactions yet is already "seen" by the time the first one arrives
        // — the count-went-up rule itself lives in `CelebrationMemory`.
        .celebrationBursts(messageId: message.id, reactions: message.reactions)
        // Hover menu (web parity, ui_nits items 2+3): react / reply-in-thread,
        // plus edit + delete on the author's own messages. The menu must stay
        // mounted while the picker is open: the react button is the popover's
        // anchor, and moving the mouse toward the popover leaves the row
        // (hovering -> false) — unmounting the anchor would tear the popover
        // down (operator-reported bug at the item-6 checkpoint).
        .overlay(alignment: .topTrailing) {
            // No hover menu where nothing can be sent — an archived channel
            // (#590) is history only, as on web.
            if hovering || showReactionPicker || showDeleteConfirm, caps.canUse(.send),
               (!message.isDeleted || deleteMode == .permanent), !message.pending, !message.failed {
                hoverMenu
                    .padding(.trailing, 22)
            }
        }
        .confirmationDialog(
            deleteMode == .permanent ? "Permanently delete this message?" : "Delete this message?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button(deleteLabel, role: .destructive) {
                onDelete(message, deleteMode == .permanent)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if deleteMode == .permanent, message.threadRootId == nil, message.replyCount > 0 {
                Text("This will permanently delete the message and all \(message.replyCount) \(message.replyCount == 1 ? "reply" : "replies"). This can't be undone.")
            } else if deleteMode == .permanent {
                Text("This message will disappear for everyone. This can't be undone.")
            } else {
                Text("The message will be replaced by a deletion notice.")
            }
        }
        .contextMenu {
            if !message.isDeleted, !message.pending, !message.failed, caps.canUse(.reactions) {
                ForEach(Array(EmojiCatalog.quickReactions.prefix(6)), id: \.self) { emoji in
                    Button(emoji) {
                        Task { await context.engine.toggleReaction(messageId: message.id, emoji: emoji) }
                    }
                }
                Divider()
            }
            if message.failed {
                Button("Retry Send") { Task { await context.engine.retrySend(message) } }
                Button("Discard", role: .destructive) { Task { await context.engine.discardFailed(message) } }
                Divider()
            }
            if showThreadAffordances, !message.failed {
                Button("Reply in Thread") {
                    onOpenThread(message.threadRootId ?? message.id)
                }
            }
            if !message.body.isEmpty, !message.isDeleted, !message.pending {
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(message.body, forType: .string)
                }
            }
            if !message.isDeleted, !message.pending, !message.failed, caps.canUse(.pins) {
                Button(message.pinnedAt == nil ? "Pin Message" : "Unpin Message") {
                    Task { await context.engine.togglePin(message) }
                }
            }
            if !message.files.isEmpty, !message.isDeleted, !message.pending, caps.canUse(.artifacts) {
                Button("Pin as Artifact") { pinAsArtifact() }
            }
            if isMine, !message.isDeleted, !message.pending, caps.canUse(.edit) {
                Button("Edit…") { onEdit(message) }
            }
            if deleteMode != nil, !message.pending {
                Button(deleteLabel, role: .destructive) { showDeleteConfirm = true }
            }
        }
    }

    /// One-tap quick reactions shown first in the hover menu — same three
    /// glyphs and order as the web client's `QUICK_REACTIONS`.
    private static let quickReactions = ["👍", "👀", "🙌"]

    /// Web-parity hover menu card: white pill with hairline border, one
    /// borderless icon button per action (design 3a tokens). Buttons use the
    /// same emoji glyphs as the web client so the two menus read identically:
    /// three one-tap reactions, a hairline divider, then 🙂 / 💬 / 📋 / save /
    /// edit / delete gated by the same conditions.
    private var hoverMenu: some View {
        HStack(spacing: 2) {
            if !message.isDeleted {
                if caps.canUse(.reactions) {
                    ForEach(Self.quickReactions, id: \.self) { emoji in
                        MenuIconButton(help: "React \(emoji)") {
                            Task { await context.engine.toggleReaction(messageId: message.id, emoji: emoji) }
                        } label: {
                            Text(emoji)
                        }
                        .accessibilityIdentifier("msg.quickReact.\(emoji)")
                    }

                    Rectangle()
                        .fill(MC.hairline)
                        .frame(width: 1, height: 22)
                        .padding(.horizontal, 2)

                    MenuIconButton(help: "Add reaction") {
                        showReactionPicker = true
                    } label: {
                        Text("🙂")
                    }
                    .accessibilityIdentifier("msg.addReaction")
                    .popover(isPresented: $showReactionPicker) {
                        EmojiPickerView { emoji in
                            showReactionPicker = false
                            Task { await context.engine.toggleReaction(messageId: message.id, emoji: emoji) }
                        }
                    }
                } else {
                    // Web parity: the glyph stays, dimmed, and says why.
                    Text("🙂")
                        .opacity(0.4)
                        .padding(.horizontal, 4)
                        .help(caps[.reactions].reason ?? "Reactions are not available here.")
                        .accessibilityIdentifier("msg.addReaction.unavailable")
                }

                if showThreadAffordances {
                    MenuIconButton(help: "Reply in thread") {
                        onOpenThread(message.threadRootId ?? message.id)
                    } label: {
                        Text("💬")
                    }
                    .accessibilityIdentifier("msg.replyInThread")
                }

                if !message.body.isEmpty {
                    MenuIconButton(help: "Copy text") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(message.body, forType: .string)
                    } label: {
                        Text("📋")
                    }
                    .accessibilityIdentifier("msg.copy")
                }

                if caps.canUse(.pins) {
                    MenuIconButton(help: message.pinnedAt == nil ? "Pin message" : "Unpin message") {
                        Task { await context.engine.togglePin(message) }
                    } label: {
                        Image(systemName: message.pinnedAt == nil ? "pin" : "pin.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(message.pinnedAt == nil ? MC.inkSoft : MC.accentSoft)
                    }
                    .accessibilityIdentifier("msg.togglePin")
                }

                if !message.files.isEmpty, caps.canUse(.artifacts) {
                    MenuIconButton(help: "Pin as artifact", action: pinAsArtifact) {
                        // Web draws this one as an inline SVG (box + leaving arrow);
                        // the matching SF Symbol keeps the same open-external read.
                        Image(systemName: "arrow.up.right.square")
                            .flowFont(size: 15)
                            .foregroundStyle(MC.inkSoft)
                    }
                    .accessibilityIdentifier("msg.saveArtifact")
                }

                if isMine, caps.canUse(.edit) {
                    MenuIconButton(help: "Edit") {
                        onEdit(message)
                    } label: {
                        Text("✏️")
                    }
                    .accessibilityIdentifier("msg.edit")
                }
            }
            if deleteMode != nil {
                MenuIconButton(help: deleteLabel) {
                    showDeleteConfirm = true
                } label: {
                    Text("🗑")
                }
                .accessibilityIdentifier("msg.delete")
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(.white)
                .shadow(color: MC.ink.opacity(0.08), radius: 2, y: 1)
        )
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(MC.hairline, lineWidth: 1))
        // The pill sits outside the row's tracked area, so it carries its own
        // hover: landing on it cancels the pending hide and keeps the menu up.
        .contentShape(Rectangle())
        .onHover { setHovering($0) }
    }

    private var pinnedHelp: String {
        guard let pinner = message.pinnedBy else { return "Pinned to this channel" }
        return "Pinned by \(userNames[pinner] ?? "a channel member")"
    }

    /// One borderless glyph button in the hover pill. Mirrors the web buttons'
    /// `rounded-md px-1.5 py-1 … hover:bg-daypill`: a rounded daypill highlight
    /// appears under the glyph on hover.
    ///
    /// The label is drawn as our own tooltip rather than with `.help()` (#110):
    /// AppKit help tags never appeared for these buttons — the pill is mounted
    /// on hover, so it isn't around when AppKit arms its tooltip rects — and
    /// the system delay is far too long for a menu you're only over for a
    /// moment. VoiceOver still gets the text as the button's label.
    private struct MenuIconButton<Label: View>: View {
        let help: String
        let action: () -> Void
        @ViewBuilder let label: () -> Label
        @State private var hovering = false
        @State private var showTip = false
        @State private var tipWork: DispatchWorkItem?

        var body: some View {
            Button {
                hideTip()
                action()
            } label: {
                label()
                    .flowFont(size: 15)
                    .frame(width: 26, height: 24)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(hovering ? MC.daypill : .clear)
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(help)
            .onHover { inside in
                hovering = inside
                if inside { scheduleTip() } else { hideTip() }
            }
            .onDisappear { hideTip() }
            .overlay(alignment: .top) {
                if showTip { tooltip }
            }
            // Lift the tip above the neighbouring buttons in the pill.
            .zIndex(showTip ? 1 : 0)
        }

        private var tooltip: some View {
            Text(help)
                .flowFont(size: 11)
                .foregroundStyle(.white)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 6).fill(MC.ink.opacity(0.92)))
                .fixedSize()
                .offset(y: 30)
                .allowsHitTesting(false)
                .transition(.opacity)
                .accessibilityHidden(true)
        }

        private func scheduleTip() {
            tipWork?.cancel()
            let work = DispatchWorkItem { showTip = true }
            tipWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work)
        }

        private func hideTip() {
            tipWork?.cancel()
            tipWork = nil
            showTip = false
        }
    }

    /// Pins the message's attached file(s) as shared artifacts in this channel
    /// (phase 13, idempotent server-side); the newly created artifact opens in
    /// the side panel automatically.
    private func pinAsArtifact() {
        let files = message.files
        guard !files.isEmpty else { return }
        let channelId = message.channelId
        Task {
            do {
                var last: Artifact?
                for file in files {
                    last = try await context.engine.createArtifact(channelId: channelId, fileId: file.id)
                }
                if let last { context.onSelectArtifact(last.id) }
            } catch {
                context.onError("Couldn't pin artifact: \(error.localizedDescription)")
            }
        }
    }

    /// Pins a link from chat as a shared co-browsing artifact in this channel
    /// (link artifacts) and opens its mini-browser in the side panel.
    private func pinLinkAsArtifact(_ url: String) {
        let channelId = message.channelId
        Task {
            do {
                let artifact = try await context.engine.createLinkArtifact(channelId: channelId, url: url)
                context.onSelectArtifact(artifact.id)
            } catch {
                context.onError("Couldn't pin link: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Body blocks (phase-3.5 ruling 2)

    /// Block-level body rendering: paragraphs keep the existing inline
    /// attributed pass (mention pills, inline markdown); quote runs get a
    /// 3pt accent bar with "> " markers stripped; fenced code renders as
    /// monospaced text in a warm block with the fence markers hidden (no
    /// pills or markdown inside code).
    @ViewBuilder
    private func bodyContent(_ segments: [MarkdownBlocks.Segment]) -> some View {
        // Find matches are numbered per message (#518), so each block needs to
        // know how many came before it to recognise the current one as its own.
        let bases = search.map {
            ChatSearch.segmentBases(segments, names: userNames, query: $0.query)
        }
        return Group {
            if let report = ArtifactReference.parse(message.body) {
                ArtifactOpenButton(title: report.title, artifactId: report.id)
            } else if segments.count == 1, case .paragraph(let text) = segments[0] {
                // Fast path: single plain paragraph keeps the original inline
                // layout (baseline-aligned edited/pending markers).
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    paragraphText(text, base: 0)
                    trailingMarkers
                }
            } else {
                HStack(alignment: .bottom, spacing: 4) {
                    VStack(alignment: .leading, spacing: Self.blockSpacing * textZoom) {
                        ForEach(Array(segments.enumerated()), id: \.offset) { index, segment in
                            segmentView(segment, base: bases?[index] ?? 0)
                        }
                    }
                    trailingMarkers
                }
            }
        }
        // The body must never be the view that gives way (#161). It shares the
        // row's VStack with attachments, unfurl cards and reactions, and a
        // multiline `Text` is the only flexible one of them: when the row's
        // ideal height exceeds the height the message list proposes, SwiftUI
        // compresses the text and the body renders cut off partway through,
        // with the card below it sitting where the rest of the prose should
        // be. `fixedSize` vertically makes the body report its wrapped height
        // as its ideal *and* its minimum, so the row grows instead. Width
        // stays flexible, so wrapping is unchanged.
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func segmentView(_ segment: MarkdownBlocks.Segment, base: Int) -> some View {
        switch segment {
        case .paragraph(let text):
            paragraphText(text, base: base)
        case .quote(let text):
            // The accent bar is an overlay, not an HStack sibling (#195). A
            // Shape has no ideal height, so as a sibling it reported an
            // unbounded height range and the body VStack handed it space the
            // quoted text needed — the bar ran on below the last line and the
            // prose above it truncated. As an overlay it is proposed the
            // text's own size, so the text alone sets the block height and the
            // bar spans exactly the quote. Leading padding = bar width + the
            // old HStack spacing, so the text sits where it always did.
            paragraphText(text, base: base)
                .foregroundStyle(MC.inkSoft)
                .padding(.leading, 11)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(MC.accent.opacity(0.55))
                        .frame(width: 3)
                }
                .accessibilityIdentifier("msg.quoteBlock")
        case .heading(let level, let text):
            headingText(level: level, text: text, base: base)
        case .code(let text):
            // Trailing padding is wider than the leading side to leave the copy
            // button (#260) a lane of its own, so it never lands on the code.
            // Bottom rather than top: the row's hover menu is a `.topTrailing`
            // overlay, and a button you reach for by hovering cannot sit under
            // the toolbar that hovering summons.
            // Code is drawn verbatim, so it is searched verbatim — the
            // AttributedString carries only the find highlight; the font and
            // colour still come from the modifiers below.
            Text(highlighted(text.isEmpty ? " " : text, base: base))
                .flowFont(size: 12, design: .monospaced)
                .foregroundStyle(MC.ink)
                .textSelection(.enabled)
                .padding(.leading, 10)
                .padding(.trailing, 36)
                .padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 8).fill(MC.codeBg))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(MC.hairline, lineWidth: 1))
                .overlay(alignment: .bottomTrailing) {
                    CodeCopyButton(source: text).padding(4)
                }
                .accessibilityIdentifier("msg.codeBlock")
        case .mermaid(let source):
            MermaidDiagramView(source: source)
        case .table(let header, let align, let rows):
            MarkdownTableView(
                header: header, align: align, rows: rows,
                userNames: userNames, currentUserId: currentUserId
            )
        case .ulist(let items):
            listView(items.map { (marker: "•", text: $0) }, bulleted: true, base: base)
        case .olist(let start, let items):
            listView(
                items.enumerated().map { (marker: "\(start + $0.offset).", text: $0.element) },
                bulleted: false,
                base: base
            )
        case .hr:
            Rectangle()
                .fill(MC.hairline)
                .frame(height: 1)
                .padding(.vertical, 3) // web's my-2 on <hr>
                .accessibilityIdentifier("msg.rule")
        }
    }

    /// Bullet and numbered lists: web uses `<ul class="list-disc pl-5">` /
    /// `<ol start=…>`, so the native analogue is a marker column plus the
    /// normal inline pass on each item — mentions and `**bold**` still work
    /// inside items. Markers are right-aligned in a fixed column so multi-digit
    /// numbers keep their text edges lined up.
    ///
    /// Spacing and marker weight come from web (#387): a `list-disc` item is a
    /// 21px line box with `space-y-0.5` between items — a 23px pitch on a 14px
    /// font, which at our 13pt body is `bodyLineHeight + listSpacing`. The disc
    /// is drawn **bold at body size**, not larger: the marker shares the row's
    /// baseline alignment, so a bigger font would make the row itself taller
    /// and leave bullet lists looser than numbered ones. Bold widens the glyph
    /// to about web's disc without touching the line box. Markers take the text
    /// colour, as web's `currentColor` ones do, instead of the softer ink.
    private func listView(
        _ items: [(marker: String, text: String)], bulleted: Bool, base: Int
    ) -> some View {
        // Each item is its own searchable string, so the running offset walks
        // the list the same way the eye does (#518).
        var running = base
        let itemBases: [Int] = items.map { item in
            let at = running
            if let search {
                running += ChatSearch.ranges(
                    in: ChatSearch.renderedText(item.text, names: userNames), query: search.query
                ).count
            }
            return at
        }
        return VStack(alignment: .leading, spacing: Self.listSpacing * textZoom) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(item.marker)
                        .flowFont(.callout, weight: bulleted ? .bold : nil)
                        .foregroundStyle(MC.ink)
                        .frame(minWidth: 14, alignment: .trailing)
                    paragraphText(item.text, base: itemBases[index])
                }
            }
        }
        .padding(.leading, 2)
        .accessibilityIdentifier("msg.list")
    }

    /// ATX headings, sized as the macOS analogue of web's scale rather than a
    /// copy of its Tailwind classes: body text is `.callout` (13pt), so h1/h2
    /// step up by web's own ratios (1.29×, 1.2×) and h3–h6 stay body-size,
    /// distinguished by weight — which is what `HEADING_CLASS` does. Sizes go
    /// through `flowFont(size:)` so text zoom (#105) still applies, and the
    /// inline pass runs inside the heading so mentions and `**bold**` work.
    private func headingText(level: Int, text: String, base: Int) -> some View {
        let size: CGFloat = level == 1 ? 17 : (level == 2 ? 15.5 : 13)
        let attributed = inlineText(text, base: base)
        return Text(attributed)
            .flowFont(size: size, weight: level <= 3 ? .bold : .semibold)
            .foregroundStyle(MC.ink)
            .textSelection(.enabled)
            // Measured at the heading's own size, not body size (#276): an h1
            // link is a third wider than the callout re-layout thinks.
            .linkCursor(attributed, size: size)
            .padding(.top, level <= 2 ? 2 : 0) // web's mt-2 on h1/h2
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("msg.heading")
    }

    /// Body rhythm ported from web (#387), where the message body is
    /// `text-sm leading-normal` — 14px text on a 1.5 line-height — and blocks
    /// carry `my-1`. Our body is 13pt, so the same ratio wants ~19.5pt line
    /// boxes against the ~16pt AppKit draws by default; `lineSpacing` makes up
    /// the difference. Everything scales with the text zoom, like the fonts do.
    static let lineSpacing: CGFloat = 3.5
    static let listSpacing: CGFloat = 6
    static let blockSpacing: CGFloat = 10

    /// One inline span, rendered and then find-highlighted (#518). `base` is
    /// how many of this message's matches came before this span, so the row can
    /// tell which occurrence — if any — is the find bar's current one.
    private func inlineText(_ text: String, base: Int) -> AttributedString {
        var attributed = MentionRendering.attributed(
            text, names: userNames, currentUserId: currentUserId,
            scale: textZoom, codeChips: true
        )
        if let search {
            ChatSearch.paint(
                &attributed,
                query: search.query,
                currentOccurrence: search.currentOccurrence.map { $0 - base }
            )
        }
        return attributed
    }

    /// A verbatim run (a code block) with the find highlight applied.
    private func highlighted(_ text: String, base: Int) -> AttributedString {
        var attributed = AttributedString(text)
        if let search {
            ChatSearch.paint(
                &attributed,
                query: search.query,
                currentOccurrence: search.currentOccurrence.map { $0 - base }
            )
        }
        return attributed
    }

    private func paragraphText(_ text: String, base: Int) -> some View {
        let attributed = inlineText(text, base: base)
        return Text(attributed)
            .flowFont(.callout)
            .lineSpacing(Self.lineSpacing * textZoom)
            .textSelection(.enabled)
            // Hand cursor over hyperlinks (#81) — SwiftUI hit-tests nothing
            // inside a Text, so linkCursor re-lays the string to find them.
            .linkCursor(attributed)
    }

    @ViewBuilder
    private var trailingMarkers: some View {
        if message.editedAt != nil {
            Text("(edited)")
                .flowFont(.caption2)
                .foregroundStyle(.tertiary)
        }
        if pendingSlow {
            ProgressView().controlSize(.mini)
        }
    }

    /// Failed-send affordance: the message stays put with an error label and a
    /// Retry button (Discard drops it). Re-sends reuse the original clientMsgId,
    /// so the server dedupes if the first POST actually landed.
    private var sendFailedFooter: some View {
        HStack(spacing: 8) {
            Label("Failed to send", systemImage: "exclamationmark.circle.fill")
                .flowFont(.caption)
                .foregroundStyle(MC.danger)
            Button("Retry") { Task { await context.engine.retrySend(message) } }
                .buttonStyle(.link)
                .flowFont(.caption, weight: .semibold)
                .pointingHandCursor()
            Button("Discard") { Task { await context.engine.discardFailed(message) } }
                .buttonStyle(.link)
                .flowFont(.caption)
                .foregroundStyle(MC.muted)
                .pointingHandCursor()
        }
        .padding(.top, 1)
    }

    /// An agent's live "thinking…" row carries its own stop control (#67).
    private var isThinkingRow: Bool {
        context.agentIds.contains(message.userId) && AgentStatus.isThinkingRow(message.body)
    }

    /// True once we've asked: the reaction is already ours, so the bridge has
    /// the signal and the turn is on its way down.
    private var stopping: Bool {
        guard let me = currentUserId else { return false }
        return message.reactions.contains { $0.emoji == AgentStatus.interruptEmoji && $0.userIds.contains(me) }
    }

    /// Interrupt: adds the 🛑 reaction the bridge maps back to the running turn.
    private var interruptButton: some View {
        Button {
            guard !stopping else { return }
            Task { await context.engine.toggleReaction(messageId: message.id, emoji: AgentStatus.interruptEmoji) }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "stop.circle")
                Text(stopping ? "Stopping…" : "Interrupt")
            }
            .flowFont(.caption, weight: .semibold)
            .foregroundStyle(stopping ? MC.faint : MC.inkSoft)
            .padding(.horizontal, 9)
            .padding(.vertical, 2)
            .background(Capsule().fill(.white))
            .overlay(Capsule().strokeBorder(MC.hairline, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(stopping)
        .pointingHandCursor()
        .help(stopping ? "Stopping…" : "Stop this agent turn")
        .accessibilityIdentifier("msg.interrupt.\(message.id)")
        .padding(.top, 2)
    }

    private var reactionChips: some View {
        HStack(spacing: 4) {
            ForEach(message.reactions, id: \.emoji) { agg in
                let mine = currentUserId.map { agg.userIds.contains($0) } ?? false
                Button {
                    Task { await context.engine.toggleReaction(messageId: message.id, emoji: agg.emoji) }
                } label: {
                    HStack(spacing: 3) {
                        Text(agg.emoji).flowFont(size: 12)
                        Text("\(agg.count)")
                            .flowFont(.caption2, weight: .bold)
                            .foregroundStyle(mine ? MC.accentSoft : MC.inkSoft)
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(.white))
                    .overlay(
                        Capsule().strokeBorder(
                            mine ? MC.accentSoft.opacity(0.4) : MC.hairline, lineWidth: 1
                        )
                    )
                }
                .buttonStyle(.plain)
                // Still shown where reacting isn't possible (an archived
                // channel, #590) — just not tappable.
                .disabled(!caps.canUse(.reactions))
                .help((agg.userIds.compactMap { userNames[$0] }).joined(separator: ", "))
                .accessibilityIdentifier("msg.reaction.\(agg.emoji)")
                .accessibilityValue("\(agg.count)\(mine ? " including you" : "")")
                // Where a 🎉 burst starts (#524) — the pill, not the row.
                .confettiPill(messageId: message.id, emoji: agg.emoji)
            }
        }
        .padding(.top, 2)
        .confettiReactionRow(messageId: message.id)
    }

    private var avatarPath: String? {
        // Avatar URLs are API-relative (/v1/avatars/<key>); cached user rows carry them.
        context.avatarPaths[message.userId]
    }
}

// MARK: - Attachments

/// Collapsed-image state (phase 5 ruling): persisted per device, capped list.
@MainActor
enum CollapsedImages {
    /// A read marker over one server's file ids — the same id on another
    /// backend is a different file, so the key is per connection+identity.
    private static var key: String {
        ConnectionManager.shared.activeSessionScope.key("collapsedImages")
    }
    private static let cap = 500

    static func contains(_ fileId: String) -> Bool {
        (UserDefaults.standard.stringArray(forKey: key) ?? []).contains(fileId)
    }

    static func set(_ fileId: String, collapsed: Bool) {
        var ids = (UserDefaults.standard.stringArray(forKey: key) ?? []).filter { $0 != fileId }
        if collapsed { ids.append(fileId) }
        UserDefaults.standard.set(Array(ids.suffix(cap)), forKey: key)
    }
}

struct AttachmentView: View {
    let file: FileAttachment
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var win: WindowState
    @State private var opening = false
    @State private var saving = false
    @State private var hovering = false
    @State private var collapsed: Bool
    @State private var showLightbox = false

    init(file: FileAttachment) {
        self.file = file
        _collapsed = State(initialValue: CollapsedImages.contains(file.id))
    }

    var body: some View {
        Group {
            if file.isImage {
                imageAttachment
            } else if file.isPlayableVideo {
                // webm stays a chip: AVFoundation can't decode it (Parity note).
                VideoAttachmentView(file: file)
            } else if file.isPDF {
                PdfAttachmentView(file: file)
            } else if file.isTextPreviewable {
                TextAttachmentView(file: file)
            } else {
                fileChip
            }
        }
        .padding(.top, 3)
        .help("\(file.name) (\(file.sizeLabel))")
        .accessibilityIdentifier("msg.file.\(file.name)")
    }

    private var isGif: Bool { file.mimeType == "image/gif" }

    // MARK: image attachments

    private var imageAttachment: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Button {
                    collapsed.toggle()
                    CollapsedImages.set(file.id, collapsed: collapsed)
                } label: {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        .flowFont(size: 9, weight: .semibold)
                        .frame(width: 12)
                }
                .buttonStyle(.plain)
                .foregroundStyle(MC.faint)
                .help(collapsed ? "Show image" : "Hide image")
                .accessibilityIdentifier("msg.file.collapse.\(file.name)")
                Text(file.name)
                    .flowFont(size: 11)
                    .foregroundStyle(MC.faint)
                    .lineLimit(1)
            }
            if !collapsed {
                imageBody
            }
        }
    }

    private var imageBody: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                // GIFs skip the static webp thumb and animate from the original.
                if isGif {
                    AnimatedAuthImage(path: "/v1/files/\(file.id)")
                } else {
                    AuthImage(path: "/v1/files/\(file.id)/thumb") {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(.secondary.opacity(0.1))
                            .overlay(ProgressView().controlSize(.small))
                    }
                    .scaledToFit()
                }
            }
            // `displaySize` is a ceiling, not a size: the card keeps the
            // image's aspect ratio and shrinks to whatever the transcript
            // column is, so opening the side panel narrows the picture instead
            // of clipping it (#354).
            .aspectRatio(displaySize.width / displaySize.height, contentMode: .fit)
            .frame(maxWidth: displaySize.width, maxHeight: displaySize.height)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
            .onTapGesture { showLightbox = true }

            if hovering || saving {
                downloadButton
                    .padding(6)
            }
        }
        .onHover { hovering = $0 }
        .sheet(isPresented: $showLightbox) {
            ImageLightboxView(file: file)
        }
    }

    /// ~2x preview (ui_nits item 1). Thumbs cap at 512px (server thumbMaxPx),
    /// so large images render upscaled/soft here — noted at review.
    private var displaySize: CGSize {
        guard let w = file.width, let h = file.height, w > 0, h > 0 else {
            return CGSize(width: 480, height: 360)
        }
        let scale = min(1, 560 / CGFloat(w), 480 / CGFloat(h))
        return CGSize(width: max(60, CGFloat(w) * scale), height: max(60, CGFloat(h) * scale))
    }

    // MARK: non-image chip

    private var fileChip: some View {
        HStack(spacing: 6) {
            Button(action: open) {
                HStack(spacing: 8) {
                    Image(systemName: iconName)
                        .flowFont(.title2)
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(file.name)
                            .flowFont(.callout)
                            .lineLimit(1)
                        Text(file.sizeLabel)
                            .flowFont(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if opening {
                        ProgressView().controlSize(.mini)
                    }
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 8).fill(.secondary.opacity(0.08)))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary, lineWidth: 1))
            }
            .buttonStyle(.plain)
            if hovering || saving {
                downloadButton
            }
        }
        .onHover { hovering = $0 }
    }

    private var downloadButton: some View {
        Button(action: saveToDownloads) {
            Group {
                if saving {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "arrow.down.to.line")
                        .flowFont(size: 12, weight: .semibold)
                }
            }
            .frame(width: 24, height: 24)
            .background(RoundedRectangle(cornerRadius: 6).fill(.white.opacity(0.92)))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(MC.hairline, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .help("Download")
        .accessibilityIdentifier("msg.file.download.\(file.name)")
    }

    private var iconName: String {
        switch file.mimeType {
        case let m where m.hasPrefix("image/"): "photo"
        case let m where m.hasPrefix("video/"): "film"
        case let m where m.hasPrefix("audio/"): "waveform"
        case "application/pdf": "doc.richtext"
        case "application/zip": "doc.zipper"
        case let m where m.hasPrefix("text/"): "doc.text"
        default: "doc"
        }
    }

    private func open() {
        guard !opening else { return }
        opening = true
        Task {
            defer { opening = false }
            do {
                let url = try await app.engine.downloadFile(file)
                NSWorkspace.shared.open(url)
            } catch {
                app.showError("Couldn't open \(file.name): \(error.localizedDescription)")
            }
        }
    }

    private func saveToDownloads() {
        guard !saving else { return }
        saving = true
        Task {
            defer { saving = false }
            do {
                let dest = try await app.engine.saveToDownloads(file)
                NSWorkspace.shared.activateFileViewerSelecting([dest])
            } catch {
                app.showError("Couldn't download \(file.name): \(error.localizedDescription)")
            }
        }
    }
}

/// In-app image popup (phase 5 item 5): original bytes, open-external and
/// download as icon buttons. Esc / ✕ closes.
struct ImageLightboxView: View {
    let file: FileAttachment
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var win: WindowState
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Text(file.name)
                    .flowFont(size: 13, weight: .semibold)
                    .lineLimit(1)
                if busy { ProgressView().controlSize(.mini) }
                Spacer()
                Button(action: openExternal) {
                    Image(systemName: "arrow.up.right.square")
                }
                .help("Open external")
                .accessibilityIdentifier("lightbox.openExternal")
                Button(action: download) {
                    Image(systemName: "arrow.down.to.line")
                }
                .help("Download")
                .accessibilityIdentifier("lightbox.download")
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                }
                .help("Close")
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("lightbox.close")
            }
            .buttonStyle(.borderless)

            Group {
                if file.mimeType == "image/gif" {
                    AnimatedAuthImage(path: "/v1/files/\(file.id)")
                } else {
                    AuthImage(path: "/v1/files/\(file.id)") {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(.secondary.opacity(0.1))
                            .overlay(ProgressView())
                    }
                    .scaledToFit()
                }
            }
            .frame(width: displaySize.width, height: displaySize.height)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .padding(14)
        .accessibilityIdentifier("lightbox")
    }

    private var displaySize: CGSize {
        guard let w = file.width, let h = file.height, w > 0, h > 0 else {
            return CGSize(width: 640, height: 480)
        }
        let scale = min(1, 860 / CGFloat(w), 600 / CGFloat(h))
        return CGSize(width: max(280, CGFloat(w) * scale), height: max(200, CGFloat(h) * scale))
    }

    private func openExternal() {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let url = try await app.engine.downloadFile(file)
                NSWorkspace.shared.open(url)
            } catch {
                app.showError("Couldn't open \(file.name): \(error.localizedDescription)")
            }
        }
    }

    private func download() {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let dest = try await app.engine.saveToDownloads(file)
                NSWorkspace.shared.activateFileViewerSelecting([dest])
            } catch {
                app.showError("Couldn't download \(file.name): \(error.localizedDescription)")
            }
        }
    }
}

// MARK: - Emoji picker (reactions)

struct EmojiPickerView: View {
    let onPick: (String) -> Void
    @State private var search = ""

    private var results: [String] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        if q.isEmpty { return EmojiCatalog.quickReactions }
        var seen = Set<String>()
        return EmojiCatalog.shortcodes
            .filter { $0.key.contains(q) }
            .sorted {
                ($0.key.hasPrefix(q) ? 0 : 1, $0.key.count, $0.key)
                    < ($1.key.hasPrefix(q) ? 0 : 1, $1.key.count, $1.key)
            }
            .compactMap { seen.insert($0.value).inserted ? $0.value : nil }
    }

    var body: some View {
        VStack(spacing: 8) {
            TextField("Search emoji", text: $search)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("emoji.search")
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(30)), count: 8), spacing: 4) {
                    ForEach(results, id: \.self) { emoji in
                        Button(emoji) { onPick(emoji) }
                            .buttonStyle(.plain)
                            .flowFont(size: 20)
                    }
                }
            }
            .frame(height: 140)
        }
        .padding(10)
        .frame(width: 300)
    }
}
