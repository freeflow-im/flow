// The acceptance criteria of issue #540 that can be checked without a browser:
// requests resolve against the owning backend, the bearer never leaves it, a
// stale 401 cannot kill a refreshed session, two connections cannot see each
// other's storage, and disposing one takes nothing else with it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager, ConnectionRuntime, ForeignOriginError } from './connectionRuntime';
import { LEGACY_TOKEN_KEY, sessionFor } from './connections';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const A = 'https://a.example.com';
const B = 'https://b.example.com';

const okJson = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body });
const status = (code: number) => ({
  ok: false,
  status: code,
  json: async () => ({ error: { code: 'unauthorized', message: 'nope' } }),
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store.clear();
  fetchMock = vi.fn(async () => okJson());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Two connections with their own runtimes, as phase 3's switcher will have. */
function twoConnections(): { manager: ConnectionManager; a: ConnectionRuntime; b: ConnectionRuntime } {
  const manager = new ConnectionManager(A);
  const a = manager.active();
  const b = manager.add(B);
  return { manager, a, b };
}

describe('request targeting', () => {
  it('resolves relative API paths against the owning backend, not the page', () => {
    const { a, b } = twoConnections();
    expect(a.url('/v1/me')).toBe(`${A}/v1/me`);
    expect(b.url('/v1/me')).toBe(`${B}/v1/me`);
    expect(b.socketUrl).toBe('wss://b.example.com/v1/ws');
  });

  it('refuses an absolute URL handed to an API helper', () => {
    const { a } = twoConnections();
    expect(() => a.url('https://evil.example.com/v1/me')).toThrow(ForeignOriginError);
    expect(() => a.url('//evil.example.com/v1/me')).toThrow(ForeignOriginError);
    // Even its own origin spelled absolutely: helpers take API paths only.
    expect(() => a.url(`${A}/v1/me`)).toThrow(ForeignOriginError);
  });

  it('sends the bearer to its own origin with no ambient credentials', async () => {
    const { a } = twoConnections();
    a.setToken('token-a');
    await a.api('GET', '/v1/me');
    expect(fetchMock).toHaveBeenCalledWith(`${A}/v1/me`, expect.objectContaining({
      credentials: 'omit',
      headers: expect.objectContaining({ authorization: 'Bearer token-a' }),
    }));
  });

  it('never treats another origin as its own', () => {
    const { a } = twoConnections();
    expect(a.ownsUrl('/v1/files/x')).toBe(true);
    expect(a.ownsUrl(`${A}/v1/files/x`)).toBe(true);
    expect(a.ownsUrl(`${B}/v1/files/x`)).toBe(false);
    expect(a.ownsUrl('https://a.example.com:8443/v1/files/x')).toBe(false);
    expect(a.ownsUrl('https://bucket.r2.cloudflarestorage.com/o?X-Amz-Signature=x')).toBe(false);
  });

  it('keeps the bearer off a presigned upload target but sends it to the local fallback', async () => {
    const { a } = twoConnections();
    a.setToken('token-a');
    const presign = {
      file: { id: 'f1' },
      upload: { url: 'https://bucket.r2.example/put?sig=1', method: 'PUT', headers: { 'content-type': 'text/plain' } },
    };
    fetchMock
      .mockResolvedValueOnce(okJson(presign))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockResolvedValueOnce(okJson({ id: 'f1' }));
    await a.uploadFile('ws-1', new File(['x'], 'x.txt', { type: 'text/plain' }));
    const put = fetchMock.mock.calls[1]!;
    expect(put[0]).toBe('https://bucket.r2.example/put?sig=1');
    expect((put[1] as RequestInit).headers).not.toHaveProperty('authorization');

    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(okJson({ file: { id: 'f2' }, upload: { url: '/v1/uploads/f2', method: 'PUT', headers: {} } }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockResolvedValueOnce(okJson({ id: 'f2' }));
    await a.uploadFile('ws-1', new File(['x'], 'x.txt', { type: 'text/plain' }));
    const localPut = fetchMock.mock.calls[1]!;
    expect(localPut[0]).toBe(`${A}/v1/uploads/f2`);
    expect((localPut[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer token-a' });
  });
});

describe('identical reads under way', () => {
  /** A fetch that answers when told to, so reads can overlap. */
  function held() {
    const release: Array<() => void> = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => release.push(() => resolve(okJson({ n: release.length })))));
    return { releaseAll: () => release.splice(0).forEach((r) => r()) };
  }

  it('sends one request for two GETs of the same path and gives both its answer', async () => {
    const { a } = twoConnections();
    const gate = held();
    const first = a.api('GET', '/v1/me/workspaces');
    const second = a.api('GET', '/v1/me/workspaces');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    gate.releaseAll();
    expect(await first).toBe(await second);
  });

  it('asks again once the first has answered', async () => {
    const { a } = twoConnections();
    await a.api('GET', '/v1/me/workspaces');
    await a.api('GET', '/v1/me/workspaces');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not share a read that began before a write', async () => {
    const { a } = twoConnections();
    const gate = held();
    const before = a.api('GET', '/v1/me/workspaces');
    const write = a.api('POST', '/v1/workspaces', { name: 'New' });
    const after = a.api('GET', '/v1/me/workspaces');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    gate.releaseAll();
    await Promise.all([before, write, after]);
  });

  it('keeps another path, another connection and a new sign-in apart', async () => {
    const { a, b } = twoConnections();
    const gate = held();
    const all = [a.api('GET', '/v1/me/workspaces'), a.api('GET', '/v1/me'), b.api('GET', '/v1/me/workspaces')];
    expect(fetchMock).toHaveBeenCalledTimes(3);
    a.setToken('another');
    all.push(a.api('GET', '/v1/me/workspaces').catch(() => null));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    gate.releaseAll();
    await Promise.allSettled(all);
  });
});

describe('auth generation', () => {
  it('ignores a 401 from a request issued before the token was replaced', async () => {
    const { a } = twoConnections();
    a.setToken('old');
    const seen: string[] = [];
    a.setUnauthorizedHandler(() => seen.push('signed-out'));

    // The old request is still in flight when the new token lands.
    let release: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const stale = a.api('GET', '/v1/me').catch(() => 'failed');
    a.setToken('fresh');
    release(status(401));
    await stale;

    expect(seen).toEqual([]);
  });

  it('believes a 401 on the current generation', async () => {
    const { a } = twoConnections();
    a.setToken('fresh');
    const seen: string[] = [];
    a.setUnauthorizedHandler(() => seen.push('signed-out'));
    fetchMock.mockResolvedValueOnce(status(401));
    await a.api('GET', '/v1/me').catch(() => {});
    expect(seen).toEqual(['signed-out']);
  });

  it('records the rejection against that connection alone', async () => {
    const { manager, a, b } = twoConnections();
    a.setToken('a');
    a.setUnauthorizedHandler(() => manager.markUnauthorized(a.connectionId));
    fetchMock.mockResolvedValueOnce(status(401));
    await a.api('GET', '/v1/me').catch(() => {});
    expect(sessionFor(manager.state, a.connectionId)!.status).toBe('unauthorized');
    expect(sessionFor(manager.state, b.connectionId)!.status).toBe('signed-out');
  });
});

describe('storage isolation', () => {
  it('gives the migrated connection the keys an existing browser already has', () => {
    store.set(LEGACY_TOKEN_KEY, 'legacy-bearer');
    store.set('flow.activeWorkspace', 'ws-1');
    const runtime = new ConnectionManager(A).active();
    expect(runtime.getToken()).toBe('legacy-bearer');
    expect(runtime.read('activeWorkspace')).toBe('ws-1');
    expect(runtime.key('activeWorkspace')).toBe('flow.activeWorkspace');
  });

  it('keeps a second connection out of the first one\'s namespace', () => {
    const { a, b } = twoConnections();
    a.setToken('token-a');
    b.setToken('token-b');
    a.write('activeWorkspace', 'ws-shared-id');
    b.write('activeWorkspace', 'ws-other');
    expect(a.read('activeWorkspace')).toBe('ws-shared-id');
    expect(b.read('activeWorkspace')).toBe('ws-other');
    expect(a.getToken()).toBe('token-a');
    expect(b.getToken()).toBe('token-b');
    expect(a.key('activeWorkspace')).not.toBe(b.key('activeWorkspace'));
  });

  it('discards the previous identity\'s stored state when a different user signs in', () => {
    const manager = new ConnectionManager(A);
    const runtime = manager.active();
    runtime.setToken('token-1');
    manager.bindIdentity(runtime.connectionId, 'user-1');
    runtime.write('activeWorkspace', 'ws-1');
    const firstKey = runtime.key('activeWorkspace');

    manager.bindIdentity(runtime.connectionId, 'user-2');
    expect(runtime.key('activeWorkspace')).not.toBe(firstKey);
    expect(runtime.read('activeWorkspace')).toBeNull();
    expect(store.get(firstKey)).toBeUndefined();
    // The first identity's credential went with its namespace.
    expect(runtime.getToken()).toBeNull();
  });

  it('remembers a navigation target per connection+identity', () => {
    const { manager, a, b } = twoConnections();
    manager.rememberNavigation({ connectionId: a.connectionId, userId: 'u', workspaceId: 'ws', channelId: 'c-a' });
    manager.rememberNavigation({ connectionId: b.connectionId, userId: 'u', workspaceId: 'ws', channelId: 'c-b' });
    expect(manager.navigationTarget(a.connectionId, 'u')!.channelId).toBe('c-a');
    expect(manager.navigationTarget(b.connectionId, 'u')!.channelId).toBe('c-b');
  });
});

describe('disposal', () => {
  it('late view cleanup cannot restore credentials or drafts after sign-out', () => {
    const { manager, a, b } = twoConnections();
    a.setToken('token-a');
    b.setToken('token-b');
    const tokenKey = a.key('token');
    const draftKey = a.key('draft:workspace:channel');
    manager.signOut(a.connectionId);
    a.write('draft:workspace:channel', 'late draft');
    a.setToken('late-token');
    expect(store.get(draftKey)).toBeUndefined();
    expect(store.get(tokenKey)).toBeUndefined();
    expect(b.getToken()).toBe('token-b');
  });

  it('revokes only its own object URLs and stops believing late responses', async () => {
    const revoked: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u));

    const { manager, a, b } = twoConnections();
    fetchMock.mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['x']) });
    const aUrl = await a.blobUrl('/v1/files/f/thumb');
    const bUrl = await b.blobUrl('/v1/files/f/thumb');
    // Same path, two backends, two entries — no cross-contamination.
    expect(aUrl).not.toBe(bUrl);

    manager.remove(a.connectionId);
    expect(revoked).toEqual([aUrl]);
    expect(a.isDisposed).toBe(true);
    expect(b.isDisposed).toBe(false);
    expect(b.cachedBlobUrl('/v1/files/f/thumb')).toBe(bUrl);
  });

  it('fetches a file\'s bytes from the storage URL the backend presigns, without the bearer', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`);
    const { a } = twoConnections();
    a.setToken('token-a');
    const calls: { url: string; auth: string | undefined }[] = [];
    fetchMock.mockImplementation(async (url: string, init: { headers?: Record<string, string> }) => {
      calls.push({ url, auth: init.headers?.authorization });
      if (url.endsWith('/url')) return okJson({ url: url.includes('/direct/') ? 'https://storage.example/o/direct?sig=1' : null, expiresInSeconds: 60 });
      return { ok: true, status: 200, blob: async () => new Blob(['x']) };
    });
    // Presigning backend: the storage URL is fetched bare.
    await a.blobUrl('/v1/files/direct');
    expect(calls.map(c => c.url)).toContain(`${A}/v1/files/direct/url`);
    const storage = calls.find(c => c.url.startsWith('https://storage.example/'));
    expect(storage?.auth).toBeUndefined();
    // Streaming backend (no URL): the authenticated path, as before.
    calls.length = 0;
    await a.blobUrl('/v1/files/local');
    expect(calls.map(c => c.url)).toEqual([`${A}/v1/files/local/url`, `${A}/v1/files/local`]);
    expect(calls[1]?.auth).toBe('Bearer token-a');
    // A thumbnail path is not a file id and never asks for a URL.
    calls.length = 0;
    await a.blobUrl('/v1/files/local/thumb');
    expect(calls.map(c => c.url)).toEqual([`${A}/v1/files/local/thumb`]);
  });

  it('revokes an object URL that lands after disposal instead of caching it', async () => {
    const revoked: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u));

    const { manager, a } = twoConnections();
    let release: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const pending = a.blobUrl('/v1/files/late/thumb').catch((e: Error) => e.message);
    manager.remove(a.connectionId);
    release({ ok: true, status: 200, blob: async () => new Blob(['x']) });

    await expect(pending).resolves.toBe('connection closed');
    expect(revoked).toContain('blob:late');
    expect(a.cachedBlobUrl('/v1/files/late/thumb')).toBeUndefined();
  });

  it('removing a connection forgets its stored state and leaves the other intact', () => {
    const { manager, a, b } = twoConnections();
    a.setToken('token-a');
    b.setToken('token-b');
    a.write('activeWorkspace', 'ws-a');
    b.write('activeWorkspace', 'ws-b');
    const goneKey = a.key('activeWorkspace');

    manager.remove(a.connectionId);
    expect(store.get(goneKey)).toBeUndefined();
    expect(b.read('activeWorkspace')).toBe('ws-b');
    expect(b.getToken()).toBe('token-b');
    expect(manager.connections.map((c) => c.origin)).toEqual([B]);
    expect(manager.activeConnectionId).toBe(b.connectionId);
  });
});

describe('cross-tab session cleanup', () => {
  it('disposes only the signed-out server and keeps this tab’s selection', () => {
    const { manager, a, b } = twoConnections();
    manager.noteTokenReplaced(a.connectionId, a.setToken('token-a'));
    manager.noteTokenReplaced(b.connectionId, b.setToken('token-b'));
    manager.setActive(b.connectionId);
    const otherTab = new ConnectionManager(A);
    otherTab.signOut(a.connectionId);
    expect(manager.reloadFromStorage()).toEqual([a.connectionId]);
    expect(a.isDisposed).toBe(true);
    expect(b.isDisposed).toBe(false);
    expect(b.getToken()).toBe('token-b');
    expect(manager.activeConnectionId).toBe(b.connectionId);
  });

  it('invalidates authenticated content when another tab changes identity', () => {
    const { manager, a, b } = twoConnections();
    manager.bindIdentity(a.connectionId, 'first-user');
    manager.noteTokenReplaced(a.connectionId, a.setToken('first-token'));
    const otherTab = new ConnectionManager(A);
    otherTab.bindIdentity(a.connectionId, 'second-user');
    const replacement = otherTab.runtime(a.connectionId)!;
    otherTab.noteTokenReplaced(a.connectionId, replacement.setToken('second-token'));
    expect(manager.reloadFromStorage()).toEqual([a.connectionId]);
    expect(manager.runtime(a.connectionId)?.userId).toBe('second-user');
    expect(a.isDisposed).toBe(true);
    expect(b.isDisposed).toBe(false);
  });
});
