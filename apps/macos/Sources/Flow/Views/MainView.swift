import AppKit
import GRDB
import SwiftUI

struct MainView: View {
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var win: WindowState

    // Ruling 5: sidebar width is a local per-device preference, clamped on use.
    @AppStorage("sidebarWidth" + Profile.suffix) private var sidebarWidth: Double = 240
    @State private var dragStartWidth: Double?

    private static let minSidebarWidth: Double = 180
    private static let maxSidebarWidth: Double = 360
    private static let defaultSidebarWidth: Double = 240

    private var clampedSidebarWidth: Double {
        min(Self.maxSidebarWidth, max(Self.minSidebarWidth, sidebarWidth))
    }

    // Phase 13: tabbed side panel width (hosts the thread + artifacts), same
    // local-preference treatment as the sidebar.
    @AppStorage("sidePanelWidth" + Profile.suffix) private var sidePanelWidth: Double = 480
    @State private var sidePanelDragStartWidth: Double?

    private static let minSidePanelWidth: Double = 320
    private static let maxSidePanelWidth: Double = 720
    private static let defaultSidePanelWidth: Double = 480

    private var clampedSidePanelWidth: Double {
        min(Self.maxSidePanelWidth, max(Self.minSidePanelWidth, sidePanelWidth))
    }

    /// Width the chat column is entitled to keep when the side panel is open.
    /// Measured, not guessed: below this the message rows start clipping their
    /// own text; at it they wrap cleanly.
    private static let minChannelWidth: Double = 320

    /// How narrow the panel may be squeezed to protect that entitlement. Lower
    /// than `minSidePanelWidth` — that is the narrowest a *person* may drag the
    /// panel, whereas this is what it gives up when the window cannot afford
    /// both columns. The panel is the optional one, so it yields first.
    private static let squeezedSidePanelWidth: Double = 240

    /// Width of the drag strips between columns.
    private static let resizerWidth: Double = 5

    /// The panel's width *as laid out*, which is not the same as the width the
    /// user asked for: `sidePanelWidth` is a stored preference, and honouring
    /// it literally is what broke the layout (#354). A hard-framed panel plus a
    /// chat column with a ~410pt intrinsic minimum made the split wider than
    /// the window at any width under ~1204pt, and SwiftUI resolved that by
    /// clipping — the workspace rail off the leading edge, the panel's own
    /// controls off the trailing one. So the preference is a ceiling, and what
    /// actually fits wins.
    ///
    /// Giving the chat column `minWidth: 0` alone (PR #351) removes the
    /// overflow but leaves the panel's demand unopposed, which squeezed chat to
    /// ~106pt and got reverted in #352. Both halves are needed: the panel may
    /// not take the space chat is entitled to, and chat yields the last of it
    /// rather than forcing the split to overflow.
    static func sidePanelWidth(preferred: Double, available: Double) -> Double {
        let room = available - resizerWidth // all the panel could physically occupy
        let fair = room - minChannelWidth // …less what the chat column is owed
        return max(0, min(preferred, max(min(squeezedSidePanelWidth, room), fair)))
    }

    var body: some View {
        HStack(spacing: 0) {
            WorkspaceRailView(manager: app.connections)
            SidebarView(manager: app.connections)
                .frame(width: clampedSidebarWidth)
            sidebarResizer
            VStack(spacing: 0) {
                detail
            }
            // The ring floats over everything — it is the one thing that has to
            // be answerable from wherever you happen to be looking (#436).
            .overlay(alignment: .bottomTrailing) {
                IncomingHuddleView().padding(20)
            }
            // The content column must be free to shrink below its contents'
            // ideal width; otherwise it sets the whole HStack's minimum and the
            // rail and sidebar get clipped off the leading edge (#354).
            .frame(minWidth: 0, maxWidth: .infinity)
            // The chat pane is white (#387), matching web's `bg-white` on the
            // same surface; the rail, sidebar and side panel keep MC.base.
            .background(MC.chat)
        }
    }

    /// Thin drag strip on the sidebar/content boundary: drag resizes live,
    /// double-tap resets to the default width.
    private var sidebarResizer: some View {
        Rectangle()
            .fill(MC.base)
            .frame(width: 5)
            .contentShape(Rectangle())
            .onTapGesture(count: 2) { sidebarWidth = Self.defaultSidebarWidth }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { value in
                        let base = dragStartWidth ?? clampedSidebarWidth
                        if dragStartWidth == nil { dragStartWidth = base }
                        sidebarWidth = min(
                            Self.maxSidebarWidth,
                            max(Self.minSidebarWidth, base + value.translation.width)
                        )
                    }
                    .onEnded { _ in dragStartWidth = nil }
            )
            .onHover { inside in
                if inside {
                    NSCursor.resizeLeftRight.push()
                } else {
                    NSCursor.pop()
                }
            }
            .accessibilityElement()
            .accessibilityIdentifier("sidebar.resizer")
            .accessibilityLabel("Resize sidebar")
            .accessibilityValue("\(Int(clampedSidebarWidth)) points")
    }

    /// Drag strip on the chat/side-panel boundary (phase 13): dragging left
    /// widens the panel; double-tap resets. Renders the hairline the old
    /// Divider provided.
    ///
    /// `laidOut` is the panel's on-screen width, which a narrow window can hold
    /// below the stored preference — dragging has to start from what the user
    /// can see, or the panel jumps on the first pixel of movement.
    private func sidePanelResizer(laidOut: Double) -> some View {
        Rectangle()
            // Borders the chat pane, so it takes the chat's white (#387)
            // rather than showing a warm strip against it.
            .fill(MC.chat)
            .frame(width: Self.resizerWidth)
            .overlay(Rectangle().fill(MC.hairline).frame(width: 1))
            .contentShape(Rectangle())
            .onTapGesture(count: 2) { sidePanelWidth = Self.defaultSidePanelWidth }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { value in
                        let base = sidePanelDragStartWidth ?? laidOut
                        if sidePanelDragStartWidth == nil { sidePanelDragStartWidth = base }
                        sidePanelWidth = min(
                            Self.maxSidePanelWidth,
                            max(Self.minSidePanelWidth, base - value.translation.width)
                        )
                    }
                    .onEnded { _ in sidePanelDragStartWidth = nil }
            )
            .onHover { inside in
                if inside {
                    NSCursor.resizeLeftRight.push()
                } else {
                    NSCursor.pop()
                }
            }
            .accessibilityElement()
            .accessibilityIdentifier("sidePanel.resizer")
            .accessibilityLabel("Resize side panel")
            .accessibilityValue("\(Int(laidOut)) points")
    }

    @ViewBuilder
    private var detail: some View {
        if win.showActivity {
            // Activity feed (phase 12) — the virtual channel that replaced the
            // bell. Covers the content pane; the channel stays put behind it.
            ActivityFeedView()
        } else if win.showScheduled {
            // Scheduled panel (#424) — same treatment as the feed above.
            ScheduledPanelView()
        } else if win.showDirectory {
            // Directory (#432) — the workspace member grid, same treatment again.
            DirectoryView()
        } else if win.showChannelBrowser {
            // Channel browser (#590) — every public channel, same treatment.
            ChannelBrowserView()
        } else if let channelId = win.selectedChannelId {
            // Tabbed side panel: Thread, Files (#347) and the channel's
            // artifacts (phase 13). GeometryReader measures the space this
            // column was *given* — the panel is sized from that rather than
            // from the stored preference alone, so the split can never come out
            // wider than the window (#354).
            GeometryReader { geo in
                HStack(spacing: 0) {
                    ChannelView(channelId: channelId)
                        .frame(minWidth: 0, maxWidth: .infinity)
                    if win.openThreadRootId != nil || win.selectedArtifactId != nil || win.filesOpen {
                        let panelWidth = Self.sidePanelWidth(
                            preferred: clampedSidePanelWidth,
                            available: geo.size.width
                        )
                        sidePanelResizer(laidOut: panelWidth)
                        SidePanelView()
                            .frame(width: panelWidth)
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height)
            }
        } else {
            VStack(spacing: 8) {
                Text("#")
                    .flowFont(size: 40, weight: .bold)
                    .foregroundStyle(MC.faint)
                Text("Select a channel")
                    .foregroundStyle(MC.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// The workspace identity mark: its avatar image when one is set (#336),
/// otherwise the initial on a color chip. Active is a white fill for the
/// initial mark, and a white ring for an avatar — an image can't be tinted.
struct WorkspaceMark: View {
    let name: String
    /// Already filtered to a fetchable API path (`Workspace.avatarImagePath`).
    let avatarPath: String?
    let size: CGFloat
    var cornerRadius: CGFloat = 12
    var active: Bool = true
    /// The connection the avatar belongs to, when it is not the one on screen.
    var loader: ImageLoader?

    init(workspace: Workspace, size: CGFloat, cornerRadius: CGFloat = 12, active: Bool = true) {
        self.init(name: workspace.name, avatarPath: workspace.avatarImagePath, size: size, cornerRadius: cornerRadius, active: active)
    }

    init(name: String, avatarPath: String?, size: CGFloat, cornerRadius: CGFloat = 12, active: Bool = true, loader: ImageLoader? = nil) {
        self.name = name
        self.avatarPath = avatarPath
        self.size = size
        self.cornerRadius = cornerRadius
        self.active = active
        self.loader = loader
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius)
        Group {
            if let path = avatarPath {
                AuthImage(path: path, loader: loader) { shape.fill(Color.white.opacity(0.15)) }
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
                        Text(String(name.prefix(1)).uppercased())
                            .flowFont(size: active ? size * 0.42 : size * 0.35, weight: active ? .heavy : .bold)
                            .foregroundStyle(active ? MC.accent : .white)
                    )
            }
        }
    }
}

/// Design 3a column 1: the 64px violet workspace rail.
struct WorkspaceRailView: View {
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var win: WindowState
    /// Republishes on a registry or unread change, so another connection's
    /// workspaces appear and their badges move without a relaunch. Passed in
    /// rather than reached for, so it is this session's manager.
    @ObservedObject private var manager: ConnectionManager
    /// Opens a workspace on a connection this window is not showing (#592).
    @Environment(\.openWorkspace) private var openWorkspace
    @StateObject private var workspaces = DBObserved<[Workspace]>(initial: [])
    @State private var showHelp = false
    @State private var helpHovering = false

    init(manager: ConnectionManager) { self.manager = manager }

    /// Rail shade follows the active workspace's palette (violet default).
    private var railColor: Color {
        let current = workspaces.value.first { $0.id == win.selectedWorkspaceId }
        return SidebarPalette.palette(for: current?.sidebarColor).rail
    }

    /// Every connection's workspaces, this one's live rows first-hand and the
    /// others from the registry — the same list the menu and chooser draw.
    private var entries: [SwitcherEntry] {
        manager.switcherEntries(foreground: app.connectionId, foregroundWorkspaces: workspaces.value)
    }

    var body: some View {
        let rows = entries
        let namesSource = switcherShowsSource(rows)
        VStack(spacing: 14) {
            ForEach(rows) { entry in
                let active = entry.foreground && entry.workspaceId == win.selectedWorkspaceId
                Button {
                    if active { return }
                    if entry.foreground { win.selectWorkspace(entry.workspaceId) }
                    else { openWorkspace(connectionId: entry.connectionId, workspaceId: entry.workspaceId) }
                } label: {
                    WorkspaceMark(
                        name: entry.name, avatarPath: entry.avatarImagePath, size: 40, cornerRadius: 12,
                        active: active, loader: entry.foreground ? nil : manager.appState(entry.connectionId)?.images
                    )
                        // Unread across this workspace's channels (#345). The
                        // overlay sits outside the mark's clip shape, so the
                        // badge can overhang the corner as designed.
                        .overlay(alignment: .topTrailing) {
                            WorkspaceUnreadBadge(count: entry.unread, ringColor: railColor)
                                .offset(x: 7, y: -7)
                                .accessibilityIdentifier("rail.unread.\(entry.key)")
                        }
                }
                .buttonStyle(.plain)
                .help(railTooltip(entry, namesSource: namesSource))
                .accessibilityIdentifier("rail.workspace.\(entry.key)")
                .accessibilityValue(entry.unread > 0 ? "\(entry.unread) unread" : "read")
                .accessibilityAddTraits(active ? [.isSelected] : [])
            }
            Button {
                win.selectWorkspace(nil)
            } label: {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(.white.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .frame(width: 40, height: 40)
                    .overlay(
                        Image(systemName: "plus")
                            .foregroundStyle(.white.opacity(0.7))
                    )
            }
            .buttonStyle(.plain)
            .help("All workspaces")
            .accessibilityIdentifier("rail.addWorkspace")
            Spacer()
            // Built-in help (#384): far lower-left, below the Spacer, where web
            // puts it at the foot of the same rail.
            Button {
                showHelp = true
            } label: {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.white.opacity(helpHovering ? 0.25 : 0.15))
                    .frame(width: 40, height: 40)
                    .overlay(
                        Text("?")
                            .flowFont(size: 18, weight: .bold)
                            .foregroundStyle(.white)
                    )
            }
            .buttonStyle(.plain)
            .onHover { helpHovering = $0 }
            .help("Help")
            .accessibilityIdentifier("rail.help")
            .accessibilityLabel("Help")
        }
        .padding(.vertical, 16)
        .frame(width: 64)
        .frame(maxHeight: .infinity)
        .background(railColor)
        .sheet(isPresented: $showHelp) { HelpView() }
        .task {
            workspaces.start(db: app.db) { db in
                try Workspace.order(Column("name").collating(.nocase)).fetchAll(db)
            }
        }
    }

    /// "Acme (Slack) — 3 unread": where a workspace lives is only worth saying
    /// when there is more than one place it could be.
    private func railTooltip(_ entry: SwitcherEntry, namesSource: Bool) -> String {
        let name = namesSource ? "\(entry.name) (\(entry.source))" : entry.name
        return unreadBadgeLabel(entry.unread).map { "\(name) — \($0) unread" } ?? name
    }
}
