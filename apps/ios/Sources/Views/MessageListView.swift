import SwiftUI
import UIKit
#if DEBUG
import os
/// Debug-only tracing — see TranscriptFollowModel.swift.
private let listLog = Logger(subsystem: "im.freeflow.follow", category: "list")
#endif

/// iOS port of the macOS message list (Views/MessageListView.swift): day
/// dividers, Slack-style author grouping (5-minute rule), markdown block
/// rendering via the shared MarkdownBlocks segmentation, and mention pills
/// via the shared MentionRendering. Used by both the channel screen and the
/// thread screen.
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
    /// The channel's history page is still in flight (#191). Drives the loading
    /// states below — an empty transcript with no explanation reads as a lost
    /// conversation, which on a slow link is what it was reported as.
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
    /// Jump-to-message target (phase 12): scroll it into view + flash it once
    /// it's in the list, then call onFocused. Nil in the normal case.
    var focusMessageId: String? = nil
    var onFocused: () -> Void = {}
    var scrollKey: String? = nil
    @State private var restoredScroll = false
    /// Passed straight to each row: tapping a sender opens their card (#223).
    var onOpenProfile: (String) -> Void = { _ in }
    /// What this conversation's controls may do (#546). Everything, unless the
    /// channel is archived.
    var capabilities: Capabilities = .allSupported

    /// Precomputed rows (grouping, day dividers, parsed markdown) rebuilt only
    /// when the message array actually changes — never per render pass. A
    /// plain class in `@State`: mutating it doesn't touch SwiftUI state, and
    /// its identity is stable across body evaluations.
    @State private var rowCache = TranscriptRowCache()
    /// The row currently flashing after a jump (fades out on a timer).
    @State private var flashId: String?
    /// The single owner of every follow/scroll decision (see
    /// `TranscriptFollowModel`). All the drivers below feed it events and
    /// execute the one command it returns — nothing else calls `scrollTo`
    /// toward the bottom.
    @State private var followBox = TranscriptFollowBox(style: .dragDistance)
    /// Mirror of `followBox.model.showJump`, written only when it changes — the one
    /// follow-model output SwiftUI renders from (see TranscriptFollowBox).
    @State private var jumpSignal = false
    /// The jump pill, debounced: `followBox.model.showJump` must hold for a beat
    /// before the pill mounts, so transient geometry (a keyboard frame, a
    /// scrollTo that lands a few points short) can never flicker it up.
    @State private var showPill = false
    /// The first message on screen when "Load earlier messages" was tapped.
    /// When the older page prepends, this row is put back at the top of the
    /// viewport — without it the scroll offset stays top-relative and every
    /// visible row shifts down by the height of the new content.
    @State private var loadOlderAnchorId: String?

    private static let scrollSpace = "messageScroll"
    /// When to re-assert the bottom after a transcript first has content, in
    /// nanoseconds from the previous pass. Three passes across ~600ms covers a
    /// LazyVStack resolving its row estimates without a poll that outlives the
    /// settling.
    private static let settleDelays: [UInt64] = [50_000_000, 150_000_000, 400_000_000]

    /// Eager below `eagerRowLimit`, lazy above (see the limit's comment).
    @ViewBuilder
    private func transcriptStack<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        if messages.count <= Self.eagerRowLimit {
            VStack(alignment: .leading, spacing: 0, content: content)
        } else {
            LazyVStack(alignment: .leading, spacing: 0, content: content)
        }
    }

    /// Executes a follow-model command. The one place this list scrolls to
    /// its end.
    /// Mirror the pill signal into SwiftUI state, only on change.
    private func syncSignals() {
        if followBox.model.showJump != jumpSignal { jumpSignal = followBox.model.showJump }
    }

    /// Scrolls to the row *identity*, never a message id (#329/#332: rows are
    /// keyed on `clientMsgId`, so a message id matches no row and silently
    /// scrolls nowhere).
    private func run(_ command: TranscriptFollowModel.Command, _ proxy: ScrollViewProxy) {
        defer { syncSignals() }
        #if DEBUG
        if case .stick = command {
            listLog.info("run stick lastKey=\(messages.lastRowKey ?? "nil") count=\(messages.count)")
        }
        #endif
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
                            .font(.callout)
                            Spacer()
                        }
                        .padding(.vertical, 8)
                    }
                    // Keyed on `clientMsgId` here as well as in the `.id()`
                    // below (#333/#332): with the ForEach still keyed on the
                    // message id, an optimistic row reconciling with its
                    // server echo reads as a delete + insert whose two views
                    // claim one `.id()`, and the leaving pending view wins —
                    // the spinner stays on screen. One element with a changed
                    // value re-renders in place instead.
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
                                    onOpenThread: onOpenThread,
                                    onEdit: onEdit,
                                    onDelete: onDelete,
                                    onOpenProfile: onOpenProfile,
                                    capabilities: capabilities
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
                        .background(GeometryReader { geometry in
                            let frame = geometry.frame(in: .named(Self.scrollSpace))
                            Color.clear.preference(key: SavedTopMessage.self,
                                value: frame.minY <= 8 && frame.maxY > 8 ? row.message.id : nil)
                        })
                    }
                }
                .padding(.vertical, 8)
                // A row that cannot fit reports its ideal width anyway — a long
                // unbroken URL is the common one — and a ScrollView's ideal
                // width is its content's. The screen's ZStack sizes to that and
                // then lays every sibling out inside it, so one row makes the
                // transcript, the composer and the floating header pill wider
                // than the phone and hangs them off both edges (#308). Bounding
                // the proposal here is what makes such a row wrap instead: the
                // window is the one width in this stack that no content can
                // inflate.
                .frame(maxWidth: transcriptWindowWidth, alignment: .leading)
                .background(
                    GeometryReader { geo in
                        let frame = geo.frame(in: .named(Self.scrollSpace))
                        Color.clear
                            .onAppear { _ = followBox.model.contentChanged(to: frame) }
                            .onChange(of: frame) { _, new in
                                // Content moved or resized. The model decides
                                // what it means — re-stick after a resize for a
                                // reader at the end (#191/#280), pin changes
                                // only for real scrolls (#159) — and this view
                                // just executes the command.
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
                            // The keyboard (or a rotation) resized the viewport.
                            // Never a pin decision — mid-transition the model
                            // freezes entirely and re-sticks once at the end.
                            run(followBox.model.viewportChanged(to: new), proxy)
                        }
                }
            )
            .overlay { emptyTranscriptState }
            .overlay(alignment: .bottom) { jumpToLatest(proxy) }
            .animation(.easeOut(duration: 0.15), value: showPill)
            // Only a finger on the glass may stop the list following the end.
            .simultaneousGesture(
                DragGesture(minimumDistance: 12)
                    .onChanged { _ in
                        if !followBox.model.isDragging { followBox.model.dragBegan() }
                    }
                    .onEnded { _ in followBox.model.dragEnded() }
            )
            // The keyboard's show/hide brackets (#139's keyboard, #111's pill
            // flicker): between Will and Did the geometry passes through
            // states that never hold still, and deciding from them is what
            // used to raise the "Latest msgs" pill the moment the keyboard
            // came up. The model freezes for the duration and re-sticks once.
            .onReceive(NotificationCenter.default.publisher(
                for: UIResponder.keyboardWillShowNotification)) { _ in followBox.model.transitionBegan() }
            .onReceive(NotificationCenter.default.publisher(
                for: UIResponder.keyboardDidShowNotification)) { _ in run(followBox.model.transitionEnded(), proxy) }
            .onReceive(NotificationCenter.default.publisher(
                for: UIResponder.keyboardWillHideNotification)) { _ in followBox.model.transitionBegan() }
            .onReceive(NotificationCenter.default.publisher(
                for: UIResponder.keyboardDidHideNotification)) { _ in run(followBox.model.transitionEnded(), proxy) }
            // The pill mounts only after the model has wanted it for a beat.
            .task(id: jumpSignal) {
                if jumpSignal {
                    try? await Task.sleep(nanoseconds: 150_000_000)
                    if !Task.isCancelled { showPill = true }
                } else {
                    showPill = false
                }
            }
            .onPreferenceChange(SavedTopMessage.self) { id in
                guard restoredScroll, let scrollKey, focusMessageId == nil else { return }
                if followBox.model.showJump, let id { UserDefaults.standard.set(id, forKey: scrollKey) }
                else if !followBox.model.showJump { UserDefaults.standard.removeObject(forKey: scrollKey) }
            }
            .onChange(of: messages.last?.id) { _, newId in
                guard newId != nil else { return }
                if restoreScroll(proxy) { return }
                // My own message always re-pins — I just pressed send, so I
                // mean to see it land; everyone else's messages leave a
                // back-scrolled reader in place (#111).
                let own = currentUserId != nil && messages.last?.userId == currentUserId
                run(followBox.model.lastMessageChanged(isOwn: own), proxy)
            }
            // "Load earlier" landed: put the row the reader was looking at
            // back at the top of the viewport. Consumed once — a later
            // prepend from a reconnect backfill must not scroll anywhere.
            .onChange(of: messages.first?.id) { _, _ in
                guard let anchor = loadOlderAnchorId else { return }
                loadOlderAnchorId = nil
                // Row identity, not the message id (#332) — and the lookup
                // doubles as the "is it in the list?" guard the old
                // `contains(where:)` gave.
                if let anchorKey = messages.rowKey(forMessageId: anchor) {
                    proxy.scrollTo(anchorKey, anchor: .top)
                }
            }
            // The single scroll driver. Everything else that moves this list
            // targets the same bottom edge, so nothing can disagree with it —
            // macOS blanked its transcript exactly this way by installing a
            // second one (see the NOTE in its MessageListView).
            //
            // On iOS 18+ the anchor is scoped to initial offset + alignment
            // only. The default all-roles form also re-anchors on *content
            // size changes*, and a LazyVStack resizes mid-scroll as real row
            // heights replace its estimates — the framework itself yanked any
            // short back-pull (under `minBackScroll`) straight back to the
            // bottom on release. Following new messages is our follow/glue's
            // job, which respects the pin state; the anchor must not compete.
            .modifier(BottomAnchor())
            // Keyboard dismissal (tap + scroll) is applied by the screen that
            // owns the composer, so it can cover the whole chat area rather
            // than just this list — see ChannelScreen (#139).
            // Jump-to-message (phase 12): center + flash the target once it's in
            // the list (older history pages in via ChannelScreen), then release.
            // A jump target owns the scroll position for its whole lifetime —
            // from set (possibly while older pages load in) to cleared.
            .onChange(of: focusMessageId) { _, new in
                followBox.model.focusActive = new != nil
                tryFocus(proxy)
            }
            .onChange(of: messages.count) { _, _ in tryFocus(proxy) }
            .onAppear {
                followBox.model.focusActive = focusMessageId != nil
                _ = restoreScroll(proxy)
                tryFocus(proxy)
            }
            // Belt to the glue's braces (#280). The glue can only correct a bad
            // initial offset if the content frame moves; when the LazyVStack's
            // estimate is wrong and *stays* wrong, nothing fires and the list
            // sits in empty space until a drag clamps it — which is what the
            // report showed. Re-assert the end a few times while the layout is
            // still settling. Same target as every other driver here, so it
            // cannot disagree with them, and the model stops it the moment the
            // reader takes over.
            .task(id: messages.first?.id) {
                guard !messages.isEmpty else { return }
                for delay in Self.settleDelays {
                    try? await Task.sleep(nanoseconds: delay)
                    guard case .stick = followBox.model.settleCommand() else { return }
                    run(followBox.model.settleCommand(), proxy)
                }
            }
            // The arrival settle (#334, ported with #332): the follow above
            // fires the instant a new message lands — before its row has a
            // height — so the scroll comes up short and an incoming reply sits
            // below the fold. The shared model's glue corrects that when the
            // row sizes, but only if a geometry event actually arrives; this
            // belt re-asserts the end across the settling window either way.
            // Keyed on the row identity, not the message id, so an optimistic
            // row reconciling with its echo doesn't re-run it (#312/#329), and
            // gated entirely on the model — a back-scrolled, focused or
            // mid-drag reader gets `.none`.
            .task(id: messages.lastRowKey) {
                guard !messages.isEmpty else { return }
                for delay in Self.settleDelays {
                    try? await Task.sleep(nanoseconds: delay)
                    let command = followBox.model.arrivalSettleCommand()
                    guard case .stick = command else { return }
                    run(command, proxy)
                }
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
                .font(.callout)
                .foregroundStyle(MC.faint)
            Spacer()
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("msg.loading")
    }

    /// Nothing to show yet. An empty transcript is two different situations —
    /// history still on its way, or a conversation with nothing in it — and the
    /// bug this fixes is that both used to render as bare background, so a slow
    /// link looked exactly like a lost conversation (#191).
    @ViewBuilder
    private var emptyTranscriptState: some View {
        if messages.isEmpty {
            if isLoadingHistory {
                loadingRow("Loading conversation…")
            } else {
                Text("No messages yet")
                    .font(.callout)
                    .foregroundStyle(MC.faint)
                    .accessibilityIdentifier("msg.emptyChannel")
            }
        }
    }

    /// Floating "Latest msgs ↓" pill, shown while the reader is above the end
    /// of the transcript (#111) — debounced through `showPill`, so it only
    /// appears once the model has wanted it for a beat. Tapping it returns to
    /// the newest message.
    private func restoreScroll(_ proxy: ScrollViewProxy) -> Bool {
        guard !restoredScroll, !messages.isEmpty else { return false }
        restoredScroll = true
        guard focusMessageId == nil, let scrollKey,
              let saved = UserDefaults.standard.string(forKey: scrollKey),
              let row = messages.rowKey(forMessageId: saved) else { return false }
        followBox.model.positionRestored(atBottom: false)
        followBox.model.landingIssued()
        proxy.scrollTo(row, anchor: .top)
        return true
    }

    @ViewBuilder
    private func jumpToLatest(_ proxy: ScrollViewProxy) -> some View {
        if showPill, !messages.isEmpty {
            Button {
                run(followBox.model.jumpTapped(), proxy)
            } label: {
                Text("Latest msgs ↓")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(MC.accentSoft)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(.white).shadow(color: MC.ink.opacity(0.16), radius: 5, y: 1))
                    .overlay(Capsule().strokeBorder(MC.hairline, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .padding(.bottom, 12)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
            .accessibilityIdentifier("msg.jumpToLatest")
        }
    }

    private func tryFocus(_ proxy: ScrollViewProxy) {
        guard let fid = focusMessageId, let key = messages.rowKey(forMessageId: fid) else { return }
        // The jump landed mid-history: unpin, so the next message follows the
        // reader's choice (the pill offers the way back) rather than yanking
        // them off the message they came to see. macOS has always done this;
        // iOS used to stay pinned (a quiet divergence, now gone).
        followBox.model.focusEngaged()
        withAnimation(.easeInOut(duration: 0.25)) {
            proxy.scrollTo(key, anchor: .center) // row identity, not message id (#332)
        }
        // One scroll is not a landing (#332). A jump into a deep transcript is
        // resolved against the LazyVStack's *estimated* row heights — the rows
        // between here and the target have never been laid out — so it comes up
        // short, and on a 140-message channel it came up short enough that the
        // target was never on screen at all. Re-assert it across the same
        // settling window the bottom glue uses; bounded by the flash, and it
        // can only ever re-aim at the same row.
        Task { @MainActor in
            for delay in Self.settleDelays {
                try? await Task.sleep(nanoseconds: delay)
                guard flashId == fid, let key = messages.rowKey(forMessageId: fid) else { return }
                proxy.scrollTo(key, anchor: .center)
            }
        }
        flashId = fid
        onFocused()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            withAnimation(.easeOut(duration: 0.6)) {
                if flashId == fid { flashId = nil }
            }
        }
    }

}

/// Bottom scroll anchor with the size-change role removed on iOS 18+ (see the
/// comment at the use site in MessageListView: the all-roles form re-anchors
/// on content size changes, which bounces a short back-pull). iOS 17 has no
/// role API and keeps the all-roles form.
struct BottomAnchor: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(.bottom, for: .alignment)
        } else {
            content.defaultScrollAnchor(.bottom)
        }
    }
}

/// Centered "Today" / date pill between days (design 3a).
struct DayDividerView: View {
    let iso: String

    var body: some View {
        HStack {
            Spacer()
            Text(label)
                .font(.system(size: 11))
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
                .font(.system(size: 12))
                .foregroundStyle(MC.faint)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 12)
    }
}

/// The phone's width, read from the window the way `floatingHeaderTopInset`
/// reads its inset, and fixed for the life of the screen because the app is
/// iPhone-portrait-only. 393pt is the common iPhone width; the fallback only
/// matters for the frame or two before a window exists.
@MainActor var transcriptWindowWidth: CGFloat {
    let window = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .first { $0.activationState == .foregroundActive }?
        .keyWindow
    let width: CGFloat = window?.bounds.width ?? 393
    return width
}

/// The widest picture a link preview may draw inside a transcript row.
///
/// `UnfurlCardView` sizes its picture exactly rather than letting a flexible
/// frame expand, so the picture decides the card's width. At the desktop's
/// 360 pt the card is wider than a phone row, and the transcript clamp above
/// then clips its trailing control (#306, #308). The row spends 14 pt of
/// gutter on each side and a 38 pt avatar column with a 10 pt gap; what the
/// card itself spends is the card's own business (`chromeWidth`).
///
/// Named pieces with explicit types rather than one literal-heavy line: the
/// single expression sent the Swift type checker past its "reasonable time"
/// limit and broke the iOS build (#310).
@MainActor var unfurlImageWidth: CGFloat {
    let rowChrome: CGFloat = 14 + 14 + 38 + 10
    let cardChrome: CGFloat = UnfurlCardView.chromeWidth
    let available: CGFloat = transcriptWindowWidth - rowChrome - cardChrome
    // Never below a legible thumbnail, never above the desktop card's size.
    return min(360, max(160, available))
}

struct MessageRow: View, @preconcurrency Equatable {
    let message: Message
    /// Pre-parsed body blocks from the row model; nil (thread screen) falls
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
    let onOpenThread: (String) -> Void
    let onEdit: (Message) -> Void
    let onDelete: (Message, Bool) -> Void
    /// Tapping the sender's avatar or name opens their profile card (#223).
    /// The presenting screen owns the sheet — a sheet per row would mean one
    /// presentation per message in the transcript.
    var onOpenProfile: (String) -> Void = { _ in }
    /// What the provider allows on this message (#546). Flow: everything.
    var capabilities: Capabilities = .allSupported

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
            && a.currentUserId == b.currentUserId
            && a.canPermanentlyDelete == b.canPermanentlyDelete
            && a.userNames == b.userNames
            && a.userStatuses == b.userStatuses
            && a.context == b.context
            && a.capabilities == b.capabilities
    }

    @State private var showReactionPicker = false
    /// The badge's tap-for-detail sheet (#424).
    @State private var showScheduledDetail = false
    @State private var showDeleteConfirm = false
    /// A pending row renders at full strength; it only dims (and shows the
    /// mini spinner) once the send has gone unconfirmed past this window.
    private static let pendingDimDelay: TimeInterval = 3
    @State private var pendingSlow = false

    /// "🕐 SCHEDULED" next to the author name (#424): the scheduler posted this
    /// message rather than its author typing it just now. Deliberately a badge
    /// on an otherwise ordinary message — the author, the mentions and the
    /// notifications are all real, and only the timing was automatic. There is
    /// no hover on a phone, so the desktop's tooltip becomes a tap.
    private var scheduledBadge: some View {
        Button { showScheduledDetail = true } label: {
            Text("🕐 SCHEDULED")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(MC.accentDeep)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 4).fill(MC.accent.opacity(0.12)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Scheduled message")
        .accessibilityIdentifier("message.scheduledBadge.\(message.id)")
        .alert("Posted automatically", isPresented: $showScheduledDetail) {
            Button("Open Scheduled") { context.onOpenScheduled() }
            Button("OK", role: .cancel) {}
        } message: {
            Text("This message was posted on a schedule. It runs as \(senderName), "
                 + "with their permissions.")
        }
    }

    private var senderName: String { userNames[message.userId] ?? "Unknown" }
    private var isMine: Bool { message.userId == currentUserId }
    private var deleteMode: MessageDeleteMode? {
        MessageDeletePolicy.mode(
            isMine: isMine,
            isDeleted: message.isDeleted,
            isSystem: message.systemKind != nil,
            canPermanentlyDelete: canPermanentlyDelete
        )
    }
    private var deleteLabel: String {
        deleteMode == .permanent ? "Permanently Delete" : "Delete"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if showHeader {
                Button {
                    onOpenProfile(message.userId)
                } label: {
                    AvatarChip(
                        userId: message.userId,
                        name: senderName,
                        avatarPath: context.avatarPaths[message.userId],
                        size: 38,
                        radius: 11
                    )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("msg.avatar.\(message.id)")
                .accessibilityLabel("\(senderName)'s profile")
            } else {
                Color.clear.frame(width: 38, height: 1)
            }

            VStack(alignment: .leading, spacing: 2) {
                if showHeader {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Button {
                            onOpenProfile(message.userId)
                        } label: {
                            Text(senderName)
                                // 15, not 14 (#531): the name was already
                                // `.bold`, but a bold 14 above a `.callout`
                                // (16) body is *smaller* than the text it
                                // labels, which is why it stopped reading as
                                // the strongest thing in the row.
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(MC.ink)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("msg.sender.\(message.id)")
                        .accessibilityLabel("\(senderName)'s profile")
                        if let emoji = userStatuses[message.userId], !emoji.isEmpty {
                            Text(emoji).font(.system(size: 14))
                        }
                        Text(ISO8601.displayTime(message.createdAt))
                            .font(.system(size: 11))
                            .foregroundStyle(MC.faint)
                        if message.scheduled { scheduledBadge }
                    }
                }

                if message.pinnedAt != nil, !message.isDeleted {
                    Label("Pinned", systemImage: "pin.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(MC.accentSoft)
                        .accessibilityIdentifier("msg.pinned.\(message.id)")
                }

                if message.isDeleted {
                    Text("This message was deleted")
                        .font(.callout)
                        .italic()
                        .foregroundStyle(.tertiary)
                } else {
                    // Parsed once in the row model; the fallback is for the
                    // thread screen, which builds rows directly.
                    let segments = self.segments ?? MarkdownBlocks.segments(message.body)
                    if !segments.isEmpty {
                        bodyContent(segments)
                    } else if pendingSlow, message.files.isEmpty {
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
                            maxImageWidth: unfurlImageWidth
                        )
                    }

                    if isThinkingRow, capabilities.canUse(.agents) {
                        interruptButton
                    }

                    if !message.reactions.isEmpty {
                        reactionChips
                    }
                }

                if showThreadAffordances, message.replyCount > 0 {
                    threadAffordance
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.top, showHeader ? 10 : 1)
        .padding(.bottom, 1)
        .background(highlighted ? MC.unread.opacity(0.16) : Color.clear)
        .animation(.easeOut(duration: 0.6), value: highlighted)
        .opacity(pendingSlow ? 0.55 : 1)
        // Confetti when a 🎉 lands (#524). On the whole row, so a message with
        // no reactions yet is already "seen" by the time the first one arrives
        // — the count-went-up rule itself lives in `CelebrationMemory`.
        .celebrationBursts(messageId: message.id, reactions: message.reactions)
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
        // Long-press context menu: iOS's answer to the macOS hover menu —
        // quick reactions, full picker, reply-in-thread, edit/delete (own).
        .contextMenu {
            if (!message.isDeleted || deleteMode == .permanent), !message.pending {
                if !message.isDeleted {
                    // Provider gating (#546): an unavailable action is not in
                    // the menu at all, as on web. Flow keeps every item.
                    if capabilities.canUse(.reactions) {
                        ControlGroup {
                            ForEach(Array(EmojiCatalog.quickReactions.prefix(4)), id: \.self) { emoji in
                                Button(emoji) {
                                    Task { await context.engine.toggleReaction(messageId: message.id, emoji: emoji) }
                                }
                            }
                        }
                        .controlGroupStyle(.compactMenu)
                        Button {
                            showReactionPicker = true
                        } label: {
                            Label("Add Reaction…", systemImage: "face.smiling")
                        }
                    }
                    if showThreadAffordances, capabilities.canUse(.threads) {
                        Button {
                            onOpenThread(message.threadRootId ?? message.id)
                        } label: {
                            Label("Reply in Thread", systemImage: "bubble.left.and.bubble.right")
                        }
                    }
                    if !message.body.isEmpty {
                        Button {
                            UIPasteboard.general.string = message.body
                        } label: {
                            Label("Copy", systemImage: "doc.on.doc")
                        }
                    }
                    if !message.failed, capabilities.canUse(.pins) {
                        Button {
                            Task { await context.engine.togglePin(message) }
                        } label: {
                            Label(
                                message.pinnedAt == nil ? "Pin Message" : "Unpin Message",
                                systemImage: message.pinnedAt == nil ? "pin" : "pin.slash"
                            )
                        }
                    }
                    if isMine, capabilities.canUse(.edit) {
                        Button {
                            onEdit(message)
                        } label: {
                            Label("Edit", systemImage: "pencil")
                        }
                    }
                }
                if deleteMode != nil, capabilities.canUse(.delete) {
                    Button(role: .destructive) {
                        showDeleteConfirm = true
                    } label: {
                        Label(deleteLabel, systemImage: "trash")
                    }
                }
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
        .sheet(isPresented: $showReactionPicker) {
            EmojiPickerView { emoji in
                showReactionPicker = false
                Task { await context.engine.toggleReaction(messageId: message.id, emoji: emoji) }
            }
            .presentationDetents([.height(340)])
        }
    }

    /// Reply count + first-4 participant avatar stack; tap pushes the thread.
    private var threadAffordance: some View {
        Button {
            onOpenThread(message.id)
        } label: {
            HStack(spacing: 6) {
                // A reply in here needs you (#270) — the sidebar badge says the
                // channel has something, this says which thread.
                if threadUnread {
                    Circle()
                        .fill(MC.unread)
                        .frame(width: 7, height: 7)
                        .accessibilityIdentifier("msg.threadUnread")
                        .accessibilityLabel("Unread reply")
                }
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
                .font(.caption)
                .foregroundStyle(MC.accent)
            }
        }
        .buttonStyle(.plain)
        .padding(.top, 3)
        .accessibilityIdentifier("msg.openThread")
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
            .font(.caption.weight(.semibold))
            .foregroundStyle(stopping ? MC.faint : MC.inkSoft)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(.white))
            .overlay(Capsule().strokeBorder(MC.hairline, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(stopping)
        .accessibilityIdentifier("msg.interrupt.\(message.id)")
        .padding(.top, 3)
    }

    /// Reaction chips with counts; tap toggles the caller's reaction.
    private var reactionChips: some View {
        HStack(spacing: 4) {
            ForEach(message.reactions, id: \.emoji) { agg in
                let mine = currentUserId.map { agg.userIds.contains($0) } ?? false
                Button {
                    Task { await context.engine.toggleReaction(messageId: message.id, emoji: agg.emoji) }
                } label: {
                    HStack(spacing: 3) {
                        Text(agg.emoji).font(.system(size: 13))
                        Text("\(agg.count)")
                            .font(.caption2.bold())
                            .foregroundStyle(mine ? MC.accentSoft : MC.inkSoft)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(mine ? MC.accent.opacity(0.10) : .white))
                    .overlay(
                        Capsule().strokeBorder(
                            mine ? MC.accentSoft.opacity(0.4) : MC.hairline, lineWidth: 1
                        )
                    )
                }
                .buttonStyle(.plain)
                // Existing reactions still show without the scope; only the
                // toggle is off (#546).
                .disabledUnless(.reactions, in: capabilities)
                .accessibilityIdentifier("msg.reaction.\(agg.emoji)")
                .accessibilityValue("\(agg.count)\(mine ? " including you" : "")")
                // Where a 🎉 burst starts (#524) — the pill, not the row.
                .confettiPill(messageId: message.id, emoji: agg.emoji)
            }
        }
        .padding(.top, 2)
        .confettiReactionRow(messageId: message.id)
    }

    // MARK: - Body blocks (shared MarkdownBlocks grammar, macOS-parity styling)

    /// Paragraphs keep the inline attributed pass (mention pills, inline
    /// markdown); quote runs get a 3pt accent bar with "> " markers stripped;
    /// fenced code renders monospaced in a warm block, fence markers hidden.
    @ViewBuilder
    private func bodyContent(_ segments: [MarkdownBlocks.Segment]) -> some View {
        Group {
            if let report = ArtifactReference.parse(message.body) {
                ArtifactOpenButton(title: report.title, artifactId: report.id)
            } else if segments.count == 1, case .paragraph(let text) = segments[0] {
                // Fast path: single plain paragraph keeps baseline-aligned markers.
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    paragraphText(text)
                    trailingMarkers
                }
            } else {
                HStack(alignment: .bottom, spacing: 4) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                            segmentView(segment)
                        }
                    }
                    trailingMarkers
                }
            }
        }
        // Same row layout as macOS, so the same #161 hazard: the body shares a
        // VStack with unfurl cards and attachments, and is the only vertically
        // flexible child. Without this it is the one that gives way when the
        // row's ideal height exceeds what the list proposes.
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func segmentView(_ segment: MarkdownBlocks.Segment) -> some View {
        switch segment {
        case .paragraph(let text):
            paragraphText(text)
        case .quote(let text):
            // Same overlay-not-sibling fix as macOS (#195): a Shape sibling has
            // no ideal height, so it absorbed space the quoted text needed and
            // the bar ran on below the last line. See the macOS comment.
            paragraphText(text)
                .foregroundStyle(MC.inkSoft)
                .padding(.leading, 11)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(MC.accent.opacity(0.55))
                        .frame(width: 3)
                }
                .accessibilityIdentifier("msg.quoteBlock")
        case .heading(let level, let text):
            headingText(level: level, text: text)
        case .code(let text):
            // The copy button (#260) overlays the scroller, not its content —
            // pinned to the block's corner, it stays put while the code scrolls
            // under it, which is the whole point of it on a phone. Bottom
            // trailing to match macOS and web, where the row's hover menu owns
            // the top-trailing corner.
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text.isEmpty ? " " : text)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(MC.ink)
                    .padding(.leading, 10)
                    .padding(.trailing, 36)
                    .padding(.vertical, 8)
            }
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
            listView(items.map { (marker: "•", text: $0) })
        case .olist(let start, let items):
            listView(items.enumerated().map { (marker: "\(start + $0.offset).", text: $0.element) })
        case .hr:
            Rectangle()
                .fill(MC.hairline)
                .frame(height: 1)
                .padding(.vertical, 3) // web's my-2 on <hr>
                .accessibilityIdentifier("msg.rule")
        }
    }

    /// macOS-parity lists: a marker column plus the normal inline pass on each
    /// item, so mentions and `**bold**` still render inside items. Markers are
    /// right-aligned in a fixed column to keep multi-digit numbers lined up.
    private func listView(_ items: [(marker: String, text: String)]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(item.marker)
                        .font(.callout)
                        .foregroundStyle(MC.inkSoft)
                        .frame(minWidth: 16, alignment: .trailing)
                    paragraphText(item.text)
                }
            }
        }
        .padding(.leading, 2)
        .accessibilityIdentifier("msg.list")
    }

    /// ATX headings at macOS parity, rebased on iOS's larger body text:
    /// `.callout` is 16pt here, so web's ratios put h1 at 21 and h2 at 19,
    /// with h3–h6 body-size and separated by weight (as `HEADING_CLASS` does).
    private func headingText(level: Int, text: String) -> some View {
        let size: CGFloat = level == 1 ? 21 : (level == 2 ? 19 : 16)
        return Text(MentionRendering.attributed(text, names: userNames, currentUserId: currentUserId))
            .font(.system(size: size, weight: level <= 3 ? .bold : .semibold))
            .foregroundStyle(MC.ink)
            .textSelection(.enabled)
            .padding(.top, level <= 2 ? 2 : 0) // web's mt-2 on h1/h2
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("msg.heading")
    }

    private func paragraphText(_ text: String) -> some View {
        Text(MentionRendering.attributed(text, names: userNames, currentUserId: currentUserId))
            .font(.callout)
            .foregroundStyle(MC.ink)
            .textSelection(.enabled)
    }

    @ViewBuilder
    private var trailingMarkers: some View {
        if message.editedAt != nil {
            Text("(edited)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        if pendingSlow {
            ProgressView().controlSize(.mini)
        }
    }
}

// MARK: - Emoji picker (reactions)

/// Grid + search picker (web parity), presented as a sheet from the
/// long-press menu. Reuses the shared EmojiCatalog.
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
        VStack(spacing: 10) {
            TextField("Search emoji", text: $search)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("emoji.search")
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 8), spacing: 10) {
                    ForEach(results, id: \.self) { emoji in
                        Button(emoji) { onPick(emoji) }
                            .buttonStyle(.plain)
                            .font(.system(size: 28))
                    }
                }
                .padding(.top, 4)
            }
        }
        .padding(14)
    }
}

// MARK: - Edit sheet (operator-ruled: sheet editor, like macOS)

struct EditMessageSheet: View {
    let message: Message
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @FocusState private var focused: Bool

    init(message: Message) {
        self.message = message
        _text = State(initialValue: message.body)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                TextField("Message", text: $text, axis: .vertical)
                    .lineLimit(3...12)
                    .focused($focused)
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 10).fill(MC.base))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(MC.hairline2))
                    .padding(14)
            }
            .navigationTitle("Edit Message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { await app.engine.editMessage(id: message.id, body: text) }
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium])
    }
}


private struct SavedTopMessage: PreferenceKey {
    static let defaultValue: String? = nil
    static func reduce(value: inout String?, nextValue: () -> String?) { value = value ?? nextValue() }
}
