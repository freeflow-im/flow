// Alerts in the suite bar (shared/alerts.ts), the Org object's half: who an alert goes to (never someone the sender
// picks), the suite bar's alerts-only socket (no Chat events, no presence), and the push to that person's sockets alone.
// Run through the Org object itself, over node:sqlite.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgStorage } from '../../test/orgStorage';
import { Org } from './object';
import { withDb, schema, type DB } from './db/index';
import { createWorkspace } from './services/workspaces';
import { addMember, createChannel } from './services/channels';

const ANN = '00000000-0000-7000-8000-00000000000a'; // owner; sponsor of Ada and of Helper
const CAL = '00000000-0000-7000-8000-00000000000c'; // a member
const ADA = '00000000-0000-7000-8000-00000000000e'; // Ann's assistant (a hosted personal agent)
const BOT = '00000000-0000-7000-8000-00000000000d'; // a shared agent Ann made
const ORPHAN = '00000000-0000-7000-8000-00000000000f'; // a shared agent with no owner
const acct = (u: string) => `acct-${u.slice(-1)}`;

beforeAll(() => {
  process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
  (globalThis as Record<string, unknown>).WebSocketRequestResponsePair ??= class { constructor(public a: string, public b: string) {} };
});

/** A socket as the object sees it: its attachment and what it was sent. */
class FakeSocket {
  att: unknown = null;
  sent: Record<string, unknown>[] = [];
  closed: number | null = null;
  serializeAttachment(a: unknown) { this.att = a; }
  deserializeAttachment() { return this.att; }
  send(text: string) { this.sent.push(JSON.parse(text) as Record<string, unknown>); }
  close(code: number) { this.closed = code; }
}

let org: Org;
let db: DB;
let workspaceId: string;
let sockets: FakeSocket[];

beforeEach(async () => {
  sockets = [];
  const made = orgStorage({ bare: true });
  const store = new Map<string, unknown>();
  const storage = { ...made.storage, get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => { store.set(k, v); }, delete: async (k: string) => store.delete(k), setAlarm: async () => {}, deleteAlarm: async () => {} };
  const ctx = { storage, getWebSockets: () => sockets, acceptWebSocket: () => {}, setWebSocketAutoResponse: () => {}, blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(), waitUntil: () => {} };
  // The directory knows one session token, Cal's.
  const directory = {
    call: async (name: string, args: unknown[]) => {
      if (name === 'applyOrgChanges') return { ok: true, value: null };
      if (name === 'authenticateIn' && args[0] === 'cal-session') {
        return { ok: true, value: { user: { id: CAL, email: 'cal@x.test', displayName: 'Cal' }, account: { id: acct(CAL), state: 'active', organizationId: workspaceId } } };
      }
      if (name === 'accountById') return { ok: true, value: null };
      return { ok: false, status: 401, code: 'stub', message: 'stub' };
    },
  };
  const env = { DIRECTORY: { idFromName: () => 'd', get: () => directory }, ASSISTANT: {} };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  org = new Org(ctx as never, env as never);
  db = (org as unknown as { db: DB }).db;
  await withDb(db, async () => {
    db.insert(schema.users).values({ id: ANN, email: 'ann@x.test', passwordHash: '!', displayName: 'Ann Lee' }).run();
    db.insert(schema.users).values({ id: CAL, email: 'cal@x.test', passwordHash: '!', displayName: 'Cal' }).run();
    db.insert(schema.users).values({ id: ADA, email: 'ada@agents.test', passwordHash: '!', displayName: 'Ada', isAgent: true }).run();
    db.insert(schema.users).values({ id: BOT, email: 'bot@agents.test', passwordHash: '!', displayName: 'Helper', isAgent: true, sponsorUserId: ANN }).run();
    db.insert(schema.users).values({ id: ORPHAN, email: 'orphan@agents.test', passwordHash: '!', displayName: 'Orphan', isAgent: true }).run();
    workspaceId = (await createWorkspace(ANN, 'Locked In', 'locked-in')).id;
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: CAL, role: 'member', accountId: acct(CAL) }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: ADA, role: 'member', kind: 'personal_agent', runtime: 'hosted', sponsorUserId: ANN, accountId: acct(ADA) }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: BOT, role: 'member', accountId: acct(BOT) }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: ORPHAN, role: 'member', accountId: acct(ORPHAN) }).run();
  });
  sql().exec('UPDATE workspace_members SET account_id = ? WHERE user_id = ?', acct(ANN), ANN);
});
afterEach(() => vi.restoreAllMocks());

const sql = () => (org as unknown as { ctx: { storage: { sql: SqlStorage } } }).ctx.storage.sql;
const together = async (...userIds: string[]) => {
  const c = await withDb(db, () => createChannel(workspaceId, ANN, `room-${userIds.join('-').slice(-6)}`));
  for (const u of userIds) if (u !== ANN) await withDb(db, () => addMember(c.id, ANN, u));
};

describe('who an alert goes to', () => {
  it('is the person themself when a person sends it', async () => {
    expect(await org.alertRecipientOf(acct(CAL))).toEqual({ accountId: acct(CAL) });
    // Whoever they name as asking: still themself.
    expect(await org.alertRecipientOf(acct(CAL), acct(ANN))).toEqual({ accountId: acct(CAL) });
  });

  it('is a personal agent’s sponsor, whoever it says asked', async () => {
    expect(await org.alertRecipientOf(acct(ADA), acct(CAL))).toEqual({ accountId: acct(ANN), agentName: 'Ada' });
  });

  it('is the person a shared agent works for when they share a channel, else its owner', async () => {
    // Cal asked, but has no channel with Helper: the owner gets it.
    expect(await org.alertRecipientOf(acct(BOT), acct(CAL))).toEqual({ accountId: acct(ANN), agentName: 'Helper' });
    await together(CAL, BOT);
    expect(await org.alertRecipientOf(acct(BOT), acct(CAL))).toEqual({ accountId: acct(CAL), agentName: 'Helper' });
    // An agent named as asking is no person to alert; no one named: the owner.
    expect(await org.alertRecipientOf(acct(BOT), acct(ADA))).toEqual({ accountId: acct(ANN), agentName: 'Helper' });
    expect(await org.alertRecipientOf(acct(BOT))).toEqual({ accountId: acct(ANN), agentName: 'Helper' });
  });

  it('is no one for an agent with no owner and no asker, or an unknown account', async () => {
    expect(await org.alertRecipientOf(acct(ORPHAN))).toBeNull();
    expect(await org.alertRecipientOf('acct-nobody')).toBeNull();
  });
});

describe('the suite bar’s socket', () => {
  it('signs in with the session cookie it opened with, and gets alerts only', async () => {
    const bar = new FakeSocket();
    bar.att = { accountId: null, sessionToken: 'cal-session' };
    sockets.push(bar);
    await org.webSocketMessage(bar as never, JSON.stringify({ op: 'auth', alerts: true }));
    expect(bar.sent[0]).toMatchObject({ op: 'hello' });
    expect(bar.att).toEqual({ userId: CAL, accountId: acct(CAL), alertsOnly: true });
    // No presence frames, and a Chat event does not reach it.
    expect(bar.sent).toHaveLength(1);
    await together(ANN, CAL);
    expect(bar.sent).toHaveLength(1);
  });

  it('is refused without a token: a Chat socket never uses the cookie', async () => {
    const chat = new FakeSocket();
    chat.att = { accountId: null, sessionToken: 'cal-session' };
    sockets.push(chat);
    await org.webSocketMessage(chat as never, JSON.stringify({ op: 'auth' }));
    expect(chat.closed).toBe(4003);
  });

  it('gets the alerts for its own account, and other sockets do not', () => {
    const mine = new FakeSocket();
    mine.att = { userId: CAL, accountId: acct(CAL), alertsOnly: true };
    const theirs = new FakeSocket();
    theirs.att = { userId: ANN, accountId: acct(ANN), alertsOnly: true };
    const chat = new FakeSocket();
    chat.att = { userId: CAL, accountId: acct(CAL) };
    sockets.push(mine, theirs, chat);
    const frame = { op: 'alert' as const, type: 'alert.created' as const, seq: 7, data: { alertId: 'a1', kind: 'Alert', title: 'Hi', lines: [], actions: [], endsAt: '2030-01-01T00:00:00.000Z' } };
    expect(org.pushAlert(acct(CAL), frame)).toBe(1);
    expect(mine.sent).toEqual([frame]);
    expect(theirs.sent).toEqual([]);
    expect(chat.sent).toEqual([]);
  });
});
