// The Events object (docs/specs/platform.md §5.2): one per organization (`idFromName(organizationId)`), holding its
// append-only event log. Every app object publishes into it by binding; GET /v1/events reads it (routes/events.ts).
// The logic is in core.ts; this is the runtime around it, the long-poll on a subscription (`wait`), and the daily alarm
// that keeps the retention window.
import { DurableObject } from 'cloudflare:workers';
import type { PlatformEvent, SubscriptionDTO } from '@flow/shared';
import { EventsCore, type EventStats, type NewSubscription, type PublishInput, type ReadQuery, type Reader, type SubscriptionRead } from './core';

const DAY_MS = 86_400_000;
/** The longest a read waits for an event to match. */
export const WAIT_MAX_MS = 30_000;

export class Events extends DurableObject {
  private readonly core: EventsCore;
  /** Whether an alarm is known to be set, so a publish need not ask the storage each time. */
  private armed = false;
  /** Reads waiting for a publish, by subscription id. In memory: lost on eviction, when the client simply polls again. */
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.core = new EventsCore(ctx.storage.sql as never, (fn) => ctx.storage.transactionSync(fn));
  }

  async publish(input: PublishInput): Promise<{ seq: number; id: string }> {
    const out = this.core.publish(input);
    this.wake();
    await this.arm();
    return out;
  }

  async publishMany(inputs: PublishInput[]): Promise<{ seq: number; id: string }[]> {
    if (!inputs.length) return [];
    const out = this.core.publishMany(inputs);
    this.wake();
    await this.arm();
    return out;
  }

  read(query: ReadQuery, reader: Reader): { events: PlatformEvent[]; next: number } {
    return this.core.read(query, reader);
  }

  stats(): EventStats {
    return this.core.stats();
  }

  createSubscription(s: NewSubscription): SubscriptionDTO {
    return this.core.createSubscription(s);
  }

  listSubscriptions(consumer: string): SubscriptionDTO[] {
    return this.core.listSubscriptions(consumer);
  }

  getSubscription(id: string): SubscriptionDTO | null {
    return this.core.getSubscription(id);
  }

  deleteSubscription(id: string): boolean {
    this.wake(id);
    return this.core.deleteSubscription(id);
  }

  ack(id: string, cursor: number): number | null {
    return this.core.ack(id, cursor);
  }

  /**
   * A subscription's read that long-polls: when nothing follows the cursor, it waits up to `waitMs` (at most 30 s) for a
   * publish, reading again after each one, and answers the empty read when the time runs out. Null for no such subscription.
   */
  async wait(id: string, reader: Reader, limit?: number, waitMs = 0): Promise<SubscriptionRead | null> {
    const deadline = Date.now() + Math.min(WAIT_MAX_MS, Math.max(0, Number(waitMs) || 0));
    for (;;) {
      const out = this.core.readSubscription(id, limit ? { limit } : {}, reader);
      const left = deadline - Date.now();
      if (!out || out.events.length || out.gap || left <= 0) return out;
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(id) ?? new Set<() => void>();
        this.waiters.set(id, set);
        const done = () => { clearTimeout(timer); set.delete(done); if (!set.size && this.waiters.get(id) === set) this.waiters.delete(id); resolve(); };
        const timer = setTimeout(done, left);
        set.add(done);
      });
    }
  }

  /** Once a day: the rows past the window (30 days, 200,000 rows) go. */
  override async alarm(): Promise<void> {
    const { aged, capped } = this.core.retain(Date.now());
    if (aged || capped) console.log(`[events] retention: ${aged} aged out, ${capped} over the cap`);
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    this.armed = true;
  }

  /** Every waiting read (or one subscription's) reads again. */
  private wake(id?: string): void {
    const sets = id ? [this.waiters.get(id)] : [...this.waiters.values()];
    for (const set of sets) for (const done of [...(set ?? [])]) done();
  }

  /** The retention alarm, set by the first publish. */
  private async arm(): Promise<void> {
    if (this.armed) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    this.armed = true;
  }
}
