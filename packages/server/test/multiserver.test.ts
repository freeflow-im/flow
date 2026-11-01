import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer } from 'node:http';

process.env.DATABASE_URL = process.env.FLOW_TEST_DATABASE_URL ?? 'postgres://flow:flow_dev@localhost:5442/flow_multiserver_test';
process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
process.env.FLOW_WEB_URL = 'https://backend.example';
process.env.FLOW_ALLOWED_WEB_ORIGINS = 'https://client.example';
process.env.FLOW_HANDOFF_RETURN_URLS = 'https://client.example/callback,flow://signin';
{
  const { default: postgres } = await import('postgres');
  const u = new URL(process.env.DATABASE_URL);
  const name = u.pathname.slice(1); u.pathname = '/postgres';
  const admin = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${name}"`).catch(() => {});
  await admin.end();
}
const { migrate } = await import('../src/db/migrate.js');
const { db, schema, closeDb } = await import('../src/db/index.js');
const { buildApp } = await import('../src/app.js');
const auth = await import('../src/services/auth.js');
const { resolveOAuthUser } = await import('../src/services/oauthAccounts.js');
const { routeUpgrade } = await import('../src/gateway/upgrade.js');
const { sendPush, pushSender, _setPushSenderForTests } = await import('../src/push/index.js');
const bus = await import('../src/bus.js');
const app = buildApp();
let token: string;
const origin = 'https://client.example';
const verifier = 'v'.repeat(43);
const context = () => ({ connectionId: 'local-connection', operationId: randomBytes(32).toString('base64url'),
  state: randomBytes(32).toString('base64url'), serverOrigin: 'https://backend.example', clientOrigin: origin as string | null,
  returnUrl: `${origin}/callback` });
const post = (url: string, payload: object, authed = false, from: string | null = origin) => app.inject({ method: 'POST', url, payload,
  headers: { ...(from ? { origin: from } : {}), ...(authed ? { authorization: `Bearer ${token}` } : {}) } });
async function start(ctx = context()) {
  const res = await post('/v1/auth/handoff/start', { ...ctx, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' }, false, ctx.clientOrigin);
  expect(res.statusCode).toBe(201);
  return { ...ctx, requestId: res.json().requestId as string };
}
async function approved(ctx = context()) {
  const body = await start(ctx);
  const res = await post('/v1/auth/handoff/approve', body, true, 'https://backend.example');
  expect(res.statusCode).toBe(200);
  const callback = new URL(res.json().callbackUrl);
  expect([...callback.searchParams.keys()].sort()).toEqual(['code', 'operationId', 'state']);
  expect(callback.searchParams.get('state')).toBe(body.state);
  return { ...body, code: callback.searchParams.get('code')!, codeVerifier: verifier };
}
beforeAll(async () => { await migrate(process.env.DATABASE_URL!); await app.ready(); });
beforeEach(async () => {
  delete process.env.FLOW_REGISTRATION_ENABLED;
  await db.execute('TRUNCATE users, workspaces, channels, messages, auth_handoffs, rate_limit_windows RESTART IDENTITY CASCADE' as never);
  const res = await auth.register('person@example.test', { autoVerify: true, password: 'password123', displayName: 'Person' });
  if (!('token' in res)) throw new Error('missing session'); token = res.token;
});
afterAll(async () => { _setPushSenderForTests(null); await app.close(); await closeDb(); });

describe('browser contract', () => {
  it('discovers protocol and configured auth without exposing private server data', async () => {
    const res = await app.inject({ url: '/v1/client-info', headers: { origin } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ protocolVersion: 1, authMethods: ['password', 'email-link'], registrationAvailable: true,
      capabilities: { browserConnections: true, authHandoff: true, push: false, pushRouting: true } });
    expect(Object.keys(res.json()).sort()).toEqual(['authMethods', 'capabilities', 'displayName', 'protocolVersion', 'registrationAvailable', 'slackConnectorOrigin']);
    // Advertised so a native client can connect Slack without the origin baked
    // into its build; null (not absent) where this deployment offers no connector.
    expect(res.json().slackConnectorOrigin).toBeNull();
    try {
      process.env.SLACK_CONNECTOR_ORIGIN = 'https://slack.example.test/';
      expect((await app.inject({ url: '/v1/client-info', headers: { origin } })).json().slackConnectorOrigin).toBe('https://slack.example.test');
      process.env.SLACK_CONNECTOR_ORIGIN = 'http://slack.example.test';
      expect((await app.inject({ url: '/v1/client-info', headers: { origin } })).json().slackConnectorOrigin).toBeNull();
    } finally { delete process.env.SLACK_CONNECTOR_ORIGIN; }
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers.vary).toContain('Origin');
  });
  it('supports preflight, bearer API/media and error responses; rejects suffix/null origins', async () => {
    for (const url of ['/v1/client-info', '/v1/auth/login', '/v1/me', '/v1/avatars/missing']) {
      const res = await app.inject({ method: 'OPTIONS', url, headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'Authorization, Content-Type, Range' } });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.headers.vary).toContain('Origin');
      for (const bad of ['null', 'https://client.example.evil.test', 'http://client.example', 'https://client.example:444', `${origin}/`]) {
        expect((await app.inject({ url, headers: { origin: bad } })).statusCode).toBe(403);
      }
    }
    const me = await app.inject({ url: '/v1/me', headers: { origin, authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.headers['access-control-allow-origin']).toBe(origin);
    const media = await app.inject({ url: '/v1/avatars/missing', headers: { origin, authorization: `Bearer ${token}` } });
    expect(media.statusCode).toBe(404);
    expect(media.headers['access-control-allow-origin']).toBe(origin);
    const sharp = (await import('sharp')).default;
    const { setAvatar } = await import('../src/services/users.js');
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const user = await setAvatar((await auth.authenticate(token)).id, image, 'image/png');
    const binary = await app.inject({ url: user.avatarUrl!, headers: { origin, authorization: `Bearer ${token}` } });
    expect(binary.statusCode).toBe(200);
    expect(binary.headers['access-control-allow-origin']).toBe(origin);
    expect(binary.headers['content-type']).toContain('image/webp');
    expect((await app.inject({ url: '/v1/me', headers: { origin, cookie: `token=${token}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin, 'access-control-request-method': 'TRACE' } })).statusCode).toBe(403);
  });
  it('enforces WS origins before upgrade, independently of HTTP CORS', async () => {
    const server = createServer(); const wss = new WebSocketServer({ noServer: true });
    routeUpgrade(server, '/v1/ws', wss);
    wss.on('connection', ws => ws.close());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address() as { port: number };
    const connect = (from?: string) => new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws`, { ...(from ? { origin: from } : {}) });
      ws.on('open', () => { ws.close(); resolve(101); });
      ws.on('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode!); });
      ws.on('error', () => resolve(403));
      setTimeout(() => { ws.terminate(); reject(new Error('WS timed out')); }, 3000).unref();
    });
    try { expect(await connect(origin)).toBe(101); expect(await connect()).toBe(101); expect(await connect('https://evil.test')).toBe(403); }
    finally { await new Promise<void>(r => wss.close(() => r())); await new Promise<void>(r => server.close(() => r())); }
  });
  it('advertises and enforces disabled registration but keeps existing login working', async () => {
    process.env.FLOW_REGISTRATION_ENABLED = '0';
    expect((await app.inject({ url: '/v1/client-info' })).json().registrationAvailable).toBe(false);
    await expect(auth.register('new@example.test')).rejects.toMatchObject({ code: 'registration_disabled' });
    await expect(auth.completeSignup('old-code', 'New', 'password123')).rejects.toMatchObject({ code: 'registration_disabled' });
    await expect(resolveOAuthUser({ provider: 'google', sub: 'new-sub', email: 'new@example.test', hostedDomain: null })).rejects.toMatchObject({ code: 'registration_disabled' });
    expect((await post('/v1/auth/login', { email: 'person@example.test', password: 'password123' })).statusCode).toBe(200);
  });
});

describe('initiated PKCE handoff', () => {
  it('requires an initiated authenticated operation and rejects replay/racing exchanges', async () => {
    const pending = await start();
    expect((await post('/v1/auth/handoff/approve', pending)).statusCode).toBe(401);
    expect((await post('/v1/auth/handoff/approve', { ...pending, requestId: 'a'.repeat(43) }, true)).statusCode).toBe(401);
    const body = await approved();
    const responses = await Promise.all([post('/v1/auth/handoff/exchange', body), post('/v1/auth/handoff/exchange', body)]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 401]);
    const success = responses.find(r => r.statusCode === 200)!;
    expect((await auth.authenticate(success.json().token)).displayName).toBe('Person');
    expect((await post('/v1/auth/app-link/exchange', { code: body.code })).statusCode).toBe(401);
  });
  it('binds every context field and verifier; bad attempts cannot consume the valid code', async () => {
    const body = await approved();
    for (const change of [{ state: 'x'.repeat(43) }, { operationId: 'x'.repeat(43) }, { connectionId: 'other' },
      { serverOrigin: 'https://other.test' }, { returnUrl: `${origin}/evil` }, { clientOrigin: 'https://backend.example' }, { codeVerifier: 'x'.repeat(43) }]) {
      expect((await post('/v1/auth/handoff/exchange', { ...body, ...change })).statusCode).toBeGreaterThanOrEqual(400);
    }
    expect((await post('/v1/auth/handoff/exchange', body, false, 'https://backend.example')).statusCode).toBe(400);
    expect((await post('/v1/auth/handoff/exchange', body, false, null)).statusCode).toBe(400);
    expect((await post('/v1/auth/handoff/exchange', body)).statusCode).toBe(200);
  });
  it('rejects unapproved and expired codes and does not approve twice', async () => {
    const pending = await start();
    expect((await post('/v1/auth/handoff/exchange', { ...pending, code: 'c'.repeat(43), codeVerifier: verifier })).statusCode).toBe(401);
    expect((await post('/v1/auth/handoff/approve', pending, true)).statusCode).toBe(200);
    expect((await post('/v1/auth/handoff/approve', pending, true)).statusCode).toBe(401);
    const body = await approved();
    await db.update(schema.authHandoffs).set({ expiresAt: new Date(0) });
    expect((await post('/v1/auth/handoff/exchange', body)).statusCode).toBe(401);
  });
  it('preserves legacy app links and supports native pending operations without Origin', async () => {
    const legacy = await post('/v1/auth/app-link', {}, true, null);
    expect(legacy.statusCode).toBe(201);
    expect((await post('/v1/auth/app-link/exchange', { code: legacy.json().code }, false, null)).statusCode).toBe(200);
    const ctx = { ...context(), clientOrigin: null, returnUrl: 'flow://signin' };
    const body = await approved(ctx);
    expect((await post('/v1/auth/handoff/exchange', body, false, null)).statusCode).toBe(200);
  });
  // The desktop app (docs/specs/desktop-electron.md) is admitted without
  // operator configuration, gets CORS headers because Chromium checks them,
  // and signs in exactly like a native client: null client origin, flow://
  // return, its own Origin ignored by the handoff binding.
  it('admits the desktop origin everywhere and lets it use the native handoff shape', async () => {
    const desktop = 'app://flow';
    const info = await app.inject({ url: '/v1/client-info', headers: { origin: desktop } });
    expect(info.statusCode).toBe(200);
    expect(info.headers['access-control-allow-origin']).toBe(desktop);
    expect(info.json().capabilities.desktop).toBe(true);
    expect((await app.inject({ url: '/v1/me', headers: { origin: desktop, authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    // Look-alikes get nothing: the constant is exact, never prefix-matched.
    for (const bad of ['app://flow/', 'app://flow.evil', 'apps://flow', 'APP://FLOW']) {
      expect((await app.inject({ url: '/v1/client-info', headers: { origin: bad } })).statusCode).toBe(403);
    }
    const preflight = await app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin: desktop, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } });
    expect(preflight.statusCode).toBe(204);
    const ctx = { ...context(), clientOrigin: null, returnUrl: 'flow://signin' };
    const started = await post('/v1/auth/handoff/start', { ...ctx, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' }, false, desktop);
    expect(started.statusCode).toBe(201);
    const pending = { ...ctx, requestId: started.json().requestId as string };
    const approve = await post('/v1/auth/handoff/approve', pending, true, 'https://backend.example');
    expect(approve.statusCode).toBe(200);
    const code = new URL(approve.json().callbackUrl).searchParams.get('code')!;
    // A browser page cannot borrow the native shape…
    expect((await post('/v1/auth/handoff/exchange', { ...pending, code, codeVerifier: verifier }, false, origin)).statusCode).toBe(400);
    // …but the desktop can, and a desktop-started operation still binds a null client origin.
    expect((await post('/v1/auth/handoff/exchange', { ...pending, code, codeVerifier: verifier }, false, desktop)).statusCode).toBe(200);
    const legacy = await post('/v1/auth/app-link', {}, true, desktop);
    expect(legacy.statusCode).toBe(201);
    expect((await post('/v1/auth/app-link/exchange', { code: legacy.json().code }, false, desktop)).statusCode).toBe(200);
  });
  it('admits the desktop origin on the WebSocket upgrade', async () => {
    const server = createServer(); const wss = new WebSocketServer({ noServer: true });
    routeUpgrade(server, '/v1/ws', wss);
    wss.on('connection', ws => ws.close());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address() as { port: number };
    const connect = (from: string) => new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws`, { origin: from });
      ws.on('open', () => { ws.close(); resolve(101); });
      ws.on('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode!); });
      ws.on('error', () => resolve(403));
      setTimeout(() => { ws.terminate(); reject(new Error('WS timed out')); }, 3000).unref();
    });
    try { expect(await connect('app://flow')).toBe(101); expect(await connect('app://flow.evil')).toBe(403); }
    finally { await new Promise<void>(r => wss.close(() => r())); await new Promise<void>(r => server.close(() => r())); }
  });
});

describe('connection push contract', () => {
  it('echoes the route on alerts, omits all badge-only sends, and keeps legacy payloads intact', async () => {
    const sent: any[] = [];
    _setPushSenderForTests({ async send(device, payload, opts) { sent.push({ device, payload, opts }); return { ok: true }; } });
    const device = { token: 'a'.repeat(64), platform: 'ios', routingId: 'route-for-connection-A' };
    const payload = { aps: { alert: { title: 'Hello' }, badge: 9, 'thread-id': 'overlapping-channel' }, channelId: 'overlapping-channel' };
    await sendPush(pushSender(), device, payload, { pushType: 'alert' });
    expect(sent[0].payload.routingId).toBe(device.routingId);
    expect(sent[0].payload.aps.badge).toBeUndefined();
    await sendPush(pushSender(), { ...device, routingId: 'route-for-connection-B' }, payload, { pushType: 'alert' });
    expect(sent[1].payload.aps['thread-id']).not.toBe(sent[0].payload.aps['thread-id']);
    await sendPush(pushSender(), device, { aps: { badge: 2 } }, { pushType: 'alert' });
    await sendPush(pushSender(), device, { aps: { badge: 2, 'content-available': 1 } }, { pushType: 'background' });
    expect(sent).toHaveLength(2);
    await sendPush(pushSender(), { ...device, routingId: null }, payload, { pushType: 'alert' });
    expect(sent[2].payload).toEqual(payload);
    expect(payload.aps.badge).toBe(9);
  });
  it('registers route and rejects incomplete opt-in; stale unregistration cannot delete a replacement route', async () => {
    const base = { token: 'a'.repeat(64), platform: 'ios', environment: 'sandbox', bundleId: 'im.freeflow.app' };
    const route = { routingId: 'connection-route-A', badgeMode: 'omit' };
    expect((await post('/v1/me/devices', { ...base, routingId: route.routingId }, true)).statusCode).toBe(400);
    expect((await post('/v1/me/devices', { ...base, ...route }, true)).statusCode).toBe(200);
    expect((await db.select().from(schema.deviceTokens))[0]?.routingId).toBe(route.routingId);
    const remove = (routingId?: string) => app.inject({ method: 'DELETE', url: `/v1/me/devices/${base.token}${routingId ? `?routingId=${routingId}` : ''}`, headers: { authorization: `Bearer ${token}` } });
    await remove(); await remove('connection-route-B');
    expect(await db.select().from(schema.deviceTokens)).toHaveLength(1);
    await remove(route.routingId);
    expect(await db.select().from(schema.deviceTokens)).toHaveLength(0);
    await post('/v1/me/devices', base, true);
    expect((await db.select().from(schema.deviceTokens))[0]?.routingId).toBeNull();
    await remove(); expect(await db.select().from(schema.deviceTokens)).toHaveLength(0);
  });
});

describe('bus subject namespacing (#542)', () => {
  const original = process.env.FLOW_BUS_PREFIX;
  afterEach(() => {
    if (original === undefined) delete process.env.FLOW_BUS_PREFIX;
    else process.env.FLOW_BUS_PREFIX = original;
  });

  it('leaves every subject alone when no prefix is configured', () => {
    delete process.env.FLOW_BUS_PREFIX;
    expect(bus.subjectMsg('w', 'c')).toBe('ws.w.chan.c.msg');
    expect(bus.subjectWorkspaceAll('w')).toBe('ws.w.>');
    expect(bus.subjectUserNotify('u')).toBe('user.u.notify');
  });

  it('namespaces publish and subscribe subjects alike, wildcards included', () => {
    // Two deployments on one NATS route on the same `ws.{workspaceId}` subjects.
    // With independently generated ids that never matters; with a *cloned*
    // database it always does, and each one's events land in the other's
    // clients. The prefix is what keeps them apart.
    process.env.FLOW_BUS_PREFIX = 'staging';
    expect(bus.subjectMsg('w', 'c')).toBe('staging.ws.w.chan.c.msg');
    expect(bus.subjectWorkspaceAll('w')).toBe('staging.ws.w.>');
    expect(bus.subjectHuddleAll()).toBe('staging.ws.*.chan.*.huddle');
    expect(bus.subjectPresenceSyncAll()).toBe('staging.presence.sync.*');
    expect(bus.subjectUserMeta('u')).toBe('staging.user.u.meta');
  });

  it('refuses characters that would inject a wildcard or another subject token', () => {
    process.env.FLOW_BUS_PREFIX = 'ev il.>.*';
    expect(bus.subjectMsg('w', 'c')).toBe('evil.ws.w.chan.c.msg');
  });

  it('keeps the gateway able to recognise a meta subject under a prefix', () => {
    process.env.FLOW_BUS_PREFIX = 'staging';
    // gateway/index.ts routes membership bookkeeping on `endsWith('.meta')`.
    expect(bus.subjectMeta('w').endsWith('.meta')).toBe(true);
  });
});
