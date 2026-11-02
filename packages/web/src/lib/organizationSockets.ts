// One socket per organization, for a server where each organization is its own object (docs/specs/cloudflare-spikes.md). To
// the rest of the app this is one socket: the same methods and callbacks as SocketClient, with every organization's events.
import type { Event } from '@flow/shared';
import { SocketClient, type SocketHandlers, type SocketStatus } from './ws';

type Socket = Pick<SocketClient, 'start' | 'stop' | 'sendTyping'>;

export class OrganizationSockets {
  private readonly sockets = new Map<string, Socket>();
  private readonly statuses = new Map<string, SocketStatus>();
  private stopped = false;
  private announced: SocketStatus | null = null;

  constructor(
    private readonly handlers: SocketHandlers,
    private readonly listOrganizations: () => Promise<string[]>,
    private readonly create: (workspaceId: string, handlers: SocketHandlers) => Socket,
  ) {}

  start(): void {
    this.stopped = false;
    void this.sync();
  }

  stop(): void {
    this.stopped = true;
    for (const socket of this.sockets.values()) socket.stop();
    this.sockets.clear();
    this.statuses.clear();
  }

  sendTyping(channelId: string, threadRootId?: string): void {
    for (const socket of this.sockets.values()) socket.sendTyping(channelId, threadRootId);
  }

  /** Opens a socket for each organization that has none: at the start, and when an event says the person joined another. */
  private async sync(): Promise<void> {
    let ids: string[];
    try {
      ids = await this.listOrganizations();
    } catch {
      if (!this.stopped) setTimeout(() => void this.sync(), 5_000);
      return;
    }
    if (this.stopped) return;
    if (!ids.length) this.announce('connected');
    for (const id of ids) {
      if (this.sockets.has(id)) continue;
      const socket = this.create(id, {
        ...this.handlers,
        onStatus: (status) => {
          this.statuses.set(id, status);
          const all = [...this.statuses.values()];
          this.announce(all.length === this.sockets.size && all.every((s) => s === 'connected') ? 'connected' : all.includes('reconnecting') ? 'reconnecting' : 'connecting');
        },
        onEvent: (event: Event) => {
          this.handlers.onEvent(event);
          if (event.type === 'workspace.joined') void this.sync();
        },
      });
      this.sockets.set(id, socket);
      socket.start();
    }
  }

  /** Only a change is announced: the app refetches everything each time it hears `connected`. */
  private announce(status: SocketStatus): void {
    if (status === this.announced) return;
    this.announced = status;
    this.handlers.onStatus(status);
  }
}
