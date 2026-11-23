// search_events (task 32): what an agent may look back on. Its own events and those of the person who started the turn,
// read as each may see them; never another person's, and not what a shared agent did for someone else.
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@flow/shared';
import { EventsCore, type PublishInput, type ReadQuery, type Reader, type Sql } from './core';
import { historyParts, shown } from './history';

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
const ANN = 'acct-ann', BEN = 'acct-ben', ADA = 'acct-ada' /* Ann's assistant */, OMNI = 'acct-omni' /* shared */;
const T0 = Date.parse('2026-11-20T10:00:00Z');
let n = 0;
const ev = (type: string, extra: Partial<PublishInput> = {}): PublishInput =>
  ({ type, organizationId: ORG, actor: null, audience: 'org', ts: new Date(T0 + (n++) * 60_000).toISOString(), data: { n: type }, ...extra });

let core: EventsCore;
beforeEach(() => {
  n = 0;
  core = new EventsCore(nodeSql());
  core.publishMany([
    ev('chat.message.created', { actor: ANN, data: { body: 'Ann in general' } }),
    ev('chat.message.created', { actor: BEN, data: { body: 'Ben in general' } }),
    ev('chat.message.created', { actor: ANN, audience: 'channel:ann-ben', channelId: 'ann-ben', data: { body: 'Ann in a private channel with Ben' } }),
    ev('meet.agent_joined', { actor: ADA, invokedBy: ANN, audience: `account:${ADA}`, about: [ADA, ANN], data: { title: 'Weekly planning' } }),
    ev('meet.ended', { audience: `account:${ADA}`, invokedBy: ANN, about: [ADA, ANN], data: { title: 'Weekly planning', transcript: 'saved' } }),
    ev('meet.agent_joined', { actor: OMNI, invokedBy: BEN, audience: `account:${OMNI}`, about: [OMNI, BEN], data: { title: 'Ben 1:1' } }),
    ev('meet.ended', { audience: `account:${OMNI}`, invokedBy: BEN, about: [OMNI, BEN], data: { title: 'Ben 1:1', transcript: 'not_recorded' } }),
    ev('meet.agent_joined', { actor: OMNI, invokedBy: ANN, audience: `account:${OMNI}`, about: [OMNI, ANN], data: { title: 'Design review' } }),
    ev('chat.message.created', { actor: OMNI, data: { body: 'Omni posted in general on its own' } }),
    ev('chat.message.created', { actor: OMNI, audience: 'channel:omni-ben', channelId: 'omni-ben', data: { body: 'Omni in a private channel without Ann' } }),
  ]);
});

/** What Events.search does: each part newest first, merged. */
function search(parts: { query: ReadQuery; reader: Reader }[], limit = 50): PlatformEvent[] {
  const seen = new Map<number, PlatformEvent>();
  for (const p of parts) for (const e of core.read({ ...p.query, before: 0, limit }, p.reader).events) seen.set(e.seq, e);
  return [...seen.values()].sort((a, b) => b.seq - a.seq).slice(0, limit);
}
const bodies = (es: PlatformEvent[]) => es.map((e) => (e.data as { body?: string; title?: string }).body ?? `${e.type} ${(e.data as { title: string }).title}`);
const channels = { [ANN]: ['ann-ben'], [BEN]: ['ann-ben', 'omni-ben'], [ADA]: [], [OMNI]: ['omni-ben'] };

describe('search_events', () => {
  it('a personal agent sees its own events and its sponsor\'s, never another person\'s', () => {
    const got = bodies(search(historyParts({ self: ADA, person: ANN, personal: true, channels }, {})));
    expect(got).toEqual(['meet.ended Weekly planning', 'meet.agent_joined Weekly planning', 'Ann in a private channel with Ben', 'Ann in general']);
    expect(bodies(search(historyParts({ self: ADA, person: ANN, personal: true, channels }, {}, 'you')))).toEqual(['meet.ended Weekly planning', 'meet.agent_joined Weekly planning']);
  });

  it('a shared agent asked by Ann: Ann\'s events, what it did for her, and what it did for no one that she may see', () => {
    const got = bodies(search(historyParts({ self: OMNI, person: ANN, personal: false, channels }, {})));
    expect(got).toEqual(['Omni posted in general on its own', 'meet.agent_joined Design review', 'Ann in a private channel with Ben', 'Ann in general']);
    // Not Ben's meeting, not Ben's messages, not its post in a channel Ann is not in.
    expect(got.join(' ')).not.toMatch(/Ben 1:1|Ben in general|without Ann/);
  });

  it('a shared agent nobody asked sees only what it did for no one', () => {
    const got = bodies(search(historyParts({ self: OMNI, person: null, personal: false, channels }, {})));
    expect(got).toEqual(['Omni in a private channel without Ann', 'Omni posted in general on its own']);
  });

  it('filters by type, time and text', () => {
    const parts = (q: ReadQuery) => historyParts({ self: ADA, person: ANN, personal: true, channels }, q);
    expect(bodies(search(parts({ types: ['meet.*'] })))).toEqual(['meet.ended Weekly planning', 'meet.agent_joined Weekly planning']);
    expect(bodies(search(parts({ fromTs: T0 + 3 * 60_000, toTs: T0 + 3 * 60_000 })))).toEqual(['meet.agent_joined Weekly planning']);
    expect(bodies(search(parts({ text: 'private channel' })))).toEqual(['Ann in a private channel with Ben']);
  });

  it('shows who acted in the agent\'s terms, and cuts long data', () => {
    const [e] = core.read({ before: 0, limit: 1, types: ['meet.agent_joined'], involves: [ADA] }, { accountId: ANN, channelIds: [], sponsoredAgentIds: [ADA] }).events;
    expect(shown(e!, ADA, ANN).by).toBe('you');
    expect(shown({ ...e!, actor: ANN }, ADA, ANN).by).toBe('the person you work for');
    expect(shown({ ...e!, actor: null }, ADA, ANN).by).toBe('the platform');
    expect(String(shown({ ...e!, data: { body: 'x'.repeat(5000) } }, ADA, ANN).data)).toHaveLength(2001);
  });
});
