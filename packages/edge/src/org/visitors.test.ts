// Channel visitors (docs/specs/chat-visitors.md, phase 1): a link into one public channel, a visitor who sees only what
// was posted after they joined (§2), never asks an agent (V5), and whose socket gets only their channel's events that pass
// §2 (§6). Run through the Org object itself, over node:sqlite, with stand-ins for the runtime's state and sockets.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { Event, MessageDTO, UserDTO } from '@flow/shared';
import { orgStorage } from '../../test/orgStorage';
import { Org } from './object';
import { withDb, schema, type DB } from './db/index';
import { createWorkspace, updateWorkspace } from './services/workspaces';
import { archiveChannel, createChannel, createDm, joinChannel } from './services/channels';
import { logEntryFor } from './eventLog';
import { EventsCore } from '../events/core';
import { sendMessage } from './services/messages';
import { sweepIdleVisitors, visitorBySession, visitorMayReceive, VISITOR_IDLE_MS } from './services/visitors';
import { _resetRateLimitsForTests } from './lib/rateLimit';
import { orgRoutes } from '../routes/org';

const ANN = '00000000-0000-7000-8000-00000000000a'; // owner
const BEN = '00000000-0000-7000-8000-00000000000b'; // member
const GUS = '00000000-0000-7000-8000-00000000000c'; // guest account
const BOT = '00000000-0000-7000-8000-00000000000d'; // a shared agent
const T0 = Date.parse('2026-11-16T10:00:00Z');

beforeAll(() => {
  process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
  (globalThis as Record<string, unknown>).WebSocketRequestResponsePair ??= class { constructor(public a: string, public b: string) {} };
});

/** A stand-in socket: what the object sends it, its attachment, and how it was closed. */
class FakeSocket {
  sent: { op: string; event?: Event; seq?: number; code?: string }[] = [];
  closed: number | null = null;
  private att: unknown = null;
  send(frame: string) { this.sent.push(JSON.parse(frame)); }
  close(code: number) { this.closed = code; }
  serializeAttachment(a: unknown) { this.att = a; }
  deserializeAttachment() { return this.att; }
  events() { return this.sent.filter((f) => f.op === 'event').map((f) => f.event!); }
}

let db: DB;
let sqlite: DatabaseSync;
let org: Org;
let sockets: FakeSocket[];
let pending: Promise<unknown>[];
let blobs: Map<string, Uint8Array>;
let workspaceId: string;
let lobby: string;

const user = (id: string, displayName: string): UserDTO => ({
  id, email: `${id}@x.test`, displayName, avatarUrl: null, timezone: 'UTC', statusEmoji: '', statusText: '', website: '', bio: '', title: '',
  isAgent: id === BOT, sponsorId: null, notificationPrefs: {}, statusSuppressAlerts: false, privacyMode: false,
} as unknown as UserDTO);
const NAMES: Record<string, string> = { [ANN]: 'Ann Lee', [BEN]: 'Ben Kim', [GUS]: 'Gus Guest', [BOT]: 'Helper' };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  _resetRateLimitsForTests();
  delete process.env.TURNSTILE_SECRET;
  sockets = [];
  pending = [];
  blobs = new Map();
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
    BLOBS: {
      put: async (k: string, d: Uint8Array) => { blobs.set(k, new Uint8Array(d)); },
      get: async (k: string) => (blobs.has(k) ? { arrayBuffer: async () => blobs.get(k)!.buffer } : null),
      head: async (k: string) => (blobs.has(k) ? { size: blobs.get(k)!.length } : null),
      delete: async (k: string) => { blobs.delete(k); },
    },
    DIRECTORY: { idFromName: () => 'd', get: () => ({ call: async (name: string) => (name === 'applyOrgChanges' ? { ok: true, value: null } : { ok: false, status: 500, code: 'stub', message: 'stub' }) }) },
    ASSISTANT: {},
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  org = new Org(ctx as never, env as never);
  db = (org as unknown as { db: DB }).db;
  await withDb(db, async () => {
    for (const [id, name] of Object.entries(NAMES)) {
      db.insert(schema.users).values({ id, email: `${id}@x.test`, passwordHash: '!', displayName: name, isAgent: id === BOT }).run();
    }
    workspaceId = (await createWorkspace(ANN, 'Locked In', 'locked-in')).id;
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: BEN, role: 'member' }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: GUS, role: 'member', kind: 'guest' }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: BOT, role: 'member' }).run();
    lobby = (await createChannel(workspaceId, ANN, 'lobby', 'Say hello')).id;
    await joinChannel(lobby, BEN);
    await joinChannel(lobby, GUS);
    await joinChannel(lobby, BOT);
  });
});
afterEach(async () => {
  await Promise.allSettled(pending);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** A request through the object, as a member (`as`), or with no session (a visitor's cookie, or nothing). */
async function call(method: string, path: string, opts: { as?: string; cookie?: string; body?: unknown; form?: FormData; ip?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const caller = {
    user: opts.as ? user(opts.as, NAMES[opts.as]!) : null, token: opts.as ? 'tok' : null, authKind: opts.as ? 'session' : null,
    ip: opts.ip ?? '10.0.0.1', organizationId: workspaceId, account: null,
  };
  return org.handle(new Request(`https://app.test${path}`, { method, headers, body }), caller as never, null);
}
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

async function makeLink(channelId = lobby, as = BEN): Promise<{ id: string; token: string; url: string }> {
  const res = await call('POST', `/v1/channels/${channelId}/visitor-links`, { as });
  expect(res.status).toBe(201);
  const link = await json<{ id: string; url: string }>(res);
  return { ...link, token: link.url.split('/').pop()! };
}

async function join(token: string, name = 'Vic Visitor'): Promise<{ cookie: string; userId: string; raw: string; setCookie: string }> {
  const res = await call('POST', `/v1/visit/${token}`, { body: { name } });
  expect(res.status).toBe(201);
  const setCookie = res.headers.get('set-cookie')!;
  const raw = decodeURIComponent(/vsid=([^;]+)/.exec(setCookie)![1]!);
  const me = await json<{ user: { id: string } }>(res);
  return { cookie: `vsid=${encodeURIComponent(raw)}`, userId: me.user.id, raw, setCookie };
}

const post = (channelId: string, userId: string, body: string, threadRootId?: string) =>
  withDb(db, () => sendMessage(channelId, userId, crypto.randomUUID(), body, threadRootId));

describe('visitor links', () => {
  it('a member makes a 24-hour link to a public channel; the preview names the organization and the channel', async () => {
    const link = await makeLink();
    expect(link.url).toMatch(/\/chat\/visit\/[A-Za-z0-9_-]{22}$/);
    const preview = await json(await call('GET', `/v1/visit/${link.token}`));
    expect(preview).toEqual({ organization: { name: 'Locked In', avatarUrl: null }, channel: { name: 'lobby', topic: 'Say hello' }, expiresAt: new Date(T0 + 86_400_000).toISOString() });
    const list = await json<{ links: { id: string; visitorCount: number; url?: string }[] }>(await call('GET', `/v1/channels/${lobby}/visitor-links`, { as: ANN }));
    expect(list.links).toEqual([expect.objectContaining({ id: link.id, createdBy: BEN, visitorCount: 0 })]);
    expect(list.links[0]!.url).toBeUndefined(); // the URL is shown once
    // Only the hash is kept, and the outbox reports it (and the id) to the directory.
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM visitor_links WHERE token_hash = ?').get(Buffer.from(link.token))).toEqual({ n: 0 });
  });

  it('is refused for private channels, DMs, guest accounts and people outside the channel', async () => {
    const secret = await withDb(db, () => createChannel(workspaceId, ANN, 'secret', undefined, true));
    expect((await call('POST', `/v1/channels/${secret.id}/visitor-links`, { as: ANN })).status).toBe(400);
    const dm = await withDb(db, () => createDm(workspaceId, ANN, [BEN]));
    expect((await call('POST', `/v1/channels/${dm.id}/visitor-links`, { as: ANN })).status).toBe(400);
    expect((await call('POST', `/v1/channels/${lobby}/visitor-links`, { as: GUS })).status).toBe(403);
    const other = await withDb(db, () => createChannel(workspaceId, ANN, 'other'));
    expect((await call('POST', `/v1/channels/${other.id}/visitor-links`, { as: BEN })).status).toBe(403);
  });

  it('joining makes a visitor: a users row, no member row, an HttpOnly cookie, and "<name> joined as a visitor"', async () => {
    const link = await makeLink();
    later(1000);
    const v = await join(link.token, '  Vic   Visitor ');
    expect(v.raw.startsWith(`${workspaceId}.`)).toBe(true);
    expect(v.setCookie).toMatch(/HttpOnly/);
    expect(v.setCookie).toMatch(/Path=\/v1\/visitor;/);
    expect(v.setCookie).toMatch(/SameSite=Strict/);
    expect(sqlite.prepare('SELECT is_visitor, display_name FROM users WHERE id = ?').get(v.userId)).toEqual({ is_visitor: 1, display_name: 'Vic Visitor' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE user_id = ?').get(v.userId)).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE user_id = ?').get(v.userId)).toEqual({ n: 0 });
    const page = await json<{ messages: MessageDTO[] }>(await call('GET', '/v1/visitor/messages', { cookie: v.cookie }));
    expect(page.messages).toEqual([expect.objectContaining({ body: 'Vic Visitor joined as a visitor', systemKind: 'member_joined', userId: v.userId, visitor: true })]);
    const me = await json(await call('GET', '/v1/visitor/me', { cookie: v.cookie }));
    expect(me).toMatchObject({ user: { id: v.userId, displayName: 'Vic Visitor', visitor: true }, organization: { id: workspaceId, name: 'Locked In' }, channel: { id: lobby, name: 'lobby' }, seesFrom: new Date(T0 + 1000).toISOString() });
    expect((me as { channel: { people: unknown[] } }).channel.people).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: BOT, isAgent: true }),
      expect.objectContaining({ userId: v.userId, visitor: true }),
    ]));
    const links = await json<{ links: { visitorCount: number }[] }>(await call('GET', `/v1/channels/${lobby}/visitor-links`, { as: ANN }));
    expect(links.links[0]!.visitorCount).toBe(1);
    expect(await json(await call('GET', `/v1/channels/${lobby}/visitors`, { as: BEN }))).toEqual({ visitors: [expect.objectContaining({ userId: v.userId, displayName: 'Vic Visitor', visitor: true, linkId: link.id })] });
  });

  it('takes a name of 1 to 40 characters', async () => {
    const link = await makeLink();
    expect((await call('POST', `/v1/visit/${link.token}`, { body: { name: '   ' } })).status).toBe(400);
    expect((await call('POST', `/v1/visit/${link.token}`, { body: { name: 'x'.repeat(41) } })).status).toBe(400);
    expect((await call('POST', `/v1/visit/${link.token}`, { body: {} })).status).toBe(400);
  });

  it('works for 24 hours; a visitor who came in by it stays after that', async () => {
    const link = await makeLink();
    const v = await join(link.token);
    later(24 * 3_600_000 - 1000);
    expect((await call('GET', `/v1/visit/${link.token}`)).status).toBe(200);
    later(2000);
    expect((await call('GET', `/v1/visit/${link.token}`)).status).toBe(404);
    const refused = await call('POST', `/v1/visit/${link.token}`, { body: { name: 'Late' } });
    expect(refused.status).toBe(404);
    expect((await json<{ error: { message: string } }>(refused)).error.message).toMatch(/no longer works/);
    expect((await call('GET', '/v1/visitor/me', { cookie: v.cookie })).status).toBe(200);
    expect(await json(await call('GET', `/v1/channels/${lobby}/visitor-links`, { as: ANN }))).toEqual({ links: [] });
  });

  it('turning a link off removes everyone who came in by it, and closes their sockets', async () => {
    const link = await makeLink();
    const other = await makeLink();
    const a = await join(link.token, 'Amy');
    const b = await join(other.token, 'Bob');
    const socket = new FakeSocket();
    sockets.push(socket);
    await org.webSocketMessage(socket as never, JSON.stringify({ op: 'visitor', token: a.raw }));
    expect(socket.sent[0]).toMatchObject({ op: 'hello' });
    const res = await call('DELETE', `/v1/visitor-links/${link.id}`, { as: BEN });
    expect(await json(res)).toEqual({ ok: true, removed: 1 });
    expect(socket.closed).toBe(4003);
    expect((await call('GET', '/v1/visitor/me', { cookie: a.cookie })).status).toBe(401);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM visitor_sessions WHERE user_id = ?').get(a.userId)).toEqual({ n: 0 });
    expect((await call('GET', `/v1/visit/${link.token}`)).status).toBe(404);
    // The other link's visitor is untouched; their old messages keep their name.
    expect((await call('GET', '/v1/visitor/me', { cookie: b.cookie })).status).toBe(200);
    expect(sqlite.prepare('SELECT display_name FROM users WHERE id = ?').get(a.userId)).toEqual({ display_name: 'Amy' });
  });

  it('a member removes a visitor; the visitor can leave', async () => {
    const link = await makeLink();
    const a = await join(link.token, 'Amy');
    const b = await join(link.token, 'Bob');
    expect((await call('DELETE', `/v1/channels/${lobby}/visitors/${a.userId}`, { as: BEN })).status).toBe(200);
    expect((await call('GET', '/v1/visitor/messages', { cookie: a.cookie })).status).toBe(401);
    const left = await call('POST', '/v1/visitor/leave', { cookie: b.cookie });
    expect(left.headers.get('set-cookie')).toMatch(/vsid=;.*Max-Age=0/);
    expect((await call('GET', '/v1/visitor/me', { cookie: b.cookie })).status).toBe(401);
    expect(await json(await call('GET', `/v1/channels/${lobby}/visitors`, { as: ANN }))).toEqual({ visitors: [] });
  });

  it('with visitors off: links 404, no new links, and current visitors lose access', async () => {
    const link = await makeLink();
    const v = await join(link.token);
    const socket = new FakeSocket();
    sockets.push(socket);
    await org.webSocketMessage(socket as never, JSON.stringify({ op: 'visitor', token: v.raw }));
    const patched = await call('PATCH', `/v1/workspaces/${workspaceId}`, { as: ANN, body: { policies: { visitors: 'off' } } });
    expect(patched.status).toBe(200);
    expect((await json<{ policies: Record<string, unknown> }>(patched)).policies.visitors).toBe('off');
    expect(socket.closed).toBe(4003);
    expect((await call('GET', '/v1/visitor/me', { cookie: v.cookie })).status).toBe(401);
    expect((await call('GET', `/v1/visit/${link.token}`)).status).toBe(404);
    const refused = await call('POST', `/v1/channels/${lobby}/visitor-links`, { as: BEN });
    expect(refused.status).toBe(403);
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe('visitors_off');
    await withDb(db, () => updateWorkspace(workspaceId, ANN, { policies: { visitors: 'on' } }));
    expect((await call('GET', '/v1/visitor/me', { cookie: v.cookie })).status).toBe(401); // removed for good
  });

  it('checks Turnstile when TURNSTILE_SECRET is set, and skips it when not', async () => {
    const link = await makeLink();
    process.env.TURNSTILE_SECRET = 'shh';
    const fetch = vi.fn(async (_url: string, init: RequestInit) => Response.json({ success: String(init.body).includes('response=good') }));
    vi.stubGlobal('fetch', fetch);
    expect((await call('POST', `/v1/visit/${link.token}`, { body: { name: 'Amy' } })).status).toBe(400);
    expect((await call('POST', `/v1/visit/${link.token}`, { body: { name: 'Amy', turnstile: 'bad' } })).status).toBe(403);
    expect((await call('POST', `/v1/visit/${link.token}`, { body: { name: 'Amy', turnstile: 'good' } })).status).toBe(201);
    expect(fetch.mock.calls[0]![0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(String(fetch.mock.calls[0]![1].body)).toContain('remoteip=10.0.0.1');
    delete process.env.TURNSTILE_SECRET;
    expect((await call('POST', `/v1/visit/${link.token}`, { body: { name: 'Bob' } })).status).toBe(201);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rate limits joining per address', async () => {
    const link = await makeLink();
    for (let i = 0; i < 20; i++) expect((await call('POST', `/v1/visit/${link.token}`, { body: { name: `P${i}` } })).status).toBe(201);
    expect((await call('POST', `/v1/visit/${link.token}`, { body: { name: 'One more' } })).status).toBe(429);
    expect((await call('POST', `/v1/visit/${link.token}`, { body: { name: 'Elsewhere' }, ip: '10.0.0.2' })).status).toBe(201);
  });
});

describe('§2: a visitor sees only what came after they joined', () => {
  async function setup() {
    const oldRoot = await post(lobby, ANN, 'before you came');
    const oldReply = await post(lobby, BEN, 'old reply', oldRoot.id);
    const link = await makeLink();
    later(1000);
    const v = await join(link.token);
    later(1000);
    const newRoot = await post(lobby, BEN, 'welcome!');
    const lateReply = await post(lobby, ANN, 'a late reply to an old thread', oldRoot.id);
    return { oldRoot, oldReply, v, newRoot, lateReply };
  }

  it('message list: only top-level messages created at or after "sees from"; members see everything', async () => {
    const { v, oldRoot, newRoot } = await setup();
    const page = await json<{ messages: MessageDTO[] }>(await call('GET', '/v1/visitor/messages', { cookie: v.cookie }));
    expect(page.messages.map((m) => m.body)).toEqual(['welcome!', 'Vic Visitor joined as a visitor']);
    const members = await json<{ messages: MessageDTO[] }>(await call('GET', `/v1/channels/${lobby}/messages`, { as: BEN }));
    expect(members.messages.map((m) => m.id)).toEqual(expect.arrayContaining([oldRoot.id, newRoot.id]));
    expect(members.messages.find((m) => m.userId === v.userId)).toMatchObject({ visitor: true });
    expect(members.messages.find((m) => m.id === newRoot.id)!.visitor).toBeUndefined();
  });

  it('threads: none whose first message is older, not even new replies (V3); newer threads in full', async () => {
    const { v, oldRoot, newRoot } = await setup();
    expect((await call('GET', `/v1/visitor/messages/${oldRoot.id}/thread`, { cookie: v.cookie })).status).toBe(404);
    const reply = await call('POST', '/v1/visitor/messages', { cookie: v.cookie, body: { clientMsgId: crypto.randomUUID(), body: 'me too', threadRootId: oldRoot.id } });
    expect(reply.status).toBe(404);
    const mine = await call('POST', '/v1/visitor/messages', { cookie: v.cookie, body: { clientMsgId: crypto.randomUUID(), body: 'thanks', threadRootId: newRoot.id } });
    expect(mine.status).toBe(201);
    await post(lobby, BEN, 'you are welcome', newRoot.id);
    const thread = await json<{ root: MessageDTO; messages: MessageDTO[] }>(await call('GET', `/v1/visitor/messages/${newRoot.id}/thread`, { cookie: v.cookie }));
    expect(thread.root.id).toBe(newRoot.id);
    expect(thread.messages.map((m) => m.body)).toEqual(['thanks', 'you are welcome']);
    expect(thread.messages[0]).toMatchObject({ visitor: true });
  });

  it('one message (a link to it): 404 unless it passes the two rules', async () => {
    const { v, oldRoot, oldReply, newRoot, lateReply } = await setup();
    for (const id of [oldRoot.id, oldReply.id, lateReply.id]) expect((await call('GET', `/v1/visitor/messages/${id}`, { cookie: v.cookie })).status).toBe(404);
    expect(await json(await call('GET', `/v1/visitor/messages/${newRoot.id}`, { cookie: v.cookie }))).toMatchObject({ id: newRoot.id });
    later(1000);
    const other = await withDb(db, () => createChannel(workspaceId, ANN, 'elsewhere'));
    const there = await post(other.id, ANN, 'not your channel');
    expect((await call('GET', `/v1/visitor/messages/${there.id}`, { cookie: v.cookie })).status).toBe(404);
  });

  it('edits, deletes and reactions only on messages they can see; edits and deletes only of their own', async () => {
    const { v, oldRoot, newRoot } = await setup();
    const react = (id: string, method = 'PUT') => call(method, `/v1/visitor/messages/${id}/reactions/${encodeURIComponent('👍')}`, { cookie: v.cookie });
    expect((await react(oldRoot.id)).status).toBe(404);
    expect(await json(await react(newRoot.id))).toEqual({ reactions: [{ emoji: '👍', count: 1, userIds: [v.userId] }] });
    expect((await react(newRoot.id, 'DELETE')).status).toBe(200);
    expect((await call('PATCH', `/v1/visitor/messages/${oldRoot.id}`, { cookie: v.cookie, body: { body: 'x' } })).status).toBe(404);
    expect((await call('PATCH', `/v1/visitor/messages/${newRoot.id}`, { cookie: v.cookie, body: { body: 'x' } })).status).toBe(403);
    expect((await call('DELETE', `/v1/visitor/messages/${oldRoot.id}`, { cookie: v.cookie })).status).toBe(404);
    const mine = await json<MessageDTO>(await call('POST', '/v1/visitor/messages', { cookie: v.cookie, body: { clientMsgId: crypto.randomUUID(), body: 'hi all' } }));
    expect(mine).toMatchObject({ visitor: true, userId: v.userId, channelId: lobby });
    expect(await json(await call('PATCH', `/v1/visitor/messages/${mine.id}`, { cookie: v.cookie, body: { body: 'hi everyone' } }))).toMatchObject({ body: 'hi everyone', visitor: true });
    expect((await call('DELETE', `/v1/visitor/messages/${mine.id}`, { cookie: v.cookie })).status).toBe(200);
    expect(sqlite.prepare('SELECT deleted_at IS NOT NULL AS gone FROM messages WHERE id = ?').get(mine.id)).toEqual({ gone: 1 });
  });

  it('files: opened only through a message they can see (or their own upload); the channel file list is cut too', async () => {
    const { v } = await setup();
    // A member's file on an old message, and one on a new message.
    const file = (id: string, name: string) => {
      blobs.set(`files/${id}`, new TextEncoder().encode(name));
      sqlite.prepare(`INSERT INTO files (id, workspace_id, user_id, name, mime_type, size_bytes, storage_key, status, created_at) VALUES (?, ?, ?, ?, 'text/plain', ?, ?, 'ready', ?)`)
        .run(id, workspaceId, BEN, name, name.length, `files/${id}`, Date.now());
      return id;
    };
    const oldFile = file(crypto.randomUUID(), 'old.txt');
    const newFile = file(crypto.randomUUID(), 'new.txt');
    // The old message predates the visitor: written with an earlier time.
    const old = await post(lobby, BEN, 'old file');
    sqlite.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(T0 - 60_000, old.id);
    sqlite.prepare('INSERT INTO message_files (message_id, file_id) VALUES (?, ?)').run(old.id, oldFile);
    const fresh = await post(lobby, BEN, 'new file');
    sqlite.prepare('INSERT INTO message_files (message_id, file_id) VALUES (?, ?)').run(fresh.id, newFile);
    expect((await call('GET', `/v1/visitor/files/${oldFile}`, { cookie: v.cookie })).status).toBe(404);
    const got = await call('GET', `/v1/visitor/files/${newFile}`, { cookie: v.cookie });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('new.txt');
    const list = await json<{ files: { id: string }[]; total: number }>(await call('GET', '/v1/visitor/files', { cookie: v.cookie }));
    expect(list.files.map((f) => f.id)).toEqual([newFile]);
    // Their own upload, attached to their own message (V9).
    const form = new FormData();
    form.append('file', new File(['hello'], 'hi.txt', { type: 'text/plain' }));
    const up = await json<{ id: string }>(await call('POST', '/v1/visitor/files', { cookie: v.cookie, form }));
    expect((await call('GET', `/v1/visitor/files/${up.id}`, { cookie: v.cookie })).status).toBe(200);
    const sent = await json<MessageDTO>(await call('POST', '/v1/visitor/messages', { cookie: v.cookie, body: { clientMsgId: crypto.randomUUID(), body: 'see file', fileIds: [up.id] } }));
    expect(sent.files.map((f) => f.id)).toEqual([up.id]);
  });

  it('a visitor cannot reach member routes: no history, search, pins, directory or single messages there', async () => {
    const { v, newRoot } = await setup();
    const asVisitor = user(v.userId, 'Vic Visitor');
    const caller = { user: asVisitor, token: 'x', authKind: 'session', ip: '', organizationId: workspaceId, account: null };
    const as = (path: string, method = 'GET', body?: unknown) =>
      org.handle(new Request(`https://app.test${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), caller as never, null);
    for (const path of [
      `/v1/channels/${lobby}/messages`, `/v1/workspaces/${workspaceId}/search?q=welcome`, `/v1/channels/${lobby}/pins`,
      `/v1/workspaces/${workspaceId}/members`, `/v1/messages/${newRoot.id}`, `/v1/workspaces/${workspaceId}/channels`, `/v1/channels/${lobby}/files`,
    ]) {
      expect((await as(path)).status, path).toBe(404);
    }
    expect((await as(`/v1/channels/${lobby}/messages`, 'POST', { clientMsgId: crypto.randomUUID(), body: 'sneaky' })).status).toBe(404);
    // And the visitor's cookie opens nothing but the visitor routes.
    expect((await call('GET', `/v1/channels/${lobby}/messages`, { cookie: v.cookie })).status).toBe(401);
    expect((await call('GET', '/v1/visitor/search?q=welcome', { cookie: v.cookie })).status).toBe(404);
  });
});

describe('agents (V5)', () => {
  it("a visitor's message never asks an agent; a member's does", async () => {
    const asked = vi.spyOn(org as unknown as { askSharedAgents: (m: MessageDTO) => Promise<void> }, 'askSharedAgents').mockResolvedValue();
    const link = await makeLink();
    const v = await join(link.token);
    await call('POST', '/v1/visitor/messages', { cookie: v.cookie, body: { clientMsgId: crypto.randomUUID(), body: `<@${BOT}> help me` } });
    await Promise.allSettled(pending);
    expect(asked).not.toHaveBeenCalled();
    await call('POST', `/v1/channels/${lobby}/messages`, { as: BEN, body: { clientMsgId: crypto.randomUUID(), body: `<@${BOT}> help me` } });
    await Promise.allSettled(pending);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("an agent's mention in a visitor's message is written out as a name and notifies no one; a member's still does", async () => {
    const link = await makeLink();
    const v = await join(link.token);
    const res = await call('POST', '/v1/visitor/messages', {
      cookie: v.cookie, body: { clientMsgId: crypto.randomUUID(), body: `<@${BOT}> and <@${BEN}>, <!channel> look`, mentions: [BOT, BEN] },
    });
    const m = await json<MessageDTO>(res);
    expect(m.body).toBe(`@Helper and <@${BEN}>, @channel look`);
    const notified = sqlite.prepare('SELECT user_id FROM notifications WHERE message_id = ?').all(m.id).map((r) => (r as { user_id: string }).user_id);
    expect(notified).toEqual([BEN]);
    // A member mentioning a visitor: a name, no notification and no error.
    const back = await json<MessageDTO>(await call('POST', `/v1/channels/${lobby}/messages`, { as: BEN, body: { clientMsgId: crypto.randomUUID(), body: `<@${v.userId}> hi`, mentions: [v.userId] } }));
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM notifications WHERE message_id = ?').get(back.id)).toEqual({ n: 0 });
  });
});

describe('live events (§6)', () => {
  async function connected() {
    const oldRoot = await post(lobby, ANN, 'old');
    const link = await makeLink();
    later(1000);
    const v = await join(link.token);
    const member = new FakeSocket();
    member.serializeAttachment({ userId: BEN, accountId: null });
    const visitor = new FakeSocket();
    sockets.push(member, visitor);
    await org.webSocketMessage(visitor as never, JSON.stringify({ op: 'visitor', token: v.raw }));
    later(1000);
    return { oldRoot, v, member, visitor };
  }

  it('a visitor socket gets new messages in its channel, but no edits, reactions or replies about older ones', async () => {
    const { oldRoot, v, member, visitor } = await connected();
    const send = async (as: string, channelId: string, body: string, threadRootId?: string) =>
      json<MessageDTO>(await call('POST', `/v1/channels/${channelId}/messages`, { as, body: { clientMsgId: crypto.randomUUID(), body, ...(threadRootId ? { threadRootId } : {}) } }));
    const fresh = await send(BEN, lobby, 'hello visitor');
    await call('PUT', `/v1/messages/${oldRoot.id}/reactions/${encodeURIComponent('👍')}`, { as: BEN });
    await call('PATCH', `/v1/messages/${oldRoot.id}`, { as: ANN, body: { body: 'edited old' } });
    await send(BEN, lobby, 'late reply', oldRoot.id);
    await call('DELETE', `/v1/messages/${oldRoot.id}`, { as: ANN });
    await call('PUT', `/v1/messages/${fresh.id}/reactions/${encodeURIComponent('🎉')}`, { as: ANN });
    await call('PATCH', `/v1/messages/${fresh.id}`, { as: BEN, body: { body: 'hello again' } });
    const other = await withDb(db, () => createChannel(workspaceId, ANN, 'elsewhere'));
    await send(ANN, other.id, 'other channel');
    const seen = visitor.events().map((e) => `${e.type}:${(e.data as { id?: string; messageId?: string }).id ?? (e.data as { messageId?: string }).messageId ?? ''}`);
    expect(seen).toEqual([`message.created:${fresh.id}`, `reaction.added:${fresh.id}`, `message.updated:${fresh.id}`]);
    // The member socket got all of it (and the other channel), and presence never names the visitor.
    expect(member.events().length).toBeGreaterThan(seen.length + 3);
    expect(visitor.events().every((e) => e.channelId === lobby)).toBe(true);
    expect(member.events().some((e) => e.type === 'presence' && (e.data as { userId: string }).userId === v.userId)).toBe(false);
  });

  it("a visitor's own messages reach members with visitor: true; typing stays in the channel", async () => {
    const { v, member, visitor } = await connected();
    await call('POST', '/v1/visitor/messages', { cookie: v.cookie, body: { clientMsgId: crypto.randomUUID(), body: 'hi' } });
    expect(member.events().find((e) => e.type === 'message.created')?.data).toMatchObject({ body: 'hi', visitor: true });
    await org.webSocketMessage(visitor as never, JSON.stringify({ op: 'typing', channelId: lobby }));
    expect(member.events().find((e) => e.type === 'typing')?.data).toMatchObject({ userId: v.userId });
    const other = await withDb(db, () => createChannel(workspaceId, ANN, 'elsewhere'));
    const before = member.events().length;
    await org.webSocketMessage(visitor as never, JSON.stringify({ op: 'typing', channelId: other.id }));
    expect(member.events().length).toBe(before);
  });

  it('a socket opened with the cookie proves itself with {op: "visitor"}; a bad token is closed', async () => {
    const link = await makeLink();
    const v = await join(link.token);
    const ws = new FakeSocket();
    // What the object's fetch() keeps from the upgrade request's cookie.
    ws.serializeAttachment({ accountId: null, visitorToken: v.raw });
    sockets.push(ws);
    await org.webSocketMessage(ws as never, JSON.stringify({ op: 'visitor' }));
    expect(ws.sent[0]).toMatchObject({ op: 'hello' });
    const bad = new FakeSocket();
    await org.webSocketMessage(bad as never, JSON.stringify({ op: 'visitor', token: `${workspaceId}.nope` }));
    expect(bad.closed).toBe(4003);
    // A visitor socket cannot become a member's.
    await org.webSocketMessage(ws as never, JSON.stringify({ op: 'auth', token: 'member-token' }));
    expect((ws.deserializeAttachment() as { visitor?: unknown }).visitor).toBeTruthy();
  });

  it('the reconnect backlog goes through the same filter', async () => {
    const { oldRoot, v } = await connected();
    const fresh = await post(lobby, BEN, 'new');
    const at = (type: string, channelId: string, data: unknown, seq: number) => ({ seq, type: `chat.${type}`, channelId, ts: new Date().toISOString(), data });
    const log = [
      at('message.updated', lobby, { ...oldRoot, body: 'edited' }, 1),
      at('message.created', lobby, fresh, 2),
      at('reaction.added', lobby, { messageId: oldRoot.id, emoji: '👍', userId: BEN, channelId: lobby }, 3),
      at('reaction.added', lobby, { messageId: fresh.id, emoji: '👍', userId: BEN, channelId: lobby }, 4),
    ];
    const readFrom = vi.fn(async (q: { since: number }) => ({ events: log.filter((e) => e.seq > q.since), next: 4 }));
    (org as unknown as { env: Record<string, unknown> }).env.EVENTS = { idFromName: (x: string) => x, get: () => ({ readFrom, publishMany: async () => [] }) };
    const ws = new FakeSocket();
    await org.webSocketMessage(ws as never, JSON.stringify({ op: 'visitor', token: v.raw, since: 0 }));
    expect(readFrom.mock.calls[0]![0]).toMatchObject({ channelId: lobby, types: ['chat.*'] });
    expect(ws.sent.filter((f) => f.op === 'event').map((f) => f.seq)).toEqual([2, 4]);
    expect(ws.sent.at(-1)).toEqual({ op: 'cursor', seq: 4 });
  });

  it('visitorMayReceive: never a user subject, another channel, or the organization', () => {
    const v = { userId: 'v', channelId: 'c1', seesFrom: 1000 };
    const times = () => null;
    const ev = (type: string, channelId: string | undefined, data: unknown) => ({ type, workspaceId: 'w', channelId, ts: '', data }) as Event;
    const msg = { id: 'm', channelId: 'c1', threadRootId: null, createdAt: new Date(2000).toISOString() };
    expect(visitorMayReceive(v, 'ws.w.chan.c1.msg', ev('message.created', 'c1', msg), times)).toBe(true);
    expect(visitorMayReceive(v, 'user.00000000-0000-7000-8000-00000000000a.notify', ev('message.created', 'c1', msg), times)).toBe(false);
    expect(visitorMayReceive(v, 'ws.w.chan.c2.msg', ev('message.created', 'c2', { ...msg, channelId: 'c2' }), times)).toBe(false);
    expect(visitorMayReceive(v, 'ws.w.meta', ev('user.updated', undefined, {}), times)).toBe(false);
    expect(visitorMayReceive(v, 'ws.w.presence', ev('presence', undefined, {}), times)).toBe(false);
    expect(visitorMayReceive(v, 'ws.w.meta', ev('channel.updated', 'c1', {}), times)).toBe(true);
    expect(visitorMayReceive(v, 'ws.w.chan.c1.artifact', ev('artifact.created', 'c1', {}), times)).toBe(false);
    expect(visitorMayReceive(v, 'ws.w.chan.c1.msg', ev('message.purged', 'c1', { ...msg, createdAt: new Date(500).toISOString() }), times)).toBe(false);
  });
});

describe('access ends (V8)', () => {
  it('the daily sweep removes visitors 30 days after their last visit', async () => {
    const link = await makeLink();
    const a = await join(link.token, 'Amy');
    const b = await join(link.token, 'Bob');
    later(VISITOR_IDLE_MS - 60_000);
    expect((await call('GET', '/v1/visitor/me', { cookie: b.cookie })).status).toBe(200); // Bob came back
    later(120_000);
    expect(await withDb(db, () => sweepIdleVisitors())).toBe(1);
    expect(await withDb(db, () => visitorBySession(a.raw))).toBeNull();
    expect((await call('GET', '/v1/visitor/me', { cookie: b.cookie })).status).toBe(200);
  });

  it('the alarm runs the sweep once a day while there are visitors', async () => {
    const link = await makeLink();
    await join(link.token, 'Amy');
    await call('GET', '/v1/visitor/me'); // any request arms the alarm
    const store = (org as unknown as { ctx: { storage: { get: (k: string) => Promise<number | undefined> } } }).ctx.storage;
    expect(await store.get('visitor_sweep_at')).toBe(Date.now() + 86_400_000);
    later(31 * 86_400_000);
    await org.alarm();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM channel_visitors WHERE removed_at IS NULL').get()).toEqual({ n: 0 });
  });
});

describe('the Worker routes a visitor', () => {
  const env = (lookups: unknown[][], handle = vi.fn(async () => Response.json({ ok: true })), fetch = vi.fn(async () => new Response(null))) => ({
    env: {
      DIRECTORY: { idFromName: () => 'd', get: () => ({ call: async (name: string, args: unknown[]) => { lookups.push([name, args]); return { ok: true, value: name === 'organizationKnown' ? true : 'org-1' }; } }) },
      ORG: { idFromName: (id: string) => id, get: () => ({ handle, fetch }) },
    },
    handle,
    fetch,
  });

  it("finds a link's organization by its token's hash, with no session", async () => {
    const lookups: unknown[][] = [];
    const e = env(lookups);
    const token = 'abcdefghijklmnopqrstuv';
    const res = await orgRoutes.request(`https://app.example/v1/visit/${token}`, {}, e.env as never);
    expect(res.status).toBe(200);
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
    expect(lookups[0]).toEqual(['organizationOfId', [digest]]);
    expect((e.handle.mock.calls[0] as unknown[])[1]).toMatchObject({ user: null, organizationId: 'org-1' });
  });

  it("sends /v1/visitor/* to the organization the cookie names, and refuses no cookie", async () => {
    const lookups: unknown[][] = [];
    const e = env(lookups);
    const org1 = '11111111-1111-7111-8111-111111111111';
    // No cookie: refused before any object is woken (index.ts turns the throw into a 401).
    expect((await orgRoutes.request('https://app.example/v1/visitor/me', {}, e.env as never)).ok).toBe(false);
    expect(e.handle).not.toHaveBeenCalled();
    const res = await orgRoutes.request('https://app.example/v1/visitor/me', { headers: { cookie: `x=1; vsid=${org1}.secret` } }, e.env as never);
    expect(res.status).toBe(200);
    expect(lookups).toEqual([['organizationKnown', [org1]]]);
    await orgRoutes.request('https://app.example/v1/visitor/ws', { headers: { cookie: `vsid=${org1}.secret`, upgrade: 'websocket' } }, e.env as never);
    expect(e.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('review fixes', () => {
  it("event-log entries for a visitor's acts are marked, and no subscription action runs on them (V5)", async () => {
    const link = await makeLink();
    const v = await join(link.token);
    const sql = { exec: (q: string, ...args: unknown[]) => { const st = sqlite.prepare(q); return { toArray: () => st.all(...(args as never[])) as Record<string, unknown>[] }; } };
    const ts = new Date().toISOString();
    const byVisitor = logEntryFor(sql as never, `ws.${workspaceId}.chan.${lobby}.msg`, { type: 'reaction.added', workspaceId, channelId: lobby, ts, data: { userId: v.userId, messageId: 'm', emoji: 'x' } } as never)!;
    expect((byVisitor.data as { visitor?: boolean }).visitor).toBe(true);
    const byMember = logEntryFor(sql as never, `ws.${workspaceId}.chan.${lobby}.msg`, { type: 'reaction.added', workspaceId, channelId: lobby, ts, data: { userId: BEN, messageId: 'm', emoji: 'x' } } as never)!;
    expect((byMember.data as { visitor?: boolean }).visitor).toBeUndefined();
    const sub = { consumer: 'acct-bot', action: { kind: 'wake', prompt: '{{data}}' } } as never;
    const decide = (data: unknown) => EventsCore.prototype.decide.call({} as never, sub, { actor: null, depth: 0, data } as never);
    expect(decide(byVisitor.data)).toEqual({ kind: 'skip', why: 'visitor' });
    expect(decide(byMember.data)).toEqual({ kind: 'wake' });
  });

  it("a visitor cannot get someone else's message back by reusing its clientMsgId", async () => {
    const link = await makeLink();
    const v = await join(link.token);
    const clientMsgId = crypto.randomUUID();
    await withDb(db, () => sendMessage(lobby, BEN, clientMsgId, 'members only, from later'));
    const res = await call('POST', '/v1/visitor/messages', { cookie: v.cookie, body: { clientMsgId, body: 'hi' } });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain('members only');
  });

  it('archiving the channel ends its visits', async () => {
    const link = await makeLink();
    const v = await join(link.token);
    await withDb(db, () => archiveChannel(lobby, ANN));
    expect((await call('GET', '/v1/visitor/me', { cookie: v.cookie })).status).toBe(401);
    expect(await json(await call('GET', `/v1/channels/${lobby}/visitors`, { as: ANN }))).toEqual({ visitors: [] });
  });

  it('with no TURNSTILE_SECRET, production (https) refuses joining rather than skipping the check', async () => {
    const link = await makeLink();
    const prev = process.env.FLOW_WEB_URL;
    process.env.FLOW_WEB_URL = 'https://app.example.test';
    try {
      expect((await call('POST', `/v1/visit/${link.token}`, { body: { name: 'Vic' } })).status).toBe(503);
    } finally {
      if (prev === undefined) delete process.env.FLOW_WEB_URL; else process.env.FLOW_WEB_URL = prev;
    }
  });
});
