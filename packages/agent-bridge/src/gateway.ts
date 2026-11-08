// Agent-token WS connection — real presence: the agent shows online while
// the daemon runs. Auto-reconnects with backoff; answers heartbeat pings.
import WebSocket from 'ws';
import type { ClientFrame, Event, PlatformEvent, ServerFrame } from '@flow/shared';

/**
 * A logged event (platform.md §5.2) as the socket event it was: Chat's `chat.<type>` back to `<type>`, with the row's
 * channel, time and data. Events of other apps (`mail.*`) are not socket events: null.
 */
export function socketEventOf(e: PlatformEvent): Event | null {
  if (!e.type.startsWith('chat.')) return null;
  return {
    type: e.type.slice('chat.'.length) as Event['type'],
    workspaceId: e.organizationId,
    ...(e.channelId ? { channelId: e.channelId } : {}),
    ts: e.ts,
    data: e.data,
  };
}

export interface FlowSocketOpts {
  serverUrl: string;
  token: string;
  /** Workspaces this connection serves — presence is announced only there
   * (#364). One bridge process serves one workspace, so without this the agent
   * showed online in every workspace it belongs to, including ones nothing was
   * listening in. */
  workspaces?: string[];
  onEvent(event: Event): void;
  onOpen?(): void;
  log(msg: string): void;
  /** On a server with one socket per organization, the one this socket serves. */
  organization?: string;
  /**
   * The event log's seq to replay from on the first connect (`auth` with `since`, platform.md §5.2); later reconnects
   * send the latest `cursor` frame instead. Unset and no cursor yet: no replay.
   */
  since?: number;
  /** The log reached `seq` and every event so far has been handed to `onEvent`. */
  onCursor?(seq: number): void;
  /** A `socket` subscription of this account has new events (platform.md §5.2): read it over HTTP. */
  onSubscription?(id: string): void;
}

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

// The server pings every 30s. If nothing (pings included) arrives for three
// beats the socket is half-dead — the classic case is a laptop sleep: the
// server terminates the connection while the machine is suspended, the FIN
// never reaches us, and 'close' never fires on its own.
const LIVENESS_TIMEOUT_MS = 90_000;
const LIVENESS_CHECK_MS = 15_000;

export class FlowSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  /** The last log seq this socket has handed on: sent as `since` on every connect, so a drop loses nothing. */
  private cursor: number | null;

  constructor(private readonly opts: FlowSocketOpts) {
    this.cursor = opts.since ?? null;
  }

  connect(): void {
    if (this.closed) return;
    const organization = this.opts.organization ? `?workspace=${encodeURIComponent(this.opts.organization)}` : '';
    const wsUrl = this.opts.serverUrl.replace(/^http/, 'ws') + '/v1/ws' + organization;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    let lastActivity = Date.now();
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > LIVENESS_TIMEOUT_MS) {
        this.opts.log('no server heartbeat for 90s (laptop sleep?) — dropping the dead socket');
        ws.terminate(); // fires 'close' → reconnect
      }
    }, LIVENESS_CHECK_MS);
    ws.on('open', () => {
      lastActivity = Date.now();
      this.send({
        op: 'auth',
        token: this.opts.token,
        ...(this.opts.workspaces ? { workspaces: this.opts.workspaces } : {}),
        ...(this.cursor !== null ? { since: this.cursor } : {}),
      });
    });
    ws.on('message', (raw: WebSocket.RawData) => {
      lastActivity = Date.now();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(raw)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.op === 'ping') return this.send({ op: 'pong' });
      if (frame.op === 'hello') {
        // A server that says so wants the client to ping, so that it can sleep between messages (Durable Objects hibernate).
        if (frame.heartbeat === 'client' && !heartbeat) heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{"op":"ping"}'); }, 30_000);
        this.attempt = 0;
        this.opts.log('connected (presence online)');
        this.opts.onOpen?.();
        return;
      }
      if (frame.op === 'event') {
        // A replayed event at or below the cursor already came through.
        if (frame.seq !== undefined && this.cursor !== null && frame.seq <= this.cursor) return;
        if (frame.seq !== undefined) this.cursor = frame.seq;
        return this.opts.onEvent(frame.event);
      }
      if (frame.op === 'cursor') {
        if (this.cursor === null || frame.seq > this.cursor) this.cursor = frame.seq;
        this.opts.onCursor?.(this.cursor);
        return;
      }
      if (frame.op === 'subscription') return this.opts.onSubscription?.(frame.id);
      if (frame.op === 'gap') return this.opts.log(`events ${frame.from}–${frame.to} aged out of the log before this socket read them`);
      if (frame.op === 'error') this.opts.log(`ws error: ${frame.code} ${frame.message}`);
    });
    ws.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      clearInterval(watchdog);
      this.scheduleReconnect();
    });
    ws.on('error', (err: Error) => this.opts.log(`ws error: ${err.message}`));
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.opts.log(`disconnected — reconnecting in ${delay / 1000}s`);
    // NOT unref'd: after a disconnect this timer may be the only handle left
    // on the event loop — an unref'd timer let the whole daemon exit(0) here.
    setTimeout(() => this.connect(), delay);
  }

  sendTyping(channelId: string, threadRootId?: string): void {
    this.send({ op: 'typing', channelId, ...(threadRootId ? { threadRootId } : {}) });
  }

  private send(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

type Socket = Pick<FlowSocket, 'connect' | 'sendTyping' | 'close'>;

/**
 * The bridge's connection to a server. Where each organization is its own object the server says so, and there is one
 * socket per organization behind the same methods; elsewhere it is the one socket it always was.
 */
export function openFlowSocket(opts: FlowSocketOpts): Socket {
  let sockets: FlowSocket[] = [];
  let closed = false;
  const api = async <T>(path: string): Promise<T> => {
    const res = await fetch(opts.serverUrl + path, { headers: { authorization: `Bearer ${opts.token}` } });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return (await res.json()) as T;
  };
  const start = async (): Promise<void> => {
    const info = await api<{ capabilities?: { socketPerOrganization?: boolean } }>('/v1/client-info').catch(() => null);
    if (closed) return;
    let organizations: (string | undefined)[] = [undefined];
    if (info?.capabilities?.socketPerOrganization) {
      const { workspaces } = await api<{ workspaces: { id: string }[] }>('/v1/me/workspaces');
      organizations = workspaces.map((w) => w.id).filter((id) => !opts.workspaces || opts.workspaces.includes(id));
    }
    if (closed) return;
    // A seq belongs to one organization's log: `since` only means something for a single socket.
    const { since, ...rest } = opts;
    sockets = organizations.map((organization) => new FlowSocket({
      ...rest, ...(organization ? { organization } : {}), ...(since !== undefined && organizations.length === 1 ? { since } : {}),
    }));
    for (const socket of sockets) socket.connect();
  };
  return {
    connect() {
      start().catch((err: Error) => {
        opts.log(`could not list organizations (${err.message}); trying again in 5s`);
        if (!closed) setTimeout(() => this.connect(), 5_000);
      });
    },
    sendTyping(channelId, threadRootId) {
      for (const socket of sockets) socket.sendTyping(channelId, threadRootId);
    },
    close() {
      closed = true;
      for (const socket of sockets) socket.close();
    },
  };
}
