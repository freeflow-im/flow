// Issue #542: every connected server keeps syncing while the tab runs, and one
// server's trouble stays that server's trouble.
//
// The socket is a seam here, not a real WebSocket: what is under test is the
// supervisor's policy — which connections it starts, how many at once, what it
// asks the server for, and what it does with a 401, a 429 or a sign-out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundSync, MAX_CONCURRENT_STARTS } from './backgroundSync';
import { ApiError, ConnectionManager } from './connectionRuntime';
import { jittered } from './ws';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const A = 'https://a.example.com';
const B = 'https://b.example.com';
const C = 'https://c.example.com';
const D = 'https://d.example.com';

/** A socket the test drives by hand. */
class FakeSocket {
  static all: FakeSocket[] = [];
  started = false;
  stopped = false;
  constructor(
    readonly url: string,
    readonly token: string,
    readonly handlers: { onStatus(s: 'connecting' | 'connected' | 'reconnecting'): void; onEvent(e: never): void },
  ) {
    FakeSocket.all.push(this);
  }
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
  connect(): void { this.handlers.onStatus('connected'); }
}

let apiCalls: { origin: string; path: string }[] = [];
let respond: (origin: string) => unknown;

beforeEach(() => {
  store.clear();
  FakeSocket.all = [];
  apiCalls = [];
  respond = () => ({ workspaces: [] });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const { origin, pathname } = new URL(url);
    apiCalls.push({ origin, path: pathname });
    const body = respond(origin);
    if (body instanceof ApiError) {
      return { ok: false, status: body.status, json: async () => ({ error: { code: body.code, message: body.message } }) };
    }
    return { ok: true, status: 200, json: async () => body };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function build(origins: string[]): { manager: ConnectionManager; sync: BackgroundSync; ids: string[] } {
  const manager = new ConnectionManager(origins[0]!);
  const ids: string[] = [];
  const first = manager.active();
  first.setToken('token-0');
  manager.bindIdentity(first.connectionId, 'user-0');
  ids.push(first.connectionId);
  for (const [i, origin] of origins.slice(1).entries()) {
    const runtime = manager.add(origin);
    runtime.setToken(`token-${i + 1}`);
    manager.bindIdentity(runtime.connectionId, `user-${i + 1}`);
    ids.push(runtime.connectionId);
  }
  const sync = new BackgroundSync(manager, {
    createSocket: (runtime, token, handlers) => new FakeSocket(runtime.socketUrl, token, handlers),
  });
  return { manager, sync, ids };
}

const socketFor = (origin: string) =>
  FakeSocket.all.find(s => s.url.startsWith(`wss://${new URL(origin).host}`));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('which connections sync', () => {
  it('opens a socket for every authenticated connection except the one on screen', () => {
    const { sync, ids } = build([A, B, C]);
    sync.setForeground(ids[0]!);
    sync.start();
    expect(socketFor(A)).toBeUndefined(); // the foreground session owns this one
    expect(socketFor(B)?.started).toBe(true);
    expect(socketFor(C)?.started).toBe(true);
  });

  it('hands the connection its own bearer and its own socket URL', () => {
    const { sync, ids } = build([A, B]);
    sync.setForeground(ids[0]!);
    sync.start();
    expect(socketFor(B)!.token).toBe('token-1');
    expect(socketFor(B)!.url).toBe('wss://b.example.com/v1/ws');
  });

  it('swaps sockets when the UI switches server: the one left behind picks one up', () => {
    const { sync, ids } = build([A, B]);
    sync.setForeground(ids[0]!);
    sync.start();
    const backgroundB = socketFor(B)!;
    sync.setForeground(ids[1]!);
    expect(backgroundB.stopped).toBe(true);
    expect(socketFor(A)?.started).toBe(true);
  });

  it('never syncs a connection that is not authenticated', () => {
    const { manager, sync, ids } = build([A, B]);
    manager.markSignedOut(ids[1]!);
    sync.setForeground(ids[0]!);
    sync.start();
    expect(socketFor(B)).toBeUndefined();
  });

  it('drops a connection that signs out, and its unread with it', async () => {
    const { manager, sync, ids } = build([A, B]);
    respond = () => ({ workspaces: [{ id: 'ws', unreadCount: 4 }] });
    sync.setForeground(ids[0]!);
    sync.start();
    socketFor(B)!.connect();
    await flush();
    expect(sync.backgroundUnread()).toBe(4);
    manager.markSignedOut(ids[1]!);
    sync.reconcile();
    expect(sync.state(ids[1]!)).toBeNull();
    expect(sync.backgroundUnread()).toBe(0);
  });

  it('stops everything on stop()', () => {
    const { sync, ids } = build([A, B, C]);
    sync.setForeground(ids[0]!);
    sync.start();
    sync.stop();
    expect(FakeSocket.all.every(s => s.stopped)).toBe(true);
    expect(sync.states()).toEqual([]);
  });
});

describe('bounded concurrency', () => {
  it('starts at most MAX_CONCURRENT_STARTS at once, and releases a slot on connect', () => {
    const { sync, ids } = build([A, B, C, D, 'https://e.example.com']);
    sync.setForeground(ids[0]!);
    sync.start();
    expect(FakeSocket.all).toHaveLength(MAX_CONCURRENT_STARTS);
    FakeSocket.all[0]!.connect();
    expect(FakeSocket.all).toHaveLength(MAX_CONCURRENT_STARTS + 1);
  });

  it('releases the slot of a connection that keeps failing, so the queue moves', () => {
    const { sync, ids } = build([A, B, C, D, 'https://e.example.com']);
    sync.setForeground(ids[0]!);
    sync.start();
    expect(FakeSocket.all).toHaveLength(MAX_CONCURRENT_STARTS);
    FakeSocket.all[0]!.handlers.onStatus('reconnecting');
    expect(FakeSocket.all).toHaveLength(MAX_CONCURRENT_STARTS + 1);
  });
});

describe('what it fetches', () => {
  it('asks only for the workspace list — no transcripts for servers off screen', async () => {
    const { sync, ids } = build([A, B]);
    sync.setForeground(ids[0]!);
    sync.start();
    socketFor(B)!.connect();
    await flush();
    expect(apiCalls).toEqual([{ origin: B, path: '/v1/me/workspaces' }]);
  });

  it('aggregates unread per connection and across them', async () => {
    const { sync, ids } = build([A, B, C]);
    respond = (origin) => origin === B
      ? { workspaces: [{ id: 'w1', unreadCount: 2 }, { id: 'w2', unreadCount: 3 }] }
      : { workspaces: [{ id: 'w1', unreadCount: 1 }] };
    sync.setForeground(ids[0]!);
    sync.start();
    socketFor(B)!.connect();
    socketFor(C)!.connect();
    await flush();
    expect(sync.state(ids[1]!)!.unread).toBe(5);
    expect(sync.state(ids[1]!)!.unreadByWorkspace).toEqual({ w1: 2, w2: 3 });
    expect(sync.backgroundUnread()).toBe(6);
  });

  it('counts a notification.created without asking the server again', async () => {
    const { sync, ids } = build([A, B]);
    respond = () => ({ workspaces: [{ id: 'w1', unreadCount: 1 }] });
    sync.setForeground(ids[0]!);
    sync.start();
    socketFor(B)!.connect();
    await flush();
    expect(apiCalls).toHaveLength(1);
    socketFor(B)!.handlers.onEvent({ type: 'notification.created', workspaceId: 'w1', ts: '', data: {} } as never);
    expect(sync.state(ids[1]!)!.unreadByWorkspace).toEqual({ w1: 2 });
    expect(apiCalls).toHaveLength(1); // rate limiter deferred the confirmation
  });

  it('keeps a switched-away connection badged from its own session numbers', () => {
    const { sync, ids } = build([A, B]);
    sync.setForeground(ids[0]!);
    sync.start();
    sync.reportForeground(ids[0]!, [{ id: 'w1', unreadCount: 7 }]);
    expect(sync.state(ids[0]!)!.unread).toBe(7);
    // Not counted while it *is* the foreground — that session renders its own.
    expect(sync.backgroundUnread()).toBe(0);
    sync.setForeground(ids[1]!);
    expect(sync.backgroundUnread()).toBe(7);
  });
});

describe('failures stay on their own connection', () => {
  it('marks only the 401 connection unauthorized and stops only its socket', async () => {
    const { manager, sync, ids } = build([A, B, C]);
    respond = (origin) => origin === B ? new ApiError(401, 'unauthorized', 'nope') : { workspaces: [{ id: 'w', unreadCount: 2 }] };
    sync.setForeground(ids[0]!);
    sync.start();
    socketFor(B)!.connect();
    socketFor(C)!.connect();
    await flush();
    expect(sync.state(ids[1]!)!.status).toBe('unauthorized');
    expect(socketFor(B)!.stopped).toBe(true);
    expect(manager.state.sessions.find(s => s.connectionId === ids[1]!)!.status).toBe('unauthorized');
    expect(sync.state(ids[2]!)!.status).toBe('connected');
    expect(socketFor(C)!.stopped).toBe(false);
    expect(manager.state.sessions.find(s => s.connectionId === ids[2]!)!.status).toBe('authenticated');
  });

  it('an unreachable server goes offline without touching the others', async () => {
    const { sync, ids } = build([A, B, C]);
    respond = (origin) => origin === B ? new ApiError(503, 'unavailable', 'down') : { workspaces: [] };
    sync.setForeground(ids[0]!);
    sync.start();
    socketFor(B)!.connect();
    socketFor(C)!.connect();
    await flush();
    expect(sync.state(ids[1]!)!.status).toBe('offline');
    expect(sync.state(ids[2]!)!.status).toBe('connected');
  });

  it('backs off after a 429 instead of retrying into the rate limiter', async () => {
    vi.useFakeTimers();
    const { sync, ids } = build([A, B]);
    respond = () => new ApiError(429, 'rate_limited', 'slow down');
    sync.setForeground(ids[0]!);
    sync.start();
    socketFor(B)!.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(apiCalls).toHaveLength(1);
    // Every event in the next half-minute is absorbed by the backoff.
    for (let i = 0; i < 5; i++) {
      socketFor(B)!.handlers.onEvent({ type: 'notification.read', workspaceId: 'w', ts: '', data: {} } as never);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(apiCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apiCalls.length).toBeGreaterThan(1);
  });

  it('rate-limits ordinary event bursts to one refresh', async () => {
    vi.useFakeTimers();
    const { sync, ids } = build([A, B]);
    sync.setForeground(ids[0]!);
    sync.start();
    socketFor(B)!.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(apiCalls).toHaveLength(1);
    for (let i = 0; i < 20; i++) {
      socketFor(B)!.handlers.onEvent({ type: 'notification.read', workspaceId: 'w', ts: '', data: {} } as never);
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(apiCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(apiCalls).toHaveLength(2);
  });
});

describe('reconnect jitter', () => {
  it('spreads a reconnect over 0.75x–1.25x of the backoff, like the native clients', () => {
    expect(jittered(1000, () => 0)).toBe(750);
    expect(jittered(1000, () => 0.5)).toBe(1000);
    expect(jittered(1000, () => 0.999)).toBe(1250);
  });
});
