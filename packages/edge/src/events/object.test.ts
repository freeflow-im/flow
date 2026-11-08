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
