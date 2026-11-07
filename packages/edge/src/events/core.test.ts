// The event log (platform.md §5.2): publish and seq order, type patterns, the three audiences, limit and next, and the
// retention window by age and by count; subscriptions: a cursor from the head, ack, the gap marker, `self`.
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatReference, parseReference } from '@flow/shared';
import { EventsCore, SCAN_MAX, type PublishInput, type Sql } from './core';

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

  it('caps limit at 500, and next is the last seq examined', () => {
    core.publishMany(Array.from({ length: 600 }, (_, i) => ev(`t.${i}`)));
    const page = core.read({ since: 0, limit: 10_000 }, BOB);
    expect(page.events).toHaveLength(500);
    expect(page.next).toBe(500);
    expect(core.read({ since: page.next, limit: 1000 }, BOB).events).toHaveLength(100);
    const small = core.read({ since: 10, limit: 3 }, BOB);
    expect([small.events.map((e) => e.seq), small.next]).toEqual([[11, 12, 13], 13]);
    expect(core.read({}, BOB).events).toHaveLength(100);
  });

  it('moves next past the rows a filter or visibility skipped', () => {
    core.publishMany([ev('chat.message.created'), ev('mail.received'), ev('chat.x', { audience: 'channel:secret' }), ev('mail.received')]);
    // The scan reached the end: next is the head, though the last match was seq 1.
    expect(core.read({ types: ['chat.*'] }, BOB)).toMatchObject({ events: [{ seq: 1 }], next: 4 });
    expect(core.read({ since: 1, types: ['chat.*'] }, BOB)).toEqual({ events: [], next: 4 });
    // Nothing matches at all: still the head.
    expect(core.read({ types: ['calendar.*'] }, BOB)).toEqual({ events: [], next: 4 });
    // limit reached: the last row examined, which a hidden row before it does not hold back.
    core.publishMany([ev('chat.y', { audience: 'channel:secret' }), ev('chat.z'), ev('chat.w')]);
    expect(core.read({ since: 4, limit: 1 }, BOB)).toMatchObject({ events: [{ seq: 6 }], next: 6 });
    expect(core.read({ since: 4, limit: 1 }, ANN)).toMatchObject({ events: [{ seq: 5 }], next: 5 });
    expect(core.read({ since: 100 }, BOB)).toEqual({ events: [], next: 100 });
  });

  it('bounds a scan of rows the reader may not see', () => {
    core.publishMany(Array.from({ length: SCAN_MAX + 10 }, () => ev('chat.hidden', { audience: 'channel:secret' })));
    expect(core.read({}, BOB)).toEqual({ events: [], next: SCAN_MAX });
    expect(core.read({ since: SCAN_MAX }, BOB)).toEqual({ events: [], next: SCAN_MAX + 10 });
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

describe('subscriptions', () => {
  const sub = (filter = {}, consumer = 'acct-bob') => core.createSubscription({ name: 'n', consumer, owner: consumer, filter, createdBy: consumer });

  it('starts at the head, keeps its fields, lists by consumer, and deletes', () => {
    core.publishMany([ev('chat.a'), ev('chat.b')]);
    const s = sub({ types: ['chat.*'] });
    expect(s).toMatchObject({ name: 'n', consumer: 'acct-bob', owner: 'acct-bob', filter: { types: ['chat.*'] }, delivery: 'pull', cursor: 2, createdBy: 'acct-bob' });
    expect(Date.parse(s.createdAt)).toBeGreaterThan(0);
    expect(s.parkedAt).toBeUndefined();
    const w = core.createSubscription({ name: 'w', consumer: 'acct-bob', owner: 'acct-bob', filter: {}, delivery: 'webhook', createdBy: 'acct-bob' });
    expect(w.delivery).toBe('webhook');
    sub({}, 'acct-ann');
    expect(core.listSubscriptions('acct-bob').map((x) => x.id).sort()).toEqual([s.id, w.id].sort());
    expect(core.readSubscription(s.id, {}, BOB)).toEqual({ events: [], next: 2 });
    expect(core.deleteSubscription(s.id)).toBe(true);
    expect(core.deleteSubscription(s.id)).toBe(false);
    expect(core.getSubscription(s.id)).toBeNull();
    expect(core.readSubscription(s.id, {}, BOB)).toBeNull();
  });

  it('reads by cursor with its filter and the reader\'s visibility; ack moves the cursor forward only', () => {
    const s = sub({ types: ['chat.*'] });
    core.publishMany([ev('chat.a'), ev('mail.received'), ev('chat.b', { audience: 'channel:secret' }), ev('chat.c'), ev('mail.x')]);
    const first = core.readSubscription(s.id, { limit: 1 }, BOB)!;
    expect([first.events.map((e) => e.seq), first.next]).toEqual([[1], 1]);
    // A read never acks.
    expect(core.readSubscription(s.id, {}, BOB)).toMatchObject({ events: [{ seq: 1 }, { seq: 4 }], next: 5 });
    expect(core.ack(s.id, 5)).toBe(5);
    expect(core.ack(s.id, 3)).toBe(5);
    expect(core.ack(s.id, 1000)).toBe(5);
    expect(core.ack('nope', 1)).toBeNull();
    expect(core.readSubscription(s.id, {}, BOB)).toEqual({ events: [], next: 5 });
    core.publish(ev('chat.d'));
    expect(core.readSubscription(s.id, {}, BOB)!.events.map((e) => e.type)).toEqual(['chat.d']);
  });

  it('self matches the events addressed to the consumer alone', () => {
    const s = sub({ self: true });
    core.publishMany([ev('mail.received', { audience: 'account:acct-bob' }), ev('mail.received', { audience: 'account:acct-ann' }), ev('chat.a')]);
    expect(core.readSubscription(s.id, {}, BOB)).toMatchObject({ events: [{ seq: 1 }], next: 3 });
  });

  it('filters by ref, channel and text', () => {
    const ref = { organizationId: ORG, app: 'mail', kind: 'message', id: 'a:INBOX:1' };
    const byRef = sub({ ref }), byChannel = sub({ channelId: 'c1' }), byText = sub({ text: 'Lunch' });
    core.publishMany([ev('mail.received', { ref, data: { subject: 'lunch?' } }), ev('chat.a', { channelId: 'c1' }), ev('chat.b')]);
    const seqs = (id: string) => core.readSubscription(id, {}, BOB)!.events.map((e) => e.seq);
    expect([seqs(byRef.id), seqs(byChannel.id), seqs(byText.id)]).toEqual([[1], [2], [1]]);
  });

  it('marks a gap when its cursor fell behind the window, and reads from the window\'s start', () => {
    const now = Date.now(), day = 86_400_000;
    const s = sub();
    core.publishMany([ev('old', { ts: new Date(now - 40 * day).toISOString() }), ev('old', { ts: new Date(now - 40 * day).toISOString() }), ev('new'), ev('new')]);
    core.retain(now);
    expect(core.readSubscription(s.id, {}, BOB)).toMatchObject({ events: [{ seq: 3 }, { seq: 4 }], next: 4, gap: { from: 1, to: 2 } });
    expect(core.ack(s.id, 4)).toBe(4);
    expect(core.readSubscription(s.id, {}, BOB)).toEqual({ events: [], next: 4 });
    // An emptied log keeps its head: a new subscription starts there, an old one behind it gets the gap.
    const behind = core.createSubscription({ name: 'b', consumer: 'acct-bob', owner: 'acct-bob', filter: {}, createdBy: 'acct-bob' });
    core.retain(now + 60 * day);
    expect(core.stats().count).toBe(0);
    expect(sub().cursor).toBe(4);
    db.prepare('UPDATE subscriptions SET cursor = 1 WHERE id = ?').run(behind.id);
    expect(core.readSubscription(behind.id, {}, BOB)).toEqual({ events: [], next: 4, gap: { from: 2, to: 4 } });
    expect(core.publish(ev('next')).seq).toBe(5);
  });
});

describe('a socket\'s backlog and the socket delivery mode', () => {
  it('reads from a since, with a gap when it aged out', () => {
    const now = Date.now(), day = 86_400_000;
    core.publishMany([ev('chat.old', { ts: new Date(now - 40 * day).toISOString() }), ev('chat.new'), ev('mail.received'), ev('chat.newer')]);
    expect(core.readFrom({ since: 2, types: ['chat.*'] }, BOB)).toMatchObject({ events: [{ seq: 4 }], next: 4 });
    expect(core.readFrom({ since: 0, types: ['chat.*'] }, BOB).gap).toBeUndefined();
    core.retain(now);
    expect(core.readFrom({ since: 0, types: ['chat.*'] }, BOB)).toMatchObject({ events: [{ seq: 2 }, { seq: 4 }], next: 4, gap: { from: 1, to: 1 } });
    expect(core.readFrom({ since: 4 }, BOB)).toEqual({ events: [], next: 4 });
  });

  it('matches socket subscriptions against a batch, keeping one account\'s events to that account', () => {
    const mk = (consumer: string, filter: object, delivery: 'socket' | 'pull' = 'socket') =>
      core.createSubscription({ name: 'n', consumer, owner: consumer, filter, delivery, createdBy: consumer });
    const chat = mk('acct-bob', { types: ['chat.*'] }), mail = mk('acct-bob', { types: ['mail.*'] });
    mk('acct-bob', {}, 'pull');
    const ann = mk('acct-ann', { types: ['chat.notification.*'] });
    const subs = core.socketSubscriptions();
    expect(subs.map((s) => s.id).sort()).toEqual([chat.id, mail.id, ann.id].sort());
    core.publishMany([ev('chat.message.created'), ev('chat.notification.created', { audience: 'account:acct-bob' })]);
    expect(core.matching(subs, 0, 2).map((s) => s.id).sort()).toEqual([chat.id]);
    core.publish(ev('chat.notification.created', { audience: 'account:acct-ann' }));
    expect(core.matching(subs, 2, 3).map((s) => s.id)).toEqual([ann.id]);
  });
});
