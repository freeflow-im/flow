// Chat's and Meet's /mcp tools in the Org object (docs/specs/suite-mcp.md §4, §5): a personal agent reads with its sponsor's reach and
// never a direct message; its first post brings it into Chat as itself (runtime `external`), where every client lists it;
// a shared agent posts as itself where it is a member; a person is no agent. Run through the Org object over node:sqlite.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO } from '@flow/shared';
import { orgStorage } from '../../test/orgStorage';
import { Org } from './object';
import { withDb, schema, type DB } from './db/index';
import { createWorkspace, listMembers } from './services/workspaces';
import { createChannel, joinChannel } from './services/channels';
import { sendMessage } from './services/messages';
import { _resetRateLimitsForTests } from './lib/rateLimit';

const ANN = '00000000-0000-7000-8000-00000000000a'; // owner, the personal agent's sponsor
const BEN = '00000000-0000-7000-8000-00000000000b'; // another member
const AGENT = '00000000-0000-7000-8000-0000000000a1'; // Ann's personal agent on /mcp (Claude Desktop)
const OMNI = '00000000-0000-7000-8000-0000000000c1'; // a shared agent, a native member

beforeAll(() => {
  process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
  (globalThis as Record<string, unknown>).WebSocketRequestResponsePair ??= class { constructor(public a: string, public b: string) {} };
});

let db: DB;
let org: Org;
let pending: Promise<unknown>[];
let workspaceId: string;
let general: string;
let bensPrivate: string;

const agentAccount = (): AccountDTO => ({
  id: 'acc-agent', principalId: AGENT, organizationId: workspaceId, address: null, displayName: 'Claude Desktop', role: 'member',
  kind: 'personal_agent', state: 'active', sponsorId: ANN, agentMode: 'personal', agentRuntime: 'external',
} as unknown as AccountDTO);

beforeEach(async () => {
  _resetRateLimitsForTests();
  pending = [];
  const made = orgStorage({ bare: true });
  const store = new Map<string, unknown>();
  const storage = { ...made.storage, get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => { store.set(k, v); }, delete: async (k: string) => store.delete(k), setAlarm: async () => {}, deleteAlarm: async () => {} };
  const ctx = { storage, getWebSockets: () => [], acceptWebSocket: () => {}, setWebSocketAutoResponse: () => {}, blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(), waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const env = { BLOBS: {}, DIRECTORY: { idFromName: () => 'd', get: () => ({ call: async (name: string) => (name === 'applyOrgChanges' ? { ok: true, value: null } : { ok: false, status: 500, code: 'stub', message: 'stub' }) }) }, ASSISTANT: {} };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  org = new Org(ctx as never, env as never);
  db = (org as unknown as { db: DB }).db;
  await withDb(db, async () => {
    for (const [id, name, agent] of [[ANN, 'Ann Lee', false], [BEN, 'Ben Kim', false], [OMNI, 'Omni', true]] as const) {
      db.insert(schema.users).values({ id, email: `${id}@x.test`, passwordHash: '!', displayName: name, isAgent: agent }).run();
    }
    workspaceId = (await createWorkspace(ANN, 'Locked In', 'locked-in')).id;
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: BEN, role: 'member' }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: OMNI, role: 'member', sponsorUserId: ANN }).run();
    general = (await joinChannel((await createChannel(workspaceId, BEN, 'launch')).id, ANN)).id;
    await joinChannel(general, OMNI);
    await sendMessage(general, BEN, 'c1', 'Ship it Friday.');
    bensPrivate = (await createChannel(workspaceId, BEN, 'bens-secret', undefined, true)).id;
    await sendMessage(bensPrivate, BEN, 'c2', 'Not for Ann.');
  });
});
afterEach(async () => {
  await Promise.allSettled(pending);
  vi.restoreAllMocks();
});

const chat = (tool: string, input: Record<string, unknown> = {}, as = AGENT) =>
  org.mcpChat({ agentUserId: as, agentAccount: as === AGENT ? agentAccount() : null, tool, input }) as Promise<Record<string, unknown>>;
const roster = () => withDb(db, () => listMembers(workspaceId, BEN)).then((ms) => ms.map((m) => m.userId));

describe('Chat at /mcp, as a personal agent', () => {
  it('reads with its sponsor’s reach: their channels and public ones, never a private channel they are not in', async () => {
    const { channels } = await chat('list_channels') as { channels: { id: string; name: string; userIsMember: boolean; agentIsMember: boolean }[] };
    expect(channels.map((c) => c.name)).toContain('launch');
    expect(channels.map((c) => c.name)).not.toContain('bens-secret');
    expect(channels.find((c) => c.id === general)).toMatchObject({ userIsMember: true, agentIsMember: false });
    const read = await chat('read_messages', { channelId: general });
    expect(read).toMatchObject({ channel: 'launch', messages: [expect.objectContaining({ from: 'Ben Kim', text: 'Ship it Friday.' })] });
    await expect(chat('read_messages', { channelId: bensPrivate })).rejects.toThrow(/No such channel/);
  });

  it('is not on Chat’s roster until it posts; then it posts as itself, in a channel its sponsor is in', async () => {
    await chat('list_channels');
    expect(await roster()).not.toContain(AGENT);
    const posted = await chat('send_message', { channelId: general, text: 'Summary: ship Friday.' });
    expect(posted).toMatchObject({ channel: 'launch', joined: true });
    expect(await roster()).toContain(AGENT);
    const read = await chat('read_messages', { channelId: general }) as { messages: { fromId: string; text: string }[] };
    expect(read.messages.at(-1)).toMatchObject({ fromId: AGENT, text: 'Summary: ship Friday.' });
    await expect(chat('send_message', { channelId: bensPrivate, text: 'hi' })).rejects.toThrow();
  });

  it('reacts and makes a channel as its sponsor, with itself in it', async () => {
    const { messages } = await chat('read_messages', { channelId: general }) as { messages: { id: string }[] };
    expect(await chat('react', { messageId: messages[0]!.id, emoji: '👍' })).toEqual({ reacted: '👍' });
    const made = await chat('create_channel', { name: 'agent-notes' }) as { id: string };
    const { channels } = await chat('list_channels') as { channels: { id: string; userIsMember: boolean; agentIsMember: boolean }[] };
    expect(channels.find((c) => c.id === made.id)).toMatchObject({ userIsMember: true, agentIsMember: true });
  });
});

describe('Chat at /mcp, as a shared agent or a person', () => {
  it('a shared agent posts as itself where it is a member', async () => {
    const posted = await chat('send_message', { channelId: general, text: 'Omni here.' }, OMNI);
    expect(posted).toMatchObject({ channel: 'launch' });
    await expect(chat('read_messages', { channelId: bensPrivate }, OMNI)).rejects.toThrow(/No such channel/);
  });

  it('a person is no agent', async () => {
    await expect(org.mcpChat({ agentUserId: BEN, tool: 'list_channels', input: {} })).rejects.toThrow(/cannot use Chat/);
  });
});

describe('Meet at /mcp', () => {
  it('makes a room as the person, with its link and the line for an event, and lists none live', async () => {
    Object.assign(process.env, { RTK_ACCOUNT_ID: 'acct', RTK_APP_ID: 'app', RTK_API_TOKEN: 'secret' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, data: { id: 'rtk-1' } })));
    try {
      const made = await org.mcpMeet({ userId: ANN, tool: 'create_meeting', input: { title: 'Launch review' }, origin: 'https://app.test' }) as { title: string; link: string; event_line: string };
      expect(made.title).toBe('Launch review');
      expect(made.link).toMatch(/^https:\/\/app\.test\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
      expect(made.event_line).toBe(`Join with FreeFlow Meet: ${made.link}`);
      expect(await org.mcpMeet({ userId: ANN, tool: 'list_live_meetings', input: {}, origin: 'https://app.test' })).toEqual({ meetings: [] });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
