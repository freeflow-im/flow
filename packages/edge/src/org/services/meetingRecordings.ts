// Meet recording (docs/specs/meetings.md phase 4, rulings R8 and R9). Anyone in a room who is a member presses Record; our
// server asks RealtimeKit to record the room (one file with everyone's video and audio) and to transcribe the session at
// its end. When RTK has uploaded the recording, the video goes to Docs, in Organization files under
// `Meetings/<date> <title>/`, owned by whoever pressed Record; the transcript (a Markdown document) joins it when RTK
// sends it. A line in the meeting's chat links each file. RTK keeps its own copies only 7 days.
//
// Everyone in the room sees the recording badge from RealtimeKit itself (the web SDK's recordingUpdate), so nothing here
// tells the room.
import { and, asc, eq, isNotNull, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { ApiError } from '../lib/errors.js';
import { meetingRow, requireRoomAccess, rtk, type MeetingRow } from './meetings.js';
import { postHuddleSystemMessage } from './messages.js';

/** What Meet needs of the organization's Docs object (edge/src/docs/object.ts `saveMeetingFiles`). */
export interface MeetingDocs {
  saveMeetingFiles(
    organizationId: string,
    owner: { userId: string; email: string },
    input: { folder: string; video?: { url: string; filename: string }; markdown?: { title: string; text: string } },
  ): Promise<{ folderUrl: string; video?: { id: string; url: string }; markdown?: { id: string; url: string } }>;
}

let docsOf: ((organizationId: string) => MeetingDocs) | null = null;

/** The Org object hands over its Docs binding at start (object.ts); tests hand over a fake. */
export function setMeetingDocs(fn: ((organizationId: string) => MeetingDocs) | null): void {
  docsOf = fn;
}

/** The top folder in Organization files (R9). */
export const MEETINGS_FOLDER = 'Meetings';
/** RTK's recording statuses while it runs: a second Record is refused. */
const RUNNING = ['INVOKED', 'RECORDING', 'PAUSED'];
/** Ours, after RTK's UPLOADED: the video is being copied to Docs, is there, or could not be. */
const SAVING = 'SAVING';
const SAVED = 'SAVED';
const SAVE_FAILED = 'SAVE_FAILED';

interface RtkRecording {
  id: string;
  session_id?: string | null;
  status?: string;
}

/** `2026-11-22` in a person's time zone (UTC when theirs is unknown). */
export function folderDate(at: Date, timeZone: string | null | undefined): string {
  const fmt = (tz: string) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).format(at);
  try {
    return fmt(timeZone || 'UTC');
  } catch {
    return fmt('UTC');
  }
}

/** A meeting session's folder: `Meetings/2026-11-22 Weekly planning`. A slash in the title would make a deeper folder. */
export function meetingFolder(title: string, date: string): string {
  const name = title.replace(/[/\\]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Meeting';
  return `${MEETINGS_FOLDER}/${date} ${name}`;
}

/** One line of RTK's transcript JSON (docs: ai/transcription). Times are milliseconds from the session's start. */
export interface TranscriptLine {
  startTime?: number;
  endTime?: number;
  sentence?: string;
  peerData?: { displayName?: string; name?: string };
}

/** `1:05` or `1:02:05`. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * RTK's transcript as a Markdown document: a heading, then one paragraph per turn (a speaker's sentences in a row are
 * joined), each led by the speaker's name and when they began.
 */
export function transcriptMarkdown(title: string, date: string, lines: TranscriptLine[]): string {
  const turns: { who: string; at: number; text: string[] }[] = [];
  for (const l of [...lines].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))) {
    const text = (l.sentence ?? '').trim();
    if (!text) continue;
    const who = (l.peerData?.displayName ?? l.peerData?.name ?? '').trim() || 'Someone';
    const last = turns.at(-1);
    if (last && last.who === who) last.text.push(text);
    else turns.push({ who, at: l.startTime ?? 0, text: [text] });
  }
  const body = turns.map((t) => `**${t.who}** · ${clock(t.at)}\n${t.text.join(' ')}`).join('\n\n');
  return `# Transcript · ${title}\n\n${date}\n\n${body || '_Nothing was said._'}\n`;
}

async function personOf(userId: string): Promise<{ email: string; displayName: string; timezone: string } | null> {
  const [u] = await db
    .select({ email: schema.users.email, displayName: schema.users.displayName, timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return u ?? null;
}

/** RTK's running recording of a room, or null. */
async function activeRecording(m: MeetingRow): Promise<RtkRecording | null> {
  const r = await rtk<RtkRecording>('GET', `/recordings/active-recording/${m.rtkMeetingId}`);
  return r && RUNNING.includes(r.status ?? '') ? r : null;
}

/**
 * POST /v1/meetings/:id/recording (R8): anyone in the room who is a member. RTK is asked to transcribe the session at
 * its end too (R7's transcript comes with the recording), then to record. A second Record while one runs is refused.
 */
export async function startRecording(ref: string, userId: string): Promise<{ ok: true; recordingId: string }> {
  const m = await meetingRow(ref);
  await requireRoomAccess(m, userId);
  if (!docsOf) throw new ApiError(503, 'recording_unavailable', 'Recording is not set up on this server');
  const session = await rtk<{ id: string; live_participants?: number }>('GET', `/meetings/${m.rtkMeetingId}/active-session`);
  if (!session) throw new ApiError(409, 'no_session', 'Nobody is in this meeting. Join it first.');
  if (await activeRecording(m)) throw new ApiError(409, 'already_recording', 'This meeting is already being recorded.');
  await rtk('PATCH', `/meetings/${m.rtkMeetingId}`, { transcribe_on_end: true });
  const started = await rtk<RtkRecording>('POST', '/recordings', {
    meeting_id: m.rtkMeetingId,
    file_name_prefix: m.code ?? m.id,
    video_config: { codec: 'H264' },
  });
  if (!started?.id) throw new ApiError(502, 'meet_upstream', 'The meeting service did not start recording');
  // A second recording in one session goes in the same folder.
  const sessionId = started.session_id ?? session.id;
  const [earlier] = await db
    .select({ folder: schema.meetingRecordings.folder })
    .from(schema.meetingRecordings)
    .where(and(eq(schema.meetingRecordings.meetingId, m.id), eq(schema.meetingRecordings.sessionId, sessionId)))
    .limit(1);
  const me = await personOf(userId);
  const now = new Date();
  await db
    .insert(schema.meetingRecordings)
    .values({
      id: started.id,
      meetingId: m.id,
      sessionId,
      startedBy: userId,
      startedAt: now,
      status: started.status ?? 'INVOKED',
      folder: earlier?.folder ?? meetingFolder(m.title, folderDate(now, me?.timezone)),
    })
    .onConflictDoNothing();
  return { ok: true, recordingId: started.id };
}

/** DELETE /v1/meetings/:id/recording: anyone in the room who is a member stops it. Nothing running is not an error. */
export async function stopRecording(ref: string, userId: string): Promise<{ ok: true }> {
  const m = await meetingRow(ref);
  await requireRoomAccess(m, userId);
  const running = await activeRecording(m);
  if (running) await rtk('PUT', `/recordings/${running.id}`, { action: 'stop' });
  return { ok: true };
}

/** The conversation a room's lines go in: a huddle's own conversation, else the room's meeting chat. */
async function chatOf(m: MeetingRow): Promise<{ id: string; workspaceId: string } | null> {
  const id = m.channelId ?? m.chatChannelId;
  if (!id) return null;
  const [c] = await db.select({ id: schema.channels.id, workspaceId: schema.channels.workspaceId }).from(schema.channels).where(eq(schema.channels.id, id)).limit(1);
  return c ?? null;
}

const absolute = (url: string) => new URL(url, config.webUrlBase).toString();

/** A `file_shared` line (Chat draws its address as the file's chip): "<sentence>\n<address>". Best-effort. */
async function postFileLine(m: MeetingRow, authorId: string, sentence: string, url: string): Promise<void> {
  const chat = await chatOf(m);
  if (chat) await postHuddleSystemMessage(chat, authorId, 'file_shared', `${sentence}\n${absolute(url)}`);
}

/** RTK's `recording.statusUpdate` (camelCase, unlike its REST answers). */
export interface RecordingWebhook {
  recording?: { id?: string; recordingId?: string; status?: string; downloadUrl?: string; outputFileName?: string };
  meeting?: { id?: string; sessionId?: string };
}

/**
 * A recording moved on (RTK webhook). Only ours (made by startRecording) count. UPLOADED only notes RTK's download
 * address: the copy to Docs can take longer than RTK waits for an answer, so the object's alarm does it
 * (saveDueMeetingFiles). True when there is now something for the alarm to do.
 */
export async function handleRecordingUpdate(m: MeetingRow, event: RecordingWebhook): Promise<boolean> {
  const rec = event.recording;
  const id = rec?.id ?? rec?.recordingId;
  if (!id || !rec?.status) return false;
  const [row] = await db.select().from(schema.meetingRecordings).where(eq(schema.meetingRecordings.id, id)).limit(1);
  if (!row || row.meetingId !== m.id || [SAVING, SAVED, SAVE_FAILED].includes(row.status)) return false;
  const sessionId = event.meeting?.sessionId ?? row.sessionId;
  const uploaded = rec.status === 'UPLOADED' && !!rec.downloadUrl;
  await db
    .update(schema.meetingRecordings)
    .set({ status: rec.status, sessionId, ...(uploaded ? { downloadUrl: rec.downloadUrl } : {}) })
    .where(eq(schema.meetingRecordings.id, id));
  return uploaded;
}

/** RTK's `meeting.transcript`. */
export interface TranscriptWebhook {
  meeting?: { id?: string; sessionId?: string };
  transcriptDownloadUrl?: string;
}

/**
 * A session's transcript (RTK webhook): noted on the session's first recording, for the alarm to save in that
 * recording's folder. A session nobody recorded has no folder, so its transcript is dropped and transcribing is turned
 * off again (R7: off by default). True when there is now something for the alarm to do.
 */
export async function handleTranscript(m: MeetingRow, event: TranscriptWebhook): Promise<boolean> {
  const sessionId = event.meeting?.sessionId;
  const url = event.transcriptDownloadUrl;
  if (!sessionId || !url) return false;
  const [first] = await db
    .select()
    .from(schema.meetingRecordings)
    .where(and(eq(schema.meetingRecordings.meetingId, m.id), eq(schema.meetingRecordings.sessionId, sessionId)))
    .orderBy(asc(schema.meetingRecordings.startedAt))
    .limit(1);
  if (!first) {
    await transcribeOffUnlessRecording(m).catch((err: Error) => console.warn('meeting transcript: could not turn transcribing off', err.message));
    return false;
  }
  if (first.transcriptUrl) return false;
  await db.update(schema.meetingRecordings).set({ transcriptDownloadUrl: url }).where(eq(schema.meetingRecordings.id, first.id));
  return true;
}

/** Whether a recording or transcript waits to be copied to Docs: the object arms its alarm for now (object.ts armAlarm). */
export const MEETING_FILES_DUE_SQL = 'SELECT 1 FROM meeting_recordings WHERE download_url IS NOT NULL OR transcript_download_url IS NOT NULL LIMIT 1';

/**
 * The alarm's part (object.ts): every recording and transcript RTK has made ready is copied to Docs, and a line in the
 * meeting's chat links it. A failure is logged and the address dropped, so one bad file does not hold up the rest or
 * repeat forever (RTK's own copy stays for 7 days).
 */
export async function saveDueMeetingFiles(): Promise<void> {
  const rows = await db
    .select()
    .from(schema.meetingRecordings)
    .where(or(isNotNull(schema.meetingRecordings.downloadUrl), isNotNull(schema.meetingRecordings.transcriptDownloadUrl)))
    .orderBy(asc(schema.meetingRecordings.startedAt));
  for (const row of rows) {
    const [m] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, row.meetingId)).limit(1);
    if (!m) continue;
    if (row.downloadUrl) await saveVideo(m, row, row.downloadUrl);
    if (row.transcriptDownloadUrl) await saveTranscript(m, row, row.transcriptDownloadUrl);
  }
}

type RecordingRow = typeof schema.meetingRecordings.$inferSelect;

async function saveVideo(m: MeetingRow, row: RecordingRow, downloadUrl: string): Promise<void> {
  try {
    const owner = await personOf(row.startedBy);
    if (!owner || !docsOf) throw new Error('no owner or no Docs');
    await db.update(schema.meetingRecordings).set({ status: SAVING }).where(eq(schema.meetingRecordings.id, row.id));
    const earlier = await db
      .select({ id: schema.meetingRecordings.id })
      .from(schema.meetingRecordings)
      .where(and(eq(schema.meetingRecordings.folder, row.folder), eq(schema.meetingRecordings.status, SAVED)));
    const filename = earlier.length ? `Recording ${earlier.length + 1}.mp4` : 'Recording.mp4';
    const saved = await docsOf(m.workspaceId).saveMeetingFiles(m.workspaceId, { userId: row.startedBy, email: owner.email }, {
      folder: row.folder,
      video: { url: downloadUrl, filename },
    });
    if (!saved.video) throw new Error('Docs saved no video');
    await db.update(schema.meetingRecordings).set({ status: SAVED, videoUrl: saved.video.url, downloadUrl: null }).where(eq(schema.meetingRecordings.id, row.id));
    await postFileLine(m, row.startedBy, `${owner.displayName.split(' ')[0] || 'Someone'}'s recording of this meeting is in Docs › ${row.folder}`, saved.video.url);
  } catch (err) {
    console.error('meeting recording: could not save to Docs', { recordingId: row.id, err: (err as Error).message });
    await db.update(schema.meetingRecordings).set({ status: SAVE_FAILED, downloadUrl: null }).where(eq(schema.meetingRecordings.id, row.id));
  }
}

async function saveTranscript(m: MeetingRow, row: RecordingRow, downloadUrl: string): Promise<void> {
  try {
    const owner = await personOf(row.startedBy);
    if (!owner || !docsOf) throw new Error('no owner or no Docs');
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`transcript download failed: ${res.status}`);
    const json = (await res.json()) as TranscriptLine[] | { transcript?: TranscriptLine[] };
    const lines = Array.isArray(json) ? json : (json.transcript ?? []);
    const date = folderDate(row.startedAt, owner.timezone);
    const saved = await docsOf(m.workspaceId).saveMeetingFiles(m.workspaceId, { userId: row.startedBy, email: owner.email }, {
      folder: row.folder,
      markdown: { title: 'Transcript', text: transcriptMarkdown(m.title, date, lines) },
    });
    if (!saved.markdown) throw new Error('Docs saved no transcript');
    await db.update(schema.meetingRecordings).set({ transcriptUrl: saved.markdown.url, transcriptDownloadUrl: null }).where(eq(schema.meetingRecordings.id, row.id));
    await postFileLine(m, row.startedBy, `The transcript of this meeting is in Docs › ${row.folder}`, saved.markdown.url);
  } catch (err) {
    console.error('meeting transcript: could not save to Docs', { recordingId: row.id, err: (err as Error).message });
    await db.update(schema.meetingRecordings).set({ transcriptDownloadUrl: null }).where(eq(schema.meetingRecordings.id, row.id));
  } finally {
    await transcribeOffUnlessRecording(m).catch((err: Error) => console.warn('meeting transcript: could not turn transcribing off', err.message));
  }
}

async function transcribeOffUnlessRecording(m: MeetingRow): Promise<void> {
  if (await activeRecording(m)) return;
  await rtk('PATCH', `/meetings/${m.rtkMeetingId}`, { transcribe_on_end: false });
}
