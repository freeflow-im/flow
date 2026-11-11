// The event bus's log (docs/specs/platform.md §5.2): one append-only table per organization, in the Events object.
// Publishers say who may read each event (`audience`); a read returns what follows a cursor that the reader may see.
// It runs over any `SqlStorage`-shaped database, so tests can use node:sqlite. Presence and typing are never logged.
import {
  formatReference, MAX_EVENT_DEPTH, parseReference, type AgentJobDTO, type AgentJobEventData, type DeliveryMode, type EventFilter,
  type JobState, type PlatformEvent, type Reference, type ScheduleDTO, type SubscriptionAction, type SubscriptionDTO,
} from '@flow/shared';
import { nextScheduleAt } from './schedule';

export interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/**
 * Who may read an event, decided by its publisher: every active account of the organization (`org`, which public
 * channels' events are), the members of a private channel, one account (the per-account objects' events), or whoever
 * an object is shared with (`ref:<reference>`, read from the share index, §4.5, and the object's owner, named by the
 * event's `data.ownerAccountId`).
 */
export type Audience = 'org' | `channel:${string}` | `account:${string}` | `ref:${string}`;

/** What a publisher hands over: the envelope less its `seq` (and its `id`, made here when absent), and the audience. */
export type PublishInput = Omit<PlatformEvent, 'seq' | 'id' | 'actor' | 'depth'> & {
  id?: string; actor?: string | null; depth?: number; audience: Audience;
};

export interface ReadQuery {
  since?: number;
  limit?: number;
  /** Newest first, from below this seq (the head when 0 or absent): the Admin app's Event log. `next` is then the oldest
   * seq returned, to read the page before it. `since` is ignored with it. */
  before?: number;
  /** Type patterns: `chat.message.created`, or a prefix with a trailing `*` (`chat.*`). */
  types?: string[];
  /** A formatted reference (`formatReference`). */
  ref?: string;
  channelId?: string;
  actorKind?: 'person' | 'agent' | 'any';
  /** Words the event's data contains, ignoring ASCII case. */
  text?: string;
  /** An account id: only the events whose audience is that account alone (a subscription's `self: true`). */
  self?: string;
}

/**
 * The reader's account, the private channels it is in, (for `actorKind`) the organization's agents' account ids, and
 * (for a `ref:` audience) the references shared with it, from the Org object's share index. Without `sharedRefs`, a
 * `ref:` event is its owner's alone.
 */
export interface Reader { accountId: string; channelIds: string[]; agentAccountIds?: string[]; sharedRefs?: string[] }

export interface EventStats { count: number; first: number | null; last: number | null; oldestTs: string | null }

export const READ_LIMIT_MAX = 500;
export const READ_LIMIT_DEFAULT = 100;
export const RETENTION_MS = 30 * 86_400_000;
export const RETENTION_ROWS = 200_000;
/** Rows one read examines at most, visible or not: a reader who may see few of them still gets a bounded scan. */
export const SCAN_MAX = 5_000;
const SCAN_BATCH = 500;

export interface NewSubscription {
  name: string; consumer: string; owner: string; filter: EventFilter; delivery?: DeliveryMode; createdBy: string;
  action?: SubscriptionAction;
  /** A schedule's subscription: its filter becomes the schedule's own ticks. Needs `organizationId`. */
  schedule?: { every: string; timezone: string };
  organizationId?: string;
}
/** A job's lease: an acked job is the agent's for this long, extended by `extend`. */
export const JOB_LEASE_MS = 10 * 60_000;
/** Deliveries past the first before a job nobody takes is parked. */
export const JOB_MAX_ATTEMPTS = 3;
/** How much of an event's data a prompt's `{{data}}` carries. */
const DATA_MAX = 8_000;
/** What a queue message's check of a job says to do: nothing more (`ack`), deliver again and check after `delayS`
 * (`redeliver`), check again after `delayS` (`later`, a lease still running), or tell the owner (`parked`). */
export type JobCheck =
  | { kind: 'ack' }
  | { kind: 'redeliver'; job: AgentJobDTO; delayS: number }
  | { kind: 'later'; delayS: number }
  | { kind: 'parked'; job: AgentJobDTO };
/** What a matched action subscription should do with one event (`act`): file a job, post, or nothing (and why). */
export type ActionDecision = { kind: 'wake' | 'post' } | { kind: 'skip'; why: 'self' | 'depth' };
/** A subscription's read: `gap` when events after its cursor aged out of the window before it read them. */
export interface SubscriptionRead { events: PlatformEvent[]; next: number; gap?: { from: number; to: number } }

export const EVENTS_MIGRATIONS: string[] = [
  `CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, actor TEXT, ref TEXT,
    channel_id TEXT, audience TEXT NOT NULL, caused_by TEXT, depth INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX events_type ON events (type, seq);
  CREATE INDEX events_channel ON events (channel_id, seq);
  CREATE INDEX events_ts ON events (ts);
  CREATE TABLE events_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `CREATE TABLE subscriptions (id TEXT PRIMARY KEY, name TEXT NOT NULL, consumer TEXT NOT NULL, owner TEXT NOT NULL, filter TEXT NOT NULL,
    delivery TEXT NOT NULL DEFAULT 'pull', cursor INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, parked_at INTEGER);
  CREATE INDEX subscriptions_consumer ON subscriptions (consumer);`,
  `ALTER TABLE subscriptions ADD COLUMN action TEXT;
  ALTER TABLE subscriptions ADD COLUMN capped_at INTEGER;
  CREATE INDEX subscriptions_owner ON subscriptions (owner);
  CREATE TABLE agent_jobs (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, agent TEXT NOT NULL, event_id TEXT NOT NULL, event_seq INTEGER NOT NULL,
    prompt TEXT NOT NULL, channel_id TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, note TEXT,
    depth INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX agent_jobs_subscription ON agent_jobs (subscription_id, created_at);
  CREATE TABLE schedules (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, every TEXT NOT NULL, timezone TEXT NOT NULL, next_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL);
  CREATE INDEX schedules_next ON schedules (next_at);
  CREATE INDEX schedules_subscription ON schedules (subscription_id);`,
  // The events shared by reference (phase 3.3): a read asks whether any follow its cursor before it fetches the reader's shares.
  `CREATE INDEX events_ref_audience ON events (seq) WHERE audience LIKE 'ref:%';`,
  // Agents as kinds (docs/specs/agents.md §3): the personal agent acting as the actor, and the account that asked a shared
  // agent for the turn the event came from.
  `ALTER TABLE events ADD COLUMN via TEXT;
  ALTER TABLE events ADD COLUMN invoked_by TEXT;`,
];

const AUDIENCE = /^(org|channel:.+|account:.+|ref:.+)$/;

export class EventsCore {
  constructor(private readonly sql: Sql, private readonly transact: <T>(fn: () => T) => T = (fn) => fn()) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY)');
    const done = (this.sql.exec('SELECT COALESCE(MAX(n), -1) AS n FROM _migrations').toArray()[0]!.n as number) + 1;
    EVENTS_MIGRATIONS.slice(done).forEach((m, i) => {
      for (const statement of m.split(';').map((s) => s.trim()).filter(Boolean)) this.sql.exec(statement);
      this.sql.exec('INSERT INTO _migrations (n) VALUES (?)', done + i);
    });
  }

  /** Appends one event; its `seq` is the next in the organization. */
  publish(input: PublishInput): { seq: number; id: string } {
    if (!AUDIENCE.test(input.audience ?? '')) throw new Error(`bad audience: ${String(input.audience)}`);
    if (!input.type || input.type === 'chat.typing' || input.type === 'chat.presence') throw new Error(`not an event: ${input.type}`);
    if (input.organizationId && !this.organizationId()) this.sql.exec('INSERT OR IGNORE INTO events_meta (key, value) VALUES (?, ?)', 'organization_id', input.organizationId);
    const id = input.id || crypto.randomUUID();
    const ts = Date.parse(input.ts);
    const row = this.sql.exec(
      `INSERT INTO events (id, type, actor, ref, channel_id, audience, caused_by, depth, ts, data, via, invoked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      id, input.type, input.actor ?? null, input.ref ? formatReference(input.ref) : null, input.channelId ?? null, input.audience,
      input.causedBy ?? null, input.depth ?? 0, Number.isFinite(ts) ? ts : Date.now(), JSON.stringify(input.data ?? null), input.via ?? null, input.invokedBy ?? null,
    ).toArray()[0]!;
    return { seq: row.seq as number, id };
  }

  /** Several events in one transaction, in the order given. */
  publishMany(inputs: PublishInput[]): { seq: number; id: string }[] {
    return this.transact(() => inputs.map((e) => this.publish(e)));
  }

  /**
   * The events after `since` that match the query and that the reader may see, oldest first. The filters are in SQL and
   * visibility is applied per row; `next` is the last seq the scan examined, seen or not: the log's head when the scan
   * reached the end, else the last row examined when `limit` events were found (or SCAN_MAX rows examined). So a reader
   * whose filter or visibility skips rows still moves past them.
   */
  read(q: ReadQuery, reader: Reader): { events: PlatformEvent[]; next: number } {
    const since = Math.max(0, Math.floor(Number(q.since) || 0));
    const limit = Math.min(READ_LIMIT_MAX, Math.max(1, Math.floor(Number(q.limit) || READ_LIMIT_DEFAULT)));
    const backwards = q.before !== undefined;
    const { filter, args } = whereOf(q, reader.agentAccountIds ?? []);
    const channels = new Set(reader.channelIds);
    const refs = new Set(reader.sharedRefs ?? []);
    const own = `account:${reader.accountId}`;
    const owns = (r: Record<string, unknown>) => {
      try { return (JSON.parse(r.data as string) as { ownerAccountId?: unknown } | null)?.ownerAccountId === reader.accountId; } catch { return false; }
    };
    const visible = (r: Record<string, unknown>) => {
      const audience = r.audience as string;
      if (audience === 'org' || audience === own) return true;
      if (audience.startsWith('channel:')) return channels.has(audience.slice(8));
      if (audience.startsWith('ref:')) return refs.has(audience.slice(4)) || owns(r);
      return false;
    };
    const organizationId = this.organizationId() ?? '';
    const events: PlatformEvent[] = [];
    let cursor = backwards ? (Math.floor(Number(q.before)) > 0 ? Math.floor(Number(q.before)) : this.head() + 1) : since;
    let examined = 0;
    for (;;) {
      const rows = backwards
        ? this.sql.exec(`SELECT * FROM events WHERE seq < ?${filter} ORDER BY seq DESC LIMIT ?`, cursor, ...args, SCAN_BATCH).toArray()
        : this.sql.exec(`SELECT * FROM events WHERE seq > ?${filter} ORDER BY seq LIMIT ?`, cursor, ...args, SCAN_BATCH).toArray();
      for (const r of rows) {
        cursor = r.seq as number;
        if (visible(r)) {
          events.push(toEvent(r, organizationId));
          if (events.length >= limit) return { events, next: cursor };
        }
        if (++examined >= SCAN_MAX) return { events, next: cursor };
      }
      if (rows.length < SCAN_BATCH) break;
    }
    return { events, next: backwards ? Math.min(cursor, ...(events.length ? [events.at(-1)!.seq] : [])) : Math.max(cursor, this.head()) };
  }

  /** Whether any event after `since` has a `ref:` audience: a read then needs the reader's shared references. */
  hasRefAudience(since: number): boolean {
    return this.sql.exec("SELECT 1 FROM events WHERE seq > ? AND audience LIKE 'ref:%' LIMIT 1", Math.max(0, Math.floor(Number(since) || 0))).toArray().length > 0;
  }

  /** The highest seq the log has given, kept or not (retention can empty the table; `seq` never goes back). */
  head(): number {
    const max = this.sql.exec('SELECT MAX(seq) AS n FROM events').toArray()[0]!.n as number | null;
    return Math.max(max ?? 0, Number(this.meta('deleted_through') ?? 0));
  }

  // ---- subscriptions: durable consumers with a cursor (§5.2) ----------------------------------------------------------

  /**
   * A new subscription starts at the log's head: it sees only what happens after it. With `schedule`, a schedule row is
   * made and the filter is forced to that schedule's ticks (`schedule.tick` on `<org>/events/schedule/<id>`).
   */
  createSubscription(s: NewSubscription, now = Date.now()): SubscriptionDTO {
    const id = crypto.randomUUID();
    let filter = s.filter ?? {};
    return this.transact(() => {
      if (s.schedule) {
        const org = s.organizationId ?? this.organizationId();
        if (!org) throw new Error('a schedule needs its organization');
        const next = nextScheduleAt(s.schedule.every, s.schedule.timezone, now);
        if (next === null) throw new Error(`bad schedule: ${s.schedule.every} in ${s.schedule.timezone}`);
        const scheduleId = crypto.randomUUID();
        filter = { types: ['schedule.tick'], ref: scheduleRef(org, scheduleId) };
        this.sql.exec('INSERT INTO schedules (id, subscription_id, every, timezone, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          scheduleId, id, s.schedule.every.trim(), s.schedule.timezone, next, now);
      }
      if (s.organizationId && !this.organizationId()) this.sql.exec('INSERT OR IGNORE INTO events_meta (key, value) VALUES (?, ?)', 'organization_id', s.organizationId);
      this.sql.exec(
        'INSERT INTO subscriptions (id, name, consumer, owner, filter, delivery, cursor, created_by, created_at, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, s.name, s.consumer, s.owner, JSON.stringify(filter), s.delivery ?? 'pull', this.head(), s.createdBy, now, s.action ? JSON.stringify(s.action) : null,
      );
      return this.getSubscription(id)!;
    });
  }

  /** The subscriptions an account consumes or owns (a sponsor's automations for its agent). */
  listSubscriptions(account: string): SubscriptionDTO[] {
    return this.sql.exec('SELECT * FROM subscriptions WHERE consumer = ? OR owner = ? ORDER BY created_at, id', account, account).toArray().map((r) => this.withSchedule(r));
  }

  getSubscription(id: string): SubscriptionDTO | null {
    const row = this.sql.exec('SELECT * FROM subscriptions WHERE id = ?', id).toArray()[0];
    return row ? this.withSchedule(row) : null;
  }

  /** The subscription, its schedule and its jobs. */
  deleteSubscription(id: string): boolean {
    return this.transact(() => {
      this.sql.exec('DELETE FROM schedules WHERE subscription_id = ?', id);
      this.sql.exec('DELETE FROM agent_jobs WHERE subscription_id = ?', id);
      return this.sql.exec('DELETE FROM subscriptions WHERE id = ? RETURNING id', id).toArray().length > 0;
    });
  }

  private withSchedule(row: Record<string, unknown>): SubscriptionDTO {
    const sub = toSubscription(row);
    const sch = this.sql.exec('SELECT * FROM schedules WHERE subscription_id = ?', sub.id).toArray()[0];
    return sch ? { ...sub, schedule: toSchedule(sch) } : sub;
  }

  /** Moves the cursor forward to `cursor` (never back, never past the head); the stored cursor, or null for no such subscription. */
  ack(id: string, cursor: number): number | null {
    const to = Math.min(Math.max(0, Math.floor(Number(cursor) || 0)), this.head());
    const row = this.sql.exec('UPDATE subscriptions SET cursor = MAX(cursor, ?) WHERE id = ? RETURNING cursor', to, id).toArray()[0];
    return row ? (row.cursor as number) : null;
  }

  /**
   * What follows the subscription's cursor that matches its filter and the reader may see. A read never acks. A cursor
   * below the oldest kept row (less one) missed events that aged out: the answer says `gap` and reads from the window's start.
   */
  readSubscription(id: string, opts: { limit?: number }, reader: Reader): SubscriptionRead | null {
    const sub = this.getSubscription(id);
    if (!sub) return null;
    return this.readFrom({ ...queryOf(sub.filter, sub.consumer), since: sub.cursor, ...(opts.limit ? { limit: opts.limit } : {}) }, reader);
  }

  /**
   * A read from a cursor that may have aged out: a `since` below the oldest kept row (less one) missed events, so the
   * answer says `gap` and reads from the window's start. A subscription's read, and a socket's backlog (`auth` with `since`).
   */
  readFrom(q: ReadQuery, reader: Reader): SubscriptionRead {
    const since = Math.max(0, Math.floor(Number(q.since) || 0));
    const first = this.sql.exec('SELECT MIN(seq) AS n FROM events').toArray()[0]!.n as number | null;
    const oldest = first ?? this.head() + 1;
    const gap = since < oldest - 1 ? { from: since + 1, to: oldest - 1 } : undefined;
    const out = this.read({ ...q, since: gap ? oldest - 1 : since }, reader);
    return gap ? { ...out, gap } : out;
  }

  /** The subscriptions whose delivery is `socket`, unparked: what a publish pokes. */
  socketSubscriptions(): SubscriptionDTO[] {
    return this.sql.exec("SELECT * FROM subscriptions WHERE delivery = 'socket' AND parked_at IS NULL").toArray().map(toSubscription);
  }

  /**
   * Which of `subs` have an event in `(after, through]` matching their filter: a poke is a hint, so visibility is left to
   * the read, except that an event for one account alone matches only that account's subscriptions. An `actorKind` filter
   * is not applied here (it needs the organization's agents); the read applies it.
   */
  matching(subs: SubscriptionDTO[], after: number, through: number): SubscriptionDTO[] {
    return subs.filter((sub) => {
      const q = queryOf(sub.filter, sub.consumer);
      delete q.actorKind;
      const { filter, args } = whereOf(q, []);
      return this.sql.exec(
        `SELECT 1 FROM events WHERE seq > ? AND seq <= ? AND (audience NOT LIKE 'account:%' OR audience = ?)${filter} LIMIT 1`,
        after, through, `account:${sub.consumer}`, ...args,
      ).toArray().length > 0;
    });
  }

  // ---- actions: `wake` files a job, `post` posts (§5.2, "Delivery modes") ---------------------------------------------

  /** The unparked subscriptions with an action: what a publish acts on. */
  actionSubscriptions(): SubscriptionDTO[] {
    return this.sql.exec("SELECT * FROM subscriptions WHERE delivery IN ('wake', 'post') AND action IS NOT NULL AND parked_at IS NULL").toArray().map(toSubscription);
  }

  /** The events in `(after, through]` that match the subscription's filter, read as `reader` (its owner) may see them. */
  matchingEvents(sub: SubscriptionDTO, after: number, through: number, reader: Reader): PlatformEvent[] {
    const out: PlatformEvent[] = [];
    let since = after;
    while (since < through) {
      const page = this.read({ ...queryOf(sub.filter, sub.owner), since, limit: READ_LIMIT_MAX }, reader);
      for (const e of page.events) if (e.seq <= through) out.push(e);
      if (page.next <= since || !page.events.length || page.next >= through) break;
      since = page.next;
    }
    return out;
  }

  /** Loop safety: an event the consumer caused is skipped unless the action opts in; one at the depth cap always is. */
  decide(sub: SubscriptionDTO, e: PlatformEvent): ActionDecision {
    if (!sub.action) return { kind: 'skip', why: 'self' };
    if ((e.depth ?? 0) >= MAX_EVENT_DEPTH) return { kind: 'skip', why: 'depth' };
    if (e.actor && e.actor === sub.consumer && !sub.action.includeSelf) return { kind: 'skip', why: 'self' };
    return { kind: sub.action.kind };
  }

  /** True the first time the subscription hits the depth cap, so its owner is told once. */
  markCapped(id: string, now = Date.now()): boolean {
    return this.sql.exec('UPDATE subscriptions SET capped_at = ? WHERE id = ? AND capped_at IS NULL RETURNING id', now, id).toArray().length > 0;
  }

  /** Moves an action subscription's cursor to what it has acted on. */
  advance(id: string, through: number): void {
    this.sql.exec('UPDATE subscriptions SET cursor = MAX(cursor, ?) WHERE id = ?', Math.min(through, this.head()), id);
  }

  /**
   * A `wake` match: a job for the consumer with the rendered prompt, and its `agent.job` event on the agent's own account
   * (`causedBy` the job, one deeper than the event), in one transaction. The job is `delivered` once its event is out.
   */
  wake(sub: SubscriptionDTO, e: PlatformEvent, now = Date.now()): { job: AgentJobDTO; published: { seq: number; id: string } } {
    if (sub.action?.kind !== 'wake') throw new Error('not a wake subscription');
    const action = sub.action;
    return this.transact(() => {
      const id = crypto.randomUUID();
      const depth = (e.depth ?? 0) + 1;
      this.sql.exec(
        `INSERT INTO agent_jobs (id, subscription_id, agent, event_id, event_seq, prompt, channel_id, state, attempts, depth, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
        id, sub.id, sub.consumer, e.id, e.seq, renderTemplate(action.prompt, e), action.channelId ?? null, depth, now, now,
      );
      const published = this.publishJob(this.getJob(id)!, e, now);
      return { job: this.getJob(id)!, published };
    });
  }

  /** The job's `agent.job` event (a new one on each delivery), and the job `delivered`. */
  private publishJob(job: AgentJobDTO, trigger: Pick<PlatformEvent, 'id' | 'seq' | 'type' | 'ref' | 'channelId'> | null, now: number): { seq: number; id: string } {
    const org = this.organizationId() ?? '';
    const t = trigger ?? this.jobTrigger(job);
    const data: AgentJobEventData = {
      jobId: job.id, subscriptionId: job.subscriptionId, prompt: job.prompt, ...(job.channelId ? { channelId: job.channelId } : {}),
      event: { id: t.id, seq: t.seq, type: t.type, ...(t.ref ? { ref: formatReference(t.ref) } : {}), ...(t.channelId ? { channelId: t.channelId } : {}) },
    };
    const out = this.publish({
      type: 'agent.job', organizationId: org, actor: null, audience: `account:${job.agent}`, ref: { organizationId: org, app: 'events', kind: 'job', id: job.id },
      causedBy: job.id, depth: job.depth, ts: new Date(now).toISOString(), data,
    });
    this.sql.exec("UPDATE agent_jobs SET state = 'delivered', lease_until = NULL, updated_at = ? WHERE id = ?", now, job.id);
    return out;
  }

  /** The event that woke a job, as its first `agent.job` named it (the trigger itself may have aged out). */
  private jobTrigger(job: AgentJobDTO): Pick<PlatformEvent, 'id' | 'seq' | 'type' | 'ref' | 'channelId'> {
    const row = this.sql.exec("SELECT data FROM events WHERE type = 'agent.job' AND caused_by = ? ORDER BY seq LIMIT 1", job.id).toArray()[0];
    const ev = row ? (JSON.parse(row.data as string) as AgentJobEventData).event : null;
    const ref = ev?.ref ? parseReference(ev.ref) : null;
    return { id: job.eventId, seq: job.eventSeq, type: ev?.type ?? 'unknown', ...(ref ? { ref } : {}), ...(ev?.channelId ? { channelId: ev.channelId } : {}) };
  }

  getJob(id: string): AgentJobDTO | null {
    const row = this.sql.exec('SELECT * FROM agent_jobs WHERE id = ?', id).toArray()[0];
    return row ? toJob(row) : null;
  }

  /** A subscription's last 50 jobs, newest first. */
  listJobs(subscriptionId: string): AgentJobDTO[] {
    return this.sql.exec('SELECT * FROM agent_jobs WHERE subscription_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50', subscriptionId).toArray().map(toJob);
  }

  /** The depth an event caused during the job's turn should carry, less one: the `agent.job` event's. Null for no such job of `agent`'s. */
  jobDepth(id: string, agent: string): number | null {
    const row = this.sql.exec('SELECT depth FROM agent_jobs WHERE id = ? AND agent = ?', id, agent).toArray()[0];
    return row ? (row.depth as number) : null;
  }

  /**
   * The agent's side of a job: `ack` (delivered → running, under a lease), `extend` (the lease again from now), `done`
   * (→ done, or failed when not `ok`). The job, or null for no such job of `agent`'s; `{ conflict }` when its state
   * does not allow it.
   */
  jobStep(id: string, agent: string, step: 'ack' | 'extend' | 'done', opts: { ok?: boolean; note?: string } = {}, now = Date.now()): AgentJobDTO | { conflict: JobState } | null {
    const job = this.getJob(id);
    if (!job || job.agent !== agent) return null;
    const lease = now + JOB_LEASE_MS;
    if (step === 'ack') {
      if (job.state === 'running') return job;
      if (job.state !== 'delivered' && job.state !== 'queued') return { conflict: job.state };
      this.sql.exec("UPDATE agent_jobs SET state = 'running', lease_until = ?, updated_at = ? WHERE id = ?", lease, now, id);
    } else if (step === 'extend') {
      if (job.state !== 'running') return { conflict: job.state };
      this.sql.exec('UPDATE agent_jobs SET lease_until = ?, updated_at = ? WHERE id = ?', lease, now, id);
    } else {
      if (job.state === 'done' || job.state === 'failed') return job;
      if (job.state === 'parked') return { conflict: job.state };
      this.sql.exec('UPDATE agent_jobs SET state = ?, lease_until = NULL, note = ?, updated_at = ? WHERE id = ?',
        opts.ok ? 'done' : 'failed', opts.note?.slice(0, 500) ?? null, now, id);
    }
    return this.getJob(id);
  }

  /**
   * A queue message's check of a job (§5.2: "a lapsed lease retries, three failures park it"). A job closed or gone
   * needs nothing; one running under its lease is checked again when the lease ends; one delivered and not acked, or
   * whose lease lapsed, is delivered again (a new `agent.job` event, the same job) and checked after 120 s × attempts,
   * or parked after JOB_MAX_ATTEMPTS.
   */
  checkJob(id: string, now = Date.now()): JobCheck {
    return this.transact(() => {
      const job = this.getJob(id);
      if (!job || job.state === 'done' || job.state === 'failed' || job.state === 'parked') return { kind: 'ack' } as const;
      if (job.state === 'running' && (job.leaseUntil ? Date.parse(job.leaseUntil) : 0) > now) {
        return { kind: 'later', delayS: Math.ceil((Date.parse(job.leaseUntil!) - now) / 1000) + 1 } as const;
      }
      const why = job.state === 'running' ? 'its lease lapsed' : 'it was not acknowledged';
      if (job.attempts >= JOB_MAX_ATTEMPTS) {
        this.sql.exec("UPDATE agent_jobs SET state = 'parked', lease_until = NULL, note = ?, updated_at = ? WHERE id = ?",
          `parked after ${job.attempts + 1} deliveries: ${why}`, now, id);
        return { kind: 'parked', job: this.getJob(id)! } as const;
      }
      const attempts = job.attempts + 1;
      this.sql.exec('UPDATE agent_jobs SET attempts = ?, note = ?, updated_at = ? WHERE id = ?', attempts, `delivered again: ${why}`, now, id);
      this.publishJob(this.getJob(id)!, null, now);
      return { kind: 'redeliver', job: this.getJob(id)!, delayS: 120 * attempts } as const;
    });
  }

  // ---- schedules: `schedule.tick` from the alarm (§5.2) ---------------------------------------------------------------

  /** The soonest a schedule is due, or null for none. */
  nextScheduleAt(): number | null {
    return (this.sql.exec('SELECT MIN(next_at) AS n FROM schedules').toArray()[0]!.n as number | null) ?? null;
  }

  /**
   * One `schedule.tick` per schedule due by `now`, on its owner's account, and each schedule's next instant from now (a
   * schedule that missed several fires once). Returns what was published, in order.
   */
  tickSchedules(now = Date.now()): { seq: number; id: string }[] {
    return this.transact(() => {
      const org = this.organizationId() ?? '';
      const due = this.sql.exec(
        'SELECT s.*, u.owner FROM schedules s JOIN subscriptions u ON u.id = s.subscription_id WHERE s.next_at <= ? ORDER BY s.next_at, s.id', now,
      ).toArray();
      const out: { seq: number; id: string }[] = [];
      for (const r of due) {
        const at = r.next_at as number;
        out.push(this.publish({
          type: 'schedule.tick', organizationId: org, actor: null, audience: `account:${r.owner as string}`, ref: scheduleRef(org, r.id as string),
          ts: new Date(now).toISOString(), data: { scheduleId: r.id, subscriptionId: r.subscription_id, every: r.every, timezone: r.timezone, at: new Date(at).toISOString() },
        }));
        const next = nextScheduleAt(r.every as string, r.timezone as string, Math.max(now, at));
        if (next === null) this.sql.exec('DELETE FROM schedules WHERE id = ?', r.id);
        else this.sql.exec('UPDATE schedules SET next_at = ? WHERE id = ?', next, r.id);
      }
      return out;
    });
  }

  stats(): EventStats {
    const r = this.sql.exec('SELECT COUNT(*) AS count, MIN(seq) AS first, MAX(seq) AS last, MIN(ts) AS oldest FROM events').toArray()[0]!;
    return { count: r.count as number, first: (r.first as number | null) ?? null, last: (r.last as number | null) ?? null, oldestTs: r.oldest == null ? null : new Date(r.oldest as number).toISOString() };
  }

  /** The retention window: rows older than `maxAgeMs`, then the oldest beyond `maxRows`. `seq` never goes back. */
  retain(now: number, maxAgeMs = RETENTION_MS, maxRows = RETENTION_ROWS): { aged: number; capped: number } {
    const head = this.head();
    const count = (where: string, arg: number) => this.sql.exec(`SELECT COUNT(*) AS n FROM events WHERE ${where}`, arg).toArray()[0]!.n as number;
    const aged = count('ts < ?', now - maxAgeMs);
    if (aged) this.sql.exec('DELETE FROM events WHERE ts < ?', now - maxAgeMs);
    const cut = this.sql.exec('SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?', maxRows).toArray()[0]?.seq as number | undefined;
    const capped = cut === undefined ? 0 : count('seq <= ?', cut);
    if (capped) this.sql.exec('DELETE FROM events WHERE seq <= ?', cut);
    if (aged || capped) this.sql.exec("INSERT INTO events_meta (key, value) VALUES ('deleted_through', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(head));
    return { aged, capped };
  }

  organizationId(): string | null {
    return this.meta('organization_id');
  }

  meta(key: string): string | null {
    return (this.sql.exec('SELECT value FROM events_meta WHERE key = ?', key).toArray()[0]?.value as string | undefined) ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec('INSERT INTO events_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }
}

/** A schedule's reference, which its ticks carry and its subscription's filter names. */
export function scheduleRef(organizationId: string, scheduleId: string): Reference {
  return { organizationId, app: 'events', kind: 'schedule', id: scheduleId };
}

/** A prompt or a post's body with the event's `{{type}}`, `{{ref}}`, `{{channel}}`, `{{actor}}` and `{{data}}` (JSON). */
export function renderTemplate(template: string, e: PlatformEvent): string {
  return template.replace(/\{\{\s*(type|ref|channel|actor|data)\s*\}\}/g, (_m, k: string) => {
    if (k === 'type') return e.type;
    if (k === 'ref') return e.ref ? formatReference(e.ref) : '';
    if (k === 'channel') return e.channelId ?? '';
    if (k === 'actor') return e.actor ?? '';
    const data = JSON.stringify(e.data ?? null);
    return data.length > DATA_MAX ? `${data.slice(0, DATA_MAX)}…` : data;
  });
}

/** A query's filters as SQL (` AND ...`, or empty) and its bindings. */
function whereOf(q: ReadQuery, agentAccountIds: string[]): { filter: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  const types = (q.types ?? []).map((t) => t.trim()).filter(Boolean);
  if (types.length) {
    where.push(`(${types.map((t) => (t.endsWith('*') ? "type LIKE ? ESCAPE '\\'" : 'type = ?')).join(' OR ')})`);
    for (const t of types) args.push(t.endsWith('*') ? `${t.slice(0, -1).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : t);
  }
  if (q.ref) { where.push('ref = ?'); args.push(q.ref); }
  if (q.channelId) { where.push('channel_id = ?'); args.push(q.channelId); }
  if (q.self) { where.push('audience = ?'); args.push(`account:${q.self}`); }
  if (q.text?.trim()) { where.push('instr(lower(data), lower(?)) > 0'); args.push(q.text.trim()); }
  if (q.actorKind === 'agent' || q.actorKind === 'person') {
    where.push(q.actorKind === 'agent'
      ? 'actor IN (SELECT value FROM json_each(?))'
      : 'actor IS NOT NULL AND actor NOT IN (SELECT value FROM json_each(?))');
    args.push(JSON.stringify(agentAccountIds));
  }
  return { filter: where.length ? ` AND ${where.join(' AND ')}` : '', args };
}

function toEvent(r: Record<string, unknown>, organizationId: string): PlatformEvent {
  const ref = r.ref ? parseReference(r.ref as string) : null;
  return {
    id: r.id as string, seq: r.seq as number, type: r.type as string, organizationId, actor: (r.actor as string | null) ?? null,
    ...(ref ? { ref } : {}), ...(r.channel_id ? { channelId: r.channel_id as string } : {}),
    ...(r.caused_by ? { causedBy: r.caused_by as string } : {}),
    ...(r.via ? { via: r.via as string } : {}), ...(r.invoked_by ? { invokedBy: r.invoked_by as string } : {}),
    depth: r.depth as number, ts: new Date(r.ts as number).toISOString(), data: JSON.parse(r.data as string),
  };
}

function toSchedule(r: Record<string, unknown>): ScheduleDTO {
  return { id: r.id as string, every: r.every as string, timezone: r.timezone as string, nextAt: new Date(r.next_at as number).toISOString() };
}

function toJob(r: Record<string, unknown>): AgentJobDTO {
  return {
    id: r.id as string, subscriptionId: r.subscription_id as string, agent: r.agent as string, eventId: r.event_id as string,
    eventSeq: r.event_seq as number, prompt: r.prompt as string, ...(r.channel_id ? { channelId: r.channel_id as string } : {}),
    state: r.state as JobState, attempts: r.attempts as number,
    ...(r.lease_until != null ? { leaseUntil: new Date(r.lease_until as number).toISOString() } : {}),
    ...(r.note ? { note: r.note as string } : {}), depth: r.depth as number,
    createdAt: new Date(r.created_at as number).toISOString(), updatedAt: new Date(r.updated_at as number).toISOString(),
  };
}

function toSubscription(r: Record<string, unknown>): SubscriptionDTO {
  return {
    id: r.id as string, name: r.name as string, consumer: r.consumer as string, owner: r.owner as string,
    filter: JSON.parse(r.filter as string) as EventFilter, delivery: r.delivery as DeliveryMode, cursor: r.cursor as number,
    createdBy: r.created_by as string, createdAt: new Date(r.created_at as number).toISOString(),
    ...(r.parked_at != null ? { parkedAt: new Date(r.parked_at as number).toISOString() } : {}),
    ...(r.action ? { action: JSON.parse(r.action as string) as SubscriptionAction } : {}),
  };
}

/** A subscription's filter as a read's query; `self` names the consumer's own account. */
export function queryOf(f: EventFilter, consumer: string): ReadQuery {
  return {
    ...(f.types?.length ? { types: f.types } : {}),
    ...(f.ref ? { ref: formatReference(f.ref) } : {}),
    ...(f.channelId ? { channelId: f.channelId } : {}),
    ...(f.actorKind ? { actorKind: f.actorKind } : {}),
    ...(f.text ? { text: f.text } : {}),
    ...(f.self ? { self: consumer } : {}),
  };
}
