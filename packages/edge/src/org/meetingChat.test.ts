// Meeting chat (docs/specs/meetings.md §9 3b): each Meet room (not a huddle) has one channel of kind `meeting`, made on
// the first join, with its creator and every member who joined; a date line per session; left out of the channel list
// and of unread (but for @mentions); guests are visitors of it from their join until the session ends. Run through the
// Org object, over node:sqlite, with a stand-in RealtimeKit.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { ChannelDTO, MeetingChatDTO, MeetingDTO, MeetingJoinDTO, MessageDTO, UserDTO } from '@flow/shared';
import { orgStorage } from '../../test/orgStorage';
import { Org } from './object';
import { withDb, schema, type DB } from './db/index';
import { createWorkspace, updateWorkspace } from './services/workspaces';
import { createChannel } from './services/channels';
import { sendMessage } from './services/messages';
import { unreadCount } from './services/notifications';
import { sessionDate } from './services/meetings';
import { _resetRateLimitsForTests } from './lib/rateLimit';

const ANN = '00000000-0000-7000-8000-00000000000a'; // owner, makes the meetings
const BEN = '00000000-0000-7000-8000-00000000000b'; // member who joins
const CAT = '00000000-0000-7000-8000-00000000000c'; // member who never joins
const T0 = Date.parse('2026-11-16T10:00:00Z'); // a Monday
const BASE = 'https://api.cloudflare.com/client/v4/accounts/acct/realtime/kit/app';

beforeAll(() => {
  process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
  Object.assign(process.env, { RTK_ACCOUNT_ID: 'acct', RTK_APP_ID: 'app', RTK_API_TOKEN: 'secret' });
  (globalThis as Record<string, unknown>).WebSocketRequestResponsePair ??= class { constructor(public a: string, public b: string) {} };
});

/** A stand-in RealtimeKit: makes rooms and participants; a session is running while `live` is true. */
let live: boolean;
let rtkCalls: string[];
function fakeRtk() {
  live = false;
  rtkCalls = [];
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${String(url).slice(BASE.length)}`;
    rtkCalls.push(key);
    const ok = (data: unknown) => Response.json({ success: true, data });
    if (key === 'POST /meetings') return ok({ id: `rtk-${++n}` });
    if (/^POST \/meetings\/[^/]+\/participants$/.test(key)) return ok({ id: `p-${++n}`, token: `tok-${n}` });
    if (/^POST \/meetings\/[^/]+\/participants\/[^/]+\/token$/.test(key)) return ok({ token: `tok-${++n}` });
    if (/^GET \/meetings\/[^/]+\/active-session$/.test(key) && live) return ok({ id: 's1', started_at: new Date(T0).toISOString(), live_participants: 1 });
    if (key === 'GET /sessions/s1/participants') return ok([{ custom_participant_id: ANN, display_name: 'Ann Lee', left_at: null }]);
    return Response.json({ success: false }, { status: 404 });
  }));
}

class FakeSocket {
  sent: { op: string; event?: { type: string; data: unknown } }[] = [];
  closed: number | null = null;
  private att: unknown = null;
  send(frame: string) { this.sent.push(JSON.parse(frame)); }
  close(code: number) { this.closed = code; }
  serializeAttachment(a: unknown) { this.att = a; }
  deserializeAttachment() { return this.att; }
}

let db: DB;
let sqlite: DatabaseSync;
let org: Org;
let sockets: FakeSocket[];
let pending: Promise<unknown>[];
let workspaceId: string;

const NAMES: Record<string, string> = { [ANN]: 'Ann Lee', [BEN]: 'Ben Kim', [CAT]: 'Cat Day' };
const user = (id: string): UserDTO => ({
  id, email: `${id}@x.test`, displayName: NAMES[id], avatarUrl: null, timezone: 'UTC', statusEmoji: '', statusText: '', website: '', bio: '', title: '',
  isAgent: false, sponsorId: null, notificationPrefs: {}, statusSuppressAlerts: false, privacyMode: false,
} as unknown as UserDTO);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  _resetRateLimitsForTests();
  delete process.env.TURNSTILE_SECRET;
  fakeRtk();
  sockets = [];
  pending = [];
  const made = orgStorage({ bare: true });
  sqlite = made.sqlite;
  const store = new Map<string, unknown>();
  const storage = {
    ...made.storage,
    get: async (k: string) => store.get(k),
    put: async (k: string, v: unknown) => { store.set(k, v); },
    delete: async (k: string) => store.delete(k),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const ctx = {
    storage,
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
    setWebSocketAutoResponse: () => {},
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
  };
  const env = {
    BLOBS: {},
    DIRECTORY: { idFromName: () => 'd', get: () => ({ call: async (name: string) => (name === 'applyOrgChanges' ? { ok: true, value: null } : { ok: false, status: 500, code: 'stub', message: 'stub' }) }) },
    ASSISTANT: {},
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  org = new Org(ctx as never, env as never);
  db = (org as unknown as { db: DB }).db;
  await withDb(db, async () => {
    for (const [id, name] of Object.entries(NAMES)) {
      db.insert(schema.users).values({ id, email: `${id}@x.test`, passwordHash: '!', displayName: name }).run();
    }
    workspaceId = (await createWorkspace(ANN, 'Locked In', 'locked-in')).id;
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: BEN, role: 'member' }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: CAT, role: 'member' }).run();
  });
});
afterEach(async () => {
  await Promise.allSettled(pending);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

async function call(method: string, path: string, opts: { as?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const caller = {
    user: opts.as ? user(opts.as) : null, token: opts.as ? 'tok' : null, authKind: opts.as ? 'session' : null,
    ip: '10.0.0.1', organizationId: workspaceId, account: null,
  };
  return org.handle(new Request(`https://app.test${path}`, { method, headers, body }), caller as never, null);
}
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

const newMeeting = async (title = 'Design review') => json<MeetingDTO>(await call('POST', `/v1/workspaces/${workspaceId}/meetings`, { as: ANN, body: { title } }));
const joinAs = async (code: string, as: string) => {
  const res = await call('POST', `/v1/meetings/${code}/join`, { as });
  expect(res.status).toBe(200);
  return json<MeetingJoinDTO>(res);
};
async function guestJoin(code: string, name = 'Dana Guest') {
  const res = await call('POST', `/v1/meetings/${code}/guest`, { body: { name } });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie');
  const raw = setCookie ? decodeURIComponent(/vsid=([^;]+)/.exec(setCookie)![1]!) : null;
  return { body: await json<{ chatChannelId: string | null; authToken: string }>(res), setCookie, raw, cookie: raw ? `vsid=${encodeURIComponent(raw)}` : '' };
}
const oldestFirst = (list: MessageDTO[]) => [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const messagesIn = (channelId: string, as = ANN) =>
  call('GET', `/v1/channels/${channelId}/messages`, { as }).then((r) => json<{ messages: MessageDTO[] }>(r)).then((p) => oldestFirst(p.messages));
/** RealtimeKit's webhook, as the Worker forwards it once verified. */
const webhook = (event: string, rtkMeetingId: string) =>
  call('POST', '/v1/rtk/webhook', { body: { event, meeting: { id: rtkMeetingId } }, headers: { 'x-flow-rtk-verified': '1' } });
const post = (channelId: string, as: string, body: string, mentions: string[] = []) =>
  withDb(db, () => sendMessage(channelId, as, crypto.randomUUID(), body, undefined, undefined, mentions));
const chats = async (as: string) => (await json<{ chats: MeetingChatDTO[] }>(await call('GET', `/v1/workspaces/${workspaceId}/meetings/chats`, { as }))).chats;

describe('the meeting channel', () => {
  it('is made on the first join: kind meeting, no name, private, with the creator and each member who joined', async () => {
    const m = await newMeeting();
    expect(m.chatChannelId).toBeNull();
    const joined = await joinAs(m.code, BEN);
    const chatId = joined.meeting.chatChannelId!;
    expect(chatId).toEqual(expect.any(String));
    expect(sqlite.prepare('SELECT kind, name, is_private FROM channels WHERE id = ?').get(chatId)).toEqual({ kind: 'meeting', name: null, is_private: 1 });
    expect(sqlite.prepare('SELECT chat_channel_id FROM meetings WHERE id = ?').get(m.id)).toEqual({ chat_channel_id: chatId });
    const members = () => (sqlite.prepare('SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY user_id').all(chatId) as { user_id: string }[]).map((r) => r.user_id);
    expect(members()).toEqual([ANN, BEN]); // CAT, invited or not, never joined
    expect((await joinAs(m.code, ANN)).meeting.chatChannelId).toBe(chatId); // one per room
    expect((await joinAs(m.code, BEN)).meeting.chatChannelId).toBe(chatId);
    expect(members()).toEqual([ANN, BEN]);
    // Many nameless channels live side by side in one organization (the (workspace, name) index allows NULLs).
    const other = await newMeeting('Standup');
    expect((await joinAs(other.code, ANN)).meeting.chatChannelId).not.toBe(chatId);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM channels WHERE kind = 'meeting' AND name IS NULL").get()).toEqual({ n: 2 });
  });

  it('is never made for a huddle: its chat is its conversation', async () => {
    const lobby = await withDb(db, () => createChannel(workspaceId, ANN, 'lobby'));
    const res = await call('POST', `/v1/channels/${lobby.id}/huddle/join`, { as: ANN });
    expect(res.status).toBe(200);
    const huddle = (await json<{ meeting: MeetingDTO }>(res)).meeting;
    const joined = await joinAs(huddle.code, ANN);
    expect(joined.meeting).toMatchObject({ channelId: lobby.id, chatChannelId: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM channels WHERE kind = 'meeting'").get()).toEqual({ n: 0 });
  });

  it('refuses a huddle of its own and sub-channels', async () => {
    const m = await newMeeting();
    const chatId = (await joinAs(m.code, ANN)).meeting.chatChannelId!;
    expect((await call('POST', `/v1/channels/${chatId}/huddle/join`, { as: ANN })).status).toBe(400);
    await expect(withDb(db, () => createChannel(workspaceId, ANN, 'side', undefined, false, chatId))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('is private: a member who never joined cannot read it', async () => {
    const m = await newMeeting();
    const chatId = (await joinAs(m.code, ANN)).meeting.chatChannelId!;
    expect((await call('GET', `/v1/channels/${chatId}/messages`, { as: CAT })).status).toBe(404);
  });
});

describe('a date line per session', () => {
  it('the first join posts "Meeting started · Mon 16 Nov"; joins while the session runs post nothing more', async () => {
    const m = await newMeeting();
    const chatId = (await joinAs(m.code, ANN)).meeting.chatChannelId!;
    live = true;
    later(10 * 60_000);
    await joinAs(m.code, BEN);
    const lines = await messagesIn(chatId);
    expect(lines).toEqual([expect.objectContaining({ body: 'Meeting started · Mon 16 Nov', systemKind: 'meeting_started', userId: ANN, createdAt: new Date(T0).toISOString() })]);
  });

  it('two people arriving together (before RTK reports a session) post one line; a later session posts another', async () => {
    const m = await newMeeting();
    const chatId = (await joinAs(m.code, ANN)).meeting.chatChannelId!;
    later(30_000);
    await joinAs(m.code, BEN);
    expect(await messagesIn(chatId)).toHaveLength(1);
    later(3 * 86_400_000); // Thursday, the room is empty again
    await joinAs(m.code, BEN);
    expect((await messagesIn(chatId)).map((x) => x.body)).toEqual(['Meeting started · Mon 16 Nov', 'Meeting started · Thu 19 Nov']);
  });

  it('meeting.started from RealtimeKit posts the line when no join did; a join right after posts none', async () => {
    const m = await newMeeting();
    const chatId = (await joinAs(m.code, ANN)).meeting.chatChannelId!;
    later(86_400_000);
    expect((await webhook('meeting.started', 'rtk-1')).status).toBe(200);
    later(10_000);
    await joinAs(m.code, BEN);
    expect((await messagesIn(chatId)).map((x) => x.body)).toEqual(['Meeting started · Mon 16 Nov', 'Meeting started · Tue 17 Nov']);
  });

  it('dates the line in the person\'s time zone', () => {
    expect(sessionDate(new Date('2026-11-16T03:00:00Z'), 'America/Los_Angeles')).toBe('Sun 15 Nov');
    expect(sessionDate(new Date('2026-11-16T03:00:00Z'), 'Not/AZone')).toBe('Mon 16 Nov');
  });
});

describe('out of the channel list, in Meetings', () => {
  it('the channel list leaves meeting channels out; …/meetings/chats lists those the caller is in, live first', async () => {
    const a = await newMeeting('Design review');
    const aChat = (await joinAs(a.code, BEN)).meeting.chatChannelId!;
    later(60 * 60_000);
    const b = await newMeeting('Standup');
    const bChat = (await joinAs(b.code, ANN)).meeting.chatChannelId!;
    const list = await json<{ channels: ChannelDTO[] }>(await call('GET', `/v1/workspaces/${workspaceId}/channels`, { as: ANN }));
    expect(list.channels.some((c) => c.kind === 'meeting')).toBe(false);
    const archived = await json<{ channels: ChannelDTO[] }>(await call('GET', `/v1/workspaces/${workspaceId}/channels?includeArchived=1`, { as: ANN }));
    expect(archived.channels.some((c) => c.kind === 'meeting')).toBe(false);

    // Newest first while neither is live.
    const mine = await chats(ANN);
    expect(mine.map((c) => c.channel.id)).toEqual([bChat, aChat]);
    expect(mine[1]).toMatchObject({
      channel: { kind: 'meeting', name: null, isPrivate: true, meeting: { code: a.code, title: 'Design review' }, unreadCount: 0 },
      meeting: { code: a.code, chatChannelId: aChat },
      peopleIds: [ANN, BEN],
      lastSessionAt: new Date(T0).toISOString(),
      lastMessageAt: new Date(T0).toISOString(),
      live: false,
      livePeople: [],
    });
    expect((await chats(BEN)).map((c) => c.channel.id)).toEqual([aChat]);
    expect(await chats(CAT)).toEqual([]);

    // A live meeting comes first, with who is in it.
    live = true;
    const now = await chats(ANN);
    expect(now[0]).toMatchObject({ live: true, livePeople: [{ userId: ANN, name: 'Ann Lee' }] });
  });
});

describe('unread', () => {
  it('a meeting chat\'s messages notify nobody, except a direct @mention of them', async () => {
    const m = await newMeeting();
    const chatId = (await joinAs(m.code, ANN)).meeting.chatChannelId!;
    await joinAs(m.code, BEN);
    const notes = (u: string) => (sqlite.prepare('SELECT kind FROM notifications WHERE user_id = ?').all(u) as { kind: number }[]).map((r) => r.kind);
    const plain = await post(chatId, BEN, 'hello all');
    await post(chatId, BEN, 'everyone <!channel>');
    await withDb(db, () => sendMessage(chatId, BEN, crypto.randomUUID(), 'a reply', plain.id));
    await call('PUT', `/v1/messages/${plain.id}/reactions/${encodeURIComponent('👍')}`, { as: ANN });
    expect(notes(ANN)).toEqual([]);
    expect(notes(BEN)).toEqual([]);
    await post(chatId, BEN, `<@${ANN}> can you share the doc?`, [ANN]);
    expect(notes(ANN)).toEqual([0]);
    // A mention of someone not in the meeting chat notifies nobody (it is private).
    await post(chatId, BEN, `<@${CAT}> too`, [CAT]);
    expect(notes(CAT)).toEqual([]);
    expect((await chats(ANN))[0]!.channel).toMatchObject({ unreadCount: 0, unreadNotifications: 1 });
    expect(await withDb(db, () => unreadCount(ANN, workspaceId))).toBe(1); // Activity and badges count notifications
  });
});

describe('guests are visitors of the meeting chat', () => {
  it('a guest join sets the visitor cookie and names the chat; the guest sees only from their join, and posts', async () => {
    const m = await newMeeting();
    const chatId = (await joinAs(m.code, ANN)).meeting.chatChannelId!;
    live = true;
    await post(chatId, ANN, 'before the guest');
    later(1000);
    const g = await guestJoin(m.code, '  Dana   Guest ');
    expect(g.body.chatChannelId).toBe(chatId);
    expect(g.setCookie).toMatch(/HttpOnly/);
    expect(g.setCookie).toMatch(/Path=\/v1\/visitor;/);
    expect(g.raw!.startsWith(`${workspaceId}.`)).toBe(true);

    const me = await json(await call('GET', '/v1/visitor/me', { cookie: g.cookie }));
    expect(me).toMatchObject({ user: { displayName: 'Dana Guest', visitor: true }, channel: { id: chatId, meeting: { code: m.code, title: 'Design review' } }, seesFrom: new Date(T0 + 1000).toISOString() });
    expect((await json<{ messages: MessageDTO[] }>(await call('GET', '/v1/visitor/messages', { cookie: g.cookie }))).messages).toEqual([]);

    const sent = await call('POST', '/v1/visitor/messages', { cookie: g.cookie, body: { clientMsgId: crypto.randomUUID(), body: 'hi from Dana' } });
    expect(sent.status).toBe(201);
    expect((await messagesIn(chatId)).map((x) => x.body)).toContain('hi from Dana');
    // No join line for a guest, no member row, no channel member row.
    const guestId = (me as { user: { id: string } }).user.id;
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE user_id = ?').get(guestId)).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE user_id = ?').get(guestId)).toEqual({ n: 0 });
    expect((await messagesIn(chatId)).some((x) => x.systemKind === 'member_joined')).toBe(false);
  });

  it('a guest who begins the session sees its date line', async () => {
    const m = await newMeeting();
    const g = await guestJoin(m.code);
    const page = await json<{ messages: MessageDTO[] }>(await call('GET', '/v1/visitor/messages', { cookie: g.cookie }));
    expect(page.messages).toEqual([expect.objectContaining({ body: 'Meeting started · Mon 16 Nov', userId: ANN })]);
    // The meeting's creator is the chat's member; the guest is not.
    expect(sqlite.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(g.body.chatChannelId)).toEqual([{ user_id: ANN }]);
  });

  it('a guest never gets member routes, and a meeting chat takes no visitor links', async () => {
    const m = await newMeeting();
    const g = await guestJoin(m.code);
    const chatId = g.body.chatChannelId!;
    expect((await call('GET', `/v1/channels/${chatId}/messages`, { cookie: g.cookie })).status).toBe(401);
    expect((await call('GET', `/v1/workspaces/${workspaceId}/meetings/chats`, { cookie: g.cookie })).status).toBe(401);
    expect((await call('POST', `/v1/channels/${chatId}/visitor-links`, { as: ANN })).status).toBe(400);
  });

  it('the visit ends when the session ends (meeting.ended): the cookie stops working and the socket closes', async () => {
    const m = await newMeeting();
    live = true;
    await joinAs(m.code, ANN);
    const g = await guestJoin(m.code);
    const socket = new FakeSocket();
    sockets.push(socket);
    await org.webSocketMessage(socket as never, JSON.stringify({ op: 'visitor', token: g.raw }));
    expect(socket.sent[0]).toMatchObject({ op: 'hello' });
    expect((await webhook('meeting.ended', 'rtk-1')).status).toBe(200);
    expect(socket.closed).toBe(4003);
    expect((await call('GET', '/v1/visitor/me', { cookie: g.cookie })).status).toBe(401);
  });

  it('with no end heard, the next session ends earlier guests\' visits; that session\'s guests see none of the last one', async () => {
    const m = await newMeeting();
    const first = await guestJoin(m.code, 'Early');
    await call('POST', '/v1/visitor/messages', { cookie: first.cookie, body: { clientMsgId: crypto.randomUUID(), body: 'last week' } });
    later(7 * 86_400_000);
    await joinAs(m.code, BEN);
    expect((await call('GET', '/v1/visitor/me', { cookie: first.cookie })).status).toBe(401);
    live = true;
    later(60_000);
    const second = await guestJoin(m.code, 'Later');
    const page = await json<{ messages: MessageDTO[] }>(await call('GET', '/v1/visitor/messages', { cookie: second.cookie }));
    expect(page.messages.map((x) => x.body)).toEqual([]);
  });

  it('with visitors off in the organization, a guest joins the call with no chat and no cookie', async () => {
    const m = await newMeeting();
    await withDb(db, () => updateWorkspace(workspaceId, ANN, { policies: { visitors: 'off' } }));
    const g = await guestJoin(m.code);
    expect(g.body).toMatchObject({ authToken: expect.any(String), chatChannelId: null });
    expect(g.setCookie).toBeNull();
  });
});
