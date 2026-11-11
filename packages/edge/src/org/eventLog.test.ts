// The Org object's half of the event bus (platform.md §5.2): every socket event a service publishes, but presence and
// typing, reaches the event log as `chat.<type>` with the acting member's account and the audience the sockets get.
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDTO, Event } from '@flow/shared';
import { orgStorage } from '../../test/orgStorage';
import type { PublishInput } from '../events/core';
import { withPublisher } from './bus';
import { withDb, schema, type DB } from './db/index';
import { directoryLink } from './directoryLink';
import { agentStampFor, logEntryFor } from './eventLog';
import { createChannel } from './services/channels';
import { sendMessage } from './services/messages';
import { addReaction } from './services/reactions';
import { accountForJoin, createWorkspace, enrollInWorkspace } from './services/workspaces';

const ANN = '00000000-0000-7000-8000-00000000000a';
const BOB = '00000000-0000-7000-8000-00000000000b';

beforeAll(() => { process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64'); });

let db: DB;
let sqlite: DatabaseSync;
let workspaceId: string;
let general: string;
/** What the Org object would hand the Events object: the publisher maps each event as `Org.broadcast` does. */
let logged: PublishInput[];

const sql = { exec: (q: string, ...args: unknown[]) => { const s = sqlite.prepare(q); return { toArray: () => s.all(...(args as never[])) as Record<string, unknown>[] }; } };

const run = <T>(fn: () => Promise<T>) => directoryLink.run({
  ensureAccount: async (organizationId, userId, role, displayName) =>
    ({ id: `acct-${userId.slice(-1)}`, principalId: userId, organizationId, address: `${displayName.toLowerCase()}@acme.freeflow.im`, displayName, role, kind: 'native', state: 'active', createdAt: '' }) satisfies AccountDTO,
}, () => withPublisher((subject: string, event: Event) => {
  const entry = logEntryFor(sql, subject, event);
  if (entry) logged.push(entry);
}, () => withDb(db, fn)));

beforeEach(async () => {
  ({ db, sqlite } = orgStorage());
  logged = [];
  await run(async () => {
    for (const [id, name] of [[ANN, 'Ann'], [BOB, 'Bob']]) db.insert(schema.users).values({ id, email: `${name}@x.test`, passwordHash: '!', displayName: name }).run();
    workspaceId = (await createWorkspace(ANN, 'Acme', 'acme')).id;
    const account = await accountForJoin(workspaceId, BOB);
    await db.transaction((tx) => enrollInWorkspace(tx, workspaceId, BOB, 'member', undefined, account));
    general = db.select().from(schema.channels).get()!.id;
  });
  logged = [];
});

describe('the event log from the Org object', () => {
  it('logs a message as chat.message.created, by the sender\'s account, for the whole organization', async () => {
    const msg = await run(() => sendMessage(general, BOB, crypto.randomUUID(), 'hello everyone'));
    const created = logged.find((e) => e.type === 'chat.message.created')!;
    expect(created).toMatchObject({ organizationId: workspaceId, actor: 'acct-b', channelId: general, audience: 'org' });
    expect((created.data as { id: string }).id).toBe(msg.id);
    expect(logged.every((e) => e.type.startsWith('chat.'))).toBe(true);
  });

  it('gives a private channel\'s events to its members, and a reaction its reactor', async () => {
    const secret = await run(() => createChannel(workspaceId, ANN, 'secret', undefined, true));
    logged = [];
    const msg = await run(() => sendMessage(secret.id, ANN, crypto.randomUUID(), 'just us'));
    await run(() => addReaction(msg.id, ANN, ':+1:'));
    expect(logged.map((e) => [e.type, e.audience, e.actor])).toEqual(expect.arrayContaining([
      ['chat.message.created', `channel:${secret.id}`, 'acct-a'],
      ['chat.reaction.added', `channel:${secret.id}`, 'acct-a'],
    ]));
    expect(logged.every((e) => e.audience === `channel:${secret.id}` || e.audience.startsWith('account:'))).toBe(true);
  });

  it('never logs presence or typing; sends a user\'s own subject to that account, or not at all when it is unknown', () => {
    const at = new Date().toISOString();
    expect(logEntryFor(sql, `ws.${workspaceId}.presence`, { type: 'presence', workspaceId, ts: at, data: { userId: ANN, status: 'online' } })).toBeNull();
    expect(logEntryFor(sql, `ws.${workspaceId}.chan.${general}.typing`, { type: 'typing', workspaceId, channelId: general, ts: at, data: { userId: ANN, channelId: general } })).toBeNull();
    expect(logEntryFor(sql, `user.${BOB}.notify`, { type: 'notification.read', workspaceId, ts: at, data: { ids: [] } })).toMatchObject({ type: 'chat.notification.read', audience: 'account:acct-b', actor: null });
    sqlite.prepare('UPDATE workspace_members SET account_id = NULL WHERE user_id = ?').run(BOB);
    expect(logEntryFor(sql, `user.${BOB}.notify`, { type: 'notification.read', workspaceId, ts: at, data: { ids: [] } })).toBeNull();
  });

  it('stamps an agent\'s turn with who asked, only when the agent names a member other than itself; carries via as resolved (agents.md §3)', () => {
    const omni = { user: { isAgent: true }, account: { id: 'acct-omni' } };
    expect(agentStampFor(sql, workspaceId, { ...omni, invokedBy: 'acct-a' })).toEqual({ invokedBy: 'acct-a' });
    // Not a member here, itself, a person claiming it, or no claim: nothing.
    expect(agentStampFor(sql, workspaceId, { ...omni, invokedBy: 'acct-stranger' })).toEqual({});
    expect(agentStampFor(sql, workspaceId, { ...omni, invokedBy: 'acct-omni' })).toEqual({});
    expect(agentStampFor(sql, workspaceId, { user: { isAgent: false }, account: { id: 'acct-a' }, invokedBy: 'acct-b' })).toEqual({});
    expect(agentStampFor(sql, workspaceId, omni)).toEqual({});
    // A personal agent acting as Ann: the Worker resolved it from the delegation, so it is taken as given.
    expect(agentStampFor(sql, workspaceId, { user: { isAgent: false }, account: { id: 'acct-a' }, via: 'agent-1' })).toEqual({ via: 'agent-1' });
  });
});
