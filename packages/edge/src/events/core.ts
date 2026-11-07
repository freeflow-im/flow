// The event bus's log (docs/specs/platform.md §5.2): one append-only table per organization, in the Events object.
// Publishers say who may read each event (`audience`); a read returns what follows a cursor that the reader may see.
// It runs over any `SqlStorage`-shaped database, so tests can use node:sqlite. Presence and typing are never logged.
import { formatReference, parseReference, type PlatformEvent } from '@flow/shared';

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
}

/** The reader's account, the private channels it is in, and (for `actorKind`) the organization's agents' account ids. */
export interface Reader { accountId: string; channelIds: string[]; agentAccountIds?: string[] }

export interface EventStats { count: number; first: number | null; last: number | null; oldestTs: string | null }

export const READ_LIMIT_MAX = 500;
export const READ_LIMIT_DEFAULT = 100;
export const RETENTION_MS = 30 * 86_400_000;
export const RETENTION_ROWS = 200_000;

export const EVENTS_MIGRATIONS: string[] = [
  `CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, actor TEXT, ref TEXT,
    channel_id TEXT, audience TEXT NOT NULL, caused_by TEXT, depth INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX events_type ON events (type, seq);
  CREATE INDEX events_channel ON events (channel_id, seq);
  CREATE INDEX events_ts ON events (ts);
  CREATE TABLE events_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
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

  /** The events after `since` that match the query and that the reader may see, oldest first. */
  read(q: ReadQuery, reader: Reader): { events: PlatformEvent[]; next: number } {
    const since = Math.max(0, Math.floor(Number(q.since) || 0));
    const limit = Math.min(READ_LIMIT_MAX, Math.max(1, Math.floor(Number(q.limit) || READ_LIMIT_DEFAULT)));
    const where = ['seq > ?', `(audience = 'org' OR audience = ? OR audience IN (SELECT 'channel:' || value FROM json_each(?)))`];
    const args: unknown[] = [since, `account:${reader.accountId}`, JSON.stringify(reader.channelIds)];
    const types = (q.types ?? []).map((t) => t.trim()).filter(Boolean);
    if (types.length) {
      where.push(`(${types.map((t) => (t.endsWith('*') ? "type LIKE ? ESCAPE '\\'" : 'type = ?')).join(' OR ')})`);
      for (const t of types) args.push(t.endsWith('*') ? `${t.slice(0, -1).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : t);
    }
    if (q.ref) { where.push('ref = ?'); args.push(q.ref); }
    if (q.channelId) { where.push('channel_id = ?'); args.push(q.channelId); }
    if (q.actorKind === 'agent' || q.actorKind === 'person') {
      where.push(q.actorKind === 'agent'
        ? 'actor IN (SELECT value FROM json_each(?))'
        : 'actor IS NOT NULL AND actor NOT IN (SELECT value FROM json_each(?))');
      args.push(JSON.stringify(reader.agentAccountIds ?? []));
    }
    const rows = this.sql.exec(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`, ...args, limit).toArray();
    const organizationId = this.organizationId() ?? '';
    const events = rows.map((r): PlatformEvent => {
      const ref = r.ref ? parseReference(r.ref as string) : null;
      return {
        id: r.id as string, seq: r.seq as number, type: r.type as string, organizationId, actor: (r.actor as string | null) ?? null,
        ...(ref ? { ref } : {}), ...(r.channel_id ? { channelId: r.channel_id as string } : {}),
        ...(r.caused_by ? { causedBy: r.caused_by as string } : {}),
        depth: r.depth as number, ts: new Date(r.ts as number).toISOString(), data: JSON.parse(r.data as string),
      };
    });
    return { events, next: events.at(-1)?.seq ?? since };
  }

  stats(): EventStats {
    const r = this.sql.exec('SELECT COUNT(*) AS count, MIN(seq) AS first, MAX(seq) AS last, MIN(ts) AS oldest FROM events').toArray()[0]!;
    return { count: r.count as number, first: (r.first as number | null) ?? null, last: (r.last as number | null) ?? null, oldestTs: r.oldest == null ? null : new Date(r.oldest as number).toISOString() };
  }

  /** The retention window: rows older than `maxAgeMs`, then the oldest beyond `maxRows`. `seq` never goes back. */
  retain(now: number, maxAgeMs = RETENTION_MS, maxRows = RETENTION_ROWS): { aged: number; capped: number } {
    const count = (where: string, arg: number) => this.sql.exec(`SELECT COUNT(*) AS n FROM events WHERE ${where}`, arg).toArray()[0]!.n as number;
    const aged = count('ts < ?', now - maxAgeMs);
    if (aged) this.sql.exec('DELETE FROM events WHERE ts < ?', now - maxAgeMs);
    const cut = this.sql.exec('SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?', maxRows).toArray()[0]?.seq as number | undefined;
    const capped = cut === undefined ? 0 : count('seq <= ?', cut);
    if (capped) this.sql.exec('DELETE FROM events WHERE seq <= ?', cut);
    return { aged, capped };
  }

  private organizationId(): string | null {
    return (this.sql.exec("SELECT value FROM events_meta WHERE key = 'organization_id'").toArray()[0]?.value as string | undefined) ?? null;
  }
}
