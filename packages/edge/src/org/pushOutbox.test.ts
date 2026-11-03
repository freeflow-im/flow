// The push outbox inside an Org object: a mention queues a push, the alarm's drain delivers it through the driver,
// and APNs' answers retry, disable a dead token, or give up, as on the Node server.
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { orgStorage } from '../../test/orgStorage';
import { withDb, schema, type DB } from './db/index';
import { _setPushSenderForTests, DevPushSender, type PushResult, type PushSender } from './push/index';
import { drainDuePushes, nextPushDueAt } from './services/pushOutbox';
import { registerDevice } from './services/devices';
import { sendMessage } from './services/messages';
import { createWorkspace, enrollInWorkspace } from './services/workspaces';

const ANN = '00000000-0000-7000-8000-00000000000a';
const BOB = '00000000-0000-7000-8000-00000000000b';
const TOKEN = 'ab'.repeat(32);
const log = { info: () => {}, warn: (o: unknown, m?: string) => console.warn(m, o) };

beforeAll(() => { process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64'); });

let db: DB;
let channelId: string;

beforeEach(async () => {
  db = orgStorage().db;
  await withDb(db, async () => {
    for (const [id, name] of [[ANN, 'Ann'], [BOB, 'Bob']]) db.insert(schema.users).values({ id, email: `${name}@x.test`, passwordHash: '!', displayName: name }).run();
    const w = await createWorkspace(ANN, 'Locked In', 'locked-in');
    await db.transaction((tx) => enrollInWorkspace(tx, w.id, BOB));
    channelId = db.select().from(schema.channels).get()!.id;
  });
});

const run = <T>(fn: () => Promise<T>) => withDb(db, fn);
const mentionBob = () => run(() => sendMessage(channelId, ANN, crypto.randomUUID(), `hey <@${BOB}>`, undefined, undefined, [BOB]));
const pending = () => withDb(db, () => db.select().from(schema.pendingPush).all());

class Scripted implements PushSender {
  calls = 0;
  constructor(private readonly answers: PushResult[]) {}
  async send(): Promise<PushResult> { return this.answers[Math.min(this.calls++, this.answers.length - 1)]!; }
}

describe('the push outbox in an Org object', () => {
  it('queues nothing for someone with no device', async () => {
    await mentionBob();
    expect(pending()).toHaveLength(0);
    expect(withDb(db, nextPushDueAt)).toBeNull();
  });

  it('queues a mention, says it is due now, and the drain delivers it through the dev driver', async () => {
    await run(() => registerDevice(BOB, { token: TOKEN, platform: 'ios', environment: 'sandbox', bundleId: 'im.freeflow.app' }));
    const dev = new DevPushSender();
    _setPushSenderForTests(dev);
    await mentionBob();
    expect(pending()).toHaveLength(1);
    expect(withDb(db, nextPushDueAt)).toBeLessThanOrEqual(Date.now());

    await run(() => drainDuePushes(log));
    expect(dev.sent).toHaveLength(1);
    expect(dev.sent[0]!.device.token).toBe(TOKEN);
    expect(dev.sent[0]!.payload.aps.alert?.title).toContain('Ann');
    expect(dev.sent[0]!.headers.pushType).toBe('alert');
    expect(pending()[0]!.deliveredAt).not.toBeNull();
    expect(withDb(db, nextPushDueAt)).toBeNull();
  });

  it('backs off on a transient failure and says when to come back', async () => {
    await run(() => registerDevice(BOB, { token: TOKEN, platform: 'ios', environment: 'sandbox', bundleId: 'im.freeflow.app' }));
    const sender = new Scripted([{ ok: false, status: 503, reason: 'ServiceUnavailable', retryable: true, disableDevice: false }]);
    _setPushSenderForTests(sender);
    await mentionBob();
    await run(() => drainDuePushes(log));
    const [row] = pending();
    expect(row!.attempts).toBe(1);
    expect(row!.deliveredAt).toBeNull();
    const due = withDb(db, nextPushDueAt)!;
    expect(due - Date.now()).toBeGreaterThan(3_000);
    expect(due - Date.now()).toBeLessThanOrEqual(5_000);
    expect(sender.calls).toBe(1);
  });

  it('disables a dead token and does not retry it', async () => {
    await run(() => registerDevice(BOB, { token: TOKEN, platform: 'ios', environment: 'sandbox', bundleId: 'im.freeflow.app' }));
    _setPushSenderForTests(new Scripted([{ ok: false, status: 410, reason: 'Unregistered', retryable: false, disableDevice: true }]));
    await mentionBob();
    await run(() => drainDuePushes(log));
    expect(pending()[0]!.failedAt).not.toBeNull();
    const device = withDb(db, () => db.select().from(schema.deviceTokens).where(eq(schema.deviceTokens.token, TOKEN)).get());
    expect(device!.disabledAt).not.toBeNull();
    // The next mention finds no live device, so nothing is queued.
    await mentionBob();
    expect(pending()).toHaveLength(1);
  });

  it('gives up after four attempts', async () => {
    await run(() => registerDevice(BOB, { token: TOKEN, platform: 'ios', environment: 'sandbox', bundleId: 'im.freeflow.app' }));
    _setPushSenderForTests(new Scripted([{ ok: false, reason: 'transport: Network connection lost', retryable: true, disableDevice: false }]));
    await mentionBob();
    for (let i = 0; i < 4; i++) {
      withDb(db, () => db.update(schema.pendingPush).set({ nextAttemptAt: new Date(0) }).run());
      await run(() => drainDuePushes(log));
    }
    const [row] = pending();
    expect(row!.attempts).toBe(4);
    expect(row!.failedAt).not.toBeNull();
    expect(withDb(db, nextPushDueAt)).toBeNull();
  });
});
