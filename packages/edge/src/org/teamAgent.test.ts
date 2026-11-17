// Setup (docs/specs/onboarding.md): a person's place in it, and the team agent (Omni) joining every public channel, now
// and as new ones are made. Run through the Org object itself, over node:sqlite.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgStorage } from '../../test/orgStorage';
import { Org } from './object';
import { withDb, schema, type DB } from './db/index';
import { createWorkspace } from './services/workspaces';
import { createChannel } from './services/channels';

const ANN = '00000000-0000-7000-8000-00000000000a'; // owner, Ada's sponsor
const ADA = '00000000-0000-7000-8000-00000000000e'; // Ann's assistant (a hosted personal agent)
const BOT = '00000000-0000-7000-8000-00000000000d'; // a shared agent

beforeAll(() => {
  process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
  (globalThis as Record<string, unknown>).WebSocketRequestResponsePair ??= class { constructor(public a: string, public b: string) {} };
});

let org: Org;
let db: DB;
let workspaceId: string;
let pending: Promise<unknown>[];

beforeEach(async () => {
  pending = [];
  const made = orgStorage({ bare: true });
  const store = new Map<string, unknown>();
  const storage = { ...made.storage, get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => { store.set(k, v); }, delete: async (k: string) => store.delete(k), setAlarm: async () => {}, deleteAlarm: async () => {} };
  const ctx = { storage, getWebSockets: () => [], acceptWebSocket: () => {}, setWebSocketAutoResponse: () => {}, blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(), waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const env = { DIRECTORY: { idFromName: () => 'd', get: () => ({ call: async (name: string) => (name === 'applyOrgChanges' ? { ok: true, value: null } : { ok: false, status: 500, code: 'stub', message: 'stub' }) }) }, ASSISTANT: {} };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  org = new Org(ctx as never, env as never);
  db = (org as unknown as { db: DB }).db;
  await withDb(db, async () => {
    db.insert(schema.users).values({ id: ANN, email: 'ann@x.test', passwordHash: '!', displayName: 'Ann Lee' }).run();
    db.insert(schema.users).values({ id: ADA, email: 'ada@agents.test', passwordHash: '!', displayName: 'Ada', isAgent: true }).run();
    db.insert(schema.users).values({ id: BOT, email: 'bot@agents.test', passwordHash: '!', displayName: 'Helper', isAgent: true }).run();
    workspaceId = (await createWorkspace(ANN, 'Locked In', 'locked-in')).id;
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: ADA, role: 'member', kind: 'personal_agent', runtime: 'hosted', sponsorUserId: ANN }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: BOT, role: 'member' }).run();
  });
});
afterEach(async () => {
  await Promise.allSettled(pending);
  vi.restoreAllMocks();
});


const sql = () => (org as unknown as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage.sql;
const isIn = (channelId: string, userId: string) => sql().exec('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?', channelId, userId).toArray().length > 0;
const newChannel = (name: string, isPrivate = false) => withDb(db, () => createChannel(workspaceId, ANN, name, undefined, isPrivate));

describe('setup', () => {
  it('is not pending for a person never marked, and moves on and ends when asked', async () => {
    expect(await org.setupOf(ANN)).toBeNull();
    expect(await org.saveSetup(ANN, { step: 3 })).toEqual({ pending: true, step: 3 });
    expect(await org.saveSetup(ANN, { done: true })).toEqual({ pending: false, step: 3 });
    expect(await org.setupOf(ANN)).toEqual({ pending: false, step: 3 });
  });
});

describe('the team agent', () => {
  it('joins every public channel there is, never a private one', async () => {
    const open = await newChannel('design');
    const closed = await newChannel('secret', true);
    await org.markTeamAgent(BOT);
    expect(await org.teamAgentId()).toBe(BOT);
    expect(isIn(open.id, BOT)).toBe(true);
    expect(isIn(closed.id, BOT)).toBe(false);
  });

  it('joins a public channel made after it was added', async () => {
    await org.markTeamAgent(BOT);
    const later = await newChannel('launch');
    await (org as unknown as { joinTeamAgent(id: string): Promise<void> }).joinTeamAgent(later.id);
    expect(isIn(later.id, BOT)).toBe(true);
  });

  it('is forgotten once it is no longer a member', async () => {
    await org.markTeamAgent(BOT);
    sql().exec('DELETE FROM workspace_members WHERE user_id = ?', BOT);
    expect(await org.teamAgentId()).toBeNull();
  });
});
