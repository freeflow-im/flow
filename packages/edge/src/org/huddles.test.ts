// Huddles on Meet (docs/specs/meetings.md phase 2): "Huddle" in a conversation makes its one Meet room on RealtimeKit
// and rings its people; being in the room (its join and leave) is what moves the roster, which lives in the
// organization's SQLite; a huddle starts only in a room of six people or fewer; RealtimeKit's signed webhook is the
// safety net for a tab closed without leaving, and the Worker refuses an unsigned one without waking an object.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { orgStorage } from '../../test/orgStorage';
import { orgRoutes } from '../routes/org';
import { verifyRtkWebhook, importRtkKey } from '../rtkWebhook';
import { withDb, schema, type DB } from './db/index';
import { handleRtkWebhook, joinAsGuest, joinMeeting, leaveMeeting, previewMeeting, setMeetingLocked, startHuddle } from './services/meetings';
import { huddleParticipants } from './huddles';
import { createWorkspace } from './services/workspaces';

const ANN = '00000000-0000-7000-8000-00000000000a';
const BEN = '00000000-0000-7000-8000-00000000000b';
const BOT = '00000000-0000-7000-8000-0000000000b0';
const BASE = 'https://api.cloudflare.com/client/v4/accounts/acct/realtime/kit/app';

beforeAll(() => {
  process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
  Object.assign(process.env, { RTK_ACCOUNT_ID: 'acct', RTK_APP_ID: 'app', RTK_API_TOKEN: 'secret' });
});

/** A fake RealtimeKit REST API: rooms and participants with made-up ids. */
function fakeRtk() {
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = `${init.method ?? 'GET'} ${url.slice(BASE.length)}`;
    if (path === 'POST /meetings') return Response.json({ success: true, data: { id: `rtk-${++n}` } });
    if (path.endsWith('/participants')) return Response.json({ success: true, data: { id: `p-${++n}`, token: 'tok' } });
    if (path.endsWith('/token')) return Response.json({ success: true, data: { token: 'tok2' } });
    return Response.json({ success: false }, { status: 404 });
  }));
}

let db: DB;
let sqlite: DatabaseSync;
let channelId: string;
beforeEach(async () => {
  ({ db, sqlite } = orgStorage());
  fakeRtk();
  await withDb(db, async () => {
    db.insert(schema.users).values({ id: ANN, email: 'ann@x.test', passwordHash: '!', displayName: 'Ann Lee' }).run();
    db.insert(schema.users).values({ id: BEN, email: 'ben@x.test', passwordHash: '!', displayName: 'Ben Kim' }).run();
    db.insert(schema.users).values({ id: BOT, email: 'bot@x.test', passwordHash: '!', displayName: 'Scribe', isAgent: true }).run();
    const workspaceId = (await createWorkspace(ANN, 'Locked In', 'locked-in')).id;
    channelId = db.select().from(schema.channels).get()!.id;
    for (const id of [BEN, BOT]) {
      db.insert(schema.workspaceMembers).values({ workspaceId, userId: id, role: 'member' }).run();
      db.insert(schema.channelMembers).values({ channelId, userId: id }).run();
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

const roster = () => withDb(db, () => huddleParticipants(channelId)).map((p) => p.userId);

describe('a huddle is the conversation’s Meet room', () => {
  it('makes one room per conversation and rings its people, not its agents', async () => {
    const first = await withDb(db, () => startHuddle(channelId, ANN));
    expect(first.meeting.channelId).toBe(channelId);
    expect(first.meeting.title.startsWith('#')).toBe(true);
    expect(first.meeting.code).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    const rung = sqlite.prepare('SELECT user_id FROM huddle_invite_targets').all().map((r) => (r as { user_id: string }).user_id);
    expect(rung).toEqual([BEN]);
    const again = await withDb(db, () => startHuddle(channelId, BEN));
    expect(again.meeting.id).toBe(first.meeting.id);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM meetings').get()).toEqual({ n: 1 });
  });

  it('is for its members only: a guest link says so, and a guest cannot join', async () => {
    const { meeting } = await withDb(db, () => startHuddle(channelId, ANN));
    expect(await withDb(db, () => previewMeeting(meeting.code))).toMatchObject({ guestsAllowed: false });
    await expect(withDb(db, () => joinAsGuest(meeting.code, 'Dana'))).rejects.toMatchObject({ statusCode: 403, code: 'guests_not_allowed' });
    await expect(withDb(db, () => setMeetingLocked(meeting.code, ANN, true))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('puts a person on the roster when they are in the room, and takes them off when they leave', async () => {
    const { meeting } = await withDb(db, () => startHuddle(channelId, ANN));
    expect(roster()).toEqual([]); // starting is not being there
    const joined = await withDb(db, () => joinMeeting(meeting.code, BEN));
    expect(joined.host).toBe(true); // a huddle has no organizer: everyone in the conversation hosts it
    await withDb(db, () => joinMeeting(meeting.code, ANN));
    expect(roster().sort()).toEqual([ANN, BEN].sort());
    await withDb(db, () => leaveMeeting(meeting.code, ANN));
    expect(roster()).toEqual([BEN]);
  });

  it('starts only in a room of six people or fewer (agents do not count), unless one is running', async () => {
    const addPerson = (i: number) =>
      withDb(db, async () => {
        const id = `00000000-0000-7000-8000-0000000001${String(i).padStart(2, '0')}`;
        db.insert(schema.users).values({ id, email: `p${i}@x.test`, passwordHash: '!', displayName: `P${i}` }).run();
        db.insert(schema.channelMembers).values({ channelId, userId: id }).run();
      });
    for (let i = 0; i < 4; i++) await addPerson(i); // Ann, Ben and four more: six people, plus the agent
    const { meeting } = await withDb(db, () => startHuddle(channelId, ANN));
    await addPerson(4); // seven
    await expect(withDb(db, () => startHuddle(channelId, BEN))).rejects.toMatchObject({ statusCode: 409, code: 'room_too_large' });
    await withDb(db, () => joinMeeting(meeting.code, ANN));
    await expect(withDb(db, () => startHuddle(channelId, BEN))).resolves.toMatchObject({ meeting: { id: meeting.id } });
  });

  it('the webhook drops someone who closed the tab, and clears the roster when the meeting ends', async () => {
    const { meeting } = await withDb(db, () => startHuddle(channelId, ANN));
    await withDb(db, () => joinMeeting(meeting.code, ANN));
    await withDb(db, () => joinMeeting(meeting.code, BEN));
    const rtkId = (sqlite.prepare('SELECT rtk_meeting_id AS id FROM meetings').get() as { id: string }).id;
    await withDb(db, () => handleRtkWebhook({ event: 'meeting.participantLeft', meeting: { id: rtkId }, participant: { customParticipantId: BEN } }));
    expect(roster()).toEqual([ANN]);
    await withDb(db, () => handleRtkWebhook({ event: 'meeting.ended', meeting: { id: rtkId } }));
    expect(roster()).toEqual([]);
  });
});

describe('the Worker side', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const signBody = (body: string) => sign('sha256', Buffer.from(body), keys.privateKey).toString('base64');
  const env = (org: string | null = 'org-1') => {
    const handle = vi.fn(async () => Response.json({ ok: true }));
    return {
      handle,
      env: {
        RTK_ACCOUNT_ID: 'acct', RTK_APP_ID: 'app', RTK_API_TOKEN: 'secret',
        DIRECTORY: { idFromName: () => 'd', get: () => ({ call: async () => ({ ok: true, value: org }) }) },
        ORG: { idFromName: (id: string) => id, get: () => ({ handle }) },
      },
    };
  };
  const post = (e: object, body: string, signature?: string) =>
    orgRoutes.request('https://app.example/v1/rtk/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'rtk-signature': signature } : {}) }, body }, e as never);

  beforeEach(() => {
    // The Worker fetches RealtimeKit's public key; here it is the test's own.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, data: { publicKey: pem } })));
  });

  it('/v1/config says Meet is on and the old LiveKit huddles are off', async () => {
    expect(await (await orgRoutes.request('https://app.example/v1/config', {}, env().env as never)).json()).toMatchObject({ huddles: false, meet: true });
  });

  it('verifies a signature over the raw body', async () => {
    const key = await importRtkKey(pem);
    const body = '{"event":"meeting.ended"}';
    expect(await verifyRtkWebhook(body, signBody(body), key)).toBe(true);
    expect(await verifyRtkWebhook(body.replace('ended', 'started'), signBody(body), key)).toBe(false);
    expect(await verifyRtkWebhook(body, undefined, key)).toBe(false);
  });

  it('forwards a signed webhook to the organization that owns the meeting, marked as verified', async () => {
    const { handle, env: e } = env();
    const body = JSON.stringify({ event: 'meeting.ended', meeting: { id: '00000000-0000-7000-8000-0000000000c1' } });
    expect((await post(e, body, signBody(body))).status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(1);
    const [req] = handle.mock.calls[0]! as unknown as [Request];
    expect(await req.text()).toBe(body);
    expect(req.headers.get('x-flow-rtk-verified')).toBe('1');
  });

  it('refuses an unsigned or forged webhook without waking an object, and drops a meeting that is not ours', async () => {
    const { handle, env: e } = env();
    const body = JSON.stringify({ event: 'meeting.ended', meeting: { id: '00000000-0000-7000-8000-0000000000c1' } });
    expect((await post(e, body)).status).toBe(401);
    expect((await post(e, body, signBody(body.replace('ended', 'started')))).status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
    const stranger = env(null);
    expect((await post(stranger.env, body, signBody(body))).status).toBe(200);
    expect(stranger.handle).not.toHaveBeenCalled();
  });
});
