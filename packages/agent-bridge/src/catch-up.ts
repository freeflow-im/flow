// Catching up after being offline (platform.md §5.2, phase 2.3). The bridge keeps one subscription per organization it
// serves, `bridge:<agent user id>`, on the events that can ask it for a turn. At start it reads what the subscription
// holds before opening the socket, feeding each event through the path live events take, and acks as it goes; while
// connected it acks the socket's latest cursor, so the next start replays only what was missed. The subscription is the
// catch-up path, not a filter: what gets answered is still `addressedToMe`'s call. A small set of answered message ids,
// kept in a state file beside the config, makes sure no message is answered twice across a restart.
import fs from 'node:fs';
import path from 'node:path';
import type { Event, SubscriptionDTO } from '@flow/shared';
import type { FlowApi } from './api.js';
import { socketEventOf } from './gateway.js';

export const CATCH_UP_TYPES = ['chat.message.created', 'chat.thread.reply', 'chat.reaction.added'];
/** How many answered message ids are remembered. */
export const HANDLED_MAX = 500;
/** A bound on one catch-up's pages, so a server that never runs dry cannot hold the start-up forever. */
const MAX_PAGES = 100;

export type SubscriptionApi = Pick<FlowApi, 'listSubscriptions' | 'createSubscription' | 'readSubscription' | 'ackSubscription'>;

export const subscriptionName = (agentId: string): string => `bridge:${agentId}`;

/** The bridge's subscription in the organization: found by name, or made (starting at the log's head). */
export async function ensureSubscription(api: SubscriptionApi, workspaceId: string, agentId: string): Promise<SubscriptionDTO> {
  const name = subscriptionName(agentId);
  const found = (await api.listSubscriptions(workspaceId)).find((s) => s.name === name);
  if (found) return found;
  return api.createSubscription(workspaceId, { name, filter: { types: CATCH_UP_TYPES }, delivery: 'pull' });
}

/**
 * Reads the subscription without waiting, page by page until it is empty, handing each Chat event to `feed` in order
 * and acking each page's `next` once its events are fed. Returns the events fed and the cursor reached.
 */
export async function catchUp(
  api: SubscriptionApi,
  workspaceId: string,
  sub: Pick<SubscriptionDTO, 'id' | 'cursor'>,
  feed: (event: Event) => Promise<void> | void,
  log: (msg: string) => void,
): Promise<{ events: number; next: number }> {
  let cursor = sub.cursor;
  let events = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const out = await api.readSubscription(workspaceId, sub.id, { wait: 0 });
    if (out.gap) log(`catch-up: events ${out.gap.from}–${out.gap.to} aged out of the log before they were read`);
    for (const e of out.events) {
      const event = socketEventOf(e);
      if (!event) continue;
      events++;
      try {
        await feed(event);
      } catch (err) {
        log(`catch-up: event ${e.seq} (${e.type}) failed: ${(err as Error).message}`);
      }
    }
    if (out.next > cursor) cursor = await api.ackSubscription(workspaceId, sub.id, out.next);
    if (!out.events.length) break;
  }
  return { events, next: cursor };
}

/** The ids of the last messages the bridge answered, oldest first, kept in `file` (when given) across restarts. */
export class HandledMessages {
  private readonly ids: string[] = [];
  private readonly set = new Set<string>();

  constructor(private readonly file: string | null, private readonly log: (msg: string) => void = () => {}, private readonly max = HANDLED_MAX) {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { handledMessageIds?: unknown };
      const ids = Array.isArray(raw.handledMessageIds) ? raw.handledMessageIds.filter((x): x is string => typeof x === 'string') : [];
      for (const id of ids.slice(-max)) this.remember(id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`state file ${file} unreadable (${(err as Error).message}) — starting empty`);
    }
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  /** Remembers `id` and writes the file. False when it was already there. */
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.remember(id);
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ handledMessageIds: this.ids }), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
      } catch (err) {
        this.log(`state file ${this.file} not written: ${(err as Error).message}`);
      }
    }
    return true;
  }

  private remember(id: string): void {
    this.ids.push(id);
    this.set.add(id);
    while (this.ids.length > this.max) this.set.delete(this.ids.shift()!);
  }
}
