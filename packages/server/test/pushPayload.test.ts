// APNs payload builder (#248). Two halves:
//
//  - the pure builder, where the properties worth pinning are the ones a phone
//    would show wrong: the title/body strings matching the macOS banner, the
//    custom keys matching the banner's `userInfo` contract (rename one and iOS
//    tap-routing silently stops finding the channel), thread grouping, the
//    sound pref reaching `aps.sound` (#251), and the body staying a preview;
//  - the same builder driven through a real drain and the DEV SENDER, so the
//    artifact under test is the file `xcrun simctl push` accepts.
//
// DB-backed for the second half — scratch database on the dev postgres (docker
// compose in packages/infra, host port 5442).
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = process.env.FLOW_TEST_DATABASE_URL
  ?? 'postgres://flow:flow_dev@localhost:5442/flow_push_payload_test';
process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
const pushDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-push-'));
process.env.FLOW_PUSH_OUTBOX = pushDir;

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
const auth = await import('../src/services/auth.js');
const ws = await import('../src/services/workspaces.js');
const ch = await import('../src/services/channels.js');
const msg = await import('../src/services/messages.js');
const rx = await import('../src/services/reactions.js');
const dev = await import('../src/services/devices.js');
const outbox = await import('../src/services/pushOutbox.js');
const badge = await import('../src/services/badgeSync.js');
const { _setPushSenderForTests, DevPushSender } = await import('../src/push/index.js');
const {
  BODY_MAX_CHARS,
  alertStringsFor,
  buildBadgeSyncPayload,
  buildMutedBadgePayload,
  buildPushPayload,
  badgeSyncHeaders,
  plainText,
  pushHeadersFor,
  SUBTITLE_MAX_CHARS,
  subtitleFor,
  truncate,
} = await import('../src/push/payload.js');
const { eq } = await import('drizzle-orm');

type PushDevice = import('../src/push/index.js').PushDevice;
type ApnsPayload = import('../src/push/index.js').ApnsPayload;
type ApnsHeaders = import('../src/push/index.js').ApnsHeaders;
type PushResult = import('../src/push/index.js').PushResult;
type PushContext = import('../src/push/payload.js').PushContext;

const { deviceTokens, notifications, pendingPush } = schema;

const log = { info: () => {}, warn: () => {} };

class FakeSender {
  sent: Array<{ device: PushDevice; payload: ApnsPayload; headers: ApnsHeaders }> = [];
  async send(device: PushDevice, payload: ApnsPayload, headers: ApnsHeaders): Promise<PushResult> {
    this.sent.push({ device, payload, headers });
    return { ok: true };
  }
}

const ctx = (over: Partial<PushContext> = {}): PushContext => ({
  notificationId: 'n1',
  workspaceId: 'w1',
  channelId: 'c1',
  messageId: 'm1',
  threadRootId: null,
  kind: 0,
  actorName: 'Alice',
  reactionEmoji: null,
  body: 'standup in 5?',
  names: {},
  conversationName: 'alerts',
  channelKind: 'standard',
  soloDmWithActor: false,
  ...over,
});

// ---- the pure builder -------------------------------------------

describe('alert strings match the macOS banner', () => {
  it('titles each kind the way SyncEngine does', () => {
    expect(alertStringsFor(ctx({ kind: 1 })).title).toBe('Alice');
    expect(alertStringsFor(ctx({ kind: 2 })).title).toBe('Alice replied in a thread');
    expect(alertStringsFor(ctx({ kind: 4, reactionEmoji: '👍' })).title).toBe('Alice reacted 👍');
    expect(alertStringsFor(ctx({ kind: 5 })).title).toBe('Alice added you to a channel');
    expect(alertStringsFor(ctx({ kind: 0 })).title).toBe('Alice mentioned you');
  });

  it('falls back the way the Mac does when the actor is unknown', () => {
    expect(alertStringsFor(ctx({ kind: 1, actorName: null })).title).toBe('New direct message');
    expect(alertStringsFor(ctx({ kind: 2, actorName: null })).title).toBe('Someone replied in a thread');
  });

  it('renders mention tokens rather than leaking them', () => {
    const id = '018f0000-0000-7000-8000-000000000001';
    expect(plainText(`hey <@${id}> and <!channel>`, { [id]: 'Bob' })).toBe('hey @Bob and @channel');
    // an id nobody knows reads "@someone", exactly as MentionRendering does
    expect(plainText(`hey <@${id}>`)).toBe('hey @someone');
  });

  it('flattens a multi-line body into one line', () => {
    expect(alertStringsFor(ctx({ body: 'one\n\ntwo   three' })).body).toBe('one two three');
  });
});

// #466/#472. Kind 3 is a followed channel's ordinary traffic — nobody was
// mentioned — and it used to fall through the `default:` to the mention title.
// Latent (the outbox never sends a kind-3 push, and `suppressAlertFor` is not
// this issue's business), so these tests are the only place the strings are
// seen until the day kind 3 is allowed to alert.
describe('channel activity says so instead of claiming a mention (#466/#472)', () => {
  it('names the channel, and never says anyone mentioned anyone', () => {
    const alert = alertStringsFor(ctx({ kind: 3 }));
    expect(alert.title).toBe('New activity in #alerts');
    expect(alert.title).not.toContain('mentioned');
    expect(alert.body).toBe('standup in 5?');
  });

  it('drops the subtitle its own title already said — the soloDmWithActor rule', () => {
    // "New activity in #alerts / #alerts / standup in 5?" spends a row saying
    // nothing, so the row goes. Every other kind keeps it: their titles name a
    // person, not a place.
    expect(alertStringsFor(ctx({ kind: 3 })).subtitle).toBeUndefined();
    expect(alertStringsFor(ctx({ kind: 0 })).subtitle).toBe('#alerts');
  });

  it('stays a sentence with the preview off', () => {
    expect(alertStringsFor(ctx({ kind: 3 }), false)).toEqual({ title: 'New activity in #alerts' });
    expect(alertStringsFor(ctx({ kind: 0 }), false)).toEqual({ title: 'Alice mentioned you', subtitle: '#alerts' });
  });

  it('falls back to a generic title when hydration could not name the channel', () => {
    // No name to put in the title, so the subtitle has nothing to echo and
    // there is nothing for it to show either — both fall back cleanly.
    expect(alertStringsFor(ctx({ kind: 3, conversationName: null }))).toEqual({
      title: 'New channel activity',
      body: 'standup in 5?',
    });
    expect(alertStringsFor(ctx({ kind: 3, conversationName: null }), false)).toEqual({
      title: 'New channel activity',
    });
  });

  it('uses the bare name in a DM-shaped conversation, not a # that reads as a channel', () => {
    expect(alertStringsFor(ctx({ kind: 3, conversationName: 'Alice, Carol', channelKind: 'group_dm' })).title)
      .toBe('New activity in Alice, Carol');
  });

  it('claims a mention for exactly one kind', () => {
    const mentioning = ([0, 1, 2, 3, 4, 5] as const).filter((kind) =>
      alertStringsFor(ctx({ kind, reactionEmoji: '\u{1F44D}' })).title.includes('mentioned'),
    );
    expect(mentioning).toEqual([0]);
  });
});

describe('the subtitle says which conversation it came from (#460)', () => {
  it('prefixes a channel with # and leaves a DM name bare', () => {
    expect(subtitleFor({ conversationName: 'alerts', channelKind: 'standard', soloDmWithActor: false })).toBe('#alerts');
    // A DM named by someone other than its sender — a group DM, or the 1:1 rule
    // below not firing — keeps the name bare: a `#` in front of a person reads
    // as a channel that does not exist.
    expect(subtitleFor({ conversationName: 'Alice', channelKind: 'dm', soloDmWithActor: false })).toBe('Alice');
    expect(subtitleFor({ conversationName: 'Alice, Carol', channelKind: 'group_dm', soloDmWithActor: false }))
      .toBe('Alice, Carol');
  });

  it('drops the row in a 1:1 DM, where the counterpart is the sender', () => {
    const dm = { conversationName: 'Alice', channelKind: 'dm' as const, soloDmWithActor: true };
    expect(subtitleFor(dm)).toBeUndefined();
    // The rule is who the counterpart is, not whether the strings match — so it
    // holds for the titles that are not a bare name either.
    expect(alertStringsFor(ctx({ kind: 1, ...dm }), false)).toEqual({ title: 'Alice sent you a message' });
    expect(alertStringsFor(ctx({ kind: 4, reactionEmoji: '👍', ...dm })).subtitle).toBeUndefined();
    // A group DM keeps its row: there the names are the ones the title leaves out.
    expect(subtitleFor({ conversationName: 'Alice, Carol', channelKind: 'group_dm', soloDmWithActor: false }))
      .toBe('Alice, Carol');
  });

  it('omits the row rather than showing an empty one when the name is unknown', () => {
    expect(subtitleFor({ conversationName: null, channelKind: 'standard', soloDmWithActor: false })).toBeUndefined();
    expect(subtitleFor({ conversationName: '   ', channelKind: 'dm', soloDmWithActor: false })).toBeUndefined();
    expect(alertStringsFor(ctx({ conversationName: null })).subtitle).toBeUndefined();
  });

  it('caps a group DM whose member list would run past the banner', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Member ${i}`).join(', ');
    const subtitle = subtitleFor({ conversationName: long, channelKind: 'group_dm', soloDmWithActor: false })!;
    expect([...subtitle]).toHaveLength(SUBTITLE_MAX_CHARS);
    expect(subtitle.endsWith('\u2026')).toBe(true);
  });

  it('rides in the alert as its own row, between title and body', () => {
    const p = buildPushPayload(ctx(), 1);
    expect(p.aps.alert).toEqual({
      title: 'Alice mentioned you',
      subtitle: '#alerts',
      body: 'standup in 5?',
    });
  });
});

describe('the body is a preview, not the message', () => {
  it('truncates well below the 4 KB cap', () => {
    const long = 'x'.repeat(BODY_MAX_CHARS * 3);
    const body = alertStringsFor(ctx({ body: long })).body!;
    expect([...body]).toHaveLength(BODY_MAX_CHARS);
    expect(body.endsWith('…')).toBe(true);
  });

  it('never slices a multi-byte character in half', () => {
    const body = truncate('👍'.repeat(10), 5);
    expect([...body]).toHaveLength(5);
    expect(body).toBe('👍👍👍👍…');
  });

  it('keeps the whole payload under Apple’s alert cap', () => {
    const payload = buildPushPayload(ctx({ body: '🎉'.repeat(5_000) }), 3);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(4096);
  });

  it('omits body entirely when a message has none (a deleted one)', () => {
    expect(alertStringsFor(ctx({ body: '' })).body).toBeUndefined();
  });
});

describe('the operator switch (PUSH_APNS.md open question 1)', () => {
  it('option (b) sends no body, and gives a DM the verb its title lacks', () => {
    expect(alertStringsFor(ctx({ kind: 1, conversationName: 'Alice', channelKind: 'dm' }), false)).toEqual({
      title: 'Alice sent you a message',
      subtitle: 'Alice', // a DM the 1:1 rule does not fire on still says where
    });
    expect(alertStringsFor(ctx({ kind: 0 }), false)).toEqual({ title: 'Alice mentioned you', subtitle: '#alerts' });
  });

  it('reads the config default, so reversing the ruling is one env var', () => {
    const before = process.env.FLOW_PUSH_BODY_PREVIEW;
    try {
      process.env.FLOW_PUSH_BODY_PREVIEW = '0';
      expect(alertStringsFor(ctx()).body).toBeUndefined();
      process.env.FLOW_PUSH_BODY_PREVIEW = '1';
      expect(alertStringsFor(ctx()).body).toBe('standup in 5?');
    } finally {
      if (before === undefined) delete process.env.FLOW_PUSH_BODY_PREVIEW;
      else process.env.FLOW_PUSH_BODY_PREVIEW = before;
    }
  });
});

describe('the custom keys are the macOS banner contract', () => {
  it('carries exactly the userInfo keys, plus notificationId', () => {
    const p = buildPushPayload(ctx({ threadRootId: 'root-1' }), 7);
    expect(Object.keys(p).filter((k) => k !== 'aps').sort()).toEqual([

      'channelId',
      'kind',
      'messageId',
      'notificationId',
      'threadRootId',
      'workspaceId',
    ]);
    expect(p.workspaceId).toBe('w1');
    expect(p.channelId).toBe('c1');
    expect(p.messageId).toBe('m1');
    expect(p.threadRootId).toBe('root-1');
    expect(p.notificationId).toBe('n1');
  });

  it('omits threadRootId for a top-level message', () => {
    expect('threadRootId' in buildPushPayload(ctx(), 1)).toBe(false);
  });

  it('groups on the channel and carries the server-authoritative badge', () => {
    const p = buildPushPayload(ctx(), 7);
    expect(p.aps.badge).toBe(7);
    expect(p.aps.sound).toBe('default');
    expect(p.aps['thread-id']).toBe('c1');
  });

  // #251. Omitted, not empty: APNs plays the default for a sound name it
  // cannot resolve, so `sound: ''` would ring.
  it('omits the sound key entirely when the sound pref is off', () => {
    const p = buildPushPayload(ctx(), 7, false);
    expect('sound' in p.aps).toBe(false);
    expect(p.aps.alert).toBeDefined();
    expect(p.aps.badge).toBe(7);
  });
});

describe('headers', () => {
  it('are an immediate alert expiring in about an hour', () => {
    const h = pushHeadersFor(ctx());
    expect(h.pushType).toBe('alert');
    expect(h.priority).toBe(10);
    expect(h.expiration! - Math.floor(Date.now() / 1000)).toBeGreaterThan(3_500);
    expect(h.expiration! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3_600);
  });

  // #251: collapse-id is gone. It only ever fired for kind 3, which
  // `suppressAlertFor` never alerts on, so no push ever carried one; and
  // collapsing the kinds that DO push would replace unread mentions with the
  // newest. `thread-id` is the grouping a busy channel actually wanted.
  it('never collapse — a replaced alert is a mention nobody saw', () => {
    for (const kind of [0, 1, 2, 3, 4, 5] as const) {
      expect(pushHeadersFor(ctx({ kind })).collapseId).toBeUndefined();
    }
  });

  it('send a muted push power-considerate: a badge nobody is woken for', () => {
    const h = pushHeadersFor(ctx(), true);
    expect(h.pushType).toBe('alert');
    expect(h.priority).toBe(5);
    expect(buildMutedBadgePayload(4)).toEqual({ aps: { badge: 4 } });
  });

  it('send the silent badge-sync power-considerate and contentless', () => {
    expect(buildBadgeSyncPayload(4)).toEqual({ aps: { badge: 4, 'content-available': 1 } });
    const h = badgeSyncHeaders();
    expect(h.pushType).toBe('background');
    expect(h.priority).toBe(5);
  });
});

// ---- through a real drain ---------------------------------------

let aliceId = '';
let bobId = '';
let carolId = '';
let workspaceId = '';
let channelId = '';
let dmId = '';
let groupDmId = '';

async function registerHuman(email: string, name: string): Promise<string> {
  const res = await auth.register(email, { password: 'password123', displayName: name, autoVerify: true });
  if (!('token' in res)) throw new Error('expected autoVerify session');
  return res.user.id;
}

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!);
  await db.execute(`TRUNCATE users, workspaces, sessions, invites, pending_signups RESTART IDENTITY CASCADE` as never);
  aliceId = await registerHuman('alice@example.test', 'Alice');
  bobId = await registerHuman('bob@example.test', 'Bob');
  const w = await ws.createWorkspace(aliceId, 'Push Payload Test', `push-${randomUUID().slice(0, 8)}`);
  workspaceId = w.id;
  await db.insert(schema.workspaceMembers).values({ workspaceId, userId: bobId, role: 'member' });
  const chan = await ch.createChannel(workspaceId, aliceId, 'alerts');
  channelId = chan.id;
  await ch.addMember(channelId, aliceId, bobId);
  // #460: the two conversations with no `name` column of their own.
  carolId = await registerHuman('carol@example.test', 'Carol');
  await db.insert(schema.workspaceMembers).values({ workspaceId, userId: carolId, role: 'member' });
  dmId = (await ch.createDm(workspaceId, aliceId, [bobId])).id;
  groupDmId = (await ch.createDm(workspaceId, aliceId, [bobId, carolId])).id;
});

beforeEach(async () => {
  await db.delete(pendingPush);
  await db.delete(notifications);
  await db.delete(deviceTokens);
  badge._resetBadgeSyncForTests();
  await dev.registerDevice(bobId, {
    token: 'a'.repeat(64),
    platform: 'ios',
    environment: 'sandbox',
    bundleId: 'im.freeflow.app',
  });
});

afterAll(async () => {
  _setPushSenderForTests(null);
  badge._resetBadgeSyncForTests();
  await fs.rm(pushDir, { recursive: true, force: true });
  await closeDb();
});

/** `addReaction` writes its notification without the caller awaiting it, so a
 * drain fired the same tick can find an empty outbox. */
async function waitForPendingPush(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await db.select().from(pendingPush)).length > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no pending_push row was ever written');
}

function useFake(): FakeSender {
  const s = new FakeSender();
  _setPushSenderForTests(s);
  return s;
}

describe('the drain hydrates a real notification', () => {
  it('builds the documented payload for a mention', async () => {
    const sender = useFake();
    await msg.sendMessage(channelId, aliceId, randomUUID(), `standup in 5, <@${bobId}>?`, undefined, undefined, [bobId]);
    await outbox.drainPendingPush(log);

    expect(sender.sent).toHaveLength(1);
    const { payload, headers } = sender.sent[0]!;
    expect(payload.aps.alert).toEqual({
      title: 'Alice mentioned you',
      subtitle: '#alerts',
      body: 'standup in 5, @Bob?',
    });
    expect(payload.aps.badge).toBe(1);
    expect(payload.aps['thread-id']).toBe(channelId);
    expect(payload.workspaceId).toBe(workspaceId);
    expect(payload.channelId).toBe(channelId);
    expect(payload.notificationId).toBe((await db.select().from(notifications))[0]!.id);
    expect(headers.pushType).toBe('alert');
    expect(headers.collapseId).toBeUndefined();
  });

  it('names the thread root on a reply, and titles it as a reply', async () => {
    const sender = useFake();
    const root = await msg.sendMessage(channelId, bobId, randomUUID(), 'thread root');
    await db.delete(pendingPush);
    await db.delete(notifications);
    await msg.sendMessage(channelId, aliceId, randomUUID(), 'me too', root.id);
    await outbox.drainPendingPush(log);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.payload.threadRootId).toBe(root.id);
    expect(sender.sent[0]!.payload.aps.alert?.title).toBe('Alice replied in a thread');
  });

  it('titles a reaction with its emoji and the message it landed on', async () => {
    const sender = useFake();
    const m = await msg.sendMessage(channelId, bobId, randomUUID(), 'ship it');
    await db.delete(pendingPush);
    await rx.addReaction(m.id, aliceId, '🎉');
    await outbox.drainPendingPush(log);

    const alert = sender.sent.at(-1)!.payload.aps.alert;
    expect(alert?.title).toBe('Alice reacted 🎉');
    expect(alert?.body).toBe('ship it');
  });

  it('counts every unread row in the badge, not just this one', async () => {
    const sender = useFake();
    for (const n of [1, 2, 3]) {
      await msg.sendMessage(channelId, aliceId, randomUUID(), `ping ${n} <@${bobId}>`, undefined, undefined, [bobId]);
    }
    await outbox.drainPendingPush(log);
    expect(sender.sent.map((s) => s.payload.aps.badge)).toEqual([3, 3, 3]);
  });

  it('writes a simctl-ready file through the dev driver', async () => {
    _setPushSenderForTests(new DevPushSender(pushDir));
    await msg.sendMessage(channelId, aliceId, randomUUID(), `simctl <@${bobId}>`, undefined, undefined, [bobId]);
    await outbox.drainPendingPush(log);

    const files = (await fs.readdir(pushDir)).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const written = JSON.parse(await fs.readFile(path.join(pushDir, files.at(-1)!), 'utf8'));
    // `xcrun simctl push <device> <file>` needs exactly this key to route it.
    expect(written['Simulator Target Bundle']).toBe('im.freeflow.app');
    expect(written.aps.alert.title).toBe('Alice mentioned you');
    expect(written.channelId).toBe(channelId);
  });

  it('shows the channel the thread lives in, not the thread', async () => {
    const sender = useFake();
    const root = await msg.sendMessage(channelId, bobId, randomUUID(), 'thread root');
    await db.delete(pendingPush);
    await db.delete(notifications);
    await msg.sendMessage(channelId, aliceId, randomUUID(), 'me too', root.id);
    await waitForPendingPush();
    await outbox.drainPendingPush(log);

    expect(sender.sent[0]!.payload.aps.alert).toEqual({
      title: 'Alice replied in a thread',
      subtitle: '#alerts',
      body: 'me too',
    });
  });

  it('gives a 1:1 DM no subtitle — its counterpart is the sender the title names', async () => {
    const sender = useFake();
    await msg.sendMessage(dmId, aliceId, randomUUID(), 'lunch?');
    await waitForPendingPush();
    await outbox.drainPendingPush(log);

    // Bob's phone. "Alice / Alice / lunch?" spends a row saying nothing, so the
    // row goes (operator ruling on #460) — the title already says where.
    expect(sender.sent[0]!.payload.aps.alert).toEqual({ title: 'Alice', body: 'lunch?' });
  });

  it('drops the row even when the 1:1 DM notification is a reaction', async () => {
    const sender = useFake();
    const m = await msg.sendMessage(dmId, bobId, randomUUID(), 'ship it');
    await db.delete(pendingPush);
    await db.delete(notifications);
    await rx.addReaction(m.id, aliceId, '🎉');
    await waitForPendingPush();
    await outbox.drainPendingPush(log);

    // Still Alice on both rows, so the subtitle still goes — the rule is who
    // the counterpart is, not how the title happens to be phrased.
    expect(sender.sent.at(-1)!.payload.aps.alert?.subtitle).toBeUndefined();
    expect(sender.sent.at(-1)!.payload.aps.alert?.title).toBe('Alice reacted 🎉');
  });

  it('subtitles a group DM with the other members, sorted', async () => {
    const sender = useFake();
    await msg.sendMessage(groupDmId, aliceId, randomUUID(), 'all three of us');
    await waitForPendingPush();
    await outbox.drainPendingPush(log);

    const forBob = sender.sent.find((s) => s.device.token === 'a'.repeat(64))!;
    expect(forBob.payload.aps.alert?.subtitle).toBe('Alice, Carol');
  });

  it('pushes no preview for a message deleted before the drain ran', async () => {
    const sender = useFake();
    const m = await msg.sendMessage(channelId, aliceId, randomUUID(), `secret <@${bobId}>`, undefined, undefined, [bobId]);
    await db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, m.id));
    await outbox.drainPendingPush(log);
    expect(sender.sent[0]!.payload.aps.alert).toEqual({ title: 'Alice mentioned you', subtitle: '#alerts' });
  });
});
