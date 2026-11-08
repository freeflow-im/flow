import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSocketDead, SocketClient, SocketCursors, SOCKET_DEADLINE_MS, SOCKET_WAKE_DEADLINE_MS } from './ws';

// The dead-socket watchdog (#271). A machine that sleeps leaves the WebSocket
// half-open: no close event, no error, nothing arriving. Silence is the only
// evidence, so these assert the client acts on it — and that a healthy idle
// connection, which is also silent apart from heartbeats, is left alone.

describe('isSocketDead', () => {
  it('leaves an idle-but-heartbeating socket alone', () => {
    expect(isSocketDead(0, 31_000)).toBe(false);
  });

  it('forgives one missed heartbeat', () => {
    expect(isSocketDead(0, 65_000)).toBe(false);
  });

  it('gives up after two', () => {
    expect(isSocketDead(0, SOCKET_DEADLINE_MS)).toBe(true);
  });

  it('is stricter on wake, where we know unobserved time passed', () => {
    expect(isSocketDead(0, 45_000, SOCKET_WAKE_DEADLINE_MS)).toBe(true);
    expect(isSocketDead(0, 5_000, SOCKET_WAKE_DEADLINE_MS)).toBe(false);
  });
});

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  /** Server → client. A dead socket simply never calls this. */
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe('SocketClient watchdog', () => {
  let visibilityListener: (() => void) | null = null;
  const statuses: string[] = [];

  const live = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    statuses.length = 0;
    visibilityListener = null;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:8787' });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: (_: string, fn: () => void) => {
        visibilityListener = fn;
      },
      removeEventListener: () => {
        visibilityListener = null;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const connected = () => {
    const client = new SocketClient('tok', {
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
    });
    client.start();
    live().onopen?.();
    live().deliver({ op: 'hello', sessionId: 's1' });
    return client;
  };

  it('drops a socket that has gone silent, and reconnects', () => {
    const client = connected();
    const dead = live();
    expect(statuses).toEqual(['connecting', 'connected']);

    vi.advanceTimersByTime(SOCKET_DEADLINE_MS + 1_000);

    expect(dead.closed).toBe(true);
    expect(statuses).toContain('reconnecting');
    // Backoff, then a genuinely new socket — that reconnect is what makes the
    // client refetch, which is the whole point of noticing.
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances.length).toBe(2);
    client.stop();
  });

  it('leaves a heartbeating connection alone indefinitely', () => {
    const client = connected();
    const ws = live();
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(30_000);
      ws.deliver({ op: 'ping' });
    }
    expect(ws.closed).toBe(false);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(ws.sent.filter((s) => s.includes('pong')).length).toBe(20);
    client.stop();
  });

  it('checks immediately when the tab becomes visible again', () => {
    const client = connected();
    const dead = live();
    // Asleep for 45s: past one heartbeat, but well inside the watchdog's own
    // deadline — without the visibility check the user waits it out.
    vi.setSystemTime(Date.now() + 45_000);
    visibilityListener?.();
    expect(dead.closed).toBe(true);
    expect(statuses).toContain('reconnecting');
    client.stop();
  });

  it('does not reconnect a socket that was only briefly hidden', () => {
    const client = connected();
    vi.setSystemTime(Date.now() + 5_000);
    visibilityListener?.();
    expect(live().closed).toBe(false);
    expect(statuses).toEqual(['connecting', 'connected']);
    client.stop();
  });

  it('stops watching once stopped', () => {
    const client = connected();
    client.stop();
    vi.advanceTimersByTime(SOCKET_DEADLINE_MS * 3);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  // The socket is a consumer of the event log (platform.md §5.2): it keeps the
  // last cursor, sends it as `since` on a reconnect (not the first connect), and
  // a replay of what already arrived live is harmless.
  it('keeps the cursor, sends it on a reconnect, and skips a replay at or below it', () => {
    const stored = new Map<string, string>();
    const cursors = new SocketCursors(() => ({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v) }));
    const applied: string[] = [];
    const url = 'ws://localhost:8787/v1/ws?workspace=w1';
    const client = new SocketClient('tok', { onEvent: (e) => applied.push(e.type), onStatus: () => {} }, url, () => 0.5, cursors);
    client.start();
    live().onopen?.();
    expect(JSON.parse(live().sent[0]!)).toEqual({ op: 'auth', token: 'tok' });
    live().deliver({ op: 'hello', sessionId: 's1' });
    live().deliver({ op: 'event', event: { type: 'message.created' } });
    live().deliver({ op: 'cursor', seq: 5 });
    expect(cursors.get(url)).toBe(5);
    expect(stored.get(`flow.cursor:${url}`)).toBe('5');
    live().onclose?.();
    vi.advanceTimersByTime(1_000);
    live().onopen?.();
    expect(JSON.parse(live().sent[0]!)).toEqual({ op: 'auth', token: 'tok', since: 5 });
    live().deliver({ op: 'hello', sessionId: 's2' });
    for (const seq of [4, 5, 6]) live().deliver({ op: 'event', event: { type: `seq.${seq}` }, seq });
    live().deliver({ op: 'cursor', seq: 6 });
    expect(applied).toEqual(['message.created', 'seq.6']);
    // A new object for the same socket reads it back from storage.
    expect(new SocketCursors(() => ({ getItem: (k) => stored.get(k) ?? null, setItem: () => {} })).get(url)).toBe(6);
    // Storage that throws is only skipped.
    const broken = new SocketCursors(() => { throw new Error('denied'); });
    broken.set(url, 3);
    expect(broken.get(url)).toBe(3);
    client.stop();
  });
});
