// Editing an automation (PATCH /v1/events/subscriptions/:id, subscriptions.ts `update`): its owner changes the name, a
// wake's prompt or a post's message; what it listens to, whom it wakes and its cursor stay; anyone else gets nothing.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { UpdateSubscriptionBody } from '@flow/shared';
import { Events } from './object';
import { subscriptionsAs } from './subscriptions';
import { meetingWakeSubscription } from '../assistant/meetingWake';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...args: unknown[]) {
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...(args as never[])) : (stmt.run(...(args as never[])), []);
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
}

const ORG = 'org-1';
const ANN = 'acct-ann', BEN = 'acct-ben', ADA = 'acct-ada';

function harness() {
  const org = { privateChannelIdsOfAccounts: async () => ({}), agentAccountIds: async () => [ADA], pokeSubscription: async () => 0 };
  const env = { ORG: { idFromName: (n: string) => n, get: () => org } };
  const storage = { sql: sqlite(), transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => null, setAlarm: async () => undefined };
  const o = new Events({ storage, waitUntil: () => undefined } as never, env as never);
  const as = (account: string) => subscriptionsAs(o as never, org as never, account, `user-${account}`, 'member', ORG);
  return { o, as };
}

describe('editing an automation', () => {
  it("its owner changes the name and a wake's prompt; the filter, agent and other action fields stay", async () => {
    const { o, as } = harness();
    const sub = await o.createSubscription(meetingWakeSubscription({ organizationId: ORG, agentAccountId: ADA, sponsorAccountId: ANN }));
    const edited = await as(ANN).update(sub.id, { name: 'My meeting notes', prompt: 'Write two lines only.' });
    expect(edited).toMatchObject({ id: sub.id, name: 'My meeting notes', consumer: ADA, owner: ANN, filter: sub.filter, cursor: sub.cursor, action: { kind: 'wake', prompt: 'Write two lines only.' } });
    expect(o.getSubscription(sub.id)?.action).toEqual({ kind: 'wake', prompt: 'Write two lines only.' });
  });

  it("is refused to anyone but the owner (the agent too), and a prompt on a post automation", async () => {
    const { o, as } = harness();
    const sub = await o.createSubscription(meetingWakeSubscription({ organizationId: ORG, agentAccountId: ADA, sponsorAccountId: ANN }));
    expect(await as(BEN).update(sub.id, { name: 'x' })).toBeNull();
    expect(await as(ADA).update(sub.id, { name: 'x' })).toBeNull();
    const post = await as(ANN).create({ name: 'Echo', delivery: 'post', filter: { types: ['chat.message.created'] }, action: { kind: 'post', channelId: 'c1', body: 'Seen' } });
    await expect(as(ANN).update(post.id, { prompt: 'x' })).rejects.toMatchObject({ code: 'not_a_wake' });
    expect(await as(ANN).update(post.id, { body: 'Seen it' })).toMatchObject({ action: { kind: 'post', channelId: 'c1', body: 'Seen it' } });
  });

  it('the body names something to change, and only name, prompt or body', () => {
    expect(UpdateSubscriptionBody.safeParse({}).success).toBe(false);
    expect(UpdateSubscriptionBody.safeParse({ filter: {} }).success).toBe(false);
    expect(UpdateSubscriptionBody.safeParse({ prompt: '  ' }).success).toBe(false);
    expect(UpdateSubscriptionBody.safeParse({ name: 'Notes' }).success).toBe(true);
  });
});
