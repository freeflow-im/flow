// search_events (events/search.ts): newest first, as the account may see; a shared agent's search adds the person who
// asked, and nobody else; filters, `since`, paging with next_before, and long data cut short.
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventsCore, type PublishInput, type Sql } from './core';
import { eventSearchAs, trimData } from './search';

function nodeSql(): Sql {
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
const ANN = 'acct-ann', BEN = 'acct-ben', ADA = 'acct-ada', OMNI = 'acct-omni';
let core: EventsCore;
let at = Date.parse('2026-11-20T09:00:00Z');
const publish = (type: string, extra: Partial<PublishInput> = {}) =>
  core.publish({ type, organizationId: ORG, actor: null, audience: 'org', ts: new Date((at += 60_000)).toISOString(), data: { title: type }, ...extra });

// The Org object's answers: Ann sponsors Ada; Ben is in the private channel "ben-only"; Omni is a shared agent.
const org = {
  privateChannelIdsOfAccounts: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, id === BEN ? ['ben-only'] : []])),
  personalAgentAccountsOf: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, id === ANN ? [ADA] : []])),
  agentAccountIds: async () => [ADA, OMNI],
};
const search = (accountId: string, invokedBy?: string) =>
  eventSearchAs({ read: async (q: never, r: never) => core.read(q, r), stats: async () => core.stats() } as never, org as never, { accountId, invokedBy: invokedBy ?? null });

beforeEach(() => {
  core = new EventsCore(nodeSql());
  at = Date.parse('2026-11-20T09:00:00Z');
});

describe('search_events', () => {
  it("a person finds their personal agent's meetings, newest first, with labels", async () => {
    publish('meet.agent.joined', { actor: ADA, audience: `account:${ADA}`, data: { title: 'Weekly sync' } });
    publish('meet.ended', { audience: `account:${ADA}`, data: { title: 'Weekly sync', transcript: { docId: 'd1' } } });
    publish('meet.ended', { audience: `account:${OMNI}`, data: { title: 'Board' } });
    const out = await search(ANN).search({ types: ['meet.*'] });
    expect(out.events.map((e) => [e.type, e.label])).toEqual([['meet.ended', 'Meeting ended (an agent was in it)'], ['meet.agent.joined', 'Agent joined a meeting']]);
    expect(out.events[0]!.data).toEqual({ title: 'Weekly sync', transcript: { docId: 'd1' } });
    expect(out.next_before).toBeNull();
  });

  it("a shared agent sees its own events and the asker's, not another person's", async () => {
    publish('meet.ended', { audience: `account:${OMNI}`, data: { title: 'Board' } });
    publish('mail.received', { audience: `account:${BEN}`, data: { subject: 'For Ben' } });
    publish('chat.message.created', { audience: 'channel:ben-only', channelId: 'ben-only', data: { text: 'private' } });
    publish('mail.received', { audience: `account:${ANN}`, data: { subject: 'For Ann' } });
    const alone = await search(OMNI).search({});
    expect(alone.events.map((e) => e.type)).toEqual(['meet.ended']);
    const forBen = await search(OMNI, BEN).search({});
    expect(forBen.events.map((e) => e.data)).toEqual([{ text: 'private' }, { subject: 'For Ben' }, { title: 'Board' }]);
  });

  it('filters by text and actor kind, stops at since, and pages with next_before', async () => {
    for (let i = 1; i <= 5; i++) publish('chat.message.created', { actor: i % 2 ? ADA : ANN, data: { text: `note ${i}` } });
    publish('chat.message.created', { data: { text: 'other' } });
    expect((await search(ANN).search({ text: 'NOTE 3' })).events.map((e) => e.data)).toEqual([{ text: 'note 3' }]);
    expect((await search(ANN).search({ actorKind: 'agent' })).events.map((e) => (e.data as { text: string }).text)).toEqual(['note 5', 'note 3', 'note 1']);
    const first = await search(ANN).search({ text: 'note', limit: 2 });
    expect(first.events.map((e) => (e.data as { text: string }).text)).toEqual(['note 5', 'note 4']);
    const second = await search(ANN).search({ text: 'note', limit: 2, before: first.next_before! });
    expect(second.events.map((e) => (e.data as { text: string }).text)).toEqual(['note 3', 'note 2']);
    const third = await search(ANN).search({ text: 'note', limit: 2, before: second.next_before! });
    expect(third.events.map((e) => (e.data as { text: string }).text)).toEqual(['note 1']);
    expect(third.next_before).toBeNull();
    const since = await search(ANN).search({ text: 'note', since: '2026-11-20T09:04:00Z' });
    expect(since.events.map((e) => (e.data as { text: string }).text)).toEqual(['note 5', 'note 4']);
    expect(since.next_before).toBeNull();
  });

  it('cuts long strings and deep data', () => {
    const out = trimData({ text: 'x'.repeat(1000), list: Array.from({ length: 30 }, (_, i) => i), a: { b: { c: { d: { e: 1 } } } } }) as Record<string, unknown>;
    expect((out.text as string).length).toBe(301);
    expect((out.list as unknown[]).at(-1)).toBe('… 10 more');
    expect(out.a).toEqual({ b: { c: { d: '{…}' } } });
  });
});
