import Foundation

/// One workspace list across every connection: every Flow server's workspaces
/// side by side on the rail, in the sidebar's workspace menu and in the
/// chooser — the native twin of `packages/web/src/lib/workspaceSwitcher.ts`.
///
/// The foreground connection contributes its live workspace rows; every other
/// connection contributes the workspaces bound to it in the registry, which is
/// what the switcher already persists per connection. Nothing here reaches for
/// another connection's database: a background connection is drawn from its
/// bindings plus the unread totals the manager republishes.

struct SwitcherEntry: Identifiable, Equatable, Sendable {
    let connectionId: String
    let workspaceId: String
    let name: String
    /// The workspace's url-safe slug when this client holds its live row; nil
    /// for a connection it only knows from the registry.
    let slug: String?
    /// My role there, from the live row; nil when it came from a binding.
    let role: String?
    let avatarUrl: String?
    let provider: ConnectionProvider
    /// Where the workspace lives: the server's host name.
    let source: String
    let unread: Int
    /// Belongs to the connection this window is showing.
    let foreground: Bool

    /// One id per workspace *per connection*: two servers may hand out the
    /// same workspace id, and both rows have to survive in the same list.
    var id: String { "\(connectionId):\(workspaceId)" }

    /// What UI identifiers name this row by — the slug where we have one, as
    /// the rail always did, and the workspace id for a background connection.
    var key: String { slug ?? workspaceId }

    /// The avatar path the image loader can fetch, or nil for the initial mark
    /// — the same rule a `Workspace` row follows.
    var avatarImagePath: String? { Workspace.avatarImagePath(avatarUrl) }
}

extension ConnectionRegistry {
    /// Every workspace this client can open, in registry order.
    ///
    /// `foregroundWorkspaces` is the live list for the connection on screen;
    /// until it loads, that connection falls back to its bindings like any
    /// other. Its rows keep their own unread count — the rail counts unread
    /// *messages*, which only the live row carries. `unreadByWorkspace` is the
    /// manager's per-connection notification total, which is what a background
    /// connection has instead: its own session's number, never a guess.
    func switcherEntries(
        foregroundConnectionId: String?,
        foregroundWorkspaces: [Workspace]? = nil,
        unreadByWorkspace: [String: [String: Int]] = [:]
    ) -> [SwitcherEntry] {
        var entries: [SwitcherEntry] = []
        for connection in connections {
            let session = session(connection.connectionId)
            let foreground = connection.connectionId == foregroundConnectionId
            // A connection that needs signing in again is listed in Workspaces
            // & servers with that prompt; it has nothing to open from a menu.
            if !foreground && session?.status != .authenticated { continue }
            let source = connection.canonicalOrigin?.label ?? connection.origin
            let unread = unreadByWorkspace[connection.connectionId] ?? [:]
            let rows: [(id: String, name: String, slug: String?, role: String?, avatarUrl: String?, unread: Int?)]
            if foreground, let foregroundWorkspaces {
                rows = foregroundWorkspaces.map { ($0.id, $0.name, $0.slug, $0.role, $0.avatarUrl, $0.unreadCount) }
            } else {
                rows = bindings
                    .filter {
                        $0.connectionId == connection.connectionId && $0.hidden != true
                            && (session?.userId == nil || $0.userId == session?.userId)
                    }
                    .map { ($0.workspaceId, $0.name, nil, nil, $0.avatarUrl, nil) }
            }
            for row in rows {
                entries.append(SwitcherEntry(
                    connectionId: connection.connectionId,
                    workspaceId: row.id,
                    name: row.name,
                    slug: row.slug,
                    role: row.role,
                    avatarUrl: row.avatarUrl,
                    provider: connection.provider,
                    source: source,
                    unread: row.unread ?? unread[row.id] ?? 0,
                    foreground: foreground
                ))
            }
        }
        return entries
    }

    /// Bring a connection's bindings in line with its live workspace list, so
    /// the switcher shows the same workspaces, names and avatars for it while
    /// another connection is on screen. Hidden bindings stay hidden;
    /// workspaces the account has left are dropped. Nil when nothing changed,
    /// so a refresh that found no news writes nothing.
    func syncedBindings(connectionId: String, userId: String, workspaces: [Workspace]) -> [WorkspaceBinding]? {
        let others = bindings.filter { $0.connectionId != connectionId }
        let mine = bindings.filter { $0.connectionId == connectionId && $0.userId == userId }
        let next = workspaces.map { ws -> WorkspaceBinding in
            let previous = mine.first { $0.workspaceId == ws.id }
            return WorkspaceBinding(
                connectionId: connectionId, userId: userId, workspaceId: ws.id, name: ws.name,
                hidden: previous?.hidden, order: previous?.order, avatarUrl: ws.avatarUrl
            )
        }
        let unchanged = next == mine && bindings.count == others.count + mine.count
        return unchanged ? nil : others + next
    }
}

/// Only worth naming where a workspace lives when there is more than one place.
func switcherShowsSource(_ entries: [SwitcherEntry]) -> Bool {
    Set(entries.map(\.connectionId)).count > 1
}
