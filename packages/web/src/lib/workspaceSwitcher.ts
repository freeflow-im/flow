// One workspace list across every connection: every Flow server's workspaces
// side by side in the sidebar menu, the chooser and Workspaces & servers.
// The foreground connection contributes its live list; every other connection
// contributes the workspaces bound to it in the registry, which is what the
// switcher already persists per connection.
import type { ConnectionRegistry, WorkspaceBinding } from './connections';
import type { ConnectionSyncState } from './backgroundSync';
import type { ConnectionProvider } from './serverOrigin';
import { originLabel } from './serverOrigin';

export interface SwitcherEntry {
  connectionId: string;
  workspaceId: string;
  name: string;
  avatarUrl: string | null;
  provider: ConnectionProvider;
  /** Where the workspace lives: the server's host name. */
  source: string;
  unread: number;
  /** Belongs to the connection this window is showing. */
  foreground: boolean;
}

export function switcherEntries(
  registry: ConnectionRegistry,
  foregroundConnectionId: string,
  foregroundWorkspaces: { id: string; name: string; avatarUrl?: string | null; unreadCount?: number }[] | undefined,
  syncStates: ConnectionSyncState[] = [],
): SwitcherEntry[] {
  const entries: SwitcherEntry[] = [];
  for (const connection of registry.connections) {
    const session = registry.sessions.find(s => s.connectionId === connection.connectionId);
    const foreground = connection.connectionId === foregroundConnectionId;
    // A connection that needs signing in again is listed in Workspaces &
    // servers with that prompt; it has nothing to open from a menu.
    if (!foreground && session?.status !== 'authenticated') continue;
    const source = originLabel(connection.origin);
    const unreadByWorkspace = syncStates.find(s => s.connectionId === connection.connectionId)?.unreadByWorkspace ?? {};
    const workspaces = foreground && foregroundWorkspaces
      ? foregroundWorkspaces
      : registry.bindings
        .filter(b => b.connectionId === connection.connectionId && !b.hidden && (!session?.userId || b.userId === session.userId))
        .map(b => ({ id: b.workspaceId, name: b.name, avatarUrl: b.avatarUrl, unreadCount: undefined }));
    for (const ws of workspaces) {
      entries.push({
        connectionId: connection.connectionId,
        workspaceId: ws.id,
        name: ws.name,
        avatarUrl: ws.avatarUrl ?? null,
        provider: connection.provider,
        source,
        unread: unreadByWorkspace[ws.id] ?? ws.unreadCount ?? 0,
        foreground,
      });
    }
  }
  return entries;
}

/** Bring a connection's bindings in line with its live workspace list, so the
 * switcher shows the same workspaces, names and avatars for it while another
 * connection is on screen. Hidden bindings stay hidden; workspaces the account
 * has left are dropped. Returns null when nothing changed. */
export function syncedBindings(
  registry: ConnectionRegistry,
  connectionId: string,
  userId: string,
  workspaces: { id: string; name: string; avatarUrl?: string | null }[],
): WorkspaceBinding[] | null {
  const others = registry.bindings.filter(b => b.connectionId !== connectionId);
  const mine = registry.bindings.filter(b => b.connectionId === connectionId && b.userId === userId);
  const next = workspaces.map((ws): WorkspaceBinding => {
    const previous = mine.find(b => b.workspaceId === ws.id);
    return { ...previous, connectionId, userId, workspaceId: ws.id, name: ws.name, avatarUrl: ws.avatarUrl ?? null };
  });
  const key = (b: WorkspaceBinding) => JSON.stringify([b.workspaceId, b.name, b.avatarUrl ?? null, !!b.hidden, b.order ?? null]);
  const unchanged = next.length === mine.length && next.every((b, i) => key(b) === key(mine[i]!))
    && registry.bindings.every(b => b.connectionId !== connectionId || b.userId === userId);
  return unchanged ? null : [...others, ...next];
}

/** Only worth naming where a workspace lives when there is more than one place. */
export function showsSource(entries: SwitcherEntry[]): boolean {
  return new Set(entries.map(e => e.connectionId)).size > 1;
}

export const OPEN_WORKSPACE_EVENT = 'flow:open-workspace';

/** Open a workspace on any connection. The root owns the foreground runtime,
 * so a session component asks it to switch rather than switching itself. */
export function openWorkspace(connectionId: string, workspaceId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_EVENT, { detail: { connectionId, workspaceId } }));
}
