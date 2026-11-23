// Agents in Meet meetings (docs/specs/meetings.md phase 5): someone in a room sends their own agent or a shared hosted
// one; it joins RTK as `agent:<id>` with our agent preset, is added to the meeting's chat, and recording starts, and
// `meet.agent.joined` goes in the agent's event log. After the session's transcript is saved (or without one, after a
// grace), each agent of that session gets `meet.ended`, which wakes its "Meeting notes" automation; the agent saves its
// Notes with save_meeting_notes, in the meeting's folder by whoever sent it and linked in the chat as the agent.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { orgStorage } from '../../test/orgStorage';
import { withDb, schema, type DB } from './db/index';
import { createMeeting, handleRtkWebhook, joinMeeting } from './services/meetings';
import { saveDueMeetingFiles, setMeetingDocs, startRecording, type MeetingDocs } from './services/meetingRecordings';
import type { PublishInput } from '../events/core';
import { agentLeft, endOverdueMeetingAgents, ENDED_GRACE_MS, listAgents, recallAgent, saveMeetingNotes, sendAgent, setMeetingAgentHooks, type MeetingAgentHooks } from './services/meetingAgents';
import { createWorkspace } from './services/workspaces';

const ANN = '00000000-0000-7000-8000-00000000000a';
const BEN = '00000000-0000-7000-8000-00000000000b';
const ADA = '00000000-0000-7000-8000-0000000000ad'; // Ann's assistant
const BOB = '00000000-0000-7000-8000-0000000000b0'; // Ben's assistant
const OMNI = '00000000-0000-7000-8000-0000000000ee'; // the organization's shared agent
const CARL = '00000000-0000-7000-8000-0000000000ca'; // the admin agent
const BASE = 'https://api.cloudflare.com/client/v4/accounts/acct/realtime/kit/app';
const TRANSCRIPT_URL = 'https://rtk-download.test/transcript.json';

beforeAll(() => {
  process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
  Object.assign(process.env, { RTK_ACCOUNT_ID: 'acct', RTK_APP_ID: 'app', RTK_API_TOKEN: 'secret' });
});

type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
let calls: Call[];
let transcript: unknown[];
function fakeRtk(answers: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method: init.method ?? 'GET', url, body });
    if (url === TRANSCRIPT_URL) return Response.json(transcript);
    const key = `${init.method ?? 'GET'} ${url.slice(BASE.length)}`;
    const hit = Object.entries(answers).find(([k]) => key === k);
    if (!hit || hit[1] === null) return Response.json({ success: false }, { status: 404 });
    return Response.json({ success: true, data: hit[1] });
  }));
}

const ROOM = {
  'POST /meetings': { id: 'rtk-m1' },
  'POST /meetings/rtk-m1/participants': { id: 'p-1', token: 'tok-agent' },
  'GET /meetings/rtk-m1/active-session': { id: 'sess-1', live_participants: 2 },
  'GET /recordings/active-recording/rtk-m1': null,
  'PATCH /meetings/rtk-m1': {},
  'POST /recordings': { id: 'rec-1', session_id: 'sess-1', status: 'INVOKED' },
};

let joined: { meetingAgentId: string; token: string }[];
let recalled: string[];
let published: PublishInput[];
let wakesFor: string[];
let saved: Parameters<MeetingDocs['saveMeetingFiles']>[];
function fakes() {
  joined = [];
  recalled = [];
  published = [];
  wakesFor = [];
  saved = [];
  const hooks: MeetingAgentHooks = {
    join: async (p) => void joined.push(p),
    recall: async (id) => void recalled.push(id),
    publish: async (e) => void published.push(e),
    ensureMeetingWake: async (p) => void wakesFor.push(p.agentAccountId),
    adminAgentId: async () => CARL,
  };
  setMeetingAgentHooks(hooks);
  setMeetingDocs(() => ({
    async saveMeetingFiles(...args) {
      saved.push(args);
      const md = args[2].markdown;
      return { folderUrl: '/docs/', ...(md ? { markdown: { id: `s-${saved.length}`, url: `/docs/md/s-${saved.length}` } } : {}) };
    },
  }));
}
const ended = () => published.filter((e) => e.type === 'meet.ended');

let db: DB;
let sqlite: DatabaseSync;
let workspaceId: string;
beforeEach(async () => {
  fakes();
  transcript = [{ startTime: 1000, sentence: 'Let us plan Q4.', peerData: { displayName: 'Ann Lee' } }];
  ({ db, sqlite } = orgStorage());
  await withDb(db, async () => {
    for (const [id, name, isAgent] of [[ANN, 'Ann Lee', false], [BEN, 'Ben Kim', false], [ADA, 'Ada', true], [BOB, 'Bob', true], [OMNI, 'Omni', true], [CARL, 'Carl', true]] as const) {
      db.insert(schema.users).values({ id, email: `${id}@x.test`, passwordHash: '!', displayName: name, isAgent }).run();
    }
    workspaceId = (await createWorkspace(ANN, 'Locked In', 'locked-in')).id;
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: BEN, role: 'member', accountId: 'acct-ben' }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: ADA, role: 'member', kind: 'personal_agent', runtime: 'hosted', sponsorUserId: ANN, accountId: 'acct-ada' }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: BOB, role: 'member', kind: 'personal_agent', runtime: 'hosted', sponsorUserId: BEN, accountId: 'acct-bob' }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: OMNI, role: 'member', kind: 'native', runtime: 'hosted', accountId: 'acct-omni' }).run();
    db.insert(schema.workspaceMembers).values({ workspaceId, userId: CARL, role: 'member', kind: 'native', runtime: 'hosted', accountId: 'acct-carl' }).run();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setMeetingAgentHooks(null);
  setMeetingDocs(null);
});

async function room() {
  fakeRtk(ROOM);
  const m = await withDb(db, () => createMeeting(workspaceId, ANN, 'Weekly planning'));
  await withDb(db, () => joinMeeting(m.code, ANN));
  await withDb(db, () => joinMeeting(m.code, BEN));
  return m;
}

describe('sending an agent', () => {
  it('joins RTK as agent:<id> with the agent preset, enters the meeting chat, and starts recording', async () => {
    const m = await room();
    const a = await withDb(db, () => sendAgent(m.code, ANN, ADA));
    expect(a).toMatchObject({ agentId: ADA, name: 'Ada', sentBy: ANN });
    const add = calls.find((c) => c.method === 'POST' && c.url === `${BASE}/meetings/rtk-m1/participants` && c.body?.preset_name === 'flow_agent');
    expect(add?.body).toMatchObject({ name: 'Ada', preset_name: 'flow_agent', custom_participant_id: `agent:${ADA}` });
    expect(joined).toEqual([{ organizationId: workspaceId, meetingAgentId: a.id, rtkMeetingId: 'rtk-m1', token: 'tok-agent' }]);
    const chat = sqlite.prepare('SELECT chat_channel_id AS id FROM meetings WHERE id = ?').get(m.id) as { id: string };
    expect(sqlite.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(chat.id, ADA)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url === `${BASE}/recordings`)).toBe(true);
    expect((await withDb(db, () => listAgents(m.code, BEN))).map((x) => x.agentId)).toEqual([ADA]);
  });

  it('logs meet.agent.joined as the agent\'s own event, asked by its sender, and makes sure its Meeting notes automation exists', async () => {
    const m = await room();
    await withDb(db, () => sendAgent(m.code, BEN, OMNI));
    expect(wakesFor).toEqual(['acct-omni']);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'meet.agent.joined', organizationId: workspaceId, actor: 'acct-omni', invokedBy: 'acct-ben', audience: 'account:acct-omni', about: ['acct-omni'],
      data: { meetingId: m.id, title: 'Weekly planning', sessionId: 'sess-1', sentBy: { accountId: 'acct-ben', name: 'Ben Kim' } },
    });
    expect((published[0]!.data as { link: string }).link).toMatch(new RegExp(`/meet/${m.code}$`));
  });

  it('sends your own agents and shared ones; not someone else\'s, nor the admin agent, nor one already there', async () => {
    const m = await room();
    await expect(withDb(db, () => sendAgent(m.code, ANN, BOB))).rejects.toMatchObject({ statusCode: 404 });
    await expect(withDb(db, () => sendAgent(m.code, ANN, CARL))).rejects.toMatchObject({ statusCode: 404 });
    await expect(withDb(db, () => sendAgent(m.code, ANN, BEN))).rejects.toMatchObject({ statusCode: 404 });
    await withDb(db, () => sendAgent(m.code, BEN, OMNI));
    await expect(withDb(db, () => sendAgent(m.code, ANN, OMNI))).rejects.toMatchObject({ statusCode: 409 });
    await withDb(db, () => sendAgent(m.code, BEN, BOB));
    expect(joined).toHaveLength(2);
  });

  it('is refused while nobody is in the room, and undone when the agent cannot join', async () => {
    const m = await room();
    fakeRtk({ ...ROOM, 'GET /meetings/rtk-m1/active-session': null });
    await expect(withDb(db, () => sendAgent(m.code, ANN, ADA))).rejects.toMatchObject({ statusCode: 409 });
    fakeRtk(ROOM);
    setMeetingAgentHooks({ join: async () => { throw new Error('ws refused'); }, recall: async () => {}, publish: async () => {}, ensureMeetingWake: async () => {}, adminAgentId: async () => null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(withDb(db, () => sendAgent(m.code, ANN, ADA))).rejects.toMatchObject({ statusCode: 502 });
    expect(await withDb(db, () => listAgents(m.code, ANN))).toEqual([]);
  });

  it('anyone in the room sends it away; its object leaving marks it gone too', async () => {
    const m = await room();
    const a = await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => recallAgent(m.code, BEN, ADA));
    expect(recalled).toEqual([a.id]);
    expect(await withDb(db, () => listAgents(m.code, ANN))).toEqual([]);
    const b = await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => agentLeft(b.id));
    expect(await withDb(db, () => listAgents(m.code, ANN))).toEqual([]);
  });
});

describe('after the meeting', () => {
  const transcriptHook = { event: 'meeting.transcript', meeting: { id: 'rtk-m1', sessionId: 'sess-1' }, transcriptDownloadUrl: TRANSCRIPT_URL };

  it('once the transcript is saved, each agent of the session gets meet.ended with it, once', async () => {
    const m = await room();
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => sendAgent(m.code, BEN, OMNI));
    await withDb(db, () => handleRtkWebhook(transcriptHook));
    await withDb(db, () => saveDueMeetingFiles());
    expect(saved.map((s) => s[2].markdown?.title)).toEqual(['Transcript']);
    const events = ended();
    expect(events.map((e) => e.audience).sort()).toEqual(['account:acct-ada', 'account:acct-omni']);
    const ada = events.find((e) => e.audience === 'account:acct-ada')!;
    expect(ada).toMatchObject({
      actor: null, about: ['acct-ada'],
      data: {
        meetingId: m.id, title: 'Weekly planning', sessionId: 'sess-1', folder: saved[0]![2].folder, sentBy: { name: 'Ann Lee' },
        transcript: { docId: 's-1', hadSpeech: true, speakers: ['Ann Lee'] }, notesSaved: false,
      },
    });
    expect((ada.data as { transcript: { url: string } }).transcript.url).toMatch(/\/docs\/md\/s-1$/);
    // Later sweeps publish nothing more for it.
    await withDb(db, () => endOverdueMeetingAgents(Date.now() + 10 * ENDED_GRACE_MS));
    expect(ended()).toHaveLength(2);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM meeting_agents WHERE ended_at IS NULL').get()).toEqual({ n: 0 });
  });

  it('with no transcript, meet.ended comes without one after the grace; not while a transcript waits to be copied', async () => {
    const m = await room();
    const a = await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => agentLeft(a.id));
    await withDb(db, () => endOverdueMeetingAgents(Date.now() + ENDED_GRACE_MS / 2));
    expect(ended()).toHaveLength(0);
    // The transcript arrived but is not copied yet: the copy publishes it.
    await withDb(db, () => handleRtkWebhook(transcriptHook));
    await withDb(db, () => endOverdueMeetingAgents(Date.now() + 2 * ENDED_GRACE_MS));
    expect(ended()).toHaveLength(0);
    // The copy fails: the agent still hears the meeting ended, without a transcript.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    transcript = null as never;
    fakeRtk({ ...ROOM });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 410 })));
    await withDb(db, () => saveDueMeetingFiles());
    expect(ended()).toHaveLength(1);
    expect(ended()[0]!.data).toMatchObject({ transcript: null, folder: expect.stringContaining('Weekly planning') });
  });

  it('an unrecorded session: meet.ended without a transcript once the grace is over', async () => {
    const m = await room();
    fakeRtk({ ...ROOM, 'POST /recordings': null });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => agentLeft(a.id));
    await withDb(db, () => endOverdueMeetingAgents(Date.now() + ENDED_GRACE_MS + 1000));
    expect(ended()).toHaveLength(1);
    expect(ended()[0]!.data).toMatchObject({ transcript: null, folder: null });
  });

  it('no agent, no events: recording alone works as before', async () => {
    const m = await room();
    await withDb(db, () => startRecording(m.code, ANN));
    await withDb(db, () => handleRtkWebhook(transcriptHook));
    await withDb(db, () => saveDueMeetingFiles());
    expect(published).toEqual([]);
    expect(saved).toHaveLength(1);
  });
});

describe('save_meeting_notes', () => {
  const transcriptHook = { event: 'meeting.transcript', meeting: { id: 'rtk-m1', sessionId: 'sess-1' }, transcriptDownloadUrl: TRANSCRIPT_URL };

  it("saves the agent's notes in the session's folder as its sender and links them in the chat as the agent", async () => {
    const m = await room();
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => handleRtkWebhook(transcriptHook));
    await withDb(db, () => saveDueMeetingFiles());
    const out = await withDb(db, () => saveMeetingNotes(ADA, { meetingId: m.id, sessionId: 'sess-1', notes: '## Summary\nWe planned Q4.' }));
    const [transcriptSave, notesSave] = saved;
    expect(notesSave![1]).toEqual({ userId: ANN, email: `${ANN}@x.test` });
    expect(notesSave![2]).toMatchObject({ folder: transcriptSave![2].folder, markdown: { title: 'Notes', text: '## Summary\nWe planned Q4.' } });
    expect(out).toMatchObject({ folder: transcriptSave![2].folder, docId: 's-2' });
    const chat = sqlite.prepare('SELECT chat_channel_id AS id FROM meetings WHERE id = ?').get(m.id) as { id: string };
    const lines = sqlite.prepare("SELECT user_id FROM messages WHERE channel_id = ? AND system_kind = 'file_shared' ORDER BY created_at").all(chat.id) as { user_id: string }[];
    expect(lines.map((l) => l.user_id)).toEqual([ANN, ADA]);
    expect(sqlite.prepare('SELECT notes_url FROM meeting_agents').get()).toEqual({ notes_url: '/docs/md/s-2' });
  });

  it('names the notes after the agent when two were there, and makes a folder for an unrecorded session', async () => {
    const m = await room();
    fakeRtk({ ...ROOM, 'POST /recordings': null });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => sendAgent(m.code, BEN, OMNI));
    await withDb(db, () => saveMeetingNotes(OMNI, { meetingId: m.id, notes: 'Short.' }));
    expect(saved[0]![1]).toEqual({ userId: BEN, email: `${BEN}@x.test` });
    expect(saved[0]![2]).toMatchObject({ folder: expect.stringMatching(/^Meetings\/\d{4}-\d{2}-\d{2} Weekly planning$/), markdown: { title: 'Notes · Omni' } });
  });

  it('refuses an agent that was not sent to the meeting, and empty notes', async () => {
    const m = await room();
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await expect(withDb(db, () => saveMeetingNotes(BOB, { meetingId: m.id, notes: 'x' }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(withDb(db, () => saveMeetingNotes(ADA, { meetingId: m.id, notes: '  ' }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(withDb(db, () => saveMeetingNotes(ADA, { meetingId: 'nope', notes: 'x' }))).rejects.toMatchObject({ statusCode: 404 });
    expect(saved).toEqual([]);
  });
});
