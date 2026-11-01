// Versioned local connection registry (docs/specs/multi-server-workspaces.md,
// "Connection and identity model"). This is the durable half of multi-server
// support: which backends this browser knows about, which identity is signed in
// on each, and *where* each one's credentials and cached state live.
//
// The registry never holds a credential. It holds a `credentialRef` — the
// storage key the bearer lives under — and a `storageKey` that namespaces every
// other per-session artifact. Two properties fall out of that:
//
//   * Legacy migration is a rename-free, copy-free act. The pre-multi-server
//     connection keeps `flow.token` as its credentialRef and the unprefixed
//     `flow.*` keys as its namespace, so an upgraded browser re-downloads
//     nothing and an interrupted migration cannot strand a session.
//   * A token is never copied to another origin, because nothing ever copies a
//     token at all.
//
// `storageKey` is minted locally and is not a server-supplied id, so two
// backends that hand out deliberately colliding user/workspace UUIDs still get
// disjoint namespaces.
import { getHost } from './host';
import { canonicalizeOrigin, originLabel, type ConnectionProvider } from './serverOrigin';

export const REGISTRY_KEY = 'flow.connections';
export const MIGRATION_MARKER_KEY = 'flow.connections.migrated';
export const REGISTRY_VERSION = 1;

/** The namespace the single pre-multi-server connection already occupies. */
export const LEGACY_STORAGE_KEY = 'legacy';
export const LEGACY_TOKEN_KEY = 'flow.token';

export interface ServerConnection {
  connectionId: string;
  provider: ConnectionProvider;
  /** Provider identity: the canonical origin. Never treated as an
   * authentication claim. */
  providerIdentity: string;
  /** Canonical origin / transport endpoint the runtime dials. */
  origin: string;
  label: string;
  /** `protocolVersion` from `GET /v1/client-info`, null until discovery runs
   * (the migrated default connection predates discovery). */
  apiVersion: number | null;
  capabilities: Record<string, boolean>;
  addedAt: string;
}

export type SessionStatus = 'authenticated' | 'unauthorized' | 'signed-out';

export interface ServerSession {
  connectionId: string;
  /** Server-issued user id. Null before the first `/v1/me` succeeds. */
  userId: string | null;
  /** Storage key the bearer lives under — a reference, never the token. */
  credentialRef: string;
  /** Namespace for this connection+identity's caches, drafts, nav and markers. */
  storageKey: string;
  /** Bumped on every token replacement so a 401 from a pre-refresh request
   * cannot invalidate the session that replaced it. */
  authGeneration: number;
  status: SessionStatus;
}

export interface WorkspaceBinding {
  connectionId: string;
  userId: string;
  workspaceId: string;
  name: string;
  /** The workspace's avatar path on its own backend, so a switcher can draw it
   * while another connection is on screen. */
  avatarUrl?: string | null;
  hidden?: boolean;
  order?: number;
}

export interface NavigationTarget {
  connectionId: string;
  userId: string;
  workspaceId: string;
  channelId?: string;
  messageId?: string;
  threadRootId?: string;
  artifactId?: string;
}

export interface ConnectionRegistry {
  version: number;
  connections: ServerConnection[];
  sessions: ServerSession[];
  bindings: WorkspaceBinding[];
  navigation: NavigationTarget[];
  activeConnectionId: string | null;
}

export function emptyRegistry(): ConnectionRegistry {
  return {
    version: REGISTRY_VERSION,
    connections: [],
    sessions: [],
    bindings: [],
    navigation: [],
    activeConnectionId: null,
  };
}

function newId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Storage key for one of a session's namespaced artifacts. The legacy
 * namespace deliberately resolves to the unprefixed key an existing browser
 * already has (`flow.activeWorkspace`, …). */
export function scopedKey(storageKey: string, name: string): string {
  return storageKey === LEGACY_STORAGE_KEY ? `flow.${name}` : `flow.${storageKey}.${name}`;
}

export function credentialRefFor(storageKey: string): string {
  return storageKey === LEGACY_STORAGE_KEY ? LEGACY_TOKEN_KEY : scopedKey(storageKey, 'token');
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Reject anything that is not a registry we wrote. A corrupt or
 * future-versioned blob is discarded rather than half-read: the connections it
 * describes are rebuildable (migration re-runs, servers get re-added), and
 * guessing at unknown ownership is exactly what the spec forbids. */
function parseRegistry(raw: string | null): ConnectionRegistry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ConnectionRegistry>;
    if (parsed?.version !== REGISTRY_VERSION) return null;
    if (!Array.isArray(parsed.connections) || !Array.isArray(parsed.sessions)) return null;
    return {
      version: REGISTRY_VERSION,
      connections: parsed.connections,
      sessions: parsed.sessions,
      bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [],
      navigation: Array.isArray(parsed.navigation) ? parsed.navigation : [],
      activeConnectionId: parsed.activeConnectionId ?? null,
    };
  } catch {
    return null;
  }
}

export function loadRegistry(): ConnectionRegistry {
  return parseRegistry(localStorage.getItem(REGISTRY_KEY)) ?? emptyRegistry();
}

export function saveRegistry(registry: ConnectionRegistry): void {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export function connectionById(
  registry: ConnectionRegistry,
  connectionId: string,
): ServerConnection | undefined {
  return registry.connections.find((c) => c.connectionId === connectionId);
}

export function sessionFor(
  registry: ConnectionRegistry,
  connectionId: string,
): ServerSession | undefined {
  return registry.sessions.find((s) => s.connectionId === connectionId);
}

/** Add a Flow connection for `origin`, or return the existing one. Changing an
 * origin creates a *new* connection in V1 — a server cannot declare itself
 * equivalent to another through discovery metadata, so identity here is the
 * canonical origin and nothing else. */
export function addFlowConnection(
  registry: ConnectionRegistry,
  input: { origin: string; label?: string; apiVersion?: number | null; capabilities?: Record<string, boolean> },
): { registry: ConnectionRegistry; connection: ServerConnection } {
  const canonical = canonicalizeOrigin(input.origin, { allowInsecureLoopback: true });
  const existing = registry.connections.find(
    (c) => c.provider === 'flow' && c.origin === canonical.origin,
  );
  if (existing) return { registry, connection: existing };

  const connection: ServerConnection = {
    connectionId: newId(),
    provider: 'flow',
    providerIdentity: canonical.origin,
    origin: canonical.origin,
    label: input.label ?? originLabel(canonical.origin),
    apiVersion: input.apiVersion ?? null,
    capabilities: input.capabilities ?? {},
    addedAt: new Date().toISOString(),
  };
  const storageKey = newId();
  const session: ServerSession = {
    connectionId: connection.connectionId,
    userId: null,
    credentialRef: credentialRefFor(storageKey),
    storageKey,
    authGeneration: 0,
    status: 'signed-out',
  };
  return {
    registry: {
      ...registry,
      connections: [...registry.connections, connection],
      sessions: [...registry.sessions, session],
      activeConnectionId: registry.activeConnectionId ?? connection.connectionId,
    },
    connection,
  };
}

export function updateSession(
  registry: ConnectionRegistry,
  connectionId: string,
  patch: Partial<ServerSession>,
): ConnectionRegistry {
  return {
    ...registry,
    sessions: registry.sessions.map((s) =>
      s.connectionId === connectionId ? { ...s, ...patch } : s,
    ),
  };
}

/** Bind a verified identity to a connection. When the identity differs from the
 * one the namespace was built for, the session gets a fresh `storageKey` and
 * the old namespace is dropped: cached state whose ownership we can no longer
 * establish is discarded and refetched, never handed to another identity. */
export function bindIdentity(
  registry: ConnectionRegistry,
  connectionId: string,
  userId: string,
): { registry: ConnectionRegistry; rotatedFrom: string | null } {
  const session = sessionFor(registry, connectionId);
  if (!session) return { registry, rotatedFrom: null };
  if (session.userId === userId) {
    return {
      registry: updateSession(registry, connectionId, { status: 'authenticated' }),
      rotatedFrom: null,
    };
  }
  // First identity on a namespace nobody has used yet: adopt it as-is. That is
  // what keeps the migrated legacy namespace attached to its own user.
  if (session.userId === null) {
    return {
      registry: updateSession(registry, connectionId, { userId, status: 'authenticated' }),
      rotatedFrom: null,
    };
  }
  const storageKey = newId();
  return {
    registry: updateSession({
      ...registry,
      bindings: registry.bindings.filter(b => b.connectionId !== connectionId),
      navigation: registry.navigation.filter(n => n.connectionId !== connectionId),
    }, connectionId, {
      userId,
      storageKey,
      credentialRef: credentialRefFor(storageKey),
      status: 'authenticated',
    }),
    rotatedFrom: session.storageKey,
  };
}

/** Remove a connection and every record scoped to it. The caller disposes the
 * live runtime; this only forgets the durable half. */
export function removeConnection(
  registry: ConnectionRegistry,
  connectionId: string,
): ConnectionRegistry {
  const remaining = registry.connections.filter((c) => c.connectionId !== connectionId);
  return {
    ...registry,
    connections: remaining,
    sessions: registry.sessions.filter((s) => s.connectionId !== connectionId),
    bindings: registry.bindings.filter((b) => b.connectionId !== connectionId),
    navigation: registry.navigation.filter((n) => n.connectionId !== connectionId),
    activeConnectionId:
      registry.activeConnectionId === connectionId
        ? (remaining[0]?.connectionId ?? null)
        : registry.activeConnectionId,
  };
}

export function setWorkspaceBinding(
  registry: ConnectionRegistry,
  binding: WorkspaceBinding,
): ConnectionRegistry {
  const rest = registry.bindings.filter(
    (b) =>
      !(
        b.connectionId === binding.connectionId &&
        b.userId === binding.userId &&
        b.workspaceId === binding.workspaceId
      ),
  );
  return { ...registry, bindings: [...rest, binding] };
}

/** One remembered destination per connection+identity — where that session
 * lands on the next launch. */
export function setNavigationTarget(
  registry: ConnectionRegistry,
  target: NavigationTarget,
): ConnectionRegistry {
  const rest = registry.navigation.filter(
    (n) => !(n.connectionId === target.connectionId && n.userId === target.userId),
  );
  return { ...registry, navigation: [...rest, target] };
}

export function navigationTargetFor(
  registry: ConnectionRegistry,
  connectionId: string,
  userId: string,
): NavigationTarget | undefined {
  return registry.navigation.find((n) => n.connectionId === connectionId && n.userId === userId);
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/** Keys a namespace owns, so dropping one is exhaustive rather than a guess. */
const NAMESPACED_NAMES = [
  'token',
  'activeWorkspace',
  'adminPanelOpen',
  'collapsedImages',
  'cachedUser',
  'pendingInvite',
  'pendingJoinLink',
];

export function clearNamespace(storageKey: string): void {
  // The bearer lives wherever the host keeps credentials (the OS store on
  // desktop), never only in localStorage.
  getHost().secrets.delete(credentialRefFor(storageKey));
  for (const name of NAMESPACED_NAMES) localStorage.removeItem(scopedKey(storageKey, name));
  const prefixes = ['draft:', 'navigation:', 'scroll:'].map(name => scopedKey(storageKey, name));
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key && prefixes.some(prefix => key.startsWith(prefix))) localStorage.removeItem(key);
  }
}

/** Create the default connection from this page's own origin on first upgrade,
 * adopting the existing token, selected workspace and identity in place.
 *
 * Crash-safe and idempotent by construction: the marker is written only after
 * the registry commits, and nothing is moved or deleted before it does. A crash
 * anywhere in here leaves a browser that still has `flow.token` and
 * `flow.activeWorkspace` exactly where they were, and the next launch re-runs
 * the migration and reaches the same result.
 */
export function migrateLegacyState(origin: string = location.origin): ConnectionRegistry {
  const existing = parseRegistry(localStorage.getItem(REGISTRY_KEY));
  if (existing && localStorage.getItem(MIGRATION_MARKER_KEY)) return existing;
  if (existing && existing.connections.length > 0) return existing;

  const canonical = canonicalizeOrigin(origin, { allowInsecureLoopback: true });
  const base = existing ?? emptyRegistry();
  const connection: ServerConnection = {
    connectionId: newId(),
    provider: 'flow',
    providerIdentity: canonical.origin,
    origin: canonical.origin,
    label: originLabel(canonical.origin),
    apiVersion: null,
    capabilities: {},
    addedAt: new Date().toISOString(),
  };
  // The identity is left null on purpose: it is committed by `bindIdentity`
  // once `/v1/me` has *validated* the adopted token. Recording a userId we have
  // not confirmed would be the one thing migration must not do.
  const session: ServerSession = {
    connectionId: connection.connectionId,
    userId: null,
    credentialRef: LEGACY_TOKEN_KEY,
    storageKey: LEGACY_STORAGE_KEY,
    authGeneration: 0,
    status: getHost().secrets.get(LEGACY_TOKEN_KEY) ? 'authenticated' : 'signed-out',
  };
  const registry: ConnectionRegistry = {
    ...base,
    connections: [...base.connections, connection],
    sessions: [...base.sessions, session],
    activeConnectionId: connection.connectionId,
  };
  saveRegistry(registry);
  localStorage.setItem(
    MIGRATION_MARKER_KEY,
    JSON.stringify({ version: REGISTRY_VERSION, at: new Date().toISOString() }),
  );
  return registry;
}

/** Registry for this browser, migrating on first upgrade. */
export function loadOrMigrateRegistry(origin: string = location.origin): ConnectionRegistry {
  const existing = parseRegistry(localStorage.getItem(REGISTRY_KEY));
  if (existing && existing.connections.length > 0) return existing;
  return migrateLegacyState(origin);
}
