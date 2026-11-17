// A note from an agent to a person in their DM (Org.agentDmNotice: an email waiting for the person's click; and
// automationNotice): a person's own agent posts only through its sponsor, so its note goes as the assistant's post in the
// DM the person opens; a shared agent posts as itself. Run through the Org object itself, over node:sqlite.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgStorage } from '../../test/orgStorage';
import { Org } from './object';
import { withDb, schema, type DB } from './db/index';
import { createWorkspace } from './services/workspaces';

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

/** Who wrote each message of the DM between the two, oldest first (the bodies are sealed at rest). */
function dmMessages(a: string, b: string): { userId: string }[] {
  const sql = (org as unknown as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage.sql;
  const dm = sql.exec(
    "SELECT c.id FROM channels c WHERE c.kind = 'dm' AND (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id AND m.user_id IN (?, ?)) = 2", a, b,
  ).toArray()[0];
  if (!dm) return [];
  return sql.exec('SELECT user_id, body FROM messages WHERE channel_id = ? ORDER BY created_at', dm.id).toArray().map((r) => ({ userId: r.user_id as string }));
}

describe('an agent’s note in its DM with a person', () => {
  it('posts a personal agent’s note through its sponsor, in their DM', async () => {
    await org.agentDmNotice({ agentUserId: ADA, personUserId: ANN, text: '✉️ I wrote an email for you to approve.' });
    expect(dmMessages(ADA, ANN)).toEqual([{ userId: ADA }]);
  });

  it('posts a shared agent’s note as itself', async () => {
    await org.agentDmNotice({ agentUserId: BOT, personUserId: ANN, text: 'Hello from Helper.' });
    expect(dmMessages(BOT, ANN)).toEqual([{ userId: BOT }]);
  });
});
