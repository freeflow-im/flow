// Meet recording (docs/specs/meetings.md phase 4, rulings R8 and R9). Anyone in a room who is a member presses Record; our
// server asks RealtimeKit to record the room (one file with everyone's video and audio) and to transcribe the session at
// its end. When RTK has uploaded the recording, the video goes to Docs, in Organization files under
// `Meetings/<date> <title>/`, owned by whoever pressed Record; the transcript (a Markdown document) joins it when RTK
// sends it. A line in the meeting's chat links each file. RTK keeps its own copies only 7 days.
//
// Everyone in the room sees the recording badge from RealtimeKit itself (the web SDK's recordingUpdate), so nothing here
// tells the room.
import { and, asc, eq, isNotNull, like, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { ApiError } from '../lib/errors.js';
import { meetingRow, requireRoomAccess, rtk, type MeetingRow } from './meetings.js';
import { postHuddleSystemMessage } from './messages.js';
import { reportMeetingEnded } from './meetingAgents.js';

/** What Meet needs of the organization's Docs object (edge/src/docs/object.ts `saveMeetingFiles`). */
export interface MeetingDocs {
  saveMeetingFiles(
    organizationId: string,
    owner: { userId: string; email: string },
    input: { folder: string; video?: { url: string; filename: string }; markdown?: { title: string; text: string }; private?: boolean },
  ): Promise<{ folderUrl: string; video?: { id: string; url: string }; markdown?: { id: string; url: string } }>;
}

let docsOf: ((organizationId: string) => MeetingDocs) | null = null;

/** The Docs objects, when the Org object has handed them over (agents' Notes are saved through it too: meetingAgents.ts). */
export const meetingDocs = () => docsOf;

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

/**
 * One line of RTK's transcript JSON (docs: ai/transcription). The docs show times in milliseconds from the session's
 * start; RTK in fact sends clock times in seconds (2026-11-23: `1795407720.681`). `msOf` reads either.
 */
export interface TranscriptLine {
  startTime?: number;
  endTime?: number;
  sentence?: string;
  peerData?: { displayName?: string; name?: string };
}

/** One CSV line's fields: every field is double-quoted, a quote inside one is doubled. */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let v = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { v += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else v += line[i++];
      }
      out.push(v);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      out.push(line.slice(i, end < 0 ? line.length : end));
      i = end < 0 ? line.length : end + 1;
    }
  }
  return out;
}

/**
 * RTK's transcript file, in either of its shapes (docs: ai/transcription, output formats). JSON: an array of
 * { startTime, endTime, sentence, peerData }. CSV (the webhook's default): no header, each row "start ms", peer id, user
 * id, custom participant id, name, text.
 */
export function parseTranscript(text: string): TranscriptLine[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('[') || t.startsWith('{')) {
    const json = JSON.parse(t) as TranscriptLine[] | { transcript?: TranscriptLine[] };
    return Array.isArray(json) ? json : (json.transcript ?? []);
  }
  return t.split(/\r?\n/).flatMap((line) => {
    const f = csvFields(line);
    const start = Number(f[0]);
    if (f.length < 6 || !Number.isFinite(start)) return [];
    return [{ startTime: start, sentence: f.slice(5).join(','), peerData: { displayName: f[4] } }];
  });
}

/** A transcript time in milliseconds: epoch seconds (RTK's real output) become milliseconds; an offset stays as it is. */
export function msOf(t: number | undefined): number {
  const v = t ?? 0;
  return v > 1e9 && v < 1e11 ? v * 1000 : v;
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
  const sorted = [...lines].sort((a, b) => msOf(a.startTime) - msOf(b.startTime));
  // Times are shown from the first line: clock times become 0:00, 0:07…
  const zero = sorted.length && msOf(sorted[0]!.startTime) > 1e11 ? msOf(sorted[0]!.startTime) : 0;
  for (const l of sorted) {
    const text = (l.sentence ?? '').trim();
    if (!text) continue;
    const who = (l.peerData?.displayName ?? l.peerData?.name ?? '').trim() || 'Someone';
    const last = turns.at(-1);
    if (last && last.who === who) last.text.push(text);
    else turns.push({ who, at: msOf(l.startTime) - zero, text: [text] });
  }
  const body = turns.map((t) => `**${t.who}** · ${clock(t.at)}\n${t.text.join(' ')}`).join('\n\n');
  return `# Transcript · ${title}\n\n${date}\n\n${body || '_Nothing was said._'}\n`;
}

export async function personOf(userId: string): Promise<{ email: string; displayName: string; timezone: string } | null> {
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
 * POST /v1/meetings/:id/recording (R8): anyone in the room who is a member. RTK already transcribes every session of the
 * room (meetings.ts, ruling 2026-11-23); recording is what keeps the session's transcript. A second Record while one
 * runs is refused.
 */
export async function startRecording(ref: string, userId: string): Promise<{ ok: true; recordingId: string }> {
  const m = await meetingRow(ref);
  await requireRoomAccess(m, userId);
  if (!docsOf) throw new ApiError(503, 'recording_unavailable', 'Recording is not set up on this server');
  const session = await rtk<{ id: string; live_participants?: number }>('GET', `/meetings/${m.rtkMeetingId}/active-session`);
  if (!session) throw new ApiError(409, 'no_session', 'Nobody is in this meeting. Join it first.');
  if (await activeRecording(m)) throw new ApiError(409, 'already_recording', 'This meeting is already being recorded.');
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
  const folder = earlier?.folder ?? (await freeFolder(meetingFolder(m.title, folderDate(now, me?.timezone)), sessionId));
  await db
    .insert(schema.meetingRecordings)
    .values({
      id: started.id,
      meetingId: m.id,
      sessionId,
      startedBy: userId,
      startedAt: now,
      status: started.status ?? 'INVOKED',
      folder,
    })
    .onConflictDoNothing();
  return { ok: true, recordingId: started.id };
}

/**
 * A session's own folder: the day's name, or with " (2)", " (3)"… when another session (a second call in the same room,
 * or another meeting of the same name) already has it, so two sessions' files and transcripts never mix.
 */
async function freeFolder(base: string, sessionId: string): Promise<string> {
  const used = await db
    .select({ folder: schema.meetingRecordings.folder, sessionId: schema.meetingRecordings.sessionId })
    .from(schema.meetingRecordings)
    .where(or(eq(schema.meetingRecordings.folder, base), like(schema.meetingRecordings.folder, `${base} (%)`)));
  const taken = new Set(used.filter((u) => u.sessionId !== sessionId).map((u) => u.folder));
  let folder = base;
  for (let n = 2; taken.has(folder); n++) folder = `${base} (${n})`;
  return folder;
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
export async function postFileLine(m: MeetingRow, authorId: string, sentence: string, url: string): Promise<void> {
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
 * recording's folder. A session nobody recorded has no folder, so its transcript is dropped: only recording keeps one
 * (ruling 2026-11-23). True when there is now something for the alarm to do.
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
  if (!first) return false;
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
    const lines = await transcriptLines(row.sessionId, downloadUrl);
    const date = folderDate(row.startedAt, owner.timezone);
    const transcriptText = transcriptMarkdown(m.title, date, lines);
    const saved = await docsOf(m.workspaceId).saveMeetingFiles(m.workspaceId, { userId: row.startedBy, email: owner.email }, {
      folder: row.folder,
      markdown: { title: 'Transcript', text: transcriptText },
    });
    if (!saved.markdown) throw new Error('Docs saved no transcript');
    await db.update(schema.meetingRecordings).set({ transcriptUrl: saved.markdown.url, transcriptDownloadUrl: null }).where(eq(schema.meetingRecordings.id, row.id));
    await postFileLine(m, row.startedBy, `The transcript of this meeting is in Docs › ${row.folder}`, saved.markdown.url);
    // The agents that were in this session are told it ended (task 32): their Meeting notes automation takes it from there.
    const spoken = lines.some((l) => !!l.sentence?.trim());
    await reportMeetingEnded(m, row.sessionId, { folder: row.folder, transcriptUrl: saved.markdown.url, transcript: spoken ? 'saved' : 'silent' });
  } catch (err) {
    console.error('meeting transcript: could not save to Docs', { recordingId: row.id, err: (err as Error).message });
    await db.update(schema.meetingRecordings).set({ transcriptDownloadUrl: null }).where(eq(schema.meetingRecordings.id, row.id));
    await reportMeetingEnded(m, row.sessionId, { folder: row.folder, transcript: 'failed' }).catch((e: Error) => console.error('meeting ended: not reported', e.message));
  }
}

/**
 * A session's transcript lines from RTK: the JSON shape when RTK gives it (the webhook's address is the CSV), else the file
 * at `fallbackUrl`. RTK keeps them 7 days. Throws when neither can be read.
 */
export async function transcriptLines(sessionId: string | null, fallbackUrl?: string | null): Promise<TranscriptLine[]> {
  const asJson = sessionId
    ? await rtk<{ transcript_download_url?: string }>('GET', `/sessions/${sessionId}/transcript?format=JSON`).catch(() => null)
    : null;
  const url = asJson?.transcript_download_url ?? fallbackUrl;
  if (!url) throw new Error('no transcript to download');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`transcript download failed: ${res.status}`);
  return parseTranscript(await res.text());
}
