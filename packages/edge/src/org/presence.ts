// Presence bookkeeping (phase1.md §3). Extracted from the gateway in phase 2
// so the notification service can resolve <!here> to currently-online channel
// members without importing gateway internals.
//
// Presence is keyed per **(user, workspace)**, not per user (#364). A user's
// socket carries every workspace they belong to, but the *connection* may only
// serve some of them — an agent bridge runs one process per workspace and
// ignores the rest — so a connection declares which workspaces it is present
// in. Counting per workspace is also what makes multiple connections work: the
// dot stays green while any connection announcing that workspace is alive.
//
// Every connection carries a lastSeen stamp so `sweepStale` can drop entries
// whose close event never arrived (half-open socket, killed process). That is
// the backstop; the socket 'close' handler is the fast path.
//
// Phase 18 M2 (docs/design/DISTRIBUTED_PRESENCE.md §1): alongside the local
// maps, the store holds a *remote* view — per-replica online snapshots
// gossiped over NATS by presenceSync.ts, expiring after a few missed beats.
// Every read merges local + live remote. The event-dedup rule is asymmetric,
// a deliberate deviation from the design doc (decision_log 2026-08-31):
//
// - **online** transitions report the *local* answer (0→1 locally emits even
//   if a remote replica already has the user). The remote view is up to one
//   heartbeat stale, and a stale entry suppressing a real online transition
//   paints a wrong gray dot until some refetch; a redundant online event is
//   harmless — presence events are idempotent state, not a stream.
// - **offline** transitions report the *merged* answer (1→0 locally emits
//   only if no live remote replica still has the user), because an offline
//   event for a user still connected elsewhere would be *wrong*, not
//   redundant. The staleness hole this leaves (both sockets closing on
//   different replicas within one beat suppresses both emissions) is closed
//   by `applyRemoteSnapshot` returning merged-view drops for presenceSync's
//   elected emitter.
//
// At one replica the remote view is empty and all of this degenerates to the
// old behavior.
//
// The store is a class so tests can run two "replicas" in one process; the
// module-level functions below delegate to a process-wide default instance —
// the seam every consumer (gateway, notifications, presenceSync) imports.

interface Connection {
  userId: string;
  /** workspaces this connection announces presence in */
  workspaces: Set<string>;
  lastSeen: number;
}

interface RemoteReplica {
  /** workspaceId -> userIds online there via that replica */
  workspaces: Map<string, Set<string>>;
  lastSeen: number;
}

export interface StaleConnection {
  connectionId: string;
  userId: string;
  /** workspaces the user is now offline in because of this expiry */
  wentOffline: string[];
}

/** A (user, workspace) pair that left the merged view when a replica expired. */
export interface RemoteOffline {
  workspaceId: string;
  userId: string;
}

export class PresenceStore {
  /** connectionId -> connection */
  private connections = new Map<string, Connection>();
  /** userId -> workspaceId -> number of live local connections present there */
  private counts = new Map<string, Map<string, number>>();
  /** workspaceId -> userIds locally online in it (index over `counts`) */
  private byWorkspace = new Map<string, Set<string>>();
  /** replicaId -> that replica's last-heartbeat snapshot */
  private remote = new Map<string, RemoteReplica>();

  /** Bump the (user, workspace) counter. True if they just came online locally. */
  private increment(userId: string, workspaceId: string): boolean {
    let perWorkspace = this.counts.get(userId);
    if (!perWorkspace) this.counts.set(userId, (perWorkspace = new Map()));
    const next = (perWorkspace.get(workspaceId) ?? 0) + 1;
    perWorkspace.set(workspaceId, next);
    if (next > 1) return false;
    let members = this.byWorkspace.get(workspaceId);
    if (!members) this.byWorkspace.set(workspaceId, (members = new Set()));
    members.add(userId);
    return true;
  }

  /** Drop one from the (user, workspace) counter. True if they just went offline locally. */
  private decrement(userId: string, workspaceId: string): boolean {
    const perWorkspace = this.counts.get(userId);
    const next = (perWorkspace?.get(workspaceId) ?? 0) - 1;
    if (!perWorkspace || next > 0) {
      perWorkspace?.set(workspaceId, next);
      return false;
    }
    perWorkspace.delete(workspaceId);
    if (perWorkspace.size === 0) this.counts.delete(userId);
    const members = this.byWorkspace.get(workspaceId);
    members?.delete(userId);
    if (members?.size === 0) this.byWorkspace.delete(workspaceId);
    return true;
  }

  /** Is the user online in this workspace via any *live remote* replica? */
  private remoteHas(userId: string, workspaceId: string): boolean {
    for (const r of this.remote.values()) {
      if (r.workspaces.get(workspaceId)?.has(userId)) return true;
    }
    return false;
  }

  /**
   * A connection came up. `workspaceIds` is the set it announces presence in.
   * Returns the workspaces where this made the user newly online *locally*
   * (publish `presence: online` for exactly those — see the header for why
   * online emissions deliberately ignore the remote view).
   */
  registerConnection(
    connectionId: string,
    userId: string,
    workspaceIds: Iterable<string>,
    now: number = Date.now(),
  ): string[] {
    const workspaces = new Set(workspaceIds);
    this.connections.set(connectionId, { userId, workspaces, lastSeen: now });
    const cameOnline: string[] = [];
    for (const wsId of workspaces) {
      if (this.increment(userId, wsId)) cameOnline.push(wsId);
    }
    return cameOnline;
  }

  /** The connection is still alive (any inbound frame, heartbeat pong included). */
  touchConnection(connectionId: string, now: number = Date.now()): void {
    const conn = this.connections.get(connectionId);
    if (conn) conn.lastSeen = now;
  }

  /**
   * The connection went away. Returns the workspaces where the user is now
   * offline **globally** (publish `presence: offline` for exactly those).
   */
  unregisterConnection(connectionId: string): string[] {
    const conn = this.connections.get(connectionId);
    if (!conn) return [];
    this.connections.delete(connectionId);
    const wentOffline: string[] = [];
    for (const wsId of conn.workspaces) {
      if (this.decrement(conn.userId, wsId) && !this.remoteHas(conn.userId, wsId)) wentOffline.push(wsId);
    }
    return wentOffline;
  }

  /** This connection now also serves `workspaceId` (a live workspace.joined).
   * True if the user is newly online there locally (see header). */
  addWorkspace(connectionId: string, workspaceId: string): boolean {
    const conn = this.connections.get(connectionId);
    if (!conn || conn.workspaces.has(workspaceId)) return false;
    conn.workspaces.add(workspaceId);
    return this.increment(conn.userId, workspaceId);
  }

  /** This connection stopped serving `workspaceId` (the user left it).
   * True if the user is now offline there globally. */
  removeWorkspace(connectionId: string, workspaceId: string): boolean {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.workspaces.has(workspaceId)) return false;
    conn.workspaces.delete(workspaceId);
    return this.decrement(conn.userId, workspaceId) && !this.remoteHas(conn.userId, workspaceId);
  }

  isOnline(userId: string, workspaceId: string): boolean {
    if ((this.counts.get(userId)?.get(workspaceId) ?? 0) > 0) return true;
    return this.remoteHas(userId, workspaceId);
  }

  /** Everyone currently online in this workspace, merged across replicas
   * (for the connect-time snapshot). */
  onlineUsersIn(workspaceId: string): string[] {
    const merged = new Set(this.byWorkspace.get(workspaceId) ?? []);
    for (const r of this.remote.values()) {
      for (const uid of r.workspaces.get(workspaceId) ?? []) merged.add(uid);
    }
    return [...merged];
  }

  /** Does this user hold any live connection, on any replica? (any workspace)
   * The gateway's disconnect path keys indicator clearing off this — a user
   * still connected via another replica must not lose their spinners. */
  hasAnyConnection(userId: string): boolean {
    if ((this.counts.get(userId)?.size ?? 0) > 0) return true;
    for (const r of this.remote.values()) {
      for (const users of r.workspaces.values()) if (users.has(userId)) return true;
    }
    return false;
  }

  /**
   * TTL backstop: forget connections that haven't been heard from within
   * `ttlMs`. A clean close is handled by `unregisterConnection`; this catches
   * the cases where the close never arrives — a half-open socket, a laptop
   * that slept, a process killed with its FIN lost. `wentOffline` is global,
   * same dedup rule as every other transition.
   */
  sweepStale(ttlMs: number, now: number = Date.now()): StaleConnection[] {
    const stale: StaleConnection[] = [];
    for (const [connectionId, conn] of this.connections) {
      if (now - conn.lastSeen <= ttlMs) continue;
      stale.push({ connectionId, userId: conn.userId, wentOffline: this.unregisterConnection(connectionId) });
    }
    return stale;
  }

  // ---- distributed layer (phase 18 M2) — fed by presenceSync.ts ----

  /** This replica's own online set, heartbeat-shaped. */
  localSnapshot(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [wsId, users] of this.byWorkspace) out[wsId] = [...users];
    return out;
  }

  /**
   * Absorb another replica's heartbeat (full snapshot, self-healing).
   * Returns the (user, workspace) pairs this snapshot *removed* from the
   * merged view — the origin replica suppressed their offline events against
   * what was then a live view of us, so presenceSync's elected emitter
   * publishes them (duplicates are tolerated; see header).
   */
  applyRemoteSnapshot(
    replicaId: string,
    workspaces: Record<string, string[]>,
    now: number = Date.now(),
  ): RemoteOffline[] {
    const previous = this.remote.get(replicaId);
    const parsed = new Map<string, Set<string>>();
    for (const [wsId, users] of Object.entries(workspaces)) parsed.set(wsId, new Set(users));
    this.remote.set(replicaId, { workspaces: parsed, lastSeen: now });
    if (!previous) return [];
    const wentOffline: RemoteOffline[] = [];
    for (const [wsId, users] of previous.workspaces) {
      for (const uid of users) {
        if (parsed.get(wsId)?.has(uid)) continue; // still there
        if (!this.isOnline(uid, wsId)) wentOffline.push({ workspaceId: wsId, userId: uid });
      }
    }
    return wentOffline;
  }

  /**
   * Drop remote replicas not heard from within `ttlMs` (a crash — their
   * offline events were never emitted). Returns the (user, workspace) pairs
   * that left the *merged* view as a result; the elected replica (see
   * presenceSync) publishes offline events for exactly those.
   */
  expireRemote(ttlMs: number, now: number = Date.now()): RemoteOffline[] {
    const dropped: RemoteReplica[] = [];
    for (const [replicaId, r] of this.remote) {
      if (now - r.lastSeen <= ttlMs) continue;
      this.remote.delete(replicaId);
      dropped.push(r);
    }
    const wentOffline: RemoteOffline[] = [];
    const seen = new Set<string>();
    for (const r of dropped) {
      for (const [wsId, users] of r.workspaces) {
        for (const uid of users) {
          const key = `${wsId}\n${uid}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!this.isOnline(uid, wsId)) wentOffline.push({ workspaceId: wsId, userId: uid });
        }
      }
    }
    return wentOffline;
  }

  /** Replica ids currently in the remote view (they expire via expireRemote). */
  liveRemoteReplicaIds(): string[] {
    return [...this.remote.keys()];
  }

  /** Test hook — drop all presence state, local and remote. */
  reset(): void {
    this.connections.clear();
    this.counts.clear();
    this.byWorkspace.clear();
    this.remote.clear();
  }
}

// ---- process-wide default instance + the function seam everyone imports ----

export const presenceStore = new PresenceStore();

export function registerConnection(
  connectionId: string,
  userId: string,
  workspaceIds: Iterable<string>,
  now: number = Date.now(),
): string[] {
  return presenceStore.registerConnection(connectionId, userId, workspaceIds, now);
}

export function touchConnection(connectionId: string, now: number = Date.now()): void {
  presenceStore.touchConnection(connectionId, now);
}

export function unregisterConnection(connectionId: string): string[] {
  return presenceStore.unregisterConnection(connectionId);
}

export function addWorkspace(connectionId: string, workspaceId: string): boolean {
  return presenceStore.addWorkspace(connectionId, workspaceId);
}

export function removeWorkspace(connectionId: string, workspaceId: string): boolean {
  return presenceStore.removeWorkspace(connectionId, workspaceId);
}

export function isOnline(userId: string, workspaceId: string): boolean {
  return presenceStore.isOnline(userId, workspaceId);
}

export function onlineUsersIn(workspaceId: string): string[] {
  return presenceStore.onlineUsersIn(workspaceId);
}

export function hasAnyConnection(userId: string): boolean {
  return presenceStore.hasAnyConnection(userId);
}

export function sweepStale(ttlMs: number, now: number = Date.now()): StaleConnection[] {
  return presenceStore.sweepStale(ttlMs, now);
}

/** Test hook — drop all presence state. */
export function resetPresence(): void {
  presenceStore.reset();
}
