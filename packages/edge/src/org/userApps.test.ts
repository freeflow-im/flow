// User apps in the Org object (docs/specs/user-apps.md, phase 1): install and remove, who holds an app's scopes (§5.2),
// the tools offered and a signed tool call (§5), an app's signed events (§5.1) and the screen's door key (§6.2). Run
// through the Org object itself, over node:sqlite, with the app's server and the event log stubbed.
import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { UserAppManifest } from '@flow/shared';
import { orgStorage } from '../../test/orgStorage';
import { Org } from './object';
import { withDb, schema, type DB } from './db/index';
import { createWorkspace } from './services/workspaces';
import { signBody, SIGNATURE_HEADER, verifyBody } from './lib/appSigning';
import { verifyAppToken } from './lib/appToken';
import type { AppHolder } from './services/userApps';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ANN = '00000000-0000-7000-8000-00000000000a'; // owner
const BEN = '00000000-0000-7000-8000-00000000000b'; // member
const GUS = '00000000-0000-7000-8000-00000000000c'; // guest
const BOT = '00000000-0000-7000-8000-00000000000d'; // a shared agent, Builder
const ACCT = { ann: 'acct-ann', ben: 'acct-ben', gus: 'acct-gus', bot: 'acct-bot' };

const ann: AppHolder = { accountId: ACCT.ann, kind: 'native', agentMode: null };
const ben: AppHolder = { accountId: ACCT.ben, kind: 'native', agentMode: null };
const gus: AppHolder = { accountId: ACCT.gus, kind: 'guest', agentMode: null };
const bot: AppHolder = { accountId: ACCT.bot, kind: 'native', agentMode: 'shared' };
const annsAgent: AppHolder = { ...ann, via: 'principal-ann-claude' };

const taskboard = (): UserAppManifest => ({
  name: 'taskboard',
  label: 'Tasks',
  kinds: [{ kind: 'task', label: 'Task' }],
  scopes: [{ id: 'taskboard:read', label: 'See tasks', read: true }, { id: 'taskboard:write', label: 'Change tasks' }],
  tools: [
    { name: 'list_tasks', description: 'Find tasks.', input: { type: 'object' }, scopes: ['taskboard:read'] },
    { name: 'claim_task', description: 'Claim a task.', input: { type: 'object', properties: { id: { type: 'string' } } }, scopes: ['taskboard:write'] },
  ],
  events: ['task.assigned'],
  server: { url: 'https://tasks.example.com/freeflow' },
  ui: { url: 'https://tasks.example.com/' },
});

beforeAll(() => {
  process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
  (globalThis as Record<string, unknown>).WebSocketRequestResponsePair ??= class { constructor(public a: string, public b: string) {} };
});

let org: Org;
let db: DB;
let published: unknown[];

beforeEach(async () => {
  published = [];
  const made = orgStorage({ bare: true });
  const store = new Map<string, unknown>();
  const storage = { ...made.storage, get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => { store.set(k, v); }, delete: async (k: string) => store.delete(k), setAlarm: async () => {}, deleteAlarm: async () => {} };
  const ctx = { storage, getWebSockets: () => [], acceptWebSocket: () => {}, setWebSocketAutoResponse: () => {}, blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(), waitUntil: () => {} };
  const events = { publish: async (e: unknown) => { published.push(e); return { seq: published.length, id: 'x' }; } };
  const env = {
    DIRECTORY: { idFromName: () => 'd', get: () => ({ call: async (name: string) => (name === 'applyOrgChanges' ? { ok: true, value: null } : { ok: false, status: 500, code: 'stub', message: 'stub' }) }) },
    ASSISTANT: {},
    EVENTS: { idFromName: () => 'e', get: () => events },
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  org = new Org(ctx as never, env as never);
  db = (org as unknown as { db: DB }).db;
  await withDb(db, async () => {
    for (const [id, email, isAgent] of [[ANN, 'ann', false], [BEN, 'ben', false], [GUS, 'gus', false], [BOT, 'bot', true]] as const) {
      db.insert(schema.users).values({ id, email: `${email}@x.test`, passwordHash: '!', displayName: email, isAgent }).run();
    }
    const workspaceId = (await createWorkspace(ANN, 'Locked In', 'locked-in')).id;
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: BEN, role: 'member' }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: GUS, role: 'member', kind: 'guest' }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: BOT, role: 'member' }).run();
    for (const [userId, accountId] of [[ANN, ACCT.ann], [BEN, ACCT.ben], [GUS, ACCT.gus], [BOT, ACCT.bot]]) {
      db.update(schema.workspaceMembers).set({ accountId }).where(eq(schema.workspaceMembers.userId, userId)).run();
    }
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const tryInstall = (grants = { members: true, accounts: [] as string[] }) =>
  org.installUserApp({ manifest: taskboard(), manifestUrl: 'https://tasks.example.com/freeflow-app.json', by: ACCT.ann, grants });
const install = async (grants?: { members: boolean; accounts: string[] }) => {
  const a = await tryInstall(grants);
  if (!a.ok) throw new Error(a.message);
  return a.value;
};

describe('installing', () => {
  it('installs once, returns the secret once, and lists the app', async () => {
    const { name, secret } = await install();
    expect(name).toBe('taskboard');
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(await tryInstall()).toMatchObject({ ok: false, status: 409, code: 'app_exists' });
    const [listed] = await org.listUserApps({ ...ben, admin: false });
    expect(listed).toMatchObject({ name: 'taskboard', label: 'Tasks', usable: true, agentsOn: false, serverOrigin: 'https://tasks.example.com', hasScreen: true });
    expect(listed!.grants).toBeUndefined();
    const [forAdmin] = await org.listUserApps({ ...ann, admin: true });
    expect(forAdmin!.grants).toEqual({ 'taskboard:read': ['members'], 'taskboard:write': ['members'] });
  });

  it('refuses a grant to someone who is not a member', async () => {
    expect(await tryInstall({ members: false, accounts: ['acct-nobody'] })).toMatchObject({ ok: false, status: 400 });
  });

  it('removes the app and its grants', async () => {
    await install();
    await org.removeUserApp('taskboard');
    expect(await org.listUserApps({ ...ann, admin: true })).toEqual([]);
    expect(await org.offeredUserAppTools(ben)).toEqual([]);
  });
});

describe('who holds the scopes (§5.2)', () => {
  it('gives every member the scopes, never a guest, and a shared agent only by name', async () => {
    await install();
    expect((await org.offeredUserAppTools(ben)).map((t) => t.name)).toEqual(['taskboard__list_tasks', 'taskboard__claim_task']);
    expect(await org.offeredUserAppTools(gus)).toEqual([]);
    expect(await org.offeredUserAppTools(bot)).toEqual([]);
    await org.setUserAppGrants('taskboard', { members: true, accounts: [ACCT.bot] });
    expect(await org.offeredUserAppTools(bot)).toHaveLength(2);
  });

  it('gives named people only, when not every member', async () => {
    await install({ members: false, accounts: [ACCT.ann] });
    expect(await org.offeredUserAppTools(ann)).toHaveLength(2);
    expect(await org.offeredUserAppTools(ben)).toEqual([]);
  });

  it("gives a person's personal agent nothing until the person turns the app on", async () => {
    await install();
    expect(await org.offeredUserAppTools(annsAgent)).toEqual([]);
    await org.setUserAppAgents('taskboard', ACCT.ann, true);
    expect(await org.offeredUserAppTools(annsAgent)).toHaveLength(2);
    expect((await org.listUserApps({ ...ann, admin: false }))[0]!.agentsOn).toBe(true);
    await org.setUserAppAgents('taskboard', ACCT.ann, false);
    expect(await org.offeredUserAppTools(annsAgent)).toEqual([]);
  });

  it('lets an account see the events of the apps whose read scope it holds', async () => {
    await install();
    expect(await org.readableAppsOf(ACCT.ben)).toEqual(['taskboard']);
    expect(await org.readableAppsOf(ACCT.gus)).toEqual([]);
    expect(await org.readableAppsOf(ACCT.bot)).toEqual([]);
  });
});

describe('a tool call (§5)', () => {
  it('signs the call, says who is calling and returns the result', async () => {
    const { secret } = await install({ members: true, accounts: [ACCT.bot] });
    let sent: { body: string; sig: string | null; url: string } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent = { url, body: init.body as string, sig: new Headers(init.headers).get(SIGNATURE_HEADER) };
      return Response.json({ result: { claimed: true } });
    });
    const answer = await org.callUserAppTool({ organizationId: ORG_ID, toolName: 'taskboard__claim_task', input: { id: 't1' }, holder: bot, userId: BOT, displayName: 'Builder', role: 'member', invokedBy: ACCT.ann });
    vi.unstubAllGlobals();
    expect(answer).toEqual({ ok: true, result: { claimed: true } });
    expect(sent!.url).toBe('https://tasks.example.com/freeflow');
    expect(verifyBody(Buffer.from(secret, 'base64url'), sent!.sig, sent!.body)).toBe(true);
    const body = JSON.parse(sent!.body);
    expect(body).toMatchObject({ v: 1, kind: 'tool', app: 'taskboard', tool: 'claim_task', input: { id: 't1' } });
    expect(body.caller).toMatchObject({ organizationId: ORG_ID, accountId: ACCT.bot, kind: 'shared_agent', invokedBy: ACCT.ann });
    expect(body.caller.scopes.sort()).toEqual(['taskboard:read', 'taskboard:write']);
  });

  it('refuses a caller without the scope, before anything is sent', async () => {
    await install();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const answer = await org.callUserAppTool({ organizationId: ORG_ID, toolName: 'taskboard__claim_task', input: {}, holder: bot, userId: BOT, displayName: 'Builder', role: 'member' });
    vi.unstubAllGlobals();
    expect(answer.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes the app's error on", async () => {
    await install();
    vi.stubGlobal('fetch', async () => Response.json({ error: 'task t9 does not exist' }, { status: 404 }));
    const answer = await org.callUserAppTool({ organizationId: ORG_ID, toolName: 'taskboard__list_tasks', input: {}, holder: ben, userId: BEN, displayName: 'ben', role: 'member' });
    vi.unstubAllGlobals();
    expect(answer).toEqual({ ok: false, error: 'Tasks answered 404: task t9 does not exist' });
  });
});

describe("an app's events (§5.1)", () => {
  const send = (secret: string | null, body: unknown) => {
    const raw = JSON.stringify(body);
    return org.publishUserAppEvent({ organizationId: ORG_ID, name: 'taskboard', body: raw, signature: secret ? signBody(Buffer.from(secret, 'base64url'), raw) : null });
  };

  it('publishes a signed event for the organization, keeping only members in about', async () => {
    const { secret } = await install();
    const r = await send(secret, { type: 'task.assigned', data: { title: 'Fix login' }, ref: { kind: 'task', id: 't1' }, about: [ACCT.bot, 'acct-nobody'] });
    expect(r.ok).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'app.taskboard.task.assigned', organizationId: ORG_ID, actor: null, audience: 'org', data: { title: 'Fix login' },
      ref: { organizationId: ORG_ID, app: 'taskboard', kind: 'task', id: 't1' }, about: [ACCT.bot],
    });
  });

  it('refuses a bad signature, an undeclared type and an undeclared kind', async () => {
    const { secret } = await install();
    expect(await send(null, { type: 'task.assigned' })).toMatchObject({ ok: false, status: 401 });
    expect(await send(randomBytes(32).toString('base64url'), { type: 'task.assigned' })).toMatchObject({ ok: false, status: 401 });
    expect(await send(secret, { type: 'task.deleted' })).toMatchObject({ ok: false, status: 400 });
    expect(await send(secret, { type: 'task.assigned', ref: { kind: 'board', id: 'b1' } })).toMatchObject({ ok: false, status: 400 });
    expect(published).toEqual([]);
  });

  it('refuses a replayed signature from long ago', async () => {
    const { secret } = await install();
    const raw = JSON.stringify({ type: 'task.assigned' });
    const old = signBody(Buffer.from(secret, 'base64url'), raw, new Date(Date.now() - 10 * 60_000));
    expect(await org.publishUserAppEvent({ organizationId: ORG_ID, name: 'taskboard', body: raw, signature: old })).toMatchObject({ ok: false, status: 401 });
  });

  it('stops a rotated secret at once', async () => {
    const { secret } = await install();
    const rotated = await org.rotateUserAppSecret('taskboard');
    const fresh = rotated.ok ? rotated.value : '';
    expect(await send(secret, { type: 'task.assigned' })).toMatchObject({ ok: false, status: 401 });
    expect(await send(fresh, { type: 'task.assigned' })).toMatchObject({ ok: true });
  });
});

describe("the screen's door key (§6.2)", () => {
  it('mints a version 2 token for a viewer who holds a scope, and none for one who does not', async () => {
    const { secret } = await install();
    const screen = await org.userAppScreen({ organizationId: ORG_ID, name: 'taskboard', holder: ben, userId: BEN, displayName: 'ben', isAgent: false });
    const token = new URL(screen!.url).searchParams.get('flow_token')!;
    const payload = verifyAppToken(Buffer.from(secret, 'base64url'), token) as unknown;
    // The server's reference verifier knows version 1 only; check version 2 by hand.
    expect(payload).toBeNull();
    const [json, mac] = token.split('.');
    expect(createHmac('sha256', Buffer.from(secret, 'base64url')).update(Buffer.from(json!, 'base64url')).digest('base64url')).toBe(mac);
    expect(JSON.parse(Buffer.from(json!, 'base64url').toString())).toMatchObject({ v: 2, app: 'taskboard', workspaceId: ORG_ID, userId: BEN, accountId: ACCT.ben });
    expect(await org.userAppScreen({ organizationId: ORG_ID, name: 'taskboard', holder: gus, userId: GUS, displayName: 'gus', isAgent: false })).toBeNull();
  });
});
