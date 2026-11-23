// Signing a hosted app's users in to other services (docs/specs/user-apps.md §6.5), through the Org object over node:sqlite:
// the client set by an admin and never read back, the sign-in's state and PKCE, the callback's code exchange, each
// person's token (refreshed when it runs out), a draft's use of the install's client, and the cleanup on removal.
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { UserAppManifest } from '@flow/shared';
import { orgStorage } from '../../test/orgStorage';
import { Org } from './object';
import { withDb, schema, type DB } from './db/index';
import { createWorkspace } from './services/workspaces';
import { signAppTicket } from './lib/appSigning';
import { organizationOfState } from './services/appOAuth';
import { draftCode } from './services/appDrafts';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ANN = '00000000-0000-7000-8000-00000000000a'; // owner
const BEN = '00000000-0000-7000-8000-00000000000b'; // member
const GUS = '00000000-0000-7000-8000-00000000000c'; // guest
const BOT = '00000000-0000-7000-8000-00000000000d'; // a shared agent
const ACCT = { ann: 'acct-ann', ben: 'acct-ben', gus: 'acct-gus', bot: 'acct-bot' };

const GITHUB = { id: 'github', label: 'GitHub', authorizeUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', scopes: ['read:user', 'repo'] };
const manifest = (): UserAppManifest => ({
  name: 'taskboard', label: 'Tasks',
  scopes: [{ id: 'taskboard:read', label: 'See tasks', read: true }],
  tools: [{ name: 'list_tasks', description: 'Find tasks.', input: { type: 'object' }, scopes: ['taskboard:read'] }],
  server: { hosted: true }, ui: { hosted: true }, egress: ['api.github.com'], oauth: [GITHUB],
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
    APPS_DOMAIN: 'flowtoo.org',
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

let secret: Buffer;
const ticket = (accountId: string, userId: string) => signAppTicket(secret, { app: 'taskboard', org: ORG_ID, accountId, userId, via: null, invokedBy: null });
const call = (op: 'start' | 'status' | 'token' | 'disconnect', accountId = ACCT.ben, userId = BEN) =>
  org.appOAuthForCaller({ organizationId: ORG_ID, name: 'taskboard', ticket: ticket(accountId, userId), op, provider: 'github' });

/** The provider's token endpoint, stubbed: what it was asked, and what it answers. */
function provider(answer: (form: URLSearchParams) => { status?: number; body: string }) {
  const asked: URLSearchParams[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toBe(GITHUB.tokenUrl);
    const form = new URLSearchParams(String((init as RequestInit).body));
    asked.push(form);
    const a = answer(form);
    return new Response(a.body, { status: a.status ?? 200 });
  });
  return asked;
}

async function installApp() {
  await org.recordUserAppUpload({ manifest: manifest(), files: { 'server.js': 10 }, prefix: 'p1/', by: ACCT.ann });
  const r = await org.installUserApp({ source: { name: 'taskboard', version: 1 }, by: ACCT.ann, grants: { members: true, accounts: [] } });
  if (!r.ok) throw new Error(r.message);
  secret = Buffer.from(r.value.secret, 'base64url');
}

/** Starts a sign-in as Ben and comes back as the provider would: the state, and the PKCE challenge it was sent. */
async function signIn(code = 'the-code') {
  const started = await call('start');
  if (!started.ok) throw new Error(started.error);
  const url = new URL((started.value as { url: string }).url);
  const state = url.searchParams.get('state')!;
  return { url, state, done: await org.finishAppOAuth({ state, code, error: null }) };
}

beforeEach(async () => { await installApp(); });

describe('the client', () => {
  it('is set by an admin and never read back', async () => {
    expect(await org.appOAuthClients({ name: 'taskboard' })).toMatchObject({ ok: true, value: { callbackUrl: expect.stringMatching(/\/v1\/apps\/oauth\/callback$/), providers: [{ provider: 'github', label: 'GitHub', set: false, clientId: null }] } });
    expect(await org.setAppOAuthClient({ name: 'taskboard', provider: 'github', clientId: 'Iv1.abc', clientSecret: 'shh-secret', by: ACCT.ann })).toMatchObject({ ok: true });
    const listed = await org.appOAuthClients({ name: 'taskboard' });
    expect(listed).toMatchObject({ ok: true, value: { providers: [{ provider: 'github', set: true, clientId: 'Iv1.abc', inherited: false }] } });
    expect(JSON.stringify(listed)).not.toContain('shh-secret');
    // Kept encrypted.
    const [row] = await withDb(db, () => db.select().from(schema.userAppOAuthClients));
    expect(Buffer.from(row!.secret).toString('utf8')).not.toContain('shh-secret');
  });

  it('refuses a provider the manifest does not declare', async () => {
    expect(await org.setAppOAuthClient({ name: 'taskboard', provider: 'google', clientId: 'x', clientSecret: 'y', by: ACCT.ann })).toMatchObject({ ok: false, status: 400 });
  });

  it('must be set before anyone can sign in', async () => {
    expect(await call('start')).toMatchObject({ ok: false, error: expect.stringMatching(/not set up/) });
  });
});

describe('signing in', () => {
  beforeEach(async () => { await org.setAppOAuthClient({ name: 'taskboard', provider: 'github', clientId: 'Iv1.abc', clientSecret: 'shh-secret', by: ACCT.ann }); });

  it('sends the person to the provider with a state and PKCE, and keeps their token from the callback', async () => {
    const asked = provider(() => ({ body: JSON.stringify({ access_token: 'gho_ben', token_type: 'bearer', scope: 'read:user,repo' }) }));
    const { url, state, done } = await signIn();
    expect(url.origin + url.pathname).toBe(GITHUB.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: 'Iv1.abc', scope: 'read:user repo', code_challenge_method: 'S256' });
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/v1\/apps\/oauth\/callback$/);
    expect(organizationOfState(state)).toBe(ORG_ID);
    expect(done).toMatchObject({ ok: true, label: 'GitHub', provider: 'github', returnOrigin: `https://taskboard--${ORG_ID.replace(/-/g, '')}.flowtoo.org` });
    // The code went with the secret and the verifier, whose hash is the challenge sent.
    const form = asked[0]!;
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_id: 'Iv1.abc', client_secret: 'shh-secret' });
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(await call('status')).toMatchObject({ ok: true, value: { connected: true, scope: 'read:user,repo' } });
    expect(await call('token')).toMatchObject({ ok: true, value: { accessToken: 'gho_ben', tokenType: 'bearer' } });
    // The token is Ben's alone.
    expect(await call('token', ACCT.ann, ANN)).toMatchObject({ ok: true, value: null });
    // A state works once.
    expect(await org.finishAppOAuth({ state, code: 'again', error: null })).toMatchObject({ ok: false });
  });

  it('sends the client in a Basic header and adds the manifest\'s sign-in settings, when it says so', async () => {
    const m = manifest();
    m.oauth = [{ ...GITHUB, tokenAuth: 'basic', authorizeParams: { access_type: 'offline', prompt: 'consent' } }];
    await org.recordUserAppUpload({ manifest: m, files: { 'server.js': 10 }, prefix: 'p2/', by: ACCT.ann });
    expect(await org.updateUserApp({ name: 'taskboard', source: { name: 'taskboard', version: 2 }, by: ACCT.ann, grants: { members: true, accounts: [] } })).toMatchObject({ ok: true });
    let auth: string | null = null;
    let form: URLSearchParams | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      auth = new Headers((init as RequestInit).headers).get('authorization');
      form = new URLSearchParams(String((init as RequestInit).body));
      return Response.json({ access_token: 'tok' });
    });
    const { url, done } = await signIn();
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(done).toMatchObject({ ok: true });
    expect(auth).toBe(`Basic ${Buffer.from('Iv1.abc:shh-secret').toString('base64')}`);
    expect(form!.get('client_secret')).toBeNull();
    expect(form!.get('code')).toBe('the-code');
  });

  it('reads a form-encoded answer (GitHub without Accept)', async () => {
    provider(() => ({ body: 'access_token=gho_form&scope=repo&token_type=bearer' }));
    expect((await signIn()).done).toMatchObject({ ok: true });
    expect(await call('token')).toMatchObject({ ok: true, value: { accessToken: 'gho_form' } });
  });

  it('says why when the provider refuses, or the person declined', async () => {
    provider(() => ({ body: JSON.stringify({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }) }));
    expect((await signIn()).done).toMatchObject({ ok: false, error: expect.stringMatching(/bad_verification_code/) });
    const started = await call('start');
    const state = new URL((started as { value: { url: string } }).value.url).searchParams.get('state')!;
    expect(await org.finishAppOAuth({ state, code: null, error: 'access_denied' })).toMatchObject({ ok: false, error: expect.stringMatching(/did not sign you in/) });
    expect(await call('status')).toMatchObject({ ok: true, value: { connected: false } });
  });

  it('refuses an unknown state and a forged ticket', async () => {
    expect(await org.finishAppOAuth({ state: `${ORG_ID}.${'a'.repeat(32)}`, code: 'x', error: null })).toMatchObject({ ok: false, returnOrigin: null });
    const forged = await org.appOAuthForCaller({ organizationId: ORG_ID, name: 'taskboard', ticket: signAppTicket(randomBytes(32), { app: 'taskboard', org: ORG_ID, accountId: ACCT.ben, userId: BEN, via: null, invokedBy: null }), op: 'token', provider: 'github' });
    expect(forged).toMatchObject({ ok: false, error: expect.stringMatching(/ticket/) });
  });

  it('refreshes a token that ran out, and drops one that cannot be refreshed', async () => {
    let n = 0;
    provider((form) => (form.get('grant_type') === 'refresh_token'
      ? (n++ === 0 ? { body: JSON.stringify({ access_token: 'gho_new', expires_in: 3600 }) } : { status: 400, body: JSON.stringify({ error: 'invalid_grant' }) })
      : { body: JSON.stringify({ access_token: 'gho_old', refresh_token: 'r1', expires_in: 1 }) }));
    await signIn();
    expect(await call('token')).toMatchObject({ ok: true, value: { accessToken: 'gho_new' } });
    // It ran out again, and the provider no longer refreshes it: the person is asked to sign in again.
    await withDb(db, () => db.update(schema.userAppOAuthTokens).set({ expiresAt: Date.now() - 1000 }).run());
    expect(await call('token')).toMatchObject({ ok: true, value: null });
    expect(await call('status')).toMatchObject({ ok: true, value: { connected: false } });
  });

  it('disconnects, and removing the app forgets the client and every token', async () => {
    provider(() => ({ body: JSON.stringify({ access_token: 'gho_ben' }) }));
    await signIn();
    expect(await call('disconnect')).toMatchObject({ ok: true });
    expect(await call('token')).toMatchObject({ ok: true, value: null });
    await signIn();
    expect(await org.removeUserApp('taskboard')).toMatchObject({ ok: true });
    const left = await withDb(db, async () => [...(await db.select().from(schema.userAppOAuthClients)), ...(await db.select().from(schema.userAppOAuthTokens))]);
    expect(left).toEqual([]);
  });
});

describe('a draft', () => {
  const draftManifest = (over: Partial<typeof GITHUB> = {}) => JSON.stringify({ ...manifest(), oauth: [{ ...GITHUB, ...over }] }, null, 2);
  async function draft(text: string) {
    const made = await org.createAppDraft({ name: 'taskboard', label: 'Tasks', author: ACCT.ben });
    if (!made.ok) throw new Error(made.message);
    const w = await org.writeAppDraftFile('taskboard', ACCT.ben, 'freeflow-app.json', text);
    if (!w.ok) throw new Error(w.message);
  }

  it('uses the install\'s client for the same provider, and keeps its tokens apart', async () => {
    await org.setAppOAuthClient({ name: 'taskboard', provider: 'github', clientId: 'Iv1.abc', clientSecret: 'shh-secret', by: ACCT.ann });
    await draft(draftManifest());
    expect(await org.appOAuthClients({ name: 'taskboard', dev: ACCT.ben })).toMatchObject({ ok: true, value: { providers: [{ set: true, inherited: true, clientId: 'Iv1.abc' }] } });
    const d = await withDb(db, () => db.select().from(schema.userAppDrafts).where(eq(schema.userAppDrafts.name, 'taskboard')));
    const code = await withDb(db, () => draftCode('taskboard', ACCT.ben));
    const t = signAppTicket(code.secret, { app: 'taskboard', org: ORG_ID, accountId: ACCT.ben, userId: BEN, via: null, invokedBy: null });
    const started = await org.appOAuthForCaller({ organizationId: ORG_ID, name: 'taskboard', ticket: t, op: 'start', provider: 'github', dev: ACCT.ben });
    expect(started).toMatchObject({ ok: true });
    provider(() => ({ body: JSON.stringify({ access_token: 'gho_dev' }) }));
    const state = new URL((started as { value: { url: string } }).value.url).searchParams.get('state')!;
    expect(await org.finishAppOAuth({ state, code: 'c', error: null })).toMatchObject({ ok: true, returnOrigin: `https://dev-${d[0]!.devHost}--${ORG_ID.replace(/-/g, '')}.flowtoo.org` });
    expect(await org.appOAuthForCaller({ organizationId: ORG_ID, name: 'taskboard', ticket: t, op: 'token', provider: 'github', dev: ACCT.ben })).toMatchObject({ ok: true, value: { accessToken: 'gho_dev' } });
    // The install's own connection is untouched.
    expect(await call('token')).toMatchObject({ ok: true, value: null });
  });

  it('never sends the install\'s secret to a token address the draft changed', async () => {
    await org.setAppOAuthClient({ name: 'taskboard', provider: 'github', clientId: 'Iv1.abc', clientSecret: 'shh-secret', by: ACCT.ann });
    await draft(draftManifest({ tokenUrl: 'https://evil.example.com/token' }));
    expect(await org.appOAuthClients({ name: 'taskboard', dev: ACCT.ben })).toMatchObject({ ok: true, value: { providers: [{ set: false, inherited: false }] } });
  });
});
