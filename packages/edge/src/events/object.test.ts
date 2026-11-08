// The Events object's long-poll (platform.md §5.2): a waiting read answers when a publish brings a match, keeps waiting
// past one that does not, and answers empty when the time runs out. Over node:sqlite, with a stand-in object state.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { PublishInput } from './core';
import { Events } from './object';

function events(): Events {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...(args as never[])) : (stmt.run(...(args as never[])), []);
      return { toArray: () => rows };
    },
  };
  const storage = { sql, transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => null, setAlarm: async () => undefined };
  return new Events({ storage } as never, {});
}

const BOB = { accountId: 'acct-bob', channelIds: [] };
const ev = (type: string): PublishInput => ({ type, organizationId: 'org-1', actor: 'acct-ann', audience: 'org', ts: new Date().toISOString(), data: {} });

describe('Events.wait', () => {
  it('answers at once when something follows the cursor', async () => {
    const o = events();
    const s = await o.createSubscription({ name: 'n', consumer: 'acct-bob', owner: 'acct-bob', filter: {}, createdBy: 'acct-bob' });
    await o.publish(ev('chat.a'));
    expect(await o.wait(s.id, BOB, undefined, 5_000)).toMatchObject({ events: [{ seq: 1 }], next: 1 });
  });

  it('resolves on a matching publish, not on one its filter skips', async () => {
    const o = events();
    const s = await o.createSubscription({ name: 'n', consumer: 'acct-bob', owner: 'acct-bob', filter: { types: ['chat.*'] }, createdBy: 'acct-bob' });
    const started = Date.now();
    const waiting = o.wait(s.id, BOB, undefined, 5_000);
    setTimeout(() => void o.publish(ev('mail.received')), 20);
    setTimeout(() => void o.publish(ev('chat.message.created')), 60);
    const out = await waiting;
    expect(out).toMatchObject({ events: [{ seq: 2, type: 'chat.message.created' }], next: 2 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('answers the empty read when the time runs out, and null for no such subscription', async () => {
    const o = events();
    const s = await o.createSubscription({ name: 'n', consumer: 'acct-bob', owner: 'acct-bob', filter: {}, createdBy: 'acct-bob' });
    const started = Date.now();
    expect(await o.wait(s.id, BOB, undefined, 150)).toEqual({ events: [], next: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(await o.wait('nope', BOB, undefined, 150)).toBeNull();
    // Deleting the subscription ends a read waiting on it.
    const waiting = o.wait(s.id, BOB, undefined, 5_000);
    setTimeout(() => o.deleteSubscription(s.id), 20);
    expect(await waiting).toBeNull();
  });
});

describe('Events reads and the share index (phase 3.3)', () => {
  const R = 'org-1/docs/sheet/s1';
  /** An Events object whose Org object answers `sharedRefsOf` from `shared`, counting the asks. */
  function withOrg(shared: Record<string, string[]>) {
    const db = new DatabaseSync(':memory:');
    const sql = {
      exec(query: string, ...args: unknown[]) {
        const stmt = db.prepare(query);
        const rows = stmt.columns().length ? stmt.all(...(args as never[])) : (stmt.run(...(args as never[])), []);
        return { toArray: () => rows };
      },
    };
    const asked: string[] = [];
    const org = { sharedRefsOf: async (r: { accountId: string }) => { asked.push(r.accountId); return shared[r.accountId] ?? []; } };
    const storage = { sql, transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => null, setAlarm: async () => undefined };
    return { o: new Events({ storage } as never, { ORG: { idFromName: (n: string) => n, get: () => org } } as never), asked };
  }
  const changed: PublishInput = { type: 'docs.file.changed', organizationId: 'org-1', actor: null, audience: `ref:${R}`, ts: new Date().toISOString(), data: { ref: R, ownerAccountId: 'acct-ann' } };

  it('asks the Org object once per read, only when a ref: event follows the cursor, on every read path', async () => {
    const { o, asked } = withOrg({ 'acct-bob': [R] });
    await o.publish(ev('chat.a'));
    expect((await o.read({ since: 0 }, BOB)).events).toHaveLength(1);
    expect(asked).toEqual([]);
    await o.publish(changed);
    expect((await o.read({ since: 0 }, BOB)).events.map((e) => e.type)).toEqual(['chat.a', 'docs.file.changed']);
    expect((await o.read({ since: 0 }, { accountId: 'acct-cat', channelIds: [] })).events.map((e) => e.type)).toEqual(['chat.a']);
    expect(asked).toEqual(['acct-bob', 'acct-cat']);
    expect((await o.readFrom({ since: 0 }, BOB)).events).toHaveLength(2);
    const s = await o.createSubscription({ name: 'n', consumer: 'acct-bob', owner: 'acct-bob', filter: { types: ['docs.*'] }, createdBy: 'acct-bob' });
    const waiting = o.wait(s.id, BOB, undefined, 5_000);
    setTimeout(() => void o.publish(changed), 20);
    expect(await waiting).toMatchObject({ events: [{ type: 'docs.file.changed' }] });
    // Revoked: the next read no longer lets it through.
    const { o: after } = withOrg({});
    await after.publish(changed);
    expect((await after.read({ since: 0 }, BOB)).events).toEqual([]);
  });
});
