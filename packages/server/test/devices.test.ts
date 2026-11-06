// APNs device-token registry (#245): the two endpoints that keep the token list
// current. Nothing sends a push yet — what is worth testing here is the rebind
// (a phone that changes hands) and that a deleted account's tokens go with it.
// DB-backed — runs against a scratch database on the dev postgres (docker
// compose in packages/infra, host port 5442). NATS is not required
// (publishEvent no-ops without a bus).
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_URL = process.env.FLOW_TEST_DATABASE_URL
  ?? 'postgres://flow:flow_dev@localhost:5442/flow_devices_test';
process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');

// self-sufficient: create the scratch database if it doesn't exist yet
{
  const { default: postgres } = await import('postgres');
  const url = new URL(process.env.DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`).catch(() => {}); // 42P04 duplicate_database
  await admin.end();
}

// dynamic imports so the env above is set before config/db read it
const { migrate } = await import('../src/db/migrate.js');
const { db, schema, closeDb } = await import('../src/db/index.js');
const { buildApp } = await import('../src/app.js');
const auth = await import('../src/services/auth.js');
const { deleteMyAccount } = await import('../src/services/accountDeletion.js');
const { eq } = await import('drizzle-orm');

const { deviceTokens, users } = schema;

const TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);

let aliceId = '';
let bobId = '';
let aliceToken = '';
let bobToken = '';

const register = (sessionToken: string, body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/v1/me/devices',
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: body,
  });

const unregister = (sessionToken: string, deviceToken: string) =>
  app.inject({
    method: 'DELETE',
    url: `/v1/me/devices/${deviceToken}`,
    headers: { authorization: `Bearer ${sessionToken}` },
  });

const body = (token = TOKEN) => ({
  token,
  platform: 'ios',
  environment: 'sandbox',
  bundleId: 'im.freeflow.app',
});

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!);
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await db.execute(`TRUNCATE users, workspaces, channels, messages RESTART IDENTITY CASCADE` as never);
  const alice = await auth.register('alice@example.test', {
    password: 'password123',
    displayName: 'Alice',
    autoVerify: true,
  });
  const bob = await auth.register('bob@example.test', {
    password: 'password123',
    displayName: 'Bob',
    autoVerify: true,
  });
  if (!('token' in alice) || !('token' in bob)) throw new Error('expected autoVerify sessions');
  aliceId = alice.user.id;
  bobId = bob.user.id;
  aliceToken = alice.token;
  bobToken = bob.token;
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('POST /v1/me/devices', () => {
  it('registers a device and rejects an anonymous caller', async () => {
    const anon = await app.inject({ method: 'POST', url: '/v1/me/devices', payload: body() });
    expect(anon.statusCode).toBe(401);

    const res = await register(aliceToken, body());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const rows = await db.select().from(deviceTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(aliceId);
    expect(rows[0]!.token).toBe(TOKEN);
    expect(rows[0]!.platform).toBe('ios');
    expect(rows[0]!.environment).toBe('sandbox');
    expect(rows[0]!.bundleId).toBe('im.freeflow.app');
    expect(rows[0]!.disabledAt).toBeNull();
  });

  it('is idempotent across cold starts: same row, touched last_seen_at', async () => {
    await register(aliceToken, body());
    const [first] = await db.select().from(deviceTokens);

    await new Promise((r) => setTimeout(r, 10));
    await register(aliceToken, body());

    const rows = await db.select().from(deviceTokens);
    expect(rows).toHaveLength(1); // not a second row per launch
    expect(rows[0]!.id).toBe(first!.id);
    expect(rows[0]!.createdAt.getTime()).toBe(first!.createdAt.getTime());
    expect(rows[0]!.lastSeenAt.getTime()).toBeGreaterThan(first!.lastSeenAt.getTime());
  });

  // The point of the global unique constraint: a phone handed to someone else
  // must move to its new owner, not end up pushing to both accounts.
  it('rebinds a token that changes hands instead of duplicating it', async () => {
    await register(aliceToken, body());
    const [before] = await db.select().from(deviceTokens);

    const res = await register(bobToken, { ...body(), environment: 'production' });
    expect(res.statusCode).toBe(200);

    const rows = await db.select().from(deviceTokens);
    expect(rows).toHaveLength(1); // one phone, one row
    expect(rows[0]!.id).toBe(before!.id);
    expect(rows[0]!.userId).toBe(bobId); // new owner
    expect(rows[0]!.environment).toBe('production'); // descriptors refreshed too
    // and nothing is left pointing at the previous owner
    expect(await db.select().from(deviceTokens).where(eq(deviceTokens.userId, aliceId))).toHaveLength(0);
  });

  it('revives a token APNs had 410d when the device asks for it back', async () => {
    await register(aliceToken, body());
    await db.update(deviceTokens).set({ disabledAt: new Date() }).where(eq(deviceTokens.token, TOKEN));

    await register(aliceToken, body());

    const rows = await db.select().from(deviceTokens);
    expect(rows[0]!.disabledAt).toBeNull();
  });

  it('treats a token as case-insensitive rather than storing it twice', async () => {
    await register(aliceToken, body(TOKEN.toUpperCase()));
    await register(aliceToken, body(TOKEN));

    const rows = await db.select().from(deviceTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).toBe(TOKEN); // stored lowercased
  });

  it('rejects a malformed body', async () => {
    for (const bad of [
      { ...body(), token: 'not-hex' },
      { ...body(), platform: 'android' }, // android with the APNs-only fields (ANDROID.md phase 3)
      { ...body(), environment: 'staging' },
      { ...body(), bundleId: '' },
      { platform: 'ios', environment: 'sandbox', bundleId: 'im.freeflow.app' }, // no token
    ]) {
      const res = await register(aliceToken, bad);
      expect(res.statusCode).toBe(400);
    }
    expect(await db.select().from(deviceTokens)).toHaveLength(0);
  });
});

describe('DELETE /v1/me/devices/:token', () => {
  it('unregisters the caller’s own device', async () => {
    await register(aliceToken, body());

    const res = await unregister(aliceToken, TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await db.select().from(deviceTokens)).toHaveLength(0);
  });

  // Sign-out fires this and then throws the session away; a client that hits a
  // 404 or a 500 on the way out has nothing useful to do about it.
  it('is idempotent and needs auth', async () => {
    expect((await unregister(aliceToken, TOKEN)).statusCode).toBe(200); // never registered
    expect((await app.inject({ method: 'DELETE', url: `/v1/me/devices/${TOKEN}` })).statusCode).toBe(401);
    expect((await unregister(aliceToken, 'not-hex')).statusCode).toBe(400);
  });

  it('will not let one user unregister another user’s device', async () => {
    await register(aliceToken, body());

    const res = await unregister(bobToken, TOKEN);
    expect(res.statusCode).toBe(200); // nothing to tell Bob about Alice
    expect(await db.select().from(deviceTokens)).toHaveLength(1); // but Alice keeps her phone
  });
});

// Android joins the registry (ANDROID.md phase 3): an FCM token is opaque and
// case-sensitive, and the APNs-only columns are absent.
describe('android devices', () => {
  const FCM = 'dXyZ_9:APA91bFakeTokenWithMixedCase-and_underscores0123456789';

  it('registers with just a token and platform, stored exactly as sent', async () => {
    const res = await register(aliceToken, { token: FCM, platform: 'android' });
    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(deviceTokens).where(eq(deviceTokens.token, FCM));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: aliceId, platform: 'android', environment: null, bundleId: null });
  });

  it('still insists on the APNs fields for ios', async () => {
    const res = await register(aliceToken, { token: TOKEN, platform: 'ios' });
    expect(res.statusCode).toBe(400);
    const bad = await register(aliceToken, { token: FCM, platform: 'ios', environment: 'sandbox', bundleId: 'im.freeflow.app' });
    expect(bad.statusCode).toBe(400); // an FCM-shaped token is not an APNs token
  });

  it('unregisters the exact token', async () => {
    await register(bobToken, { token: FCM + '-bob', platform: 'android' });
    const res = await unregister(bobToken, encodeURIComponent(FCM + '-bob'));
    expect(res.statusCode).toBe(200);
    expect(await db.select().from(deviceTokens).where(eq(deviceTokens.token, FCM + '-bob'))).toHaveLength(0);
  });
});

describe('account lifecycle', () => {
  // The FK cascade alone does not cover this: DELETE /v1/me tombstones the user
  // (row kept for message authorship), so nothing is ever deleted from `users`
  // and ON DELETE CASCADE never fires. tombstoneUser drops the tokens instead.
  it('drops device tokens when the account is deleted', async () => {
    await register(aliceToken, body());
    await register(bobToken, body(OTHER_TOKEN));

    await deleteMyAccount(aliceId);

    const rows = await db.select().from(deviceTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(bobId); // only Alice's went
  });

  it('cascades on a genuine row delete', async () => {
    await register(aliceToken, body());
    await db.delete(users).where(eq(users.id, aliceId));
    expect(await db.select().from(deviceTokens)).toHaveLength(0);
  });
});
