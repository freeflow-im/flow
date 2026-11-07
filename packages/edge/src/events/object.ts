// The Events object (docs/specs/platform.md §5.2): one per organization (`idFromName(organizationId)`), holding its
// append-only event log. Every app object publishes into it by binding; GET /v1/events reads it (routes/events.ts).
// The logic is in core.ts; this is the runtime around it, and the daily alarm that keeps the retention window.
import { DurableObject } from 'cloudflare:workers';
import type { PlatformEvent } from '@flow/shared';
import { EventsCore, type EventStats, type PublishInput, type ReadQuery, type Reader } from './core';

const DAY_MS = 86_400_000;

export class Events extends DurableObject {
  private readonly core: EventsCore;
  /** Whether an alarm is known to be set, so a publish need not ask the storage each time. */
  private armed = false;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.core = new EventsCore(ctx.storage.sql as never, (fn) => ctx.storage.transactionSync(fn));
  }

  async publish(input: PublishInput): Promise<{ seq: number; id: string }> {
    const out = this.core.publish(input);
    await this.arm();
    return out;
  }

  async publishMany(inputs: PublishInput[]): Promise<{ seq: number; id: string }[]> {
    if (!inputs.length) return [];
    const out = this.core.publishMany(inputs);
    await this.arm();
    return out;
  }

  read(query: ReadQuery, reader: Reader): { events: PlatformEvent[]; next: number } {
    return this.core.read(query, reader);
  }

  stats(): EventStats {
    return this.core.stats();
  }

  /** Once a day: the rows past the window (30 days, 200,000 rows) go. */
  override async alarm(): Promise<void> {
    const { aged, capped } = this.core.retain(Date.now());
    if (aged || capped) console.log(`[events] retention: ${aged} aged out, ${capped} over the cap`);
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    this.armed = true;
  }

  /** The retention alarm, set by the first publish. */
  private async arm(): Promise<void> {
    if (this.armed) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    this.armed = true;
  }
}
