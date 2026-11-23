// Meet recording (docs/specs/meetings.md phase 4, R8 and R9): anyone in a room who is a member starts and stops RTK's
// recording, with the session's transcript turned on; RTK's webhooks only note what is ready, and the object's alarm
// copies it to Docs (Organization files, Meetings/<date> <title>/) and links it in the meeting's chat.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { orgStorage } from '../../test/orgStorage';
import { withDb, schema, type DB } from './db/index';
import { createMeeting, handleRtkWebhook, joinMeeting } from './services/meetings';
import {
  clock,
  folderDate,
  meetingFolder,
  parseTranscript,
  MEETING_FILES_DUE_SQL,
  saveDueMeetingFiles,
  setMeetingDocs,
  startRecording,
  stopRecording,
  transcriptMarkdown,
  type MeetingDocs,
} from './services/meetingRecordings';
import { createWorkspace } from './services/workspaces';

const ANN = '00000000-0000-7000-8000-00000000000a';
const BEN = '00000000-0000-7000-8000-00000000000b';
const EVE = '00000000-0000-7000-8000-00000000000e';
const BASE = 'https://api.cloudflare.com/client/v4/accounts/acct/realtime/kit/app';
const VIDEO_URL = 'https://rtk-download.test/rec-1.mp4';
const TRANSCRIPT_URL = 'https://rtk-download.test/transcript.json';

beforeAll(() => {
  process.env.FLOW_DATA_KEY = randomBytes(32).toString('base64');
  Object.assign(process.env, { RTK_ACCOUNT_ID: 'acct', RTK_APP_ID: 'app', RTK_API_TOKEN: 'secret' });
});

type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
let calls: Call[];
/** A fake RTK answering by path (a value of null is RTK's 404), plus the transcript's download address. */
function fakeRtk(answers: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method: init.method ?? 'GET', url, body });
    if (url === TRANSCRIPT_URL) {
      return Response.json([
        { startTime: 1000, endTime: 2000, sentence: 'Hello everyone.', peerData: { displayName: 'Ann Lee' } },
        { startTime: 2500, endTime: 3000, sentence: 'Shall we start?', peerData: { displayName: 'Ann Lee' } },
        { startTime: 65_000, endTime: 66_000, sentence: 'Yes.', peerData: { displayName: 'Ben Kim' } },
      ]);
    }
    const key = `${init.method ?? 'GET'} ${url.slice(BASE.length)}`;
    const hit = Object.entries(answers).find(([k]) => key === k);
    if (!hit || hit[1] === null) return Response.json({ success: false, error: { code: 404 } }, { status: 404 });
    return Response.json({ success: true, data: hit[1] });
  }));
}

/** A fake Docs object: remembers what Meet asked it to save. */
function fakeDocs() {
  const saved: { orgId: string; owner: { userId: string; email: string }; input: Parameters<MeetingDocs['saveMeetingFiles']>[2] }[] = [];
  const docs: MeetingDocs = {
    async saveMeetingFiles(orgId, owner, input) {
      saved.push({ orgId, owner, input });
      return {
        folderUrl: `/docs/?folder=${encodeURIComponent(input.folder)}&org=${orgId}`,
        ...(input.video ? { video: { id: 'f1', url: '/docs/f/f1' } } : {}),
        ...(input.markdown ? { markdown: { id: 's1', url: '/docs/md/s1' } } : {}),
      };
    },
  };
  setMeetingDocs(() => docs);
  return saved;
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
afterEach(() => {
  vi.unstubAllGlobals();
  setMeetingDocs(null);
});

const RUNNING_ROOM = {
  'POST /meetings': { id: 'rtk-m1' },
  'POST /meetings/rtk-m1/participants': { id: 'p-1', token: 'tok' },
  'GET /meetings/rtk-m1/active-session': { id: 'sess-1', live_participants: 2 },
  'GET /recordings/active-recording/rtk-m1': null,
  'PATCH /meetings/rtk-m1': { id: 'rtk-m1', transcribe_on_end: true },
  'POST /recordings': { id: 'rec-1', session_id: 'sess-1', status: 'INVOKED' },
};

/** A room "Weekly planning" with Ann and Ben in it (so it has its meeting chat). */
async function room(answers: Record<string, unknown> = RUNNING_ROOM) {
  fakeRtk(answers);
  const m = await withDb(db, () => createMeeting(workspaceId, ANN, 'Weekly planning'));
  await withDb(db, () => joinMeeting(m.code, ANN));
  await withDb(db, () => joinMeeting(m.code, BEN));
  return m;
}

describe('folder names and the transcript', () => {
  it('names a session folder under Meetings by date and title, without slashes', () => {
    expect(meetingFolder('Weekly planning', '2026-11-22')).toBe('Meetings/2026-11-22 Weekly planning');
    expect(meetingFolder(' Q4 / Q1  review ', '2026-11-22')).toBe('Meetings/2026-11-22 Q4 - Q1 review');
    expect(meetingFolder('', '2026-11-22')).toBe('Meetings/2026-11-22 Meeting');
  });

  it('dates the folder in the recorder\'s time zone', () => {
    const late = new Date('2026-11-23T02:00:00Z');
    expect(folderDate(late, 'America/Los_Angeles')).toBe('2026-11-22');
    expect(folderDate(late, 'Not/A_Zone')).toBe('2026-11-23');
  });

  it('writes one paragraph per turn, with the speaker and when they began', () => {
    expect(clock(65_000)).toBe('1:05');
    expect(clock(3_725_000)).toBe('1:02:05');
    const md = transcriptMarkdown('Weekly planning', '2026-11-22', [
      { startTime: 65_000, sentence: 'Yes.', peerData: { displayName: 'Ben Kim' } },
      { startTime: 1000, sentence: 'Hello everyone.', peerData: { displayName: 'Ann Lee' } },
      { startTime: 2500, sentence: 'Shall we start?', peerData: { displayName: 'Ann Lee' } },
      { startTime: 70_000, sentence: '   ' },
    ]);
    expect(md).toBe('# Transcript · Weekly planning\n\n2026-11-22\n\n**Ann Lee** · 0:01\nHello everyone. Shall we start?\n\n**Ben Kim** · 1:05\nYes.\n');
    expect(transcriptMarkdown('X', 'd', [])).toContain('_Nothing was said._');
  });

  it('reads RTK\'s real times, clock seconds, from the first line', () => {
    const md = transcriptMarkdown('Q4', 'd', [
      { startTime: 1795407727.081, sentence: 'is going well.', peerData: { displayName: 'Scott' } },
      { startTime: 1795407720.681, sentence: 'Okay, everything', peerData: { displayName: 'Scott' } },
      { startTime: 1795407795.5, sentence: 'Agreed.', peerData: { displayName: 'Ben' } },
    ]);
    expect(md).toContain('**Scott** · 0:00\nOkay, everything is going well.');
    expect(md).toContain('**Ben** · 1:14\nAgreed.');
  });

  it('reads RTK\'s transcript as JSON or as its header-less CSV, and an empty file as nothing said', () => {
    const csv = '"1000","peer-1","user-1","cpi-1","Ann Lee","Hello, everyone"\n"3000","peer-2","user-2","cpi-2","Ben ""B"" Kim","Hi Ann"\n';
    expect(parseTranscript(csv)).toEqual([
      { startTime: 1000, sentence: 'Hello, everyone', peerData: { displayName: 'Ann Lee' } },
      { startTime: 3000, sentence: 'Hi Ann', peerData: { displayName: 'Ben "B" Kim' } },
    ]);
    expect(parseTranscript('[{"startTime":5,"sentence":"Yo","peerData":{"displayName":"Eve"}}]')).toEqual([{ startTime: 5, sentence: 'Yo', peerData: { displayName: 'Eve' } }]);
    expect(parseTranscript('')).toEqual([]);
    expect(parseTranscript('[]')).toEqual([]);
  });
});

describe('starting and stopping', () => {
  it('lets any member in the room record: RTK records one H.264 file (the room is transcribed from its creation)', async () => {
    fakeDocs();
    const m = await room();
    expect(calls.find((c) => c.method === 'POST' && c.url === `${BASE}/meetings`)?.body).toMatchObject({ transcribe_on_end: true });
    const r = await withDb(db, () => startRecording(m.code, BEN));
    expect(r).toEqual({ ok: true, recordingId: 'rec-1' });
    const post = calls.find((c) => c.method === 'POST' && c.url === `${BASE}/recordings`);
    expect(post?.body).toMatchObject({ meeting_id: 'rtk-m1', video_config: { codec: 'H264' } });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    const row = sqlite.prepare('SELECT session_id, started_by, status, folder FROM meeting_recordings WHERE id = ?').get('rec-1') as Record<string, string>;
    expect(row).toMatchObject({ session_id: 'sess-1', started_by: BEN, status: 'INVOKED' });
    expect(row.folder).toMatch(/^Meetings\/\d{4}-\d{2}-\d{2} Weekly planning$/);
  });

  it('keeps a second recording of a session in its folder, and gives a later session that day its own', async () => {
    fakeDocs();
    const m = await room({ ...RUNNING_ROOM, 'POST /recordings': { id: 'rec-1', session_id: 'sess-1', status: 'INVOKED' } });
    await withDb(db, () => startRecording(m.code, BEN));
    fakeRtk({ ...RUNNING_ROOM, 'POST /recordings': { id: 'rec-2', session_id: 'sess-1', status: 'INVOKED' } });
    await withDb(db, () => startRecording(m.code, ANN));
    fakeRtk({ ...RUNNING_ROOM, 'GET /meetings/rtk-m1/active-session': { id: 'sess-2' }, 'POST /recordings': { id: 'rec-3', session_id: 'sess-2', status: 'INVOKED' } });
    await withDb(db, () => startRecording(m.code, ANN));
    const folders = (sqlite.prepare('SELECT id, folder FROM meeting_recordings ORDER BY id').all() as { id: string; folder: string }[]).map((r) => r.folder);
    expect(folders[0]).toBe(folders[1]);
    expect(folders[2]).toBe(`${folders[0]} (2)`);
  });

  it('refuses a second recording, a room nobody is in, and people outside the organization', async () => {
    fakeDocs();
    const m = await room({ ...RUNNING_ROOM, 'GET /recordings/active-recording/rtk-m1': { id: 'rec-0', status: 'RECORDING' } });
    await expect(withDb(db, () => startRecording(m.code, ANN))).rejects.toMatchObject({ statusCode: 409 });
    fakeRtk({ ...RUNNING_ROOM, 'GET /meetings/rtk-m1/active-session': null });
    await expect(withDb(db, () => startRecording(m.code, ANN))).rejects.toMatchObject({ statusCode: 409 });
    fakeRtk(RUNNING_ROOM);
    await expect(withDb(db, () => startRecording(m.code, EVE))).rejects.toMatchObject({ statusCode: 404 });
    expect(calls.some((c) => c.url === `${BASE}/recordings` && c.method === 'POST')).toBe(false);
  });

  it('stops the running recording; nothing running is fine', async () => {
    const m = await room({ ...RUNNING_ROOM, 'GET /recordings/active-recording/rtk-m1': { id: 'rec-1', status: 'RECORDING' }, 'PUT /recordings/rec-1': { id: 'rec-1', status: 'UPLOADING' } });
    await withDb(db, () => stopRecording(m.code, BEN));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: `${BASE}/recordings/rec-1`, body: { action: 'stop' } });
    fakeRtk(RUNNING_ROOM);
    await expect(withDb(db, () => stopRecording(m.code, BEN))).resolves.toEqual({ ok: true });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('after the meeting', () => {
  const uploaded = (status = 'UPLOADED') => ({
    event: 'recording.statusUpdate',
    recording: { id: 'rec-1', status, downloadUrl: VIDEO_URL },
    meeting: { id: 'rtk-m1', sessionId: 'sess-1' },
  });
  const due = () => sqlite.prepare(MEETING_FILES_DUE_SQL).all().length > 0;
  const lines = (channelId: string) =>
    (sqlite.prepare("SELECT system_kind FROM messages WHERE channel_id = ? AND system_kind = 'file_shared'").all(channelId) as unknown[]).length;

  it('the webhook only notes the upload; the alarm copies the video to Docs as the recorder and links it in the chat', async () => {
    const saved = fakeDocs();
    const m = await room();
    await withDb(db, () => startRecording(m.code, BEN));
    await withDb(db, () => handleRtkWebhook(uploaded('RECORDING')));
    expect(due()).toBe(false);
    await withDb(db, () => handleRtkWebhook(uploaded()));
    expect(saved).toHaveLength(0);
    expect(due()).toBe(true);

    await withDb(db, () => saveDueMeetingFiles());
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ orgId: workspaceId, owner: { userId: BEN, email: `${BEN}@x.test` }, input: { video: { url: VIDEO_URL, filename: 'Recording.mp4' } } });
    expect(saved[0]!.input.folder).toMatch(/^Meetings\/.* Weekly planning$/);
    expect(due()).toBe(false);
    expect(sqlite.prepare('SELECT status, video_url FROM meeting_recordings WHERE id = ?').get('rec-1')).toEqual({ status: 'SAVED', video_url: '/docs/f/f1' });
    const chat = sqlite.prepare('SELECT chat_channel_id AS id FROM meetings WHERE id = ?').get(m.id) as { id: string };
    expect(lines(chat.id)).toBe(1);

    // RTK sends it again: nothing is saved twice.
    await withDb(db, () => handleRtkWebhook(uploaded()));
    expect(due()).toBe(false);
  });

  it('saves the session\'s transcript as Markdown in the same folder, then turns transcribing off', async () => {
    const saved = fakeDocs();
    const m = await room();
    await withDb(db, () => startRecording(m.code, BEN));
    await withDb(db, () => handleRtkWebhook({ event: 'meeting.transcript', meeting: { id: 'rtk-m1', sessionId: 'sess-1' }, transcriptDownloadUrl: TRANSCRIPT_URL }));
    expect(due()).toBe(true);
    await withDb(db, () => saveDueMeetingFiles());
    expect(saved).toHaveLength(1);
    expect(saved[0]!.input.markdown?.title).toBe('Transcript');
    expect(saved[0]!.input.markdown?.text).toContain('**Ann Lee** · 0:01\nHello everyone. Shall we start?');
    expect(sqlite.prepare('SELECT transcript_url FROM meeting_recordings WHERE id = ?').get('rec-1')).toEqual({ transcript_url: '/docs/md/s1' });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('drops a transcript of a session nobody recorded, and recordings that are not ours', async () => {
    const saved = fakeDocs();
    await room();
    await withDb(db, () => handleRtkWebhook({ event: 'meeting.transcript', meeting: { id: 'rtk-m1', sessionId: 'sess-other' }, transcriptDownloadUrl: TRANSCRIPT_URL }));
    await withDb(db, () => handleRtkWebhook({ ...uploaded(), recording: { id: 'rec-elsewhere', status: 'UPLOADED', downloadUrl: VIDEO_URL } }));
    expect(due()).toBe(false);
    await withDb(db, () => saveDueMeetingFiles());
    expect(saved).toHaveLength(0);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('a copy that fails is logged and given up, not retried forever', async () => {
    setMeetingDocs(() => ({ saveMeetingFiles: async () => { throw new Error('R2 down'); } }));
    const m = await room();
    await withDb(db, () => startRecording(m.code, BEN));
    await withDb(db, () => handleRtkWebhook(uploaded()));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await withDb(db, () => saveDueMeetingFiles());
    expect(sqlite.prepare('SELECT status FROM meeting_recordings WHERE id = ?').get('rec-1')).toEqual({ status: 'SAVE_FAILED' });
    expect(due()).toBe(false);
  });
});
