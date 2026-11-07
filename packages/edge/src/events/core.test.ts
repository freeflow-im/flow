// The event log (platform.md §5.2): publish and seq order, type patterns, the three audiences, limit and next, and the
// retention window by age and by count.
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatReference, parseReference } from '@flow/shared';
import { EventsCore, type PublishInput, type Sql } from './core';

function nodeSql(): { sql: Sql; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    sql: {
      exec(query: string, ...args: unknown[]) {
        const stmt = db.prepare(query);
        const rows = stmt.columns().length ? stmt.all(...(args as never[])) : (stmt.run(...(args as never[])), []);
        return { toArray: () => rows as Record<string, unknown>[] };
      },
    },
  };
}

const ORG = 'org-1';
const ANN = { accountId: 'acct-ann', channelIds: ['secret'] };
const BOB = { accountId: 'acct-bob', channelIds: [] };
const ev = (type: string, extra: Partial<PublishInput> = {}): PublishInput =>
  ({ type, organizationId: ORG, actor: 'acct-ann', audience: 'org', ts: new Date().toISOString(), data: { n: type }, ...extra });

let core: EventsCore;
let db: DatabaseSync;
beforeEach(() => {
  const s = nodeSql();
  db = s.db;
  core = new EventsCore(s.sql, (fn) => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; } });
});

describe('references', () => {
  it('formats and parses, keeping slashes in the id', () => {
    const ref = { organizationId: ORG, app: 'mail', kind: 'message', id: 'a1:[Gmail]/Sent:7' };
    expect(formatReference(ref)).toBe('org-1/mail/message/a1:[Gmail]/Sent:7');
    expect(parseReference(formatReference(ref))).toEqual(ref);
    expect(parseReference('org/app/kind')).toBeNull();
  });
});

describe('the event log', () => {
  it('assigns seq in order, keeps a given id, makes one otherwise, and reads the envelope back', () => {
    const a = core.publish(ev('chat.message.created', { id: 'e1', channelId: 'c1', ref: { organizationId: ORG, app: 'chat', kind: 'message', id: 'm1' } }));
    const [b, c] = core.publishMany([ev('chat.reaction.added'), ev('mail.received', { actor: null })]);
    expect([a.seq, b!.seq, c!.seq]).toEqual([1, 2, 3]);
    expect(a.id).toBe('e1');
    expect(b!.id).toMatch(/^[0-9a-f-]{36}$/);
    const { events, next } = core.read({ since: 0 }, BOB);
    expect(events.map((e) => [e.seq, e.type])).toEqual([[1, 'chat.message.created'], [2, 'chat.reaction.added'], [3, 'mail.received']]);
    expect(events[0]).toMatchObject({ id: 'e1', organizationId: ORG, actor: 'acct-ann', channelId: 'c1', depth: 0, data: { n: 'chat.message.created' }, ref: { app: 'chat', kind: 'message', id: 'm1' } });
    expect(events[2]!.actor).toBeNull();
    expect(next).toBe(3);
    expect(core.read({ since: 3 }, BOB)).toEqual({ events: [], next: 3 });
    expect(() => core.publish(ev('chat.x', { id: 'e1' }))).toThrow();
    expect(() => core.publish(ev('chat.typing'))).toThrow();
    expect(() => core.publish(ev('chat.x', { audience: 'everyone' as never }))).toThrow();
  });

  it('rolls back a batch that fails part way', () => {
    core.publish(ev('a', { id: 'dup' }));
    expect(() => core.publishMany([ev('b'), ev('c', { id: 'dup' })])).toThrow();
    expect(core.stats().count).toBe(1);
  });

  it('matches exact types and trailing-star patterns, and filters by ref and channel', () => {
    core.publishMany([
      ev('chat.message.created', { channelId: 'c1' }), ev('chat.reaction.added', { channelId: 'c2' }),
      ev('mail.received', { ref: { organizationId: ORG, app: 'mail', kind: 'message', id: 'x:INBOX:1' } }), ev('chatter.x'), ev('chat_x'),
    ]);
    const types = (q: Parameters<EventsCore['read']>[0]) => core.read(q, BOB).events.map((e) => e.type);
    expect(types({ types: ['chat.*'] })).toEqual(['chat.message.created', 'chat.reaction.added']);
    expect(types({ types: ['mail.received', 'chat.reaction.added'] })).toEqual(['chat.reaction.added', 'mail.received']);
    expect(types({ types: ['*'] })).toHaveLength(5);
    expect(types({ ref: 'org-1/mail/message/x:INBOX:1' })).toEqual(['mail.received']);
    expect(types({ channelId: 'c2' })).toEqual(['chat.reaction.added']);
  });

  it('shows an event to its audience only: the organization, a private channel\'s members, one account', () => {
    core.publishMany([
      ev('chat.message.created'), ev('chat.message.created', { audience: 'channel:secret', channelId: 'secret' }),
      ev('mail.received', { audience: 'account:acct-ann' }), ev('mail.received', { audience: 'account:acct-bob' }),
    ]);
    expect(core.read({}, ANN).events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(core.read({}, BOB).events.map((e) => e.seq)).toEqual([1, 4]);
  });

  it('filters by actor kind with the agents named by the reader', () => {
    core.publishMany([ev('a', { actor: 'acct-bot' }), ev('b'), ev('c', { actor: null })]);
    const reader = { ...BOB, agentAccountIds: ['acct-bot'] };
    expect(core.read({ actorKind: 'agent' }, reader).events.map((e) => e.type)).toEqual(['a']);
    expect(core.read({ actorKind: 'person' }, reader).events.map((e) => e.type)).toEqual(['b']);
    expect(core.read({ actorKind: 'any' }, reader).events).toHaveLength(3);
  });

  it('caps limit at 500, and next is the last seq returned', () => {
    core.publishMany(Array.from({ length: 600 }, (_, i) => ev(`t.${i}`)));
    const page = core.read({ since: 0, limit: 10_000 }, BOB);
    expect(page.events).toHaveLength(500);
    expect(page.next).toBe(500);
    expect(core.read({ since: page.next, limit: 1000 }, BOB).events).toHaveLength(100);
    const small = core.read({ since: 10, limit: 3 }, BOB);
    expect([small.events.map((e) => e.seq), small.next]).toEqual([[11, 12, 13], 13]);
    expect(core.read({}, BOB).events).toHaveLength(100);
  });

  it('keeps 30 days, then the newest rows up to the cap, and never reuses a seq', () => {
    const now = Date.now(), day = 86_400_000;
    core.publishMany([
      ev('old', { ts: new Date(now - 31 * day).toISOString() }), ev('old', { ts: new Date(now - 30 * day - 1).toISOString() }),
      ...Array.from({ length: 5 }, () => ev('recent', { ts: new Date(now - day).toISOString() })),
    ]);
    expect(core.stats()).toMatchObject({ count: 7, first: 1, last: 7 });
    expect(core.retain(now)).toEqual({ aged: 2, capped: 0 });
    expect(core.retain(now, 30 * day, 3)).toEqual({ aged: 0, capped: 2 });
    const stats = core.stats();
    expect(stats).toMatchObject({ count: 3, first: 5, last: 7 });
    expect(stats.oldestTs).toBe(new Date(now - day).toISOString());
    expect(core.publish(ev('next')).seq).toBe(8);
    expect(core.retain(now, 30 * day, 3)).toEqual({ aged: 0, capped: 1 });
  });
});
