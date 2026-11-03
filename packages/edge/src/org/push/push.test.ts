// The APNs driver over fetch: the provider token, the request it builds, and how Apple's answers map onto retry and
// disable, which is what the outbox acts on. Plus the routing contract every driver sits behind.
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair, importSPKI, exportSPKI, jwtVerify } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apnsProviderToken, resetApnsProviderToken } from './apnsAuth';
import { ApnsFetchPushSender } from './apnsSender';
import { DevPushSender, sendPush, type ApnsPayload, type PushDevice } from './index';

const device: PushDevice = { token: 'ab'.repeat(32), platform: 'ios', environment: 'production', bundleId: 'im.freeflow.app' };
const payload: ApnsPayload = { aps: { alert: { title: 'Ann', body: 'hi' }, badge: 3, 'thread-id': 'chan-1' }, channelId: 'chan-1' };
const quiet = { warn: vi.fn(), error: vi.fn() };

let spki = '';
beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  process.env.FLOW_APNS_KEY = btoa(await exportPKCS8(privateKey));
  process.env.FLOW_APNS_KEY_ID = 'KEY1234567';
  process.env.FLOW_APNS_TEAM_ID = 'TEAM123456';
  spki = await exportSPKI(publicKey);
});
afterEach(() => resetApnsProviderToken());

describe('APNs provider token', () => {
  it('is an ES256 JWT naming the key and the team, signed by the .p8', async () => {
    const jwt = await apnsProviderToken();
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    const { payload: claims } = await jwtVerify(jwt, await importSPKI(spki, 'ES256'));
    expect(claims.iss).toBe('TEAM123456');
  });

  it('is reused for 55 minutes, then re-signed', async () => {
    const t0 = Date.now();
    const first = await apnsProviderToken(t0);
    expect(await apnsProviderToken(t0 + 54 * 60_000)).toBe(first);
    const later = await apnsProviderToken(t0 + 56 * 60_000);
    expect(later).not.toBe(first);
    expect(decodeJwt(later).iat).toBe(Math.floor((t0 + 56 * 60_000) / 1000));
  });

  it('accepts a raw PEM as well as base64 of one', async () => {
    const saved = process.env.FLOW_APNS_KEY!;
    process.env.FLOW_APNS_KEY = atob(saved);
    expect(await apnsProviderToken()).toMatch(/^ey/);
    process.env.FLOW_APNS_KEY = saved;
  });
});

function sender(status: number, body: unknown = '', headers: Record<string, string> = {}) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));
  return { fetch, s: new ApnsFetchPushSender({ fetch: fetch as unknown as typeof globalThis.fetch, signer: async () => 'jwt', log: quiet }) };
}

describe('the APNs driver over fetch', () => {
  it('posts the payload to the device on the environment its row names, with the APNs headers', async () => {
    const { fetch, s } = sender(200, '', { 'apns-id': 'id-1' });
    expect(await s.send(device, payload, { pushType: 'alert', collapseId: 'c1' })).toEqual({ ok: true, apnsId: 'id-1' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://api.push.apple.com/3/device/${device.token}`);
    expect(init!.method).toBe('POST');
    expect(init!.headers).toMatchObject({ authorization: 'bearer jwt', 'apns-topic': 'im.freeflow.app', 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': 'c1' });
    expect(JSON.parse(init!.body as string)).toEqual(payload);

    await s.send({ ...device, environment: 'sandbox' }, payload, { pushType: 'background' });
    expect(fetch.mock.calls[1]![0]).toMatch(/^https:\/\/api\.sandbox\.push\.apple\.com\//);
    expect(fetch.mock.calls[1]![1]!.headers).toMatchObject({ 'apns-priority': '5', 'apns-push-type': 'background' });
  });

  it.each([
    [410, { reason: 'Unregistered' }, { retryable: false, disableDevice: true }],
    [400, { reason: 'BadDeviceToken' }, { retryable: false, disableDevice: true }],
    [400, { reason: 'DeviceTokenNotForTopic' }, { retryable: false, disableDevice: true }],
    [403, { reason: 'ExpiredProviderToken' }, { retryable: true, disableDevice: false }],
    [403, { reason: 'InvalidProviderToken' }, { retryable: false, disableDevice: false }],
    [429, { reason: 'TooManyRequests' }, { retryable: true, disableDevice: false }],
    [503, { reason: 'ServiceUnavailable' }, { retryable: true, disableDevice: false }],
    [400, { reason: 'PayloadTooLarge' }, { retryable: false, disableDevice: false }],
    [400, 'not json', { retryable: false, disableDevice: false }],
  ])('maps %i %j', async (status, body, expected) => {
    const { s } = sender(status, body);
    const r = await s.send(device, payload, { pushType: 'alert' });
    expect(r).toMatchObject({ ok: false, status, ...expected });
  });

  it('treats a transport failure as transient (what workerd answers locally, having no HTTP/2)', async () => {
    const s = new ApnsFetchPushSender({ fetch: (async () => { throw new Error('Network connection lost.'); }) as never, signer: async () => 'jwt', log: quiet });
    expect(await s.send(device, payload, { pushType: 'alert' })).toMatchObject({ ok: false, retryable: true, disableDevice: false, reason: expect.stringContaining('Network connection lost') });
  });

  it('refuses to start without its credentials', () => {
    const saved = process.env.FLOW_APNS_KEY_ID;
    delete process.env.FLOW_APNS_KEY_ID;
    expect(() => new ApnsFetchPushSender()).toThrow(/FLOW_APNS_KEY_ID/);
    process.env.FLOW_APNS_KEY_ID = saved;
  });
});

describe('the routing contract', () => {
  it('sends a plain device the payload as built', async () => {
    const dev = new DevPushSender();
    await sendPush(dev, device, payload, { pushType: 'alert' });
    expect(dev.sent[0]!.payload).toEqual(payload);
  });

  it('gives a routed device no badge, a per-route thread, and its routing id; and skips silent badge pushes', async () => {
    const dev = new DevPushSender();
    const routed = { ...device, routingId: 'route-abcdef0123456789' };
    await sendPush(dev, routed, payload, { pushType: 'alert' });
    const sent = dev.sent[0]!.payload;
    expect(sent.aps.badge).toBeUndefined();
    expect(sent.aps['thread-id']).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.routingId).toBe('route-abcdef0123456789');
    expect(await sendPush(dev, routed, { aps: { badge: 2, 'content-available': 1 } }, { pushType: 'background' })).toEqual({ ok: true });
    expect(dev.sent).toHaveLength(1);
  });
});
