// Per-channel unread counts (#71): your own messages must never badge, and
// posting advances your read cursor. DB-backed — scratch database on the dev
// postgres (docker compose in packages/infra, host port 5442).
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';

process.env.DATABASE_URL = process.env.FLOW_TEST_DATABASE_URL
  ?? 'postgres://flow:flow_dev@localhost:5442/flow_unread_test';
process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');

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
const { and, desc, eq, isNull } = await import('drizzle-orm');
const { encryptBody } = await import('../src/crypto/index.js');
const { newId } = await import('../src/lib/ids.js');
const { _resetBadgeSyncForTests } = await import('../src/services/badgeSync.js');

const { channelMembers, messages, notifications } = schema;

let aliceId = '';
let bobId = '';
let workspaceId = '';
let channelId = ''; // standard channel: alice, bob
let dmChannelId = ''; // alice ↔ bob DM

async function registerHuman(email: string, name: string): Promise<string> {
  const res = await auth.register(email, { password: 'password123', displayName: name, autoVerify: true });
  if (!('token' in res)) throw new Error('expected autoVerify session');
  return res.user.id;
}

async function unreadFor(userId: string, chanId: string): Promise<number> {
  const list = await ch.listChannels(workspaceId, userId);
  return list.find((c) => c.id === chanId)?.unreadCount ?? -1;
}

async function readCursor(userId: string, chanId: string): Promise<string | null> {
  const rows = await db
    .select({ lastReadMsgId: channelMembers.lastReadMsgId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, chanId), eq(channelMembers.userId, userId)))
    .limit(1);
  return rows[0]?.lastReadMsgId ?? null;
}

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!);
  await db.execute(`TRUNCATE users, workspaces, sessions, invites, pending_signups RESTART IDENTITY CASCADE` as never);
  aliceId = await registerHuman('alice@example.test', 'Alice');
  bobId = await registerHuman('bob@example.test', 'Bob');

  const w = await ws.createWorkspace(aliceId, 'Unread Test', `unread-${randomUUID().slice(0, 8)}`);
  workspaceId = w.id;
  await db.insert(schema.workspaceMembers).values({ workspaceId, userId: bobId, role: 'member' });
  const chan = await ch.createChannel(workspaceId, aliceId, 'standup');
  channelId = chan.id;
  await ch.addMember(channelId, aliceId, bobId);
  const dm = await ch.createDm(workspaceId, aliceId, [bobId]);
  dmChannelId = dm.id;
});

afterAll(async () => {
  // Marking read queued badge syncs on 2 s timers that read the database; forget them before it closes.
  _resetBadgeSyncForTests();
  await closeDb();
});

describe('unread counts ignore your own messages', () => {
  it('a DM message you sent does not badge for you', async () => {
    await msg.sendMessage(dmChannelId, aliceId, randomUUID(), 'note to bob');
    expect(await unreadFor(aliceId, dmChannelId)).toBe(0);
  });

  it("the other party's DM message still badges", async () => {
    await msg.sendMessage(dmChannelId, bobId, randomUUID(), 'hey alice');
    expect(await unreadFor(aliceId, dmChannelId)).toBe(1);
    expect(await unreadFor(bobId, dmChannelId)).toBe(0);
  });

  it('own messages do not badge in a standard channel either', async () => {
    await msg.sendMessage(channelId, aliceId, randomUUID(), 'standup thread starts here');
    await msg.sendMessage(channelId, aliceId, randomUUID(), 'second one');
    expect(await unreadFor(aliceId, channelId)).toBe(0);
    expect(await unreadFor(bobId, channelId)).toBe(2);
  });

  it('a stale read cursor does not resurrect your own messages', async () => {
    // Simulate a client that never advanced the cursor: rewind it to null and
    // confirm only the other party's messages are counted.
    await db
      .update(channelMembers)
      .set({ lastReadMsgId: null })
      .where(and(eq(channelMembers.channelId, dmChannelId), eq(channelMembers.userId, aliceId)));
    expect(await unreadFor(aliceId, dmChannelId)).toBe(1); // bob's message only
  });
});

// The counts for a whole list come from one grouped query: every channel must
// still be measured against its own read cursor, not a neighbour's.
describe('one list, several read cursors', () => {
  it('counts each joined channel past its own cursor', async () => {
    const a = await ch.createChannel(workspaceId, aliceId, `cursor-a-${randomUUID().slice(0, 6)}`);
    const b = await ch.createChannel(workspaceId, aliceId, `cursor-b-${randomUUID().slice(0, 6)}`);
    const c = await ch.createChannel(workspaceId, aliceId, `cursor-c-${randomUUID().slice(0, 6)}`);
    for (const id of [a.id, b.id, c.id]) await ch.addMember(id, aliceId, bobId);
    const send = (id: string, text: string) => msg.sendMessage(id, aliceId, randomUUID(), text);
    const a1 = await send(a.id, 'a1'); await send(a.id, 'a2'); await send(a.id, 'a3');
    await send(b.id, 'b1'); const b2 = await send(b.id, 'b2');
    await send(c.id, 'c1'); await send(c.id, 'c2');
    const setCursor = (id: string, to: string | null) => db.update(channelMembers).set({ lastReadMsgId: to })
      .where(and(eq(channelMembers.channelId, id), eq(channelMembers.userId, bobId)));
    await setCursor(a.id, a1.id); // two unread after it
    await setCursor(b.id, b2.id); // read to the end
    await setCursor(c.id, null); // never read: everything counts

    const list = await ch.listChannels(workspaceId, bobId);
    const byId = new Map(list.map((x) => [x.id, x]));
    expect(byId.get(a.id)?.unreadCount).toBe(2);
    expect(byId.get(b.id)?.unreadCount).toBe(0);
    expect(byId.get(c.id)?.unreadCount).toBe(2);
    expect(byId.get(a.id)?.oldestUnreadThreadReply ?? null).toBeNull();
  });
});

describe('sending advances the read cursor', () => {
  it('a top-level send moves lastReadMsgId to that message', async () => {
    const m = await msg.sendMessage(channelId, bobId, randomUUID(), 'bob checking in');
    expect(await readCursor(bobId, channelId)).toBe(m.id);
    expect(await unreadFor(bobId, channelId)).toBe(0);
  });

  it('a thread reply leaves the channel cursor alone', async () => {
    const newer = await msg.sendMessage(channelId, bobId, randomUUID(), 'newest');
    await db
      .update(channelMembers)
      .set({ lastReadMsgId: newer.id })
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, aliceId)));
    // alice replies in a thread — a reply must not touch the channel cursor
    await msg.sendMessage(channelId, aliceId, randomUUID(), 'threaded reply', newer.id);
    expect(await readCursor(aliceId, channelId)).toBe(newer.id);
  });
});

// #270: a thread hanging off a join/leave line is unreachable — no client
// draws a thread affordance on one — so a notification it raises could never
// be read, and the sidebar badge stuck at 1 for ever.
describe('threads on system messages', () => {
  // Earlier tests in this file leave bob notifications of their own; these
  // assert exact counts, so start each one from a clean inbox.
  beforeEach(async () => {
    await db.delete(notifications).where(eq(notifications.userId, bobId));
  });

  async function systemRootId(): Promise<string> {
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.systemKind, 'member_joined')))
      .limit(1);
    const id = rows[0]?.id;
    if (!id) throw new Error('expected a member_joined line from addMember');
    return id;
  }

  it('refuses a reply to a join/leave line', async () => {
    const root = await systemRootId();
    await expect(msg.sendMessage(channelId, aliceId, randomUUID(), 'reply to a join line', root))
      .rejects.toMatchObject({ code: 'bad_thread_root' });
  });

  it('a channel visit clears a notification already stuck under a system root', async () => {
    // Rows like this exist in the wild, written before the refusal above: a
    // reply under the join line, notifying its author. Forge one directly.
    const root = await systemRootId();
    const replyId = newId();
    const enc = encryptBody('a reply that predates the fix');
    await db.insert(messages).values({
      id: replyId,
      channelId,
      userId: aliceId,
      threadRootId: root,
      clientMsgId: newId(),
      body: enc.body,
      bodyNonce: enc.bodyNonce,
      encKeyId: enc.encKeyId,
      encScheme: enc.encScheme,
    });
    await db.insert(notifications).values({
      id: newId(),
      userId: bobId, // bob authored the join line, so the reply notified him
      messageId: replyId,
      channelId,
      kind: 2,
      actorId: aliceId,
    });

    const before = (await ch.listChannels(workspaceId, bobId)).find((c) => c.id === channelId);
    expect(before?.unreadNotifications).toBe(1);
    // and it is visible on the root's reply chip, not only in the sidebar
    expect(before?.unreadThreadRootIds).toContain(root);

    const newest = (
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.channelId, channelId), isNull(messages.threadRootId)))
        .orderBy(desc(messages.id))
        .limit(1)
    )[0]!.id;
    await ch.markRead(channelId, bobId, newest);

    const after = (await ch.listChannels(workspaceId, bobId)).find((c) => c.id === channelId);
    expect(after?.unreadNotifications).toBe(0);
    expect(after?.unreadThreadRootIds).toEqual([]);
  });

  it('opening the thread still clears an ordinary reply', async () => {
    const root = await msg.sendMessage(channelId, bobId, randomUUID(), 'a real root');
    await msg.sendMessage(channelId, aliceId, randomUUID(), 'a real reply', root.id);

    const before = (await ch.listChannels(workspaceId, bobId)).find((c) => c.id === channelId);
    expect(before?.unreadNotifications).toBe(1);
    expect(before?.unreadThreadRootIds).toEqual([root.id]);

    await ch.markRead(channelId, bobId, root.id, root.id);
    const after = (await ch.listChannels(workspaceId, bobId)).find((c) => c.id === channelId);
    expect(after?.unreadNotifications).toBe(0);
    expect(after?.unreadThreadRootIds).toEqual([]);
  });
});

// #533: the sidebar badge counts every unread row a channel has, thread replies
// included, but a visit used to clear only top-level ones — so the number was
// structurally unclearable from the channel view. A visit now sweeps the
// channel's thread rows too.
describe('a channel visit clears thread-reply notifications', () => {
  let chanId = '';

  beforeEach(async () => {
    const c = await ch.createChannel(workspaceId, aliceId, `t533-${randomUUID().slice(0, 8)}`);
    chanId = c.id;
    await ch.addMember(chanId, aliceId, bobId);
    await db.delete(notifications).where(eq(notifications.userId, bobId));
  });

  async function forBob() {
    return (await ch.listChannels(workspaceId, bobId)).find((c) => c.id === chanId);
  }

  it('clears replies across several threads in one visit', async () => {
    const first = await msg.sendMessage(chanId, bobId, randomUUID(), 'first root');
    const second = await msg.sendMessage(chanId, bobId, randomUUID(), 'second root');
    await msg.sendMessage(chanId, aliceId, randomUUID(), 'reply one', first.id);
    await msg.sendMessage(chanId, aliceId, randomUUID(), 'reply two', first.id);
    await msg.sendMessage(chanId, aliceId, randomUUID(), 'reply three', second.id);

    const before = await forBob();
    expect(before?.unreadNotifications).toBe(3);
    expect(before?.unreadThreadRootIds).toEqual(expect.arrayContaining([first.id, second.id]));

    await ch.markRead(chanId, bobId, second.id); // the visit, no threadRootId

    const after = await forBob();
    expect(after?.unreadNotifications).toBe(0);
    expect(after?.unreadThreadRootIds).toEqual([]);
    expect(after?.oldestUnreadThreadReply).toBeUndefined();
  });

  it('clears a reply whose root sits past the read cursor', async () => {
    // The cursor a client sends is the newest message it has cached, which on a
    // partially loaded transcript can be older than the thread's root. The
    // sweep must not depend on where the cursor landed, or the badge is stuck
    // again for exactly the user who scrolled least.
    const older = await msg.sendMessage(chanId, aliceId, randomUUID(), 'older top-level');
    const root = await msg.sendMessage(chanId, bobId, randomUUID(), 'newer root');
    await msg.sendMessage(chanId, aliceId, randomUUID(), 'a reply', root.id);

    expect((await forBob())?.unreadNotifications).toBe(1);
    await ch.markRead(chanId, bobId, older.id);
    expect((await forBob())?.unreadNotifications).toBe(0);
  });

  it('leaves another channel alone', async () => {
    const root = await msg.sendMessage(chanId, bobId, randomUUID(), 'root here');
    await msg.sendMessage(chanId, aliceId, randomUUID(), 'reply here', root.id);
    const otherRoot = await msg.sendMessage(channelId, bobId, randomUUID(), 'root over there');
    await msg.sendMessage(channelId, aliceId, randomUUID(), 'reply over there', otherRoot.id);

    await ch.markRead(chanId, bobId, root.id);

    expect((await forBob())?.unreadNotifications).toBe(0);
    const other = (await ch.listChannels(workspaceId, bobId)).find((c) => c.id === channelId);
    expect(other?.unreadNotifications).toBe(1);
  });

  it('the cleared state survives a reload of the channel list', async () => {
    const root = await msg.sendMessage(chanId, bobId, randomUUID(), 'bobs root');
    await msg.sendMessage(chanId, aliceId, randomUUID(), 'a reply', root.id);
    await ch.markRead(chanId, bobId, root.id);

    // Rows are flipped server-side, not just zeroed on a client: any fresh read
    // of the list — a relaunched app, another device — sees the same zero.
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, bobId), eq(notifications.channelId, chanId), isNull(notifications.readAt)));
    expect(rows).toEqual([]);
    expect((await forBob())?.unreadNotifications).toBe(0);
  });
});

// #327: when a channel's unreads live only inside a thread, the sidebar row is
// the only sign of them — the main timeline looks unchanged. The channel list
// says which thread to open (and where in it), so one click lands on the unread.
describe('oldest unread inside a thread', () => {
  let chanId = '';

  // A fresh channel and a clean inbox per case: earlier tests in this file
  // leave bob both notifications and unread messages.
  beforeEach(async () => {
    const c = await ch.createChannel(workspaceId, aliceId, `t327-${randomUUID().slice(0, 8)}`);
    chanId = c.id;
    await ch.addMember(chanId, aliceId, bobId);
    await db.delete(notifications).where(eq(notifications.userId, bobId));
  });

  async function forBob() {
    return (await ch.listChannels(workspaceId, bobId)).find((c) => c.id === chanId);
  }

  it('points at the thread when every unread is a reply', async () => {
    const root = await msg.sendMessage(chanId, bobId, randomUUID(), 'bobs root');
    const reply = await msg.sendMessage(chanId, aliceId, randomUUID(), 'first reply', root.id);
    await msg.sendMessage(chanId, aliceId, randomUUID(), 'second reply', root.id);

    const c = await forBob();
    expect(c?.unreadCount).toBe(0); // nothing new in the main timeline
    expect(c?.oldestUnreadThreadReply).toEqual({ rootId: root.id, replyId: reply.id });
  });

  it('stays quiet when the oldest unread is a top-level message', async () => {
    await msg.sendMessage(chanId, aliceId, randomUUID(), 'top-level news');

    const c = await forBob();
    expect(c?.unreadCount).toBe(1);
    expect(c?.oldestUnreadThreadReply).toBeUndefined();
  });

  it('stays quiet with no unreads at all', async () => {
    const c = await forBob();
    expect(c?.unreadCount).toBe(0);
    expect(c?.oldestUnreadThreadReply).toBeUndefined();
  });

  it('lets the main timeline win when an unread top-level message is older', async () => {
    // alice's root is itself unread for bob; his reply makes him a participant
    // so alice's later reply notifies him.
    const root = await msg.sendMessage(chanId, aliceId, randomUUID(), 'alices root');
    await msg.sendMessage(chanId, bobId, randomUUID(), 'bob joins the thread', root.id);
    await msg.sendMessage(chanId, aliceId, randomUUID(), 'alice replies back', root.id);

    const c = await forBob();
    expect(c?.unreadCount).toBe(1); // the root is still unread in the timeline
    expect(c?.unreadThreadRootIds).toEqual([root.id]); // the chip keeps its dot
    expect(c?.oldestUnreadThreadReply).toBeUndefined();
  });

  it('picks the thread holding the oldest unread when several have replies', async () => {
    const first = await msg.sendMessage(chanId, bobId, randomUUID(), 'first root');
    const second = await msg.sendMessage(chanId, bobId, randomUUID(), 'second root');
    const oldest = await msg.sendMessage(chanId, aliceId, randomUUID(), 'reply in first', first.id);
    await msg.sendMessage(chanId, aliceId, randomUUID(), 'reply in second', second.id);

    const c = await forBob();
    expect(c?.oldestUnreadThreadReply).toEqual({ rootId: first.id, replyId: oldest.id });
    // the other thread keeps its own unread indicator
    expect(c?.unreadThreadRootIds).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it('clears once the thread has been read', async () => {
    const root = await msg.sendMessage(chanId, bobId, randomUUID(), 'bobs root');
    const reply = await msg.sendMessage(chanId, aliceId, randomUUID(), 'a reply', root.id);
    expect((await forBob())?.oldestUnreadThreadReply).toEqual({ rootId: root.id, replyId: reply.id });

    await ch.markRead(chanId, bobId, reply.id, root.id); // opening the thread
    expect((await forBob())?.oldestUnreadThreadReply).toBeUndefined();
  });
});
