// The Events object (docs/specs/platform.md §5.2): one per organization (`idFromName(organizationId)`), holding its
// append-only event log. Every app object publishes into it by binding; GET /v1/events reads it (routes/events.ts).
// The logic is in core.ts; this is the runtime around it, the long-poll on a subscription (`wait`), the actions a publish
// sets off (`wake` jobs, through the `flow-jobs` Queue, and `post`s), and the alarm that keeps the retention window and
// fires the schedules.
import { DurableObject } from 'cloudflare:workers';
import type { AgentJobDTO, JobState, PlatformEvent, SubscriptionDTO } from '@flow/shared';
import { EventsCore, renderTemplate, type EventStats, type JobCheck, type NewSubscription, type PublishInput, type ReadQuery, type Reader, type SubscriptionRead } from './core';
import type { Org } from '../org/object';

/** One message on the `flow-jobs` Queue: check this job once its delay is up (index.ts's `queue`). */
export interface JobMessage { organizationId: string; jobId: string; check: 'ack' }

/**
 * ORG is how a `socket` subscription's poke reaches its consumer's sockets, how an action reads as its owner, posts, and
 * tells the owner something; JOBS is the `flow-jobs` Queue that re-checks each wake job after JOBS_ACK_DELAY_SECONDS
 * (default 60).
 */
export interface EventsEnv { ORG?: DurableObjectNamespace<Org>; JOBS?: Queue<JobMessage>; JOBS_ACK_DELAY_SECONDS?: string }

/** What the queue consumer does with a message after a check: ack it, retry it after a delay, or ack it and send a new one. */
export type CheckAnswer = { ack: true } | { retryAfter: number } | { requeueAfter: number };

const DAY_MS = 86_400_000;
/** The longest a read waits for an event to match. */
export const WAIT_MAX_MS = 30_000;

export class Events extends DurableObject<EventsEnv> {
  private readonly core: EventsCore;
  /** Whether an alarm is known to be set, so a publish need not ask the storage each time. */
  private armed = false;
  /** Reads waiting for a publish, by subscription id. In memory: lost on eviction, when the client simply polls again. */
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(ctx: DurableObjectState, env: EventsEnv) {
    super(ctx, env);
    this.core = new EventsCore(ctx.storage.sql as never, (fn) => ctx.storage.transactionSync(fn));
  }

  /** The actions publishes set off, one batch after another, so jobs are filed in the order their events came. */
  private acting: Promise<void> = Promise.resolve();

  async publish(input: PublishInput): Promise<{ seq: number; id: string }> {
    const out = this.core.publish(input);
    this.published(input.organizationId, out.seq - 1, out.seq);
    await this.arm();
    return out;
  }

  async publishMany(inputs: PublishInput[]): Promise<{ seq: number; id: string }[]> {
    if (!inputs.length) return [];
    const out = this.core.publishMany(inputs);
    this.published(inputs[0]!.organizationId, out[0]!.seq - 1, out.at(-1)!.seq);
    await this.arm();
    return out;
  }

  /** After events `(after, through]` are in: waiting reads read again, socket subscriptions are poked, actions act. */
  private published(organizationId: string, after: number, through: number): void {
    this.wake();
    this.poke(organizationId, after, through);
    const run = this.acting.then(() => this.act(organizationId, after, through)).catch((err: Error) => console.error(`[events] actions: ${err.message}`));
    this.acting = run;
    this.ctx.waitUntil?.(run);
  }

  /** Resolves once the actions of every publish so far are done (tests, and the alarm). */
  settled(): Promise<void> {
    return this.acting;
  }

  /** A socket's backlog (`auth` with `since`): what follows `since` that the reader may see, with `gap` when it aged out. */
  async readFrom(query: ReadQuery, reader: Reader): Promise<SubscriptionRead> {
    return this.core.readFrom(query, await this.withShares(reader, query.since));
  }

  async read(query: ReadQuery, reader: Reader): Promise<{ events: PlatformEvent[]; next: number }> {
    return this.core.read(query, await this.withShares(reader, query.since));
  }

  /**
   * The reader with the references shared with it (the Org object's share index, platform.md §4.5), asked once per read
   * and only when an event after `since` has a `ref:` audience, so a revoked grant stops delivery on the next read. Every
   * read goes through here: the one-shot route, a subscription's (and its long-poll), a socket's backlog, and an action's.
   * Without the Org object (or when it fails) a `ref:` event is its owner's alone.
   */
  private async withShares(reader: Reader, since: unknown): Promise<Reader> {
    if (reader.sharedRefs || !this.env.ORG || !this.core.hasRefAudience(Number(since) || 0)) return reader;
    const org = this.core.organizationId();
    if (!org) return reader;
    try {
      const sharedRefs = await this.env.ORG.get(this.env.ORG.idFromName(org)).sharedRefsOf({ accountId: reader.accountId, channelIds: reader.channelIds });
      return { ...reader, sharedRefs };
    } catch (err) {
      console.error(`[events] shares of ${reader.accountId}: ${(err as Error).message}`);
      return reader;
    }
  }

  stats(): EventStats {
    return this.core.stats();
  }

  async createSubscription(s: NewSubscription): Promise<SubscriptionDTO> {
    const sub = this.core.createSubscription(s);
    if (sub.schedule) await this.rearm();
    return sub;
  }

  listSubscriptions(account: string): SubscriptionDTO[] {
    return this.core.listSubscriptions(account);
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
      const sub = this.core.getSubscription(id);
      const out = sub ? this.core.readSubscription(id, limit ? { limit } : {}, await this.withShares(reader, sub.cursor)) : null;
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

  // ---- jobs (the agent's side, and the queue's check) ------------------------------------------------------------------

  getJob(id: string): AgentJobDTO | null {
    return this.core.getJob(id);
  }

  listJobs(subscriptionId: string): AgentJobDTO[] {
    return this.core.listJobs(subscriptionId);
  }

  jobDepth(id: string, agent: string): number | null {
    return this.core.jobDepth(id, agent);
  }

  jobStep(id: string, agent: string, step: 'ack' | 'extend' | 'done', opts: { ok?: boolean; note?: string } = {}): AgentJobDTO | { conflict: JobState } | null {
    return this.core.jobStep(id, agent, step, opts);
  }

  /**
   * The `flow-jobs` consumer's question about one job (core.checkJob): a delivery again is published (and pokes the
   * agent's socket subscriptions like any publish); a parked job tells its subscription's owner.
   */
  async checkJob(jobId: string): Promise<CheckAnswer> {
    const out: JobCheck = this.core.checkJob(jobId);
    const org = this.core.organizationId() ?? '';
    if (out.kind === 'redeliver') {
      const seq = this.core.head();
      this.published(org, seq - 1, seq);
      console.log(`[events] job ${jobId}: delivered again (attempt ${out.job.attempts})`);
      return { retryAfter: out.delayS };
    }
    if (out.kind === 'later') return { requeueAfter: out.delayS };
    if (out.kind === 'parked') {
      console.log(`[events] job ${jobId}: parked (${out.job.note})`);
      const sub = this.core.getSubscription(out.job.subscriptionId);
      if (sub) await this.notify(org, sub, 'parked');
    }
    return { ack: true };
  }

  /** Every day the rows past the window (30 days, 200,000 rows) go; each due schedule publishes its `schedule.tick`. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const due = Number(this.core.meta('retention_at') ?? 0);
    if (due <= now) {
      const { aged, capped } = this.core.retain(now);
      if (aged || capped) console.log(`[events] retention: ${aged} aged out, ${capped} over the cap`);
      this.core.setMeta('retention_at', String(now + DAY_MS));
    }
    const ticks = this.core.tickSchedules(now);
    if (ticks.length) this.published(this.core.organizationId() ?? '', ticks[0]!.seq - 1, ticks.at(-1)!.seq);
    await this.rearm();
  }

  /**
   * The `socket` delivery mode (§5.2): each such subscription with a match among the events just appended (`after`,
   * `through`] has its consumer's sockets told `{ op: 'subscription', id }`, by the Org object that holds them. The
   * subscriptions are loaded once per batch; the poke is not awaited, so a publish does not wait on the sockets.
   */
  private poke(organizationId: string, after: number, through: number): void {
    if (!this.env.ORG || !organizationId) return;
    let hits: { id: string; consumer: string }[];
    try {
      const subs = this.core.socketSubscriptions();
      hits = subs.length ? this.core.matching(subs, after, through) : [];
    } catch (err) {
      return console.error(`[events] socket match: ${(err as Error).message}`);
    }
    if (!hits.length) return;
    const org = this.env.ORG.get(this.env.ORG.idFromName(organizationId));
    const send = Promise.all(hits.map((s) => org.pokeSubscription(s.consumer, s.id)))
      .catch((err: Error) => console.error(`[events] socket poke: ${err.message}`));
    this.ctx.waitUntil?.(send);
  }

  /** Every waiting read (or one subscription's) reads again. */
  private wake(id?: string): void {
    const sets = id ? [this.waiters.get(id)] : [...this.waiters.values()];
    for (const set of sets) for (const done of [...(set ?? [])]) done();
  }

  /** The alarm, set by the first publish: the next retention pass or the next schedule, whichever is sooner. */
  private async arm(): Promise<void> {
    if (this.armed) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.rearm();
    this.armed = true;
  }

  private async rearm(): Promise<void> {
    let retention = Number(this.core.meta('retention_at') ?? 0);
    if (!retention) {
      retention = Date.now() + DAY_MS;
      this.core.setMeta('retention_at', String(retention));
    }
    await this.ctx.storage.setAlarm(Math.min(retention, this.core.nextScheduleAt() ?? Infinity));
    this.armed = true;
  }

  // ---- actions --------------------------------------------------------------------------------------------------------

  /**
   * The `wake` and `post` subscriptions with a match among events `(after, through]`, read with each owner's visibility
   * (the owner's account and private channels, from the Org object once per batch). Loop safety (§5.2): an event the
   * consumer caused is skipped unless the action opts in, and one at MAX_EVENT_DEPTH is skipped with a log line, and
   * the owner told the first time. A wake files a job and queues its check; a post asks the Org object to post.
   */
  private async act(organizationId: string, after: number, through: number): Promise<void> {
    const subs = this.core.actionSubscriptions();
    if (!subs.length || !organizationId) return;
    const org = this.env.ORG?.get(this.env.ORG.idFromName(organizationId));
    const owners = [...new Set(subs.map((s) => s.owner))];
    const kinds = subs.some((s) => s.filter.actorKind === 'person' || s.filter.actorKind === 'agent');
    const [channels, agents] = await Promise.all([
      org ? (org.privateChannelIdsOfAccounts(owners) as Promise<Record<string, string[]>>) : Promise.resolve({} as Record<string, string[]>),
      kinds && org ? (org.agentAccountIds() as Promise<string[]>) : Promise.resolve(undefined),
    ]);
    for (const sub of subs) {
      const reader = await this.withShares({ accountId: sub.owner, channelIds: channels[sub.owner] ?? [], ...(agents ? { agentAccountIds: agents } : {}) }, after);
      const events = this.core.matchingEvents(sub, after, through, reader);
      for (const e of events) {
        const d = this.core.decide(sub, e);
        if (d.kind === 'skip') {
          if (d.why === 'depth') {
            console.log(`[events] subscription ${sub.id} (${sub.name}): event ${e.seq} at depth ${e.depth} is past the cap, no ${sub.delivery}`);
            if (this.core.markCapped(sub.id)) await this.notify(organizationId, sub, 'capped');
          }
          continue;
        }
        if (d.kind === 'wake') await this.fileJob(organizationId, sub, e);
        else if (org && sub.action?.kind === 'post') {
          await org.postAutomation({
            ownerAccountId: sub.owner, channelId: sub.action.channelId, body: renderTemplate(sub.action.body, e),
            clientMsgId: `automation:${sub.id}:${e.id}`, depth: (e.depth ?? 0) + 1,
          }).catch((err: Error) => console.error(`[events] post for ${sub.id}: ${err.message}`));
        }
      }
      this.core.advance(sub.id, through);
    }
  }

  private async fileJob(organizationId: string, sub: SubscriptionDTO, e: PlatformEvent): Promise<void> {
    const { job, published } = this.core.wake(sub, e);
    this.published(organizationId, published.seq - 1, published.seq);
    const delaySeconds = Math.max(0, Number(this.env.JOBS_ACK_DELAY_SECONDS ?? 60) || 0) || 60;
    if (!this.env.JOBS) return console.warn(`[events] job ${job.id}: no flow-jobs queue bound, so it is never re-checked`);
    await this.env.JOBS.send({ organizationId, jobId: job.id, check: 'ack' }, { delaySeconds })
      .catch((err: Error) => console.error(`[events] job ${job.id}: queue send failed: ${err.message}`));
  }

  /** "Automation X could not wake Y" (a parked job), or "… reached the depth cap", to the subscription's owner. */
  private async notify(organizationId: string, sub: SubscriptionDTO, why: 'parked' | 'capped'): Promise<void> {
    if (!this.env.ORG || !organizationId) return;
    const org = this.env.ORG.get(this.env.ORG.idFromName(organizationId));
    await org.automationNotice({ ownerAccountId: sub.owner, agentAccountId: sub.delivery === 'wake' ? sub.consumer : null, name: sub.name, why })
      .catch((err: Error) => console.error(`[events] notice for ${sub.id}: ${err.message}`));
  }
}
