// Agent-token WS connection — real presence: the agent shows online while
// the daemon runs. Auto-reconnects with backoff; answers heartbeat pings.
import WebSocket from 'ws';
import type { ClientFrame, Event, ServerFrame } from '@flow/shared';

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

  constructor(private readonly opts: FlowSocketOpts) {}

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
      if (frame.op === 'event') return this.opts.onEvent(frame.event);
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
    sockets = organizations.map((organization) => new FlowSocket({ ...opts, ...(organization ? { organization } : {}) }));
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
