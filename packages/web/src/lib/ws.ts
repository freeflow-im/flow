// Thin WS client mirroring the macOS SocketClient (phase1.md §4): auth frame,
// ping→pong, reconnect with backoff. Online-only client: every reconnect is
// followed by query invalidation (the REST refetch IS the backfill). Where the
// server keeps an event log (platform.md §5.2) the socket is also a consumer:
// it remembers the log's `cursor`, and a reconnect's `auth` carries it as
// `since`, so the server replays what happened while the socket was down.
import type { Event, ServerFrame } from '@flow/shared';

export type SocketStatus = 'connecting' | 'connected' | 'reconnecting';

export interface SocketHandlers {
  onEvent(event: Event): void;
  onStatus(status: SocketStatus): void;
  /** The session id from `hello`. Identifies this *device* to the server, which
   * is how a DM ring answered here is told apart from the same ring answered on
   * your phone (#436). Fires again on every reconnect — the id is new each time. */
  onSession?(sessionId: string): void;
}

// How long silence from the server means the socket is dead (#271). The
// server heartbeats every 30s, but a connection that dies half-open — laptop
// asleep, Wi-Fi gone — reports nothing at all: no close event, no error, just
// nothing arriving. Silence is the only signal there is. Deadlines mirror the
// native clients (apps/macos/Sources/Flow/Networking/SocketClient.swift).
export const SOCKET_DEADLINE_MS = 70_000; // two missed heartbeats, plus slack
export const CLIENT_HEARTBEAT_MS = 30_000;
export const SOCKET_WAKE_DEADLINE_MS = 30_000; // a tab just restored: one is enough
const CHECK_INTERVAL_MS = 10_000;

export function isSocketDead(lastInboundAt: number, now: number, deadline = SOCKET_DEADLINE_MS): boolean {
  return now - lastInboundAt >= deadline;
}

/** Spread a reconnect over a window instead of firing it on the tick.
 *
 * Bare exponential backoff synchronises: a server restart drops every client
 * at once and they all come back at the same millisecond, which is the second
 * outage. It matters more now that one client holds a socket per connected
 * server (docs/specs/multi-server-workspaces.md, "Runtime architecture") — a
 * laptop waking up would otherwise reconnect all of them simultaneously.
 *
 * 0.75x–1.25x of the backoff, matching the native clients exactly
 * (apps/macos/Sources/Flow/Networking/SocketClient.swift). */
export function jittered(backoff: number, random: () => number = Math.random): number {
  return Math.round(backoff * (0.75 + random() * 0.5));
}

/**
 * The last log seq each socket applied, by socket URL (one connection's one
 * organization). In memory, and in sessionStorage so it outlives the object;
 * storage that throws (private mode, blocked site data) is only skipped.
 */
export class SocketCursors {
  private readonly seqs = new Map<string, number>();

  constructor(private readonly storage: () => Pick<Storage, 'getItem' | 'setItem'> | null = () => sessionStorage) {}

  get(key: string): number | null {
    const known = this.seqs.get(key);
    if (known !== undefined) return known;
    try {
      const raw = this.storage()?.getItem(`flow.cursor:${key}`);
      const n = raw == null ? NaN : Number(raw);
      if (Number.isFinite(n) && n >= 0) {
        this.seqs.set(key, n);
        return n;
      }
    } catch {
      /* no storage */
    }
    return null;
  }

  /** Moves the cursor forward (never back). */
  set(key: string, seq: number): void {
    if (!Number.isFinite(seq) || seq < 0 || seq <= (this.get(key) ?? -1)) return;
    this.seqs.set(key, seq);
    try {
      this.storage()?.setItem(`flow.cursor:${key}`, String(seq));
    } catch {
      /* no storage */
    }
  }

  /** A replayed event (it carries a `seq`) applies only past the cursor; one at
   * or below it already arrived live before the drop. */
  accept(key: string, seq: number | undefined): boolean {
    if (seq === undefined) return true;
    if (seq <= (this.get(key) ?? -1)) return false;
    this.set(key, seq);
    return true;
  }
}

/** Every socket's cursors, shared so a recreated client keeps them. */
export const socketCursors = new SocketCursors(() => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
});

export class SocketClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 500;
  private lastInboundAt = 0;
  /** Whether this client has been connected: only a reconnect asks for a backlog. */
  private connectedBefore = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') this.dropIfSilent(SOCKET_WAKE_DEADLINE_MS);
  };

  /** `url` is the owning backend's `/v1/ws`, not one derived from the page's
   * origin — in a multi-server client those are different servers. Defaults to
   * the page origin so a caller with no connection context behaves as before. */
  constructor(
    private readonly token: string,
    private readonly handlers: SocketHandlers,
    private readonly url: string = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/ws`,
    /** Test seam for the reconnect jitter. */
    private readonly random: () => number = Math.random,
    private readonly cursors: SocketCursors = socketCursors,
  ) {}

  start(): void {
    this.stopped = false;
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisible);
    this.stopWatchdog();
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  sendTyping(channelId: string, threadRootId?: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 'typing', channelId, ...(threadRootId ? { threadRootId } : {}) }));
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.handlers.onStatus(this.backoff === 500 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    // Arm the watchdog from the attempt, not from `hello`: a socket that opens
    // and then says nothing is just as dead.
    this.lastInboundAt = Date.now();
    this.startWatchdog();

    ws.onopen = () => {
      // The first connect loads everything over REST; a reconnect also asks the
      // server for what it missed since the last cursor it applied.
      const since = this.connectedBefore ? this.cursors.get(this.url) : null;
      ws.send(JSON.stringify({ op: 'auth', token: this.token, ...(since !== null ? { since } : {}) }));
    };
    ws.onmessage = (msg) => {
      // Any frame is proof of life — pings included, and they are what keeps an
      // idle connection out of the watchdog's jaws.
      this.lastInboundAt = Date.now();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(msg.data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.op === 'ping') {
        ws.send(JSON.stringify({ op: 'pong' }));
      } else if (frame.op === 'hello') {
        this.startHeartbeat(ws, frame.heartbeat);
        this.backoff = 500;
        this.connectedBefore = true;
        this.handlers.onSession?.(frame.sessionId);
        this.handlers.onStatus('connected');
      } else if (frame.op === 'event') {
        if (this.cursors.accept(this.url, frame.seq)) this.handlers.onEvent(frame.event);
      } else if (frame.op === 'cursor') {
        this.cursors.set(this.url, frame.seq);
      }
    };
    ws.onclose = () => {
      this.stopHeartbeat();
      this.stopWatchdog();
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.handlers.onStatus('reconnecting');
    const delay = jittered(this.backoff, this.random);
    this.backoff = Math.min(this.backoff * 2, 15_000);
    setTimeout(() => this.connect(), delay);
  }

  // Nothing from the server for `deadline` ms: give up on this socket and
  // reconnect. We take the reconnect path ourselves rather than waiting for
  // `onclose`, because closing a half-open socket waits on a close handshake
  // the dead peer will never answer.
  /** A server that says so wants the client to ping, so that it can sleep between messages (Durable Objects hibernate). */
  private startHeartbeat(ws: WebSocket, mode?: string): void {
    this.stopHeartbeat();
    if (mode !== 'client') return;
    this.heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('{"op":"ping"}');
    }, CLIENT_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private dropIfSilent(deadline: number): void {
    const ws = this.ws;
    if (!ws || !isSocketDead(this.lastInboundAt, Date.now(), deadline)) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    ws.close();
    this.ws = null;
    this.stopWatchdog();
    this.scheduleReconnect();
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => this.dropIfSilent(SOCKET_DEADLINE_MS), CHECK_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
  }
}
