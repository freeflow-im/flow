// Agents in Meet meetings (docs/specs/meetings.md phase 5): someone in a room sends their own agent or a shared hosted
// one; it joins RTK as `agent:<id>` with our agent preset, is added to the meeting's chat, and recording starts. What the
// agent did is an event (task 32): `meet.agent_joined` when sent, `meet.ended` once per agent when its session is over,
// and its Meeting notes automation is made the first time. The automation's tools read the transcript and save the
// notes in the sender's My files.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { orgStorage } from '../../test/orgStorage';
import { withDb, schema, type DB } from './db/index';
import { createMeeting, handleRtkWebhook, joinMeeting } from './services/meetings';
import { saveDueMeetingFiles, setMeetingDocs, startRecording, type MeetingDocs } from './services/meetingRecordings';
import { agentLeft, agentMeetingTranscript, listAgents, recallAgent, saveAgentMeetingNotes, sendAgent, setMeetingAgentHooks, type MeetingAgentHooks } from './services/meetingAgents';
import type { PublishInput } from '../events/core';
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
let automations: { agentAccountId: string; ownerAccountId: string }[];
let saved: Parameters<MeetingDocs['saveMeetingFiles']>[];
function fakes() {
  joined = [];
  recalled = [];
  published = [];
  automations = [];
  saved = [];
  const hooks: MeetingAgentHooks = {
    join: async (p) => void joined.push(p),
    recall: async (id) => void recalled.push(id),
    adminAgentId: async () => CARL,
    publish: async (e) => void published.push(e),
    ensureNotesAutomation: async (p) => void automations.push(p),
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
    sqlite.prepare('UPDATE workspace_members SET account_id = ? WHERE user_id = ?').run('acct-ann', ANN);
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
    setMeetingAgentHooks({ join: async () => { throw new Error('ws refused'); }, recall: async () => {}, adminAgentId: async () => null, publish: async () => {}, ensureNotesAutomation: async () => {} });
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

describe('what the agent did, as events (task 32)', () => {
  const transcriptHook = { event: 'meeting.transcript', meeting: { id: 'rtk-m1', sessionId: 'sess-1' }, transcriptDownloadUrl: TRANSCRIPT_URL };
  const ended = () => published.filter((e) => e.type === 'meet.ended');

  it('sending an agent publishes meet.agent_joined as the agent, for its sender, and makes its Meeting notes automation', async () => {
    const m = await room();
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => sendAgent(m.code, BEN, OMNI));
    const joins = published.filter((e) => e.type === 'meet.agent_joined');
    expect(joins[0]).toMatchObject({ actor: 'acct-ada', invokedBy: 'acct-ann', audience: 'account:acct-ada', about: ['acct-ada', 'acct-ann'], ref: { app: 'meet', kind: 'meeting', id: m.id } });
    expect(joins[0]!.data).toMatchObject({ meetingId: m.id, title: 'Weekly planning', sessionId: 'sess-1', agent: { name: 'Ada' }, sentBy: { name: 'Ann Lee' } });
    expect(joins[1]).toMatchObject({ actor: 'acct-omni', invokedBy: 'acct-ben', audience: 'account:acct-omni' });
    // A personal agent's is its sponsor's; a shared agent with no sponsor, its first sender's.
    expect(automations).toEqual([{ agentAccountId: 'acct-ada', ownerAccountId: 'acct-ann' }, { agentAccountId: 'acct-omni', ownerAccountId: 'acct-ben' }]);
  });

  it('meet.ended once per agent when the transcript is saved, with who came and the files; the old Notes turn is gone', async () => {
    const m = await room();
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => sendAgent(m.code, BEN, OMNI));
    fakeRtk({ ...ROOM, 'GET /sessions/sess-1/participants': [{ custom_participant_id: ANN, display_name: 'Ann Lee' }, { custom_participant_id: BEN, display_name: 'Ben Kim' }, { custom_participant_id: `agent:${ADA}`, display_name: 'Ada' }] });
    await withDb(db, () => handleRtkWebhook(transcriptHook));
    await withDb(db, () => saveDueMeetingFiles());
    expect(ended().map((e) => e.audience)).toEqual(['account:acct-ada', 'account:acct-omni']);
    const ada = ended()[0]!;
    expect(ada).toMatchObject({ actor: null, invokedBy: 'acct-ann', about: ['acct-ada', 'acct-ann'] });
    expect(ada.data).toMatchObject({ meetingId: m.id, sessionId: 'sess-1', title: 'Weekly planning', transcript: 'saved', sentBy: { name: 'Ann Lee' } });
    expect((ada.data as { transcriptUrl: string }).transcriptUrl).toMatch(/\/docs\/md\/s-1$/);
    expect((ada.data as { attendees: unknown[] }).attendees).toEqual([{ name: 'Ann Lee', kind: 'person' }, { name: 'Ben Kim', kind: 'person' }, { name: 'Ada', kind: 'agent' }]);
    // Only the transcript is saved: no Notes turn writes anything now.
    expect(saved.map((x) => x[2].markdown?.title)).toEqual(['Transcript']);
    // RTK's meeting.ended afterwards, or the alarm again, tells no one twice.
    await withDb(db, () => handleRtkWebhook({ event: 'meeting.ended', meeting: { id: 'rtk-m1', sessionId: 'sess-1' } }));
    await withDb(db, () => saveDueMeetingFiles());
    expect(ended()).toHaveLength(2);
  });

  it('attendance is recorded without a transcript: a silent session, a failed one, and one nobody recorded', async () => {
    transcript = [];
    const m = await room();
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => handleRtkWebhook(transcriptHook));
    await withDb(db, () => saveDueMeetingFiles());
    expect(ended().map((e) => (e.data as { transcript: string }).transcript)).toEqual(['silent']);

    // The next session's transcript cannot be downloaded.
    fakeRtk({ ...ROOM, 'GET /meetings/rtk-m1/active-session': { id: 'sess-2' }, 'POST /recordings': { id: 'rec-2', session_id: 'sess-2', status: 'INVOKED' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await withDb(db, () => recallAgent(m.code, ANN, ADA));
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => handleRtkWebhook({ ...transcriptHook, meeting: { id: 'rtk-m1', sessionId: 'sess-2' }, transcriptDownloadUrl: 'https://rtk-download.test/gone.json' }));
    await withDb(db, () => saveDueMeetingFiles());
    expect(ended().map((e) => (e.data as { transcript: string }).transcript)).toEqual(['silent', 'failed']);

    // A third session where recording never started: RTK's meeting.ended reports it at once.
    fakeRtk({ ...ROOM, 'GET /meetings/rtk-m1/active-session': { id: 'sess-3' }, 'POST /recordings': null });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withDb(db, () => recallAgent(m.code, ANN, ADA));
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    await withDb(db, () => handleRtkWebhook({ event: 'meeting.ended', meeting: { id: 'rtk-m1', sessionId: 'sess-3' } }));
    expect(ended().map((e) => (e.data as { transcript: string }).transcript)).toEqual(['silent', 'failed', 'not_recorded']);
    expect(ended()[2]!.data).not.toHaveProperty('transcriptUrl');
  });

  it('no agent, no event: recording alone works as before', async () => {
    const m = await room();
    await withDb(db, () => startRecording(m.code, ANN));
    await withDb(db, () => handleRtkWebhook(transcriptHook));
    await withDb(db, () => saveDueMeetingFiles());
    expect(published).toEqual([]);
    expect(saved).toHaveLength(1);
  });
});

describe('the Meeting notes automation\'s tools', () => {
  const asJson = { 'GET /sessions/sess-1/transcript?format=JSON': { transcript_download_url: TRANSCRIPT_URL } };

  it('reads the transcript of a session the agent was in, and no other', async () => {
    const m = await room();
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    fakeRtk({ ...ROOM, ...asJson });
    const t = await withDb(db, () => agentMeetingTranscript(ADA, m.id, 'sess-1'));
    expect(t).toMatchObject({ title: 'Weekly planning', cut: false });
    expect(t.transcript).toContain('**Ann Lee** · 0:01\nLet us plan Q4.');
    await expect(withDb(db, () => agentMeetingTranscript(BOB, m.id, 'sess-1'))).rejects.toMatchObject({ code: 'not_attended' });
    await expect(withDb(db, () => agentMeetingTranscript(ADA, m.id, 'sess-9'))).rejects.toMatchObject({ code: 'not_attended' });
  });

  it('cuts a very long transcript', async () => {
    transcript = Array.from({ length: 4000 }, (_, i) => ({ startTime: i, sentence: 'x'.repeat(60), peerData: { displayName: i % 2 ? 'Ann Lee' : 'Ben Kim' } }));
    const m = await room();
    await withDb(db, () => sendAgent(m.code, ANN, ADA));
    fakeRtk({ ...ROOM, ...asJson });
    const t = await withDb(db, () => agentMeetingTranscript(ADA, m.id, 'sess-1'));
    expect(t.cut).toBe(true);
    expect(t.transcript).toContain('[The rest of the transcript was cut.]');
  });

  it('saves the notes in the sender\'s My files, in the meeting\'s folder there', async () => {
    const m = await room();
    await withDb(db, () => sendAgent(m.code, BEN, OMNI));
    const out = await withDb(db, () => saveAgentMeetingNotes(OMNI, m.id, 'sess-1', '## Summary\nWe planned Q4.'));
    const [, owner, input] = saved.at(-1)!;
    expect(owner).toEqual({ userId: BEN, email: `${BEN}@x.test` });
    expect(input).toMatchObject({ private: true, markdown: { title: 'Notes', text: '## Summary\nWe planned Q4.' } });
    expect(input.folder).toMatch(/^Meetings\/\d{4}-\d{2}-\d{2} Weekly planning$/);
    expect(out).toMatchObject({ owner: 'Ben Kim', folder: `My files › ${input.folder}` });
    expect(out.url).toMatch(/\/docs\/md\/s-\d+$/);
    await expect(withDb(db, () => saveAgentMeetingNotes(ADA, m.id, 'sess-1', 'x'))).rejects.toMatchObject({ code: 'not_attended' });
    await expect(withDb(db, () => saveAgentMeetingNotes(OMNI, m.id, 'sess-1', '  '))).rejects.toMatchObject({ code: 'no_notes' });
  });
});
