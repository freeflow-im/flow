// Session runtimes (docs/specs/multi-server-workspaces.md, "Runtime
// architecture"). A ConnectionRuntime owns everything that belongs to one
// backend session: the API client bound to that origin, the bearer and its auth
// generation, the blob/text caches and the object URLs they minted, and the
// identity those are cached for. ConnectionManager owns the runtimes.
//
// Nothing here reads a module-global. That is the whole point: an operation
// that captured a runtime when it started cannot be retargeted at another
// server by a later workspace switch, and disposing one connection cannot touch
// another's sockets, caches or object URLs.
import type { AppTokenDTO, FileDTO, PresignedUploadDTO, WorkspaceDTO } from '@flow/shared';
import { prepareImageForUpload } from './imagePrep';
import {
  bindIdentity,
  connectionById,
  credentialRefFor,
  clearNamespace,
  loadOrMigrateRegistry,
  loadRegistry,
  removeConnection as removeFromRegistry,
  navigationTargetFor,
  saveRegistry,
  scopedKey,
  setNavigationTarget,
  sessionFor,
  updateSession,
  addFlowConnection,
  setWorkspaceBinding,
  type WorkspaceBinding,
  type ConnectionRegistry,
  type NavigationTarget,
  type ServerConnection,
} from './connections';
import { getHost } from './host';
import { isSameOrigin, socketUrlFor } from './serverOrigin';

/** Where bearers live: `localStorage` in a browser, the OS credential store
 * behind the desktop shell (docs/specs/desktop-electron.md). Read through
 * the host on every call rather than captured, so a test can swap it. */
const credentials = () => getHost().secrets;

/** The server a fresh client connects to: the shell's baked default on
 * desktop (the page origin there is `app://flow`, not a server), the page's
 * own origin in a browser. */
export function defaultServerOrigin(): string {
  return getHost().defaultServerOrigin ?? location.origin;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown when a caller hands an API helper an absolute URL. API helpers accept
 * relative API paths only — an authenticated absolute URL is how a bearer ends
 * up on someone else's origin. */
export class ForeignOriginError extends ApiError {
  constructor(url: string) {
    super(0, 'foreign_origin', `refusing to send credentials to ${url}`);
  }
}

export type FileImageVariant = 'thumbnail' | 'original';

export class ConnectionRuntime {
  readonly connectionId: string;
  readonly provider: string;
  /** Canonical origin every request, socket and media URL resolves against —
   * not the page's origin, which is a different server in a multi-server
   * client. */
  readonly origin: string;
  readonly label: string;

  private token: string | null = null;
  /** Bumped on every token replacement. A request carries the generation it
   * went out under, and a 401 is only believed when it still matches — so a
   * slow request from before a refresh cannot sign out the session that
   * replaced it. */
  private generation = 0;
  private identity: string | null = null;
  private storageKey: string;

  private blobCache = new Map<string, Promise<string>>();
  private resolvedBlobUrls = new Map<string, string>();
  private textCache = new Map<string, Promise<string>>();
  private objectUrls = new Set<string>();
  private disposed = false;

  private onUnauthorized: (() => void) | null = null;

  constructor(
    connection: ServerConnection,
    init: { storageKey: string; userId: string | null; authGeneration: number },
  ) {
    this.connectionId = connection.connectionId;
    this.provider = connection.provider;
    this.origin = connection.origin;
    this.label = connection.label;
    this.storageKey = init.storageKey;
    this.identity = init.userId;
    this.generation = init.authGeneration;
    this.token = credentials().get(credentialRefFor(init.storageKey));
  }

  get userId(): string | null {
    return this.identity;
  }

  get authGeneration(): number {
    return this.generation;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** `wss://…/v1/ws` on the owning backend. */
  get socketUrl(): string {
    return socketUrlFor(this.origin);
  }

  // -- storage -------------------------------------------------------------

  /** Storage key for one of this session's namespaced artifacts. */
  key(name: string): string {
    return scopedKey(this.storageKey, name);
  }

  read(name: string): string | null {
    return localStorage.getItem(this.key(name));
  }

  write(name: string, value: string | null): void {
    if (this.disposed) return;
    if (value === null) localStorage.removeItem(this.key(name));
    else localStorage.setItem(this.key(name), value);
  }

  // -- credentials ---------------------------------------------------------

  getToken(): string | null {
    return this.token;
  }

  /** Replace this connection's bearer. Bumps the auth generation, so any 401
   * still in flight from the previous one is ignored. */
  setToken(token: string | null): number {
    if (this.disposed) return this.generation;
    this.token = token;
    this.generation += 1;
    const ref = credentialRefFor(this.storageKey);
    if (token) credentials().set(ref, token);
    else credentials().delete(ref);
    return this.generation;
  }

  setUnauthorizedHandler(handler: (() => void) | null): void {
    this.onUnauthorized = handler;
  }

  /** Called with the generation the failing request went out under. */
  private reportUnauthorized(generation: number): void {
    if (this.disposed || generation !== this.generation) return;
    this.onUnauthorized?.();
  }

  /** Adopt the storage namespace this session's identity owns. Returns the
   * namespace that was abandoned, if the identity changed — its cached state
   * has unknown ownership now and must be discarded, not reassigned. */
  adoptStorageKey(storageKey: string): void {
    if (storageKey === this.storageKey) return;
    this.storageKey = storageKey;
    this.token = credentials().get(credentialRefFor(storageKey));
    this.dropCaches();
  }

  setIdentity(userId: string | null): void {
    this.identity = userId;
  }

  // -- URLs ----------------------------------------------------------------

  /** Absolute URL on the owning backend for a relative API path. Absolute
   * input is refused rather than passed through. */
  url(path: string): string {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) || path.startsWith('//')) {
      throw new ForeignOriginError(path);
    }
    return new URL(path.startsWith('/') ? path : `/${path}`, this.origin).toString();
  }

  /** Does this URL belong to the backend that may see our bearer? */
  ownsUrl(url: string): boolean {
    return isSameOrigin(this.origin, url);
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  // -- REST ----------------------------------------------------------------

  async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.disposed) throw new ApiError(0, 'disposed', 'connection closed');
    const url = this.url(path);
    const generation = this.generation;
    const res = await fetch(url, {
      method,
      // Bearer auth only; a cross-origin backend must never see ambient
      // cookies (docs/dev/MULTISERVER.md, "Allowed browser origins").
      credentials: 'omit',
      redirect: 'error',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...this.authHeaders(),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code: string; message: string };
    };
    if (!res.ok) {
      if (res.status === 401) this.reportUnauthorized(generation);
      throw new ApiError(
        res.status,
        json.error?.code ?? `http_${res.status}`,
        json.error?.message ?? `HTTP ${res.status}`,
      );
    }
    if (this.disposed || generation !== this.generation) throw new ApiError(0, 'disposed', 'session changed');
    return json as T;
  }

  mintAppToken(artifactId: string): Promise<AppTokenDTO> {
    return this.api('POST', `/v1/artifacts/${artifactId}/app-token`);
  }

  fileStreamUrl(fileId: string): Promise<{ url: string | null; expiresInSeconds: number }> {
    return this.api('GET', `/v1/files/${fileId}/url`);
  }

  fileThumbUrl(fileId: string): Promise<{ url: string | null; expiresInSeconds: number }> {
    return this.api('GET', `/v1/files/${fileId}/thumb/url`);
  }

  async fileImageUrl(fileId: string, variant: FileImageVariant): Promise<string> {
    const direct = variant === 'thumbnail' ? await this.fileThumbUrl(fileId) : await this.fileStreamUrl(fileId);
    // A presigned storage URL is on someone else's origin by design — hand it
    // straight to the element, never through the authenticated fetch path.
    if (direct.url) return direct.url;
    const suffix = variant === 'thumbnail' ? '/thumb' : '';
    return this.blobUrl(`/v1/files/${fileId}${suffix}`);
  }

  async uploadFile(workspaceId: string, original: File): Promise<FileDTO> {
    const file = await prepareImageForUpload(original);
    const pres = await this.api<PresignedUploadDTO>(
      'POST',
      `/v1/workspaces/${workspaceId}/files/presign`,
      { filename: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size },
    );
    // A relative target is this backend's own proxied-upload fallback and needs
    // our bearer. An absolute one is external storage and must never see it —
    // checked against the owning origin rather than trusted to be foreign.
    const target = pres.upload.url;
    const relative = !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) && !target.startsWith('//');
    const put = await fetch(relative ? this.url(target) : target, {
      method: pres.upload.method,
      credentials: 'omit',
      redirect: 'error',
      headers: {
        ...pres.upload.headers,
        ...(relative ? this.authHeaders() : {}),
      },
      body: file,
    });
    if (!put.ok) throw new ApiError(put.status, 'upload_failed', `upload failed (HTTP ${put.status})`);
    return this.api<FileDTO>('POST', `/v1/files/${pres.file.id}/complete`);
  }

  /** POST one file as multipart — the server-buffered upload path avatars use.
   * Surfaces the server's own error text, so a rejected mime type or an
   * over-cap image says why rather than "upload failed". */
  private async uploadMultipart<T>(path: string, file: File): Promise<T> {
    const form = new FormData();
    form.append('file', file, file.name);
    const generation = this.generation;
    const res = await fetch(this.url(path), {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: this.authHeaders(),
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code: string; message: string };
    };
    if (!res.ok) {
      if (res.status === 401) this.reportUnauthorized(generation);
      throw new ApiError(
        res.status,
        json.error?.code ?? 'upload_failed',
        json.error?.message ?? 'upload failed',
      );
    }
    if (this.disposed || generation !== this.generation) throw new ApiError(0, 'disposed', 'session changed');
    return json as T;
  }

  uploadAvatar(file: File): Promise<unknown> {
    return this.uploadMultipart('/v1/me/avatar', file);
  }

  uploadWorkspaceAvatar(workspaceId: string, file: File): Promise<WorkspaceDTO> {
    return this.uploadMultipart<WorkspaceDTO>(`/v1/workspaces/${workspaceId}/avatar`, file);
  }

  // -- authenticated blobs -------------------------------------------------

  /** Resolved object URLs, mirrored out of `blobCache` as each promise settles.
   * Even an already-resolved promise only delivers on the next microtask, so a
   * component seeding its first render from `blobUrl(path)` always paints a
   * placeholder for one frame. `cachedBlobUrl` lets it seed synchronously from
   * a prior resolution instead. */
  cachedBlobUrl(path: string): string | undefined {
    return this.resolvedBlobUrls.get(path);
  }

  blobUrl(path: string): Promise<string> {
    let cached = this.blobCache.get(path);
    if (!cached) {
      const generation = this.generation;
      cached = (async () => {
        // On a presigning backend (R2 in production) `GET /v1/files/:id` is a
        // 302 to storage, and the authenticated fetch below refuses redirects
        // so the bearer can never follow one off-origin. Ask for the storage
        // URL explicitly, as `fileImageUrl` does, and fetch it bare; a backend
        // that streams the bytes itself answers with no URL and the
        // authenticated path is used as before.
        const fileId = path.match(/^\/v1\/files\/([^/?#]+)$/)?.[1];
        const direct = fileId ? (await this.fileStreamUrl(fileId)).url : null;
        const res = await fetch(direct ?? this.url(path), {
          credentials: 'omit',
          redirect: 'error',
          headers: direct ? {} : this.authHeaders(),
        });
        if (!res.ok) {
          if (res.status === 401) this.reportUnauthorized(generation);
          throw new ApiError(res.status, 'blob_failed', `HTTP ${res.status}`);
        }
        const objectUrl = URL.createObjectURL(await res.blob());
        // A response that lands after this runtime was disposed must not
        // resurrect it: revoke immediately rather than leaking the URL.
        if (this.disposed) {
          URL.revokeObjectURL(objectUrl);
          throw new ApiError(0, 'disposed', 'connection closed');
        }
        this.objectUrls.add(objectUrl);
        return objectUrl;
      })();
      void cached.then(
        (u) => {
          if (!this.disposed) this.resolvedBlobUrls.set(path, u);
        },
        () => this.blobCache.delete(path),
      );
      this.blobCache.set(path, cached);
    }
    return cached;
  }

  /** Authenticated text fetch for inline file previews (same immutable-URL cache). */
  fileText(path: string): Promise<string> {
    let cached = this.textCache.get(path);
    if (!cached) {
      cached = this.blobUrl(path).then((u) => fetch(u).then((r) => r.text()));
      cached.catch(() => this.textCache.delete(path));
      this.textCache.set(path, cached);
    }
    return cached;
  }

  /** Drop cached bytes without ending the session — used when the identity
   * behind the cache changes. */
  private dropCaches(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.blobCache.clear();
    this.resolvedBlobUrls.clear();
    this.textCache.clear();
  }

  /** End this runtime: revoke its object URLs, drop its caches, and stop
   * believing anything that arrives afterwards. Touches nothing outside itself. */
  dispose(): void {
    this.disposed = true;
    this.onUnauthorized = null;
    this.dropCaches();
  }
}

// ---------------------------------------------------------------------------
// ConnectionManager
// ---------------------------------------------------------------------------

export class ConnectionManager {
  private registry: ConnectionRegistry;
  private runtimes = new Map<string, ConnectionRuntime>();
  private selected: string | null;

  constructor(origin: string = defaultServerOrigin()) {
    this.registry = loadOrMigrateRegistry(origin);
    this.selected = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem('flow.selectedConnection');
    // Any provider can be the foreground connection (#545); a Flow server is
    // the fallback when nothing valid is selected, because auth links and the
    // signed-out screens are Flow's.
    if (!this.selected || !connectionById(this.registry, this.selected)) {
      const saved = this.registry.activeConnectionId;
      this.selected = saved && connectionById(this.registry, saved) ? saved : this.registry.connections.find(c => c.provider === 'flow')?.connectionId ?? null;
    }
  }

  get state(): ConnectionRegistry {
    return this.registry;
  }

  get connections(): ServerConnection[] {
    return this.registry.connections;
  }

  get activeConnectionId(): string | null {
    return this.selected;
  }

  private commit(registry: ConnectionRegistry): void {
    this.registry = registry;
    saveRegistry(registry);
  }

  /** Reconcile another tab's credential changes without adopting its selection. */
  reloadFromStorage(): string[] {
    const next = loadRegistry();
    const invalidated: string[] = [];
    for (const [id, runtime] of this.runtimes) {
      const old = sessionFor(this.registry, id);
      const session = sessionFor(next, id);
      if (!session || session.storageKey !== old?.storageKey ||
          session.authGeneration !== old?.authGeneration || session.status !== old?.status ||
          credentials().get(session.credentialRef) !== runtime.getToken()) {
        runtime.dispose();
        this.runtimes.delete(id);
        invalidated.push(id);
      }
    }
    this.registry = next;
    if (this.selected && !connectionById(next, this.selected)) {
      this.selected = next.connections.find(c => c.provider === 'flow')?.connectionId ?? null;
    }
    return invalidated;
  }

  /** The runtime for a connection, created on first use. */
  runtime(connectionId: string): ConnectionRuntime | null {
    const existing = this.runtimes.get(connectionId);
    if (existing) return existing;
    const connection = connectionById(this.registry, connectionId);
    const session = sessionFor(this.registry, connectionId);
    if (!connection || !session) return null;
    const runtime = new ConnectionRuntime(connection, {
      storageKey: session.storageKey,
      userId: session.userId,
      authGeneration: session.authGeneration,
    });
    this.runtimes.set(connectionId, runtime);
    return runtime;
  }

  /** The runtime the UI is currently pointed at. */
  active(): ConnectionRuntime {
    const id = this.selected;
    const runtime = id ? this.runtime(id) : null;
    if (runtime) return runtime;
    // Only reachable if the registry was emptied under us; rebuilding the
    // default connection is better than throwing on every render.
    const { registry, connection } = addFlowConnection(this.registry, { origin: defaultServerOrigin() });
    this.commit({ ...registry, activeConnectionId: connection.connectionId });
    this.selected = connection.connectionId;
    return this.runtime(connection.connectionId)!;
  }

  setActive(connectionId: string): void {
    if (!connectionById(this.registry, connectionId)) return;
    this.selected = connectionId;
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('flow.selectedConnection', connectionId);
  }

  add(origin: string, label?: string): ConnectionRuntime {
    const { registry, connection } = addFlowConnection(this.registry, { origin, label });
    this.commit(registry);
    return this.runtime(connection.connectionId)!;
  }

  /** Persist a replaced bearer's generation alongside the runtime's. */
  noteTokenReplaced(connectionId: string, generation: number): void {
    this.commit(updateSession(this.registry, connectionId, { authGeneration: generation }));
  }

  /** Commit a *validated* identity. Rotates the namespace when the identity
   * changed, dropping the previous one's stored state rather than handing it to
   * the new user. */
  bindIdentity(connectionId: string, userId: string): void {
    const { registry, rotatedFrom } = bindIdentity(this.registry, connectionId, userId);
    this.commit(registry);
    const session = sessionFor(registry, connectionId);
    const runtime = this.runtimes.get(connectionId);
    if (session && runtime) {
      runtime.setIdentity(userId);
      runtime.adoptStorageKey(session.storageKey);
    }
    if (rotatedFrom) clearNamespace(rotatedFrom);
  }

  /** Remember where a connection+identity is parked. One entry per session, so
   * two connections never overwrite each other's landing spot. */
  rememberNavigation(target: NavigationTarget): void {
    this.commit(setNavigationTarget(this.registry, target));
  }

  navigationTarget(connectionId: string, userId: string): NavigationTarget | undefined {
    return navigationTargetFor(this.registry, connectionId, userId);
  }

  setBinding(binding: WorkspaceBinding): void {
    this.commit(setWorkspaceBinding(this.registry, binding));
  }

  replaceBindings(bindings: WorkspaceBinding[]): void {
    this.commit({ ...this.registry, bindings });
  }

  forgetWorkspace(connectionId: string, workspaceId: string): void {
    this.commit({ ...this.registry, bindings: this.registry.bindings.filter(b => b.connectionId !== connectionId || b.workspaceId !== workspaceId) });
  }

  signOut(connectionId: string, remove = false): void {
    const session = sessionFor(this.registry, connectionId);
    this.runtimes.get(connectionId)?.dispose();
    this.runtimes.delete(connectionId);
    if (session) clearNamespace(session.storageKey);
    if (remove) this.remove(connectionId);
    else this.markSignedOut(connectionId);
  }

  markSignedOut(connectionId: string): void {
    this.commit(updateSession(this.registry, connectionId, { status: 'signed-out' }));
  }

  /** The backend rejected this connection's bearer. Recorded as a durable fact
   * about the connection — the runtime only reports it when the generation
   * still matches, so a 401 from a pre-refresh request never lands here. */
  markUnauthorized(connectionId: string): void {
    this.commit(updateSession(this.registry, connectionId, { status: 'unauthorized' }));
  }

  /** Forget a connection entirely: dispose its runtime, drop its namespace and
   * its registry records. Every other connection is untouched. */
  remove(connectionId: string): void {
    const session = sessionFor(this.registry, connectionId);
    this.runtimes.get(connectionId)?.dispose();
    this.runtimes.delete(connectionId);
    this.commit(removeFromRegistry(this.registry, connectionId));
    if (this.selected === connectionId) {
      this.selected = this.registry.connections.find(c => c.provider === 'flow')?.connectionId ?? null;
      if (typeof sessionStorage !== 'undefined') {
        if (this.selected) sessionStorage.setItem('flow.selectedConnection', this.selected);
        else sessionStorage.removeItem('flow.selectedConnection');
      }
    }
    if (session) clearNamespace(session.storageKey);
  }
}

/** The process-wide manager. Components reach their runtime through
 * `ConnectionContext` (see `state.tsx`); this is the root that seeds it, and
 * the fallback for the module-level helpers in `lib/api.ts`. */
let manager: ConnectionManager | null = null;

export function connectionManager(): ConnectionManager {
  manager ??= new ConnectionManager();
  return manager;
}

export function activeRuntime(): ConnectionRuntime {
  return connectionManager().active();
}

/** Test seam: replace the process-wide manager. */
export function __setConnectionManager(next: ConnectionManager | null): void {
  manager = next;
}
