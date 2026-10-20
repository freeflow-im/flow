// The push seam (#246): driver selection by config, and the dev driver's
// artifact. The artifact assertions are the point — the file it writes is fed
// straight to `xcrun simctl push`, so its shape is a contract, not a log.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ApnsHttp2PushSender,
  DevPushSender,
  FcmHttpV1PushSender,
  PlatformPushSender,
  _setPushSenderForTests,
  apnsEnvFor,
  apnsTopicFor,
  pushSender,
  type ApnsHeaders,
  type ApnsPayload,
  type PushDevice,
} from '../src/push/index.js';

const saved = {
  driver: process.env.FLOW_PUSH_DRIVER,
  outbox: process.env.FLOW_PUSH_OUTBOX,
  env: process.env.FLOW_APNS_ENV,
  topic: process.env.FLOW_APNS_TOPIC,
  key: process.env.FLOW_APNS_KEY,
  keyId: process.env.FLOW_APNS_KEY_ID,
  teamId: process.env.FLOW_APNS_TEAM_ID,
  fcm: process.env.FLOW_FCM_SERVICE_ACCOUNT,
};

/** A throwaway P-256 key, so selecting the apns driver needs no real .p8 (#250). */
const P8_PEM = crypto
  .generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

/** A throwaway RSA key, so selecting the FCM driver needs no real Firebase key. */
const RSA_PEM = crypto
  .generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

let dir: string;

const device: PushDevice = {
  token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  platform: 'ios',
  environment: 'sandbox',
  bundleId: 'im.freeflow.app',
};

const payload: ApnsPayload = {
  aps: {
    alert: { title: 'Alice (DM)', body: 'standup in 5?' },
    sound: 'default',
    badge: 7,
    'thread-id': 'chan-1',
  },
  workspaceId: 'ws-1',
  channelId: 'chan-1',
  messageId: 'msg-1',
  notificationId: 'note-1',
};

const headers: ApnsHeaders = { pushType: 'alert', priority: 10, expiration: 3600, collapseId: 'chan-1' };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-push-'));
  _setPushSenderForTests(null);
});

afterEach(async () => {
  _setPushSenderForTests(null);
  await fs.rm(dir, { recursive: true, force: true });
  for (const [k, v] of [
    ['FLOW_PUSH_DRIVER', saved.driver],
    ['FLOW_PUSH_OUTBOX', saved.outbox],
    ['FLOW_APNS_ENV', saved.env],
    ['FLOW_APNS_TOPIC', saved.topic],
    ['FLOW_APNS_KEY', saved.key],
    ['FLOW_APNS_KEY_ID', saved.keyId],
    ['FLOW_APNS_TEAM_ID', saved.teamId],
    ['FLOW_FCM_SERVICE_ACCOUNT', saved.fcm],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** The single file the dev driver wrote, parsed. */
async function onlyArtifact(): Promise<{ name: string; json: Record<string, unknown> }> {
  const names = await fs.readdir(dir);
  expect(names).toHaveLength(1);
  return { name: names[0]!, json: JSON.parse(await fs.readFile(path.join(dir, names[0]!), 'utf8')) as Record<string, unknown> };
}

describe('driver selection', () => {
  const driverFor = (platform: string) => (pushSender() as PlatformPushSender).driverFor(platform);

  it('defaults to the dev driver, for every platform', () => {
    delete process.env.FLOW_PUSH_DRIVER;
    delete process.env.FLOW_FCM_SERVICE_ACCOUNT;
    expect(pushSender()).toBeInstanceOf(PlatformPushSender);
    expect(driverFor('ios')).toBeInstanceOf(DevPushSender);
    expect(driverFor('android')).toBeInstanceOf(DevPushSender);
    expect(driverFor('watch')).toBeInstanceOf(DevPushSender); // unknown platform: the fallback
  });

  it('ignores an unknown driver name rather than half-configuring one', () => {
    process.env.FLOW_PUSH_DRIVER = 'firebase';
    expect(driverFor('ios')).toBeInstanceOf(DevPushSender);
  });

  it('selects the real apns driver when it is configured', () => {
    process.env.FLOW_PUSH_DRIVER = 'apns';
    process.env.FLOW_APNS_KEY = Buffer.from(P8_PEM).toString('base64');
    process.env.FLOW_APNS_KEY_ID = 'ABCDE12345';
    process.env.FLOW_APNS_TEAM_ID = 'TEAM123456';
    expect(driverFor('ios')).toBeInstanceOf(ApnsHttp2PushSender);
    // …and iOS being configured says nothing about Android.
    expect(driverFor('android')).toBeInstanceOf(DevPushSender);
  });

  it('selects the FCM driver for android when a service account is configured, leaving iOS alone', () => {
    delete process.env.FLOW_PUSH_DRIVER;
    process.env.FLOW_FCM_SERVICE_ACCOUNT = JSON.stringify({
      type: 'service_account',
      project_id: 'freeflow-android',
      client_email: 'firebase-adminsdk@freeflow-android.iam.gserviceaccount.com',
      private_key: RSA_PEM,
    });
    expect(driverFor('android')).toBeInstanceOf(FcmHttpV1PushSender);
    expect(driverFor('ios')).toBeInstanceOf(DevPushSender);
  });

  it('refuses a FLOW_FCM_SERVICE_ACCOUNT that is not a service-account key', () => {
    process.env.FLOW_FCM_SERVICE_ACCOUNT = JSON.stringify({ project_id: 'p' });
    expect(() => pushSender()).toThrow(/service-account/);
  });

  it('refuses to half-configure the apns driver rather than silently writing to disk', () => {
    // A production deploy that is missing the key must fail where someone is
    // watching, not fall back to the dev driver and drop every push in .push/.
    process.env.FLOW_PUSH_DRIVER = 'apns';
    delete process.env.FLOW_APNS_KEY;
    expect(() => pushSender()).toThrow(/FLOW_APNS_KEY/);
  });

  it('memoises the sender and lets tests swap it', async () => {
    delete process.env.FLOW_PUSH_DRIVER;
    expect(pushSender()).toBe(pushSender());
    const fake = { send: async () => ({ ok: true }) as const };
    _setPushSenderForTests(fake);
    expect(pushSender()).toBe(fake);
  });
});

describe('topic and environment resolution', () => {
  it('prefers the device row over the global config', () => {
    process.env.FLOW_APNS_TOPIC = 'im.example.other';
    process.env.FLOW_APNS_ENV = 'production';
    expect(apnsTopicFor(device)).toBe('im.freeflow.app');
    expect(apnsEnvFor(device)).toBe('sandbox');
  });

  it('falls back to config when the device carries neither', () => {
    process.env.FLOW_APNS_TOPIC = 'im.example.other';
    process.env.FLOW_APNS_ENV = 'production';
    const bare: PushDevice = { token: 'ff00', platform: 'ios' };
    expect(apnsTopicFor(bare)).toBe('im.example.other');
    expect(apnsEnvFor(bare)).toBe('production');
  });

  it('lets an explicit header override both', () => {
    expect(apnsTopicFor(device, { pushType: 'alert', topic: 'im.freeflow.app.dev' })).toBe('im.freeflow.app.dev');
  });
});

describe('dev driver artifact', () => {
  it('writes a simctl-ready payload file and reports success', async () => {
    const res = await new DevPushSender(dir).send(device, payload, headers);
    expect(res).toEqual({ ok: true });

    const { name, json } = await onlyArtifact();
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-a1b2c3d4e5f6\.json$/);

    // simctl requires a top-level `aps` dict, and takes the target bundle from
    // this key when the command line doesn't name one.
    expect(json.aps).toEqual(payload.aps);
    expect(json['Simulator Target Bundle']).toBe('im.freeflow.app');

    // Custom keys ride flat alongside `aps` — that's the contract the client
    // tap-routing reads.
    expect(json.channelId).toBe('chan-1');
    expect(json.notificationId).toBe('note-1');

    // Transport details are logged, never smuggled into the payload: anything
    // extra here would be delivered to the app as custom data.
    expect(Object.keys(json).sort()).toEqual(
      ['Simulator Target Bundle', 'aps', 'channelId', 'messageId', 'notificationId', 'workspaceId'].sort(),
    );
  });

  it('creates the outbox directory and keeps one file per send', async () => {
    const nested = path.join(dir, 'deep', 'push');
    const sender = new DevPushSender(nested);
    await sender.send(device, payload, headers);
    await sender.send({ ...device, token: 'beef' }, payload, { pushType: 'background', priority: 5 });
    expect((await fs.readdir(nested)).length).toBe(2);
  });

  it('falls back to the config topic when the device has no bundleId', async () => {
    process.env.FLOW_APNS_TOPIC = 'im.example.other';
    await new DevPushSender(dir).send({ token: 'ff00', platform: 'ios' }, payload, { pushType: 'alert' });
    const { json } = await onlyArtifact();
    expect(json['Simulator Target Bundle']).toBe('im.example.other');
  });
});
