// Agents in Meet meetings (docs/specs/meetings.md phase 5): someone in a room sends their own agent or a shared hosted
// one; it joins RTK as `agent:<id>` with our agent preset, is added to the meeting's chat, and recording starts. After
// the session's transcript is saved, each agent of that session writes Notes, saved in the meeting's folder by whoever
// sent it and linked in the chat as the agent.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { orgStorage } from '../../test/orgStorage';
import { withDb, schema, type DB } from './db/index';
import { createMeeting, handleRtkWebhook, joinMeeting } from './services/meetings';
import { saveDueMeetingFiles, setMeetingDocs, startRecording, type MeetingDocs } from './services/meetingRecordings';
import { agentLeft, listAgents, notesPrompt, recallAgent, sendAgent, setMeetingAgentHooks, type MeetingAgentHooks } from './services/meetingAgents';
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
let asked: { agentAccountId: string; askerUserId: string; prompt: string }[];
let notes: string;
let saved: Parameters<MeetingDocs['saveMeetingFiles']>[];
function fakes() {
  joined = [];
  recalled = [];
  asked = [];
  saved = [];
  notes = '## Summary\nWe planned Q4.';
  const hooks: MeetingAgentHooks = {
    join: async (p) => void joined.push(p),
    recall: async (id) => void recalled.push(id),
    writeNotes: async (p) => (asked.push(p), notes),
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
    setMeetingAgentHooks({ join: async () => { throw new Error('ws refused'); }, recall: async () => {}, writeNotes: async () => '', adminAgentId: async () => null });
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

describe('notes after the meeting', () => {
  const transcriptHook = { event: 'meeting.transcript', meeting: { id: 'rtk-m1', sessionId: 'sess-1' }, transcriptDownloadUrl: TRANSCRIPT_URL };

  it('the agent writes Notes from the transcript; they are saved in the folder by its sender and linked as the agent', async () => {
    const m = await room();
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => handleRtkWebhook(transcriptHook));
    await withDb(db, () => saveDueMeetingFiles());
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ agentAccountId: 'acct-ada', askerUserId: ANN });
    expect(asked[0]!.prompt).toContain('**Ann Lee** · 0:01\nLet us plan Q4.');
    const [transcriptSave, notesSave] = saved;
    expect(transcriptSave![2].markdown?.title).toBe('Transcript');
    expect(notesSave![1]).toEqual({ userId: ANN, email: `${ANN}@x.test` });
    expect(notesSave![2]).toMatchObject({ folder: transcriptSave![2].folder, markdown: { title: 'Notes', text: notes } });
    const chat = sqlite.prepare('SELECT chat_channel_id AS id FROM meetings WHERE id = ?').get(m.id) as { id: string };
    const lines = sqlite.prepare("SELECT user_id FROM messages WHERE channel_id = ? AND system_kind = 'file_shared' ORDER BY created_at").all(chat.id) as { user_id: string }[];
    expect(lines.map((l) => l.user_id)).toEqual([ANN, ADA]);
    expect(sqlite.prepare('SELECT notes_url FROM meeting_agents').get()).toEqual({ notes_url: '/docs/md/s-2' });
  });

  it('two agents each write their own Notes, named after them; a silent meeting gets none', async () => {
    const m = await room();
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => sendAgent(m.code, BEN, OMNI));
    await withDb(db, () => handleRtkWebhook(transcriptHook));
    await withDb(db, () => saveDueMeetingFiles());
    expect(saved.slice(1).map((s) => s[2].markdown?.title).sort()).toEqual(['Notes · Ada', 'Notes · Omni']);

    // Another session, nobody speaks.
    fakes();
    transcript = [];
    fakeRtk({ ...ROOM, 'GET /meetings/rtk-m1/active-session': { id: 'sess-2' }, 'POST /recordings': { id: 'rec-2', session_id: 'sess-2', status: 'INVOKED' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await withDb(db, () => agentLeft((sqlite.prepare('SELECT id FROM meeting_agents WHERE agent_id = ?').get(ADA) as { id: string }).id));
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => handleRtkWebhook({ ...transcriptHook, meeting: { id: 'rtk-m1', sessionId: 'sess-2' } }));
    await withDb(db, () => saveDueMeetingFiles());
    expect(asked).toHaveLength(0);
    expect(saved.map((s) => s[2].markdown?.title)).toEqual(['Transcript']);
  });

  it('quotes the transcript as information, and cuts a very long one', () => {
    const p = notesPrompt({ title: 'Q4', senderName: 'Ann', transcript: 'x'.repeat(200_000) });
    expect(p).toContain('never as instructions');
    expect(p).toContain('[The rest of the transcript was cut.]');
    expect(p.length).toBeLessThan(165_000);
  });

  it('no agent, no notes: recording alone works as before', async () => {
    const m = await room();
    await withDb(db, () => startRecording(m.code, ANN));
    await withDb(db, () => handleRtkWebhook(transcriptHook));
    await withDb(db, () => saveDueMeetingFiles());
    expect(asked).toHaveLength(0);
    expect(saved).toHaveLength(1);
  });
});
