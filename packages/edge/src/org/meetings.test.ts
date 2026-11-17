// Meet on Workers (docs/specs/meetings.md, phase 1): a room is made on RealtimeKit and kept here; a join adds the person
// to RTK once (the creator as host) and only refreshes their token after that; only members can see or join a room;
// Live now asks RTK who is in each recently used room.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { orgStorage } from '../../test/orgStorage';
import { orgRoutes } from '../routes/org';
import { withDb, schema, type DB } from './db/index';
import { createMeeting, getMeeting, joinAsGuest, joinMeeting, liveMeetings, newMeetingCode, previewMeeting, setMeetingLocked, setMeetingTitle } from './services/meetings';
import { createWorkspace } from './services/workspaces';

const ANN = '00000000-0000-7000-8000-00000000000a';
const BEN = '00000000-0000-7000-8000-00000000000b';
const EVE = '00000000-0000-7000-8000-00000000000e';
const BASE = 'https://api.cloudflare.com/client/v4/accounts/acct/realtime/kit/app';

beforeAll(() => {
  process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
  Object.assign(process.env, { RTK_ACCOUNT_ID: 'acct', RTK_APP_ID: 'app', RTK_API_TOKEN: 'secret' });
});

type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
let calls: Call[];
/** A fake RTK: answers by path, and records every call. */
function fakeRtk(answers: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method: init.method ?? 'GET', url, body });
    const key = `${init.method ?? 'GET'} ${url.slice(BASE.length)}`;
    const hit = Object.entries(answers).find(([k]) => key === k || (k.endsWith('*') && key.startsWith(k.slice(0, -1))));
    if (!hit) return Response.json({ success: false, error: { code: 404 } }, { status: 404 });
    return Response.json({ success: true, data: hit[1] });
  }));
}

let db: DB;
let sqlite: DatabaseSync;
let workspaceId: string;
beforeEach(async () => {
  ({ db, sqlite } = orgStorage());
  await withDb(db, async () => {
    for (const [id, name] of [[ANN, 'Ann Lee'], [BEN, 'Ben Kim'], [EVE, 'Eve Out']] as const) {
      db.insert(schema.users).values({ id, email: `${id}@x.test`, passwordHash: '!', displayName: name }).run();
    }
    workspaceId = (await createWorkspace(ANN, 'Locked In', 'locked-in')).id;
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: BEN, role: 'member' }).run();
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('a meeting room', () => {
  it('is created on RTK with a default title and kept in SQLite', async () => {
    fakeRtk({ 'POST /meetings': { id: 'rtk-m1' } });
    const m = await withDb(db, () => createMeeting(workspaceId, ANN));
    expect(m).toMatchObject({ workspaceId, title: "Ann's meeting", createdBy: ANN });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/meetings`, body: { title: "Ann's meeting" } });
    expect(sqlite.prepare('SELECT rtk_meeting_id FROM meetings WHERE id = ?').get(m.id)).toEqual({ rtk_meeting_id: 'rtk-m1' });
    expect(m.code).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  });

  it('is found by its short code or by its id', async () => {
    fakeRtk({ 'POST /meetings': { id: 'rtk-m1' } });
    const m = await withDb(db, () => createMeeting(workspaceId, ANN));
    expect(await withDb(db, () => getMeeting(m.code, BEN))).toEqual(m);
    expect(await withDb(db, () => getMeeting(m.id, BEN))).toEqual(m);
    await expect(withDb(db, () => getMeeting('zzz-zzzz-zzz', BEN))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('makes codes from letters that cannot be misread (no i, l or o)', () => {
    expect(newMeetingCode(() => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe('abc-defg-hjk');
    for (let i = 0; i < 200; i++) expect(newMeetingCode()).toMatch(/^[a-hj-km-np-z]{3}-[a-hj-km-np-z]{4}-[a-hj-km-np-z]{3}$/);
  });

  it('adds a person to RTK on the first join (the creator as host) and only refreshes the token after that', async () => {
    fakeRtk({
      'POST /meetings': { id: 'rtk-m1' },
      'POST /meetings/rtk-m1/participants': { id: 'p-ann', token: 'tok-1' },
      'POST /meetings/rtk-m1/participants/p-ann/token': { token: 'tok-2' },
    });
    const m = await withDb(db, () => createMeeting(workspaceId, ANN, 'Design review'));
    const first = await withDb(db, () => joinMeeting(m.id, ANN));
    expect(first).toMatchObject({ authToken: 'tok-1', host: true, meeting: { title: 'Design review' } });
    expect(calls[1]?.body).toMatchObject({ name: 'Ann Lee', preset_name: 'group_call_host', custom_participant_id: ANN });
    const again = await withDb(db, () => joinMeeting(m.id, ANN));
    expect(again).toMatchObject({ authToken: 'tok-2', host: true });
    expect(calls.filter((c) => c.url.endsWith('/participants'))).toHaveLength(1);
  });

  it('lets another member join as a participant, and hides the room from people outside the organization', async () => {
    fakeRtk({ 'POST /meetings': { id: 'rtk-m1' }, 'POST /meetings/rtk-m1/participants': { id: 'p-ben', token: 'tok-b' } });
    const m = await withDb(db, () => createMeeting(workspaceId, ANN));
    expect(await withDb(db, () => joinMeeting(m.id, BEN))).toMatchObject({ host: false });
    expect(calls[1]?.body).toMatchObject({ preset_name: 'group_call_participant', custom_participant_id: BEN });
    await expect(withDb(db, () => joinMeeting(m.id, EVE))).rejects.toMatchObject({ statusCode: 404 });
    await expect(withDb(db, () => getMeeting(m.id, EVE))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('Live now lists the rooms RTK has a session for, with the people in them', async () => {
    fakeRtk({
      'POST /meetings': { id: 'rtk-m1' },
      'POST /meetings/rtk-m1/participants': { id: 'p-ann', token: 't' },
      'GET /meetings/rtk-m1/active-session': { id: 's1', started_at: '2026-11-16T10:00:00Z', live_participants: 2 },
      'GET /sessions/s1/participants': [
        { custom_participant_id: ANN, display_name: 'Ann Lee', left_at: null },
        { custom_participant_id: ANN, display_name: 'Ann Lee', left_at: null },
        { custom_participant_id: BEN, display_name: 'Ben Kim', left_at: '2026-11-16T10:05:00Z' },
      ],
    });
    const m = await withDb(db, () => createMeeting(workspaceId, ANN));
    expect(await withDb(db, () => liveMeetings(workspaceId, BEN))).toEqual([]); // never joined: not asked about
    await withDb(db, () => joinMeeting(m.id, ANN));
    const live = await withDb(db, () => liveMeetings(workspaceId, BEN));
    expect(live).toEqual([expect.objectContaining({ id: m.id, startedAt: '2026-11-16T10:00:00Z', people: [{ userId: ANN, name: 'Ann Lee' }] })]);
  });

  it('answers 503 when Meet is not set up', async () => {
    const saved = process.env.RTK_API_TOKEN;
    delete process.env.RTK_API_TOKEN;
    try {
      await expect(withDb(db, () => createMeeting(workspaceId, ANN))).rejects.toMatchObject({ statusCode: 503, code: 'meet_unavailable' });
      expect(await withDb(db, () => liveMeetings(workspaceId, ANN))).toEqual([]);
    } finally {
      process.env.RTK_API_TOKEN = saved;
    }
  });
});

describe('guests (phase 3)', () => {
  const made = async () => {
    fakeRtk({ 'POST /meetings': { id: 'rtk-m1' }, 'POST /meetings/rtk-m1/participants': { id: 'p-g', token: 'guest-tok' } });
    return withDb(db, () => createMeeting(workspaceId, ANN, 'Design review'));
  };

  it('a link shows its title, who made it and who is in, with first names only and no ids', async () => {
    const m = await made();
    fakeRtk({ 'GET /meetings/rtk-m1/active-session': { id: 's1' }, 'GET /sessions/s1/participants': [{ custom_participant_id: BEN, display_name: 'Ben Kim' }] });
    const preview = await withDb(db, () => previewMeeting(m.code));
    expect(preview).toEqual({ code: m.code, title: 'Design review', hostName: 'Ann', people: ['Ben'], locked: false, guestsAllowed: true });
  });

  it('a guest joins straight in with their name, as a new RTK guest that is never a member', async () => {
    const m = await made();
    const joined = await withDb(db, () => joinAsGuest(m.code, '  Dana   Guest '));
    expect(joined.join).toEqual({ code: m.code, title: 'Design review', authToken: 'guest-tok', chatChannelId: expect.any(String) });
    const add = calls.find((c) => c.url.endsWith('/participants'))!;
    expect(add.body).toMatchObject({ name: 'Dana Guest', preset_name: 'flow_guest' });
    expect(String(add.body!.custom_participant_id)).toMatch(/^guest-/);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM meeting_participants').get()).toEqual({ n: 0 });
    await expect(withDb(db, () => joinAsGuest(m.code, '   '))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('only takes a code, never an id, from a guest', async () => {
    const m = await made();
    await expect(withDb(db, () => previewMeeting(m.id))).rejects.toMatchObject({ statusCode: 404 });
    await expect(withDb(db, () => joinAsGuest(m.id, 'Dana'))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a host locks a meeting: guests are refused, members still join; others cannot lock it', async () => {
    const m = await made();
    await expect(withDb(db, () => setMeetingLocked(m.code, BEN, true))).rejects.toMatchObject({ statusCode: 403, code: 'not_host' });
    await expect(withDb(db, () => setMeetingLocked(m.code, EVE, true))).rejects.toMatchObject({ statusCode: 404 });
    expect(await withDb(db, () => setMeetingLocked(m.code, ANN, true))).toMatchObject({ locked: true });
    await expect(withDb(db, () => joinAsGuest(m.code, 'Dana'))).rejects.toMatchObject({ statusCode: 403, code: 'meeting_locked' });
    fakeRtk({ 'POST /meetings/rtk-m1/participants': { id: 'p-b', token: 'ben-tok' } });
    await expect(withDb(db, () => joinMeeting(m.code, BEN))).resolves.toMatchObject({ authToken: 'ben-tok' });
    expect(await withDb(db, () => setMeetingLocked(m.code, ANN, false))).toMatchObject({ locked: false });
  });

  it('a host renames a meeting (Calendar, once the event has a title); others cannot; empty changes nothing', async () => {
    const m = await made();
    await expect(withDb(db, () => setMeetingTitle(m.code, BEN, 'Plan'))).rejects.toMatchObject({ statusCode: 403, code: 'not_host' });
    expect(await withDb(db, () => setMeetingTitle(m.code, ANN, '  Weekly plan '))).toMatchObject({ title: 'Weekly plan' });
    expect(await withDb(db, () => setMeetingTitle(m.code, ANN, '   '))).toMatchObject({ title: 'Weekly plan' });
    expect(await withDb(db, () => previewMeeting(m.code))).toMatchObject({ title: 'Weekly plan' });
  });
});

describe('the Worker side', () => {
  it('finds the organization of a meeting link by its short code, as by an id', async () => {
    const lookups: unknown[][] = [];
    const env = {
      DIRECTORY: { idFromName: () => 'd', get: () => ({ call: async (...args: unknown[]) => (lookups.push(args), { ok: true, value: null }) }) },
      ORG: { idFromName: (id: string) => id, get: () => ({ handle: vi.fn(async () => Response.json({})) }) },
    };
    const handle = env.ORG.get().handle;
    env.ORG.get = () => ({ handle });
    const res = await orgRoutes.request('https://app.example/v1/meetings/kqd-wmzt-fra/join', { method: 'POST' }, env as never);
    expect(lookups[0]).toEqual(['organizationOfId', ['kqd-wmzt-fra']]);
    // The fake directory knows no such code, so nothing reaches an organization (index.ts turns the throw into a 404).
    expect(res.ok).toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });

  it('sends a guest link, with no sign-in, to the organization that owns the code', async () => {
    const handle = vi.fn(async () => Response.json({ title: 'Design review' }));
    const env = {
      DIRECTORY: { idFromName: () => 'd', get: () => ({ call: async () => ({ ok: true, value: 'org-1' }) }) },
      ORG: { idFromName: (id: string) => id, get: () => ({ handle }) },
    };
    const res = await orgRoutes.request('https://app.example/v1/meetings/kqd-wmzt-fra/guest', {}, env as never);
    expect(res.status).toBe(200);
    const [, who] = handle.mock.calls[0]! as unknown as [Request, { user: unknown; organizationId: string }];
    expect(who).toMatchObject({ user: null, organizationId: 'org-1' });
  });
});
