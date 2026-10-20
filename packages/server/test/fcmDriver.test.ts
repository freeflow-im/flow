// The FCM HTTP v1 driver (ANDROID.md phase 3). Two halves: the pure
// translation of the outbox's APNs-shaped payload into an FCM message — the
// contract the Android app reads (channel ids, data keys) — and the mapping of
// FCM's answers onto the two facts the outbox acts on. The transport is a
// stub fetch that records the request; no Google account, no network.
import { describe, expect, it } from 'vitest';
import {
  ANDROID_CHANNELS,
  DEFAULT_CHANNEL,
  FcmHttpV1PushSender,
  classifyFcmFailure,
  toFcmMessage,
} from '../src/push/fcmSender.js';
import type { ApnsHeaders, ApnsPayload, PushDevice } from '../src/push/types.js';

const device: PushDevice = { token: 'fcm-TOKEN_abc:APA91b', platform: 'android' };

const alertPayload: ApnsPayload = {
  aps: {
    alert: { title: 'Alice mentioned you', subtitle: '#general', body: 'standup in 5?' },
    sound: 'default',
    badge: 7,
    'thread-id': 'c1',
  },
  workspaceId: 'w1',
  channelId: 'c1',
  messageId: 'm1',
  notificationId: 'n1',
  kind: 0,
};

const NOW = 1_700_000_000_000;
const headers: ApnsHeaders = { pushType: 'alert', priority: 10, expiration: Math.floor(NOW / 1000) + 3600 };

describe('toFcmMessage', () => {
  it('turns the alert into a tray notification on the kind\'s channel, and the routing keys into data', () => {
    const m = toFcmMessage(device, alertPayload, headers, NOW).message;
    expect(m.token).toBe(device.token);
    expect(m.notification).toEqual({ title: 'Alice mentioned you', body: '#general — standup in 5?' });
    expect(m.android).toEqual({
      priority: 'HIGH',
      ttl: '3600s',
      notification: { channel_id: 'mentions', sound: 'default', notification_count: 7 },
    });
    expect(m.data).toEqual({
      workspaceId: 'w1',
      channelId: 'c1',
      messageId: 'm1',
      notificationId: 'n1',
      kind: '0',
      badge: '7',
    });
  });

  it('keeps every data value a string — FCM refuses anything else', () => {
    const m = toFcmMessage(device, { ...alertPayload, threadRootId: 't1', kind: 2 }, headers, NOW).message;
    for (const v of Object.values(m.data)) expect(typeof v).toBe('string');
    expect(m.data.threadRootId).toBe('t1');
    expect(m.android.notification?.channel_id).toBe('threads');
  });

  it('drops the subtitle join when there is no body, and the sound when the pref is off', () => {
    const p: ApnsPayload = { ...alertPayload, aps: { alert: { title: 'Alice' }, badge: 1 } };
    const m = toFcmMessage(device, p, headers, NOW).message;
    expect(m.notification).toEqual({ title: 'Alice' });
    expect(m.android.notification).toEqual({ channel_id: 'mentions', notification_count: 1 });
  });

  it('sends a badge-only or muted push as data at normal priority, with no tray notification', () => {
    const muted: ApnsPayload = { aps: { badge: 3 } };
    const m = toFcmMessage(device, muted, { pushType: 'alert', priority: 5, expiration: Math.floor(NOW / 1000) + 60 }, NOW).message;
    expect(m.notification).toBeUndefined();
    expect(m.android).toEqual({ priority: 'NORMAL', ttl: '60s' });
    expect(m.data).toEqual({ badge: '3' });
  });

  it('falls back to the default channel for an unknown or missing kind', () => {
    expect(toFcmMessage(device, { ...alertPayload, kind: 99 }, headers, NOW).message.android.notification?.channel_id).toBe(DEFAULT_CHANNEL);
    const { kind: _k, ...noKind } = alertPayload;
    expect(toFcmMessage(device, noKind, headers, NOW).message.android.notification?.channel_id).toBe(DEFAULT_CHANNEL);
    expect(Object.keys(ANDROID_CHANNELS).map(Number).sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('clamps an already-expired push to a zero ttl and maps collapseId', () => {
    const m = toFcmMessage(device, alertPayload, { ...headers, expiration: Math.floor(NOW / 1000) - 5, collapseId: 'c1' }, NOW).message;
    expect(m.android.ttl).toBe('0s');
    expect(m.android.collapse_key).toBe('c1');
  });
});

describe('classifyFcmFailure', () => {
  const body = (code: string, status = code) =>
    JSON.stringify({ error: { status, details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code }] } });

  it('retires a token FCM says is gone, like APNs 410', () => {
    expect(classifyFcmFailure(404, body('UNREGISTERED', 'NOT_FOUND'))).toEqual({ status: 404, reason: '404 UNREGISTERED', retryable: false, disableDevice: true });
    expect(classifyFcmFailure(400, JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' } }))).toMatchObject({ disableDevice: true, retryable: false });
  });

  it('retries on quota and server trouble, never on our own bad payload', () => {
    expect(classifyFcmFailure(429, body('QUOTA_EXCEEDED', 'RESOURCE_EXHAUSTED'))).toMatchObject({ retryable: true, disableDevice: false });
    expect(classifyFcmFailure(503, body('UNAVAILABLE'))).toMatchObject({ retryable: true, disableDevice: false });
    expect(classifyFcmFailure(400, body('INVALID_ARGUMENT'))).toMatchObject({ retryable: false, disableDevice: false });
    expect(classifyFcmFailure(401, 'nope')).toEqual({ status: 401, reason: '401', retryable: false, disableDevice: false });
  });
});

describe('FcmHttpV1PushSender', () => {
  function stubFetch(status: number, bodyText = '') {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return { ok: status >= 200 && status < 300, status, text: async () => bodyText } as unknown as Response;
    }) as typeof fetch;
    return { fetchImpl, calls };
  }
  const quiet = { warn: () => {}, error: () => {} };

  it('posts the translated message to the project\'s send endpoint with a bearer token', async () => {
    const { fetchImpl, calls } = stubFetch(200, '{"name":"projects/p/messages/1"}');
    const sender = new FcmHttpV1PushSender({ accessToken: async () => 'ya29.test', projectId: 'freeflow-android', endpoint: 'https://fcm.test/', fetchImpl, log: quiet });
    await expect(sender.send(device, alertPayload, headers)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://fcm.test/v1/projects/freeflow-android/messages:send');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer ya29.test');
    expect(JSON.parse(String(calls[0]!.init.body)).message.token).toBe(device.token);
  });

  it('reports a gone token as disableDevice and a 503 as retryable', async () => {
    const gone = new FcmHttpV1PushSender({ accessToken: async () => 't', projectId: 'p', fetchImpl: stubFetch(404, JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })).fetchImpl, log: quiet });
    expect(await gone.send(device, alertPayload, headers)).toMatchObject({ ok: false, disableDevice: true, retryable: false });
    const down = new FcmHttpV1PushSender({ accessToken: async () => 't', projectId: 'p', fetchImpl: stubFetch(503, '{}').fetchImpl, log: quiet });
    expect(await down.send(device, alertPayload, headers)).toMatchObject({ ok: false, retryable: true, disableDevice: false });
  });

  it('treats a token-minting failure as retryable, not as a dead device', async () => {
    const { fetchImpl, calls } = stubFetch(200);
    const sender = new FcmHttpV1PushSender({ accessToken: async () => { throw new Error('key rejected'); }, projectId: 'p', fetchImpl, log: quiet });
    expect(await sender.send(device, alertPayload, headers)).toMatchObject({ ok: false, retryable: true, disableDevice: false });
    expect(calls).toHaveLength(0);
  });

  it('refuses to construct without a usable service account', () => {
    expect(() => new FcmHttpV1PushSender({ serviceAccount: { project_id: 'p', client_email: '', private_key: '' } })).toThrow(/service account/);
  });
});
