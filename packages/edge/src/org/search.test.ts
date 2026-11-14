// Message search in the Org object (services/search.ts, docs/specs/search.md): kept as messages are sent, edited and
// deleted; rebuilt for messages sent before it; filtered by the query and by who may read each message (requireChannelAccess).
import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDTO } from '@flow/shared';
import { parseSearch } from '@flow/shared/search';
import type { DatabaseSync } from 'node:sqlite';
import { orgStorage } from '../../test/orgStorage';
import { withPublisher } from './bus';
import { withDb, schema, type DB } from './db/index';
import { directoryLink } from './directoryLink';
import { createChannel, createDm } from './services/channels';
import { deleteMessage, editMessage, sendMessage } from './services/messages';
import { MESSAGE_TEXT_VERSION, reindexMessages, searchMessages, type MessageSearchOptions } from './services/search';
import { shareEvents } from './services/shares';
import { accountForJoin, createWorkspace, enrollInWorkspace } from './services/workspaces';

const ANN = '00000000-0000-7000-8000-00000000000a';
const BOB = '00000000-0000-7000-8000-00000000000b';
const CAT = '00000000-0000-7000-8000-00000000000c';
const acct = (u: string) => `acct-${u.slice(-1)}`;

beforeAll(() => { process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64'); });

let db: DB;
let sqlite: DatabaseSync;
let ws: string;
const run = <T>(fn: () => Promise<T>) => directoryLink.run({
  ensureAccount: async (organizationId, userId, role, displayName) =>
    ({ id: acct(userId), principalId: userId, organizationId, address: `${displayName.toLowerCase()}@acme.freeflow.im`, displayName, role, kind: 'native', state: 'active', createdAt: '' }) satisfies AccountDTO,
}, () => shareEvents.run(async () => {}, () => withPublisher(() => {}, () => withDb(db, fn))));

const find = (who: string, q: string, opts: MessageSearchOptions = {}) => run(() => searchMessages(ws, who, parseSearch(q), opts));
const bodies = async (who: string, q: string, opts: MessageSearchOptions = {}) => (await find(who, q, opts)).map((h) => h.snippet.replace(/[\u0002\u0003]/g, ''));
const send = (channel: string, who: string, body: string, threadRootId?: string, fileIds?: string[]) =>
  run(() => sendMessage(channel, who, crypto.randomUUID(), body, threadRootId, fileIds));

let pub: string, secret: string, dm: string;
beforeEach(async () => {
  ({ db, sqlite } = orgStorage());
  await run(async () => {
    for (const [id, name] of [[ANN, 'Ann'], [BOB, 'Bob'], [CAT, 'Cat']]) db.insert(schema.users).values({ id, email: `${name.toLowerCase()}@x.test`, passwordHash: '!', displayName: name }).run();
    ws = (await createWorkspace(ANN, 'Acme', 'acme')).id;
    const account = await accountForJoin(ws, BOB);
    await db.transaction((tx) => enrollInWorkspace(tx, ws, BOB, 'member', undefined, account));
    pub = (await createChannel(ws, ANN, 'launch')).id;
    secret = (await createChannel(ws, ANN, 'salaries', undefined, true)).id;
    dm = (await createDm(ws, ANN, [BOB])).id;
  });
});

describe('searchMessages', () => {
  it('finds a message by its words as it is sent, in public channels the reader has not joined, never in private ones', async () => {
    await send(pub, ANN, 'The launch moves to Thursday.');
    await send(secret, ANN, 'Thursday is also payroll day.');
    const hits = await find(BOB, 'thursday');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: 'chat', kind: 'message', title: '#launch', channelId: pub, channelName: 'launch', channelKind: 'standard', authorName: 'Ann', threadRootId: null });
    expect(hits[0]!.snippet).toBe('The launch moves to \u0002Thursday\u0003.');
    expect(hits[0]!.url).toBe(`/chat/?open=message%3A${hits[0]!.id}`);
    expect((await find(ANN, 'thursday')).map((h) => h.channelId).sort()).toEqual([pub, secret].sort());
    // Stemming.
    expect(await bodies(BOB, 'moving')).toEqual(['The launch moves to Thursday.']);
  });

  it('direct messages are their members’ only, and a person’s assistant never searches them', async () => {
    await send(dm, ANN, 'Lunch at noon?');
    expect((await find(BOB, 'lunch'))[0]).toMatchObject({ title: 'Direct message', channelName: null, channelKind: 'dm' });
    expect(await find(BOB, 'lunch', { channelsOnly: true })).toEqual([]);
    // Not a member of the organization at all.
    await expect(find(CAT, 'lunch')).rejects.toThrow();
  });

  it('finds people by name in mentions, and files by name', async () => {
    const file = crypto.randomUUID();
    await run(async () => db.insert(schema.files).values({ id: file, workspaceId: ws, userId: ANN, name: 'q3-forecast.xlsx', mimeType: 'application/vnd.ms-excel', sizeBytes: 10, storageKey: 'k', createdAt: new Date() }).run());
    await send(pub, ANN, `<@${BOB}> can you check this?`, undefined, [file]);
    await send(pub, ANN, 'no file here');
    expect(await bodies(ANN, 'bob')).toEqual(['@Bob can you check this?\nq3-forecast.xlsx']);
    expect((await find(ANN, 'forecast')).length).toBe(1);
    expect((await find(ANN, 'has:attachment')).length).toBe(1);
  });

  it('an edit replaces the words; a delete (tombstone or permanent) removes the message', async () => {
    const m = await send(pub, ANN, 'budget is 10k');
    await run(() => editMessage(m.id, ANN, 'budget is 12k'));
    expect(await bodies(ANN, '10k')).toEqual([]);
    expect(await bodies(ANN, '12k')).toEqual(['budget is 12k']);
    await run(() => deleteMessage(m.id, ANN));
    expect(await find(ANN, 'budget')).toEqual([]);
    const n = await send(pub, ANN, 'budget again');
    await run(() => deleteMessage(n.id, ANN, { hard: true }));
    expect(await find(ANN, 'budget')).toEqual([]);
    expect(sqlite.prepare('SELECT count(*) AS n FROM search_messages').get()).toEqual({ n: 0 });
  });

  it('filters: from, in, dates, links, kinds; and a name or channel that is no one finds nothing', async () => {
    await send(pub, ANN, 'pricing deck ready https://example.com/deck');
    // Bob joins by posting (sendMessage joins a public channel on the first post).
    await send(pub, BOB, 'pricing looks good');
    expect(await bodies(ANN, 'pricing from:bob')).toEqual(['pricing looks good']);
    expect(await bodies(BOB, 'pricing from:me')).toEqual(['pricing looks good']);
    expect(await bodies(ANN, 'pricing from:ann@x.test')).toEqual(['pricing deck ready https://example.com/deck']);
    expect(await find(ANN, 'pricing from:nobody')).toEqual([]);
    expect((await find(ANN, 'pricing in:#launch')).length).toBe(2);
    expect(await find(ANN, 'pricing in:#nowhere')).toEqual([]);
    expect(await find(BOB, 'in:salaries')).toEqual([]);
    expect(await bodies(ANN, 'pricing has:link')).toEqual(['pricing deck ready https://example.com/deck']);
    expect(await find(ANN, 'pricing after:2999-01-01')).toEqual([]);
    expect((await find(ANN, 'pricing before:2999-01-01')).length).toBe(2);
    expect(await find(ANN, 'pricing type:doc')).toEqual([]);
    expect((await find(ANN, 'pricing type:message')).length).toBe(2);
    // Filters alone list newest first.
    expect(await bodies(ANN, 'from:bob')).toEqual(['pricing looks good']);
  });

  it('thread replies are found with their thread; sort=recent puts the newest first', async () => {
    const root = await send(pub, ANN, 'release notes draft');
    await send(pub, ANN, 'release notes final', root.id);
    const recent = await find(ANN, 'release', { sort: 'recent' });
    expect(recent.map((h) => h.threadRootId)).toEqual([root.id, null]);
  });

  it('search as you type, OR, NOT, and FTS5 syntax typed by a person is only words', async () => {
    await send(pub, ANN, 'quarterly roadmap');
    await send(pub, ANN, 'quarterly offsite');
    expect((await find(ANN, 'roadm', { prefixLast: true })).length).toBe(1);
    expect((await find(ANN, 'roadmap OR offsite')).length).toBe(2);
    expect(await bodies(ANN, 'quarterly -offsite')).toEqual(['quarterly roadmap']);
    await expect(find(ANN, 'NEAR(a b) body:x "unclosed')).resolves.toEqual([]);
  });
});

describe('reindexMessages', () => {
  it('indexes a full batch of 200 in one go: Durable Object SQLite binds at most 100 variables per statement', async () => {
    const file = crypto.randomUUID();
    await run(async () => db.insert(schema.files).values({ id: file, workspaceId: ws, userId: ANN, name: 'osprey-count.csv', mimeType: 'text/csv', sizeBytes: 1, storageKey: 'k', createdAt: new Date() }).run());
    await send(pub, ANN, 'osprey with a file', undefined, [file]);
    for (let i = 0; i < 149; i++) await send(pub, ANN, `osprey ${i}`);
    sqlite.exec('DELETE FROM search_messages');
    expect(await run(() => reindexMessages(200))).toBe(150);
    expect((await find(ANN, 'osprey', { limit: 100 })).length).toBe(100);
    expect((await find(ANN, 'count')).length).toBe(1);
  });

  it('indexes messages sent before search, and ones indexed by an older way of taking the words, in batches', async () => {
    for (let i = 0; i < 5; i++) await send(pub, ANN, `heron sighting ${i}`);
    await send(pub, ANN, 'egret');
    sqlite.exec('DELETE FROM search_messages');
    expect(await find(ANN, 'heron')).toEqual([]);
    expect(await run(() => reindexMessages(4))).toBe(4);
    expect(await run(() => reindexMessages(4))).toBe(2);
    expect(await run(() => reindexMessages(4))).toBe(0);
    expect((await find(ANN, 'heron')).length).toBe(5);
    // System lines ("joined the channel") are never indexed, so they are never stale either.
    expect(sqlite.prepare('SELECT count(*) AS n FROM search_messages').get()).toEqual({ n: 6 });

    sqlite.exec(`UPDATE search_messages SET rev = '0:' || substr(rev, ${String(MESSAGE_TEXT_VERSION).length + 2}), body = 'stale'`);
    expect(await find(ANN, 'egret')).toEqual([]);
    expect(await run(() => reindexMessages(10))).toBe(6);
    expect((await find(ANN, 'egret')).length).toBe(1);
  });
});
