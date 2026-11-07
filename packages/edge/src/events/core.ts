// The event bus's log (docs/specs/platform.md §5.2): one append-only table per organization, in the Events object.
// Publishers say who may read each event (`audience`); a read returns what follows a cursor that the reader may see.
// It runs over any `SqlStorage`-shaped database, so tests can use node:sqlite. Presence and typing are never logged.
import { formatReference, parseReference, type DeliveryMode, type EventFilter, type PlatformEvent, type SubscriptionDTO } from '@flow/shared';

export interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/**
 * Who may read an event, decided by its publisher: every active account of the organization (`org`, which public
 * channels' events are), the members of a private channel, or one account (the per-account objects' events).
 * Phase 3 adds a reference's audience, read from the share index (§4.5).
 */
export type Audience = 'org' | `channel:${string}` | `account:${string}`;

/** What a publisher hands over: the envelope less its `seq` (and its `id`, made here when absent), and the audience. */
export type PublishInput = Omit<PlatformEvent, 'seq' | 'id' | 'actor' | 'depth'> & {
  id?: string; actor?: string | null; depth?: number; audience: Audience;
};

export interface ReadQuery {
  since?: number;
  limit?: number;
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

/** The reader's account, the private channels it is in, and (for `actorKind`) the organization's agents' account ids. */
export interface Reader { accountId: string; channelIds: string[]; agentAccountIds?: string[] }

export interface EventStats { count: number; first: number | null; last: number | null; oldestTs: string | null }

export const READ_LIMIT_MAX = 500;
export const READ_LIMIT_DEFAULT = 100;
export const RETENTION_MS = 30 * 86_400_000;
export const RETENTION_ROWS = 200_000;
/** Rows one read examines at most, visible or not: a reader who may see few of them still gets a bounded scan. */
export const SCAN_MAX = 5_000;
const SCAN_BATCH = 500;

export interface NewSubscription { name: string; consumer: string; owner: string; filter: EventFilter; delivery?: DeliveryMode; createdBy: string }
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
];

const AUDIENCE = /^(org|channel:.+|account:.+)$/;

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
      `INSERT INTO events (id, type, actor, ref, channel_id, audience, caused_by, depth, ts, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      id, input.type, input.actor ?? null, input.ref ? formatReference(input.ref) : null, input.channelId ?? null, input.audience,
      input.causedBy ?? null, input.depth ?? 0, Number.isFinite(ts) ? ts : Date.now(), JSON.stringify(input.data ?? null),
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
    const { filter, args } = whereOf(q, reader.agentAccountIds ?? []);
    const channels = new Set(reader.channelIds);
    const own = `account:${reader.accountId}`;
    const visible = (audience: string) => audience === 'org' || audience === own || (audience.startsWith('channel:') && channels.has(audience.slice(8)));
    const organizationId = this.organizationId() ?? '';
    const events: PlatformEvent[] = [];
    let cursor = since;
    let examined = 0;
    for (;;) {
      const rows = this.sql.exec(`SELECT * FROM events WHERE seq > ?${filter} ORDER BY seq LIMIT ?`, cursor, ...args, SCAN_BATCH).toArray();
      for (const r of rows) {
        cursor = r.seq as number;
        if (visible(r.audience as string)) {
          events.push(toEvent(r, organizationId));
          if (events.length >= limit) return { events, next: cursor };
        }
        if (++examined >= SCAN_MAX) return { events, next: cursor };
      }
      if (rows.length < SCAN_BATCH) break;
    }
    return { events, next: Math.max(cursor, this.head()) };
  }

  /** The highest seq the log has given, kept or not (retention can empty the table; `seq` never goes back). */
  head(): number {
    const max = this.sql.exec('SELECT MAX(seq) AS n FROM events').toArray()[0]!.n as number | null;
    return Math.max(max ?? 0, Number(this.meta('deleted_through') ?? 0));
  }

  // ---- subscriptions: durable consumers with a cursor (§5.2) ----------------------------------------------------------

  /** A new subscription starts at the log's head: it sees only what happens after it. */
  createSubscription(s: NewSubscription): SubscriptionDTO {
    const id = crypto.randomUUID();
    this.sql.exec(
      'INSERT INTO subscriptions (id, name, consumer, owner, filter, delivery, cursor, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, s.name, s.consumer, s.owner, JSON.stringify(s.filter ?? {}), s.delivery ?? 'pull', this.head(), s.createdBy, Date.now(),
    );
    return this.getSubscription(id)!;
  }

  listSubscriptions(consumer: string): SubscriptionDTO[] {
    return this.sql.exec('SELECT * FROM subscriptions WHERE consumer = ? ORDER BY created_at, id', consumer).toArray().map(toSubscription);
  }

  getSubscription(id: string): SubscriptionDTO | null {
    const row = this.sql.exec('SELECT * FROM subscriptions WHERE id = ?', id).toArray()[0];
    return row ? toSubscription(row) : null;
  }

  deleteSubscription(id: string): boolean {
    return this.sql.exec('DELETE FROM subscriptions WHERE id = ? RETURNING id', id).toArray().length > 0;
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

  private organizationId(): string | null {
    return this.meta('organization_id');
  }

  private meta(key: string): string | null {
    return (this.sql.exec('SELECT value FROM events_meta WHERE key = ?', key).toArray()[0]?.value as string | undefined) ?? null;
  }
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
    depth: r.depth as number, ts: new Date(r.ts as number).toISOString(), data: JSON.parse(r.data as string),
  };
}

function toSubscription(r: Record<string, unknown>): SubscriptionDTO {
  return {
    id: r.id as string, name: r.name as string, consumer: r.consumer as string, owner: r.owner as string,
    filter: JSON.parse(r.filter as string) as EventFilter, delivery: r.delivery as DeliveryMode, cursor: r.cursor as number,
    createdBy: r.created_by as string, createdAt: new Date(r.created_at as number).toISOString(),
    ...(r.parked_at != null ? { parkedAt: new Date(r.parked_at as number).toISOString() } : {}),
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
