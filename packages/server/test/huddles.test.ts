// Huddles on the Node server: the transient in-memory roster store, and the
// service on top of it. Huddles moved to Meet on the Worker
// (docs/specs/meetings.md phase 2), so this server refuses to start one and
// only keeps leave working for old clients.
//
// The store half is pure and needs no database; the service half does, so
// this uses the same scratch-database setup as indicators.test.ts (docker
// compose in packages/infra, host port 5442).
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = process.env.FLOW_TEST_DATABASE_URL
  ?? 'postgres://flow:flow_dev@localhost:5442/flow_huddles_test';
process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
process.env.FLOW_FILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-huddles-test-'));
delete process.env.FLOW_BLOB_DRIVER;
// #436: the ring is 30s in production. Tests wait on it, so shrink it here —
// read once at module load by services/huddleInvites.ts.
process.env.FLOW_HUDDLE_RING_MS = '150';

{
  const { default: postgres } = await import('postgres');
  const url = new URL(process.env.DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`).catch(() => {}); // 42P04 duplicate_database
  await admin.end();
}

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const auth = await import('../src/services/auth.js');
const ws = await import('../src/services/workspaces.js');
const ch = await import('../src/services/channels.js');
const store = await import('../src/huddles.js');
const hd = await import('../src/services/huddles.js');
const hi = await import('../src/services/huddleInvites.js');
const presence = await import('../src/presence.js');

let aliceId = '';
let bobId = '';
let outsiderId = ''; // workspace member, not in `channelId`
let workspaceId = '';
let channelId = '';
let privateId = ''; // private channel: alice + bob only
let dmId = '';
let groupDmId = '';
let archivedId = '';

async function registerHuman(email: string, name: string): Promise<string> {
  const res = await auth.register(email, { password: 'password123', displayName: name, autoVerify: true });
  if (!('token' in res)) throw new Error('expected autoVerify session');
  return res.user.id;
}

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!);
  const { db, schema } = await import('../src/db/index.js');
  await db.execute(`TRUNCATE users, workspaces, sessions, invites, pending_signups RESTART IDENTITY CASCADE` as never);
  aliceId = await registerHuman('alice@example.test', 'Alice');
  bobId = await registerHuman('bob@example.test', 'Bob');
  outsiderId = await registerHuman('outsider@example.test', 'Outsider');

  const w = await ws.createWorkspace(aliceId, 'Huddles Test', `hud-${randomUUID().slice(0, 8)}`);
  workspaceId = w.id;
  const { workspaceMembers } = schema;
  for (const uid of [bobId, outsiderId]) {
    await db.insert(workspaceMembers).values({ workspaceId, userId: uid, role: 'member' });
  }

  const chan = await ch.createChannel(workspaceId, aliceId, 'work');
  channelId = chan.id;
  await ch.addMember(channelId, aliceId, bobId);

  const priv = await ch.createChannel(workspaceId, aliceId, 'secret', undefined, true);
  privateId = priv.id;
  await ch.addMember(privateId, aliceId, bobId);

  const dm = await ch.createDm(workspaceId, aliceId, [bobId]);
  dmId = dm.id;

  const groupDm = await ch.createDm(workspaceId, aliceId, [bobId, outsiderId]);
  groupDmId = groupDm.id;

  const toArchive = await ch.createChannel(workspaceId, aliceId, 'stale');
  archivedId = toArchive.id;
  await ch.archiveChannel(archivedId, aliceId);
});

afterAll(async () => {
  await closeDb();
  fs.rmSync(process.env.FLOW_FILE_DIR!, { recursive: true, force: true });
});

beforeEach(async () => {
  store.resetHuddles();
  hi.resetHuddleInviteTimers();
  presence.resetPresence();
  const { db, schema } = await import('../src/db/index.js');
  await db.delete(schema.huddleInvites);
  await db.delete(schema.messages);
  await db.delete(schema.notifications);
  await db.update(schema.users).set({ statusSuppressAlerts: false });
});

describe('huddle store', () => {
  const CH = 'chan-1';
  const WS = 'ws-1';

  it('reports nothing for a channel with no live huddle', () => {
    expect(store.huddleParticipants(CH)).toEqual([]);
  });

  it('joining adds a participant and reports the roster transition', () => {
    const r = store.joinHuddle(CH, WS, 'u1', 1000);
    expect(r.before).toEqual([]);
    expect(r.after).toEqual([{ userId: 'u1', joinedAt: 1000 }]);
  });

  it('a rejoin is idempotent and keeps the original joinedAt', () => {
    store.joinHuddle(CH, WS, 'u1', 1000);
    const again = store.joinHuddle(CH, WS, 'u1', 5000); // "now" advanced, but same user
    expect(again.before).toEqual([{ userId: 'u1', joinedAt: 1000 }]);
    expect(again.after).toEqual([{ userId: 'u1', joinedAt: 1000 }]); // unchanged
  });

  it('a second joiner keeps the huddle live and both show in the roster', () => {
    store.joinHuddle(CH, WS, 'u1', 1000);
    store.joinHuddle(CH, WS, 'u2', 2000);
    expect(store.huddleParticipants(CH)).toEqual([
      { userId: 'u1', joinedAt: 1000 },
      { userId: 'u2', joinedAt: 2000 },
    ]);
  });

  it('leaving drops one participant; the huddle survives while another remains', () => {
    store.joinHuddle(CH, WS, 'u1', 1000);
    store.joinHuddle(CH, WS, 'u2', 2000);
    const left = store.leaveHuddle(CH, 'u1');
    expect(left.after).toEqual([{ userId: 'u2', joinedAt: 2000 }]);
    expect(left.workspaceId).toBe(WS);
  });

  it('the last leaver ends the huddle', () => {
    store.joinHuddle(CH, WS, 'u1', 1000);
    const left = store.leaveHuddle(CH, 'u1');
    expect(left.after).toEqual([]);
    expect(store.huddleParticipants(CH)).toEqual([]);
  });

  it('leaving a huddle you were never in is a no-op with no known workspace', () => {
    const r = store.leaveHuddle(CH, 'nobody');
    expect(r.before).toEqual([]);
    expect(r.after).toEqual([]);
    expect(r.workspaceId).toBeUndefined();
  });

  it('clearChannelHuddle wipes everyone at once', () => {
    store.joinHuddle(CH, WS, 'u1', 1000);
    store.joinHuddle(CH, WS, 'u2', 2000);
    const cleared = store.clearChannelHuddle(CH);
    expect(cleared.before.map((p) => p.userId).sort()).toEqual(['u1', 'u2']);
    expect(cleared.workspaceId).toBe(WS);
    expect(store.huddleParticipants(CH)).toEqual([]);
  });

  it('reconcileChannel replaces the roster with the full roster from another replica', () => {
    store.joinHuddle(CH, WS, 'stale-user', 1000); // e.g. a leaver the webhook never told us about
    const r = store.reconcileChannel(CH, WS, [{ userId: 'u1', joinedAt: 3000 }]);
    expect(r.before.map((p) => p.userId)).toEqual(['stale-user']);
    expect(r.after).toEqual([{ userId: 'u1', joinedAt: 3000 }]);
  });

  it('reconcileChannel with an empty roster clears the channel', () => {
    store.joinHuddle(CH, WS, 'u1', 1000);
    store.reconcileChannel(CH, WS, []);
    expect(store.huddleParticipants(CH)).toEqual([]);
  });

  it('reports many channels at once, omitting the quiet ones', () => {
    store.joinHuddle('c1', WS, 'u1', 1000);
    const map = store.huddleParticipantsMany(['c1', 'c2']);
    expect(map.get('c1')).toEqual([{ userId: 'u1', joinedAt: 1000 }]);
    expect(map.has('c2')).toBe(false);
  });
});

describe('huddles are not on this server', () => {
  it('refuses to start or answer one (503 huddles_unavailable)', () => {
    expect(hd.huddlesUnavailable()).toMatchObject({ statusCode: 503, code: 'huddles_unavailable' });
  });

  it('leaving removes the participant; leaving twice is a harmless no-op', async () => {
    store.joinHuddle(channelId, workspaceId, aliceId);
    await hd.leaveHuddle(channelId, aliceId);
    expect(store.huddleParticipants(channelId)).toEqual([]);
    await expect(hd.leaveHuddle(channelId, aliceId)).resolves.toBeUndefined();
  });

  it('leave still requires channel access', async () => {
    await expect(hd.leaveHuddle(privateId, outsiderId)).rejects.toThrow(/not found/i);
  });
});
