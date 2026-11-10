// The Workspace app (packages/docs) hosted in this server (src/docs.ts; docs/specs/freeflow-suite.md §2):
// one session for both, as a bearer or the `sid` cookie; its routes under /api, its client under /docs.
// DB-backed — runs against a scratch database on the dev postgres (docker compose in packages/infra, host
// port 5442), with the Workspace app's own SQLite in a temporary directory.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = process.env.FLOW_TEST_DATABASE_URL
  ?? 'postgres://flow:flow_dev@localhost:5442/flow_workspace_test';
process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-workspace-'));
process.env.WORKSPACE_DATA_DIR = path.join(tmp, 'data');
process.env.WORKSPACE_STATIC_DIR = path.join(tmp, 'client');
process.env.WORKSPACE_LEGACY_HOSTS = 'mcpdocs.example.test, docs.example.test';
fs.mkdirSync(process.env.WORKSPACE_STATIC_DIR);
fs.writeFileSync(path.join(process.env.WORKSPACE_STATIC_DIR, 'index.html'), '<!doctype html><title>Workspace</title>');

{
  const { default: postgres } = await import('postgres');
  const url = new URL(process.env.DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`).catch(() => {});
  await admin.end();
}

const { migrate } = await import('../src/db/migrate.js');
const { db, closeDb } = await import('../src/db/index.js');
const { buildApp } = await import('../src/app.js');
const auth = await import('../src/services/auth.js');

let app: ReturnType<typeof buildApp>;
let aliceId = '';
let aliceToken = '';

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!);
  app = buildApp();
  await app.ready();
  await db.execute(`TRUNCATE users, workspaces, channels, messages RESTART IDENTITY CASCADE` as never);
  const alice = await auth.register('alice@example.test', { password: 'password123', displayName: 'Alice', autoVerify: true });
  if (!('token' in alice)) throw new Error('expected an autoVerify session');
  aliceId = alice.user.id;
  aliceToken = alice.token;
});

afterAll(async () => {
  await app.close();
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const cookie = (token: string) => ({ cookie: `sid=${token}` });
const setCookie = (res: { headers: Record<string, unknown> }): string => {
  const h = res.headers['set-cookie'];
  const first = Array.isArray(h) ? h[0] : h;
  if (typeof first !== 'string') throw new Error('no set-cookie header');
  return first;
};

describe('the session as a cookie', () => {
  it('a sign-in sets the session as an httpOnly cookie beside the bearer', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'alice@example.test', password: 'password123' } });
    expect(res.statusCode).toBe(200);
    const token = res.json().token as string;
    const c = setCookie(res);
    expect(c.startsWith(`sid=${token};`)).toBe(true);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
    expect(c).toMatch(/Path=\//);
  });

  it("the cookie authenticates this server's own routes too", async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: cookie(aliceToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(aliceId);
    const anon = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(anon.statusCode).toBe(401);
  });

  it('a client holding only the bearer can have its session set as the cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/session-cookie', headers: bearer(aliceToken) });
    expect(res.statusCode).toBe(200);
    expect(setCookie(res).startsWith(`sid=${aliceToken};`)).toBe(true);
    const anon = await app.inject({ method: 'POST', url: '/v1/auth/session-cookie' });
    expect(anon.statusCode).toBe(401);
  });

  it('signing out clears the cookie and ends the session', async () => {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'alice@example.test', password: 'password123' } });
    const token = login.json().token as string;
    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: cookie(token) });
    expect(out.statusCode).toBe(200);
    expect(setCookie(out)).toMatch(/^sid=;/);
    const after = await app.inject({ method: 'GET', url: '/v1/me', headers: cookie(token) });
    expect(after.statusCode).toBe(401);
  });
});

describe('the Workspace app', () => {
  it('knows the signed-in user, by cookie or bearer, and says it is in the suite', async () => {
    for (const headers of [cookie(aliceToken), bearer(aliceToken)]) {
      const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ user: { id: aliceId, email: 'alice@example.test' }, googleLogin: false, suite: { basePath: '/docs' } });
    }
    const anon = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anon.json().user).toBeNull();
    const stale = await app.inject({ method: 'GET', url: '/api/auth/me', headers: cookie('not-a-session') });
    expect(stale.json().user).toBeNull();
  });

  it("creates files for this server's users (mirrored into its own database)", async () => {
    const created = await app.inject({ method: 'POST', url: '/api/sheets', headers: cookie(aliceToken), payload: { title: 'Budget' } });
    expect(created.statusCode).toBe(200);
    expect(created.json().sheet.title).toBe('Budget');
    const list = await app.inject({ method: 'GET', url: '/api/sheets', headers: bearer(aliceToken) });
    expect(list.json().sheets.map((s: { title: string }) => s.title)).toEqual(['Budget']);
    const anon = await app.inject({ method: 'POST', url: '/api/sheets', payload: { title: 'Nope' } });
    expect(anon.statusCode).toBe(401);
  });

  it('its own sign-in routes are gone: the suite signs in', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'alice@example.test', password: 'password123' } });
    expect(res.statusCode).toBe(404);
  });

  it('signing out of the Workspace app signs out of the suite', async () => {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'alice@example.test', password: 'password123' } });
    const token = login.json().token as string;
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: cookie(token) });
    expect(out.statusCode).toBe(200);
    expect(setCookie(out)).toMatch(/^sid=;/);
    const after = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
    expect(after.statusCode).toBe(401);
  });

  it('serves its client under /docs, sending a visitor to the suite sign-in first', async () => {
    const visitor = await app.inject({ method: 'GET', url: '/docs' });
    expect(visitor.statusCode).toBe(302);
    expect(visitor.headers.location).toBe('/?next=%2Fdocs');
    const home = await app.inject({ method: 'GET', url: '/docs', headers: cookie(aliceToken) });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('<title>Workspace</title>');
    const deep = await app.inject({ method: 'GET', url: '/docs/sheet/abc' });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers['content-type']).toMatch(/text\/html/);
    const shared = await app.inject({ method: 'GET', url: '/docs/p/secret' });
    expect(shared.headers['x-robots-tag']).toBe('noindex');
    const old = await app.inject({ method: 'GET', url: '/p/secret' });
    expect(old.statusCode).toBe(301);
    expect(old.headers.location).toBe('/docs/p/secret');
    // Its base path until 2026-11-10.
    const moved = await app.inject({ method: 'GET', url: '/workspace/s/abc?x=1' });
    expect(moved.statusCode).toBe(301);
    expect(moved.headers.location).toBe('/docs/s/abc?x=1');
    expect((await app.inject({ method: 'GET', url: '/workspace' })).headers.location).toBe('/docs');
  });

  it("sends pages asked for on the app's old host names to /docs on the suite's host", async () => {
    const home = await app.inject({ method: 'GET', url: '/', headers: { host: 'mcpdocs.example.test' } });
    expect(home.statusCode).toBe(301);
    expect(home.headers.location).toMatch(/\/docs$/);
    const file = await app.inject({ method: 'GET', url: '/s/abc?x=1', headers: { host: 'docs.example.test:443' } });
    expect(file.statusCode).toBe(301);
    expect(file.headers.location).toMatch(/\/docs\/s\/abc\?x=1$/);
    // The plugin's paths and the API are not redirected (served or answered on that host as they are).
    const mcp = await app.inject({ method: 'GET', url: '/mcp', headers: { host: 'docs.example.test' } });
    expect(mcp.statusCode).not.toBe(301);
    const api = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { host: 'docs.example.test' } });
    expect(api.statusCode).toBe(200);
    // The suite's own host is untouched.
    const own = await app.inject({ method: 'GET', url: '/', headers: { host: 'localhost' } });
    expect(own.statusCode).not.toBe(301);
  });

  it('leaves the Chat API as it was: unknown /api and /v1 paths are JSON 404s', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nothing', headers: bearer(aliceToken) });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });
});

describe('imported Workspace accounts', () => {
  it('signs in with the scrypt hash the Workspace app stored, and replaces it with argon2', async () => {
    const { scryptSync, randomBytes } = await import('node:crypto');
    const { schema } = await import('../src/db/index.js');
    const { eq } = await import('drizzle-orm');
    const salt = randomBytes(16);
    const hash = scryptSync('old-password', salt, 64, { N: 16384, r: 8, p: 1 });
    const stored = ['scrypt', 16384, 8, 1, salt.toString('base64'), hash.toString('base64')].join('$');
    const [carol] = await db.insert(schema.users).values({ id: '11111111-2222-4333-8444-555555555555', email: 'carol@example.test', passwordHash: stored, displayName: 'carol', emailVerifiedAt: new Date() }).returning();
    const wrong = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'carol@example.test', password: 'other' } });
    expect(wrong.statusCode).toBe(401);
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'carol@example.test', password: 'old-password' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(carol!.id);
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, carol!.id));
    expect(after!.passwordHash.startsWith('$argon2')).toBe(true);
    const again = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'carol@example.test', password: 'old-password' } });
    expect(again.statusCode).toBe(200);
  });
});

// Phase 4 (docs/specs/freeflow-suite.md §2.4, ruled 2026-11-02): the Workspace app's files belong to an organization,
// shared with its members (Organization files) or private to their owner there (My files).
describe('organization files', () => {
  let harbor = '';
  let other = '';
  let bobToken = '';
  let daveToken = '';

  beforeAll(async () => {
    const workspaces = await import('../src/services/workspaces.js');
    const { db: database } = await import('../src/db/index.js');
    const bob = await auth.register('bob@example.test', { password: 'password123', displayName: 'Bob', autoVerify: true });
    const dave = await auth.register('dave@example.test', { password: 'password123', displayName: 'Dave', autoVerify: true });
    if (!('token' in bob) || !('token' in dave)) throw new Error('expected autoVerify sessions');
    bobToken = bob.token;
    daveToken = dave.token;
    harbor = (await workspaces.createWorkspace(aliceId, 'Harbor & Pine', `harbor-${Date.now()}`)).id;
    other = (await workspaces.createWorkspace(aliceId, 'Other Co', `other-${Date.now()}`)).id;
    await database.transaction((tx) => workspaces.enrollInWorkspace(tx, harbor, bob.user.id));
  });

  const titles = (res: { json(): unknown }) => ((res.json() as { docs: { title: string }[] }).docs ?? []).map((d) => d.title).sort();

  it('a member lists and opens an organization file; a non-member gets a 404, and a 403 for the list', async () => {
    const made = await app.inject({ method: 'POST', url: '/api/docs', headers: cookie(aliceToken), payload: { title: 'Team plan', workspace: harbor, shared: true } });
    expect(made.statusCode).toBe(200);
    expect(made.json().doc).toMatchObject({ workspaceId: harbor, shared: true });
    const id = made.json().doc.id as string;
    const listed = await app.inject({ method: 'GET', url: `/api/library?workspace=${harbor}&shared=1`, headers: cookie(bobToken) });
    expect(titles(listed)).toEqual(['Team plan']);
    const opened = await app.inject({ method: 'GET', url: `/api/docs/${id}`, headers: cookie(bobToken) });
    expect(opened.statusCode).toBe(200);
    const saved = await app.inject({ method: 'PUT', url: `/api/docs/${id}`, headers: cookie(bobToken), payload: { doc: opened.json().doc } });
    expect(saved.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/docs/${id}`, headers: cookie(daveToken) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/library?workspace=${harbor}&shared=1`, headers: cookie(daveToken) })).statusCode).toBe(403);
  });

  it('a new file is private to its maker in the organization, unless made in Organization files', async () => {
    const mine = await app.inject({ method: 'POST', url: '/api/docs', headers: cookie(aliceToken), payload: { title: 'Private notes', workspace: harbor } });
    expect(mine.json().doc).toMatchObject({ workspaceId: harbor });
    expect(mine.json().doc.shared).toBeUndefined();
    const id = mine.json().doc.id as string;
    expect(titles(await app.inject({ method: 'GET', url: `/api/library?workspace=${harbor}`, headers: cookie(aliceToken) }))).toContain('Private notes');
    expect(titles(await app.inject({ method: 'GET', url: `/api/library?workspace=${harbor}&shared=1`, headers: cookie(bobToken) }))).not.toContain('Private notes');
    expect((await app.inject({ method: 'GET', url: `/api/docs/${id}`, headers: cookie(bobToken) })).statusCode).toBe(404);
    // My files are per organization: not in Alice's files of her other organization.
    expect(titles(await app.inject({ method: 'GET', url: `/api/library?workspace=${other}`, headers: cookie(aliceToken) }))).not.toContain('Private notes');
  });

  it('creating in a folder of Organization files lands in the organization', async () => {
    const folder = await app.inject({ method: 'POST', url: '/api/folders', headers: cookie(bobToken), payload: { name: 'Clients', workspace: harbor, shared: true } });
    expect(folder.statusCode).toBe(200);
    const made = await app.inject({ method: 'POST', url: '/api/sheets', headers: cookie(bobToken), payload: { title: 'Pipeline', folder: 'Clients', workspace: harbor, shared: true } });
    expect(made.json().sheet).toMatchObject({ folder: 'Clients', workspaceId: harbor, shared: true });
    const inFolder = await app.inject({ method: 'GET', url: `/api/library?workspace=${harbor}&shared=1&folder=Clients`, headers: cookie(aliceToken) });
    expect(titles(inFolder)).toEqual(['Pipeline']);
    // The folder is the organization's, not in Bob's own files.
    expect((await app.inject({ method: 'GET', url: `/api/library?workspace=${harbor}&folder=Clients`, headers: cookie(bobToken) })).statusCode).toBe(404);
  });

  it('shares a private file with the organization and makes it private again', async () => {
    const made = await app.inject({ method: 'POST', url: '/api/markdown', headers: cookie(aliceToken), payload: { title: 'Draft', text: '# Draft', workspace: harbor } });
    const id = made.json().doc.id as string;
    expect((await app.inject({ method: 'GET', url: `/api/markdown/${id}`, headers: cookie(bobToken) })).statusCode).toBe(404);
    const shared = await app.inject({ method: 'POST', url: `/api/files/${id}/scope`, headers: cookie(aliceToken), payload: { workspace: harbor, shared: true } });
    expect(shared.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/markdown/${id}`, headers: cookie(bobToken) })).statusCode).toBe(200);
    const back = await app.inject({ method: 'POST', url: `/api/files/${id}/scope`, headers: cookie(aliceToken), payload: { workspace: harbor, shared: false } });
    expect(back.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/markdown/${id}`, headers: cookie(bobToken) })).statusCode).toBe(404);
    // Not into an organization the user is not in.
    expect((await app.inject({ method: 'POST', url: `/api/files/${id}/scope`, headers: cookie(bobToken), payload: { workspace: other, shared: true } })).statusCode).toBe(403);
  });

  it('a file from before organizations stays private, in My files of every organization', async () => {
    const legacy = await app.inject({ method: 'POST', url: '/api/docs', headers: cookie(aliceToken), payload: { title: 'Old memo' } });
    expect(legacy.json().doc.workspaceId).toBeUndefined();
    for (const ws of [harbor, other]) expect(titles(await app.inject({ method: 'GET', url: `/api/library?workspace=${ws}`, headers: cookie(aliceToken) }))).toContain('Old memo');
    expect((await app.inject({ method: 'GET', url: `/api/docs/${legacy.json().doc.id}`, headers: cookie(bobToken) })).statusCode).toBe(404);
  });
});
