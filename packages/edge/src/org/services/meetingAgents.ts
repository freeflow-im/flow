// Agents in Meet meetings (docs/specs/meetings.md phase 5, §1.6, §5.4; rulings R10 and 2026-11-23). Someone in a room
// sends an agent: their own hosted personal agent, or one of the organization's hosted shared agents. The agent joins as
// an RTK agent participant (its MeetingAgent object holds the connection), is added to the meeting's chat so it answers
// @mentions there, and turns recording on. It cannot hear the meeting: RTK agents get no audio, and live transcription
// is off (ruling 2026-11-23).
//
// What the agent did is an event (Taskboard task 32, decision_log 2026-11-22 "Agents remember through the event log"):
// `meet.agent_joined` when it is sent, and `meet.ended` once its session is over and the transcript is in (or there is
// none), one per agent that attended, addressed to the agent. The agent's "Meeting notes" automation (made the first time
// it is sent; an ordinary automation people can edit or delete) wakes it on `meet.ended`: it reads the transcript
// (read_meeting_transcript), saves its notes in the sender's My files (save_meeting_notes) and writes itself a memory
// entry. That replaces phase 5's headless Notes turn.
//
// Nobody's agent joins by itself (ruling 2026-11-23): only when someone sends it.
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { PublishInput } from '../../events/core.js';
import { db, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { ApiError } from '../lib/errors.js';
import { config } from '../config.js';
import { meetingRow, requireRoomAccess, rtk, type MeetingRow } from './meetings.js';
import { folderDate, meetingDocs, meetingFolder, personOf, startRecording, transcriptLines, transcriptMarkdown } from './meetingRecordings.js';

/** Our RTK preset for agents (scripts/rtk-presets.mjs makes it on each RTK app). */
export const AGENT_PRESET = 'flow_agent';
/** An agent's RTK custom participant id: `agent:<user id>` (a person's is their user id, a guest's `guest-…`). */
export const AGENT_ID_PREFIX = 'agent:';
/** The transcript an agent reads is cut to this many characters (about 40k tokens). */
const MAX_TRANSCRIPT_CHARS = 160_000;
const TOKEN_TTL_MS = 5 * 60 * 60 * 1000;

/** What the organization's object does for this module with its bindings (object.ts). Tests hand over fakes. */
export interface MeetingAgentHooks {
  /** The agent's MeetingAgent object joins the room. */
  join(p: { organizationId: string; meetingAgentId: string; rtkMeetingId: string; token: string }): Promise<void>;
  /** It leaves. */
  recall(meetingAgentId: string): Promise<void>;
  /** The organization's admin agent, which is never sent. */
  adminAgentId(): Promise<string | null>;
  /** One event into the organization's log (events/object.ts). */
  publish(event: PublishInput): Promise<void>;
  /**
   * The agent's Meeting notes automation, owned by `ownerAccountId`: made the first time the agent is sent, and never
   * again once someone deleted it (deleting it is how it is turned off).
   */
  ensureNotesAutomation(p: { agentAccountId: string; ownerAccountId: string }): Promise<void>;
}

let hooks: MeetingAgentHooks | null = null;
export function setMeetingAgentHooks(h: MeetingAgentHooks | null): void {
  hooks = h;
}

export interface MeetingAgentDTO {
  id: string;
  agentId: string;
  name: string;
  sentBy: string;
  joinedAt: string;
}

const tokenExpiry = () => new Date(Date.now() + TOKEN_TTL_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The agent as a member of the room's organization, if it may be sent by this person: theirs, or a shared hosted one. */
async function sendable(m: MeetingRow, userId: string, agentId: string): Promise<{ name: string; accountId: string | null } | null> {
  const [a] = await db
    .select({
      isAgent: schema.users.isAgent,
      name: schema.users.displayName,
      kind: schema.workspaceMembers.kind,
      runtime: schema.workspaceMembers.runtime,
      sponsor: schema.workspaceMembers.sponsorUserId,
      accountId: schema.workspaceMembers.accountId,
    })
    .from(schema.workspaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(and(eq(schema.workspaceMembers.workspaceId, m.workspaceId), eq(schema.workspaceMembers.userId, agentId)))
    .limit(1);
  if (!a?.isAgent || a.runtime !== 'hosted') return null;
  if (a.kind === 'personal_agent') return a.sponsor === userId ? { name: a.name, accountId: a.accountId } : null;
  if (a.kind === 'native' && agentId !== (await hooks?.adminAgentId())) return { name: a.name, accountId: a.accountId };
  return null;
}

const toDTO = (r: typeof schema.meetingAgents.$inferSelect, name: string): MeetingAgentDTO => ({
  id: r.id,
  agentId: r.agentId,
  name,
  sentBy: r.sentBy,
  joinedAt: r.joinedAt.toISOString(),
});

/**
 * POST /v1/meetings/:id/agents: someone in the room sends an agent. It joins RTK as an agent participant, is added to the
 * meeting's chat, and recording starts (unless it already runs). Refused while nobody is in the room, and for an agent
 * already there.
 */
export async function sendAgent(ref: string, userId: string, agentId: string): Promise<MeetingAgentDTO> {
  const m = await meetingRow(ref);
  await requireRoomAccess(m, userId);
  if (!hooks) throw new ApiError(503, 'agents_unavailable', 'Agents cannot join meetings on this server');
  const agent = await sendable(m, userId, agentId);
  if (!agent) throw new ApiError(404, 'agent_not_found', "You can send your own agents and your organization's shared agents.");
  const [here] = await db
    .select({ id: schema.meetingAgents.id })
    .from(schema.meetingAgents)
    .where(and(eq(schema.meetingAgents.meetingId, m.id), eq(schema.meetingAgents.agentId, agentId), isNull(schema.meetingAgents.leftAt)))
    .limit(1);
  if (here) throw new ApiError(409, 'already_here', `${agent.name} is already in this meeting.`);
  const session = await rtk<{ id: string }>('GET', `/meetings/${m.rtkMeetingId}/active-session`);
  if (!session) throw new ApiError(409, 'no_session', 'Nobody is in this meeting. Join it first.');
  const added = await rtk<{ id: string; token: string }>('POST', `/meetings/${m.rtkMeetingId}/participants`, {
    name: agent.name,
    preset_name: AGENT_PRESET,
    custom_participant_id: `${AGENT_ID_PREFIX}${agentId}`,
    expires_on: tokenExpiry(),
  });
  if (!added) throw new ApiError(502, 'meet_upstream', 'The meeting service did not answer');
  const row = { id: newId(), meetingId: m.id, agentId, sentBy: userId, sessionId: session.id, joinedAt: new Date(), leftAt: null, notesUrl: null, reportedAt: null };
  await db.insert(schema.meetingAgents).values(row);
  try {
    await hooks.join({ organizationId: m.workspaceId, meetingAgentId: row.id, rtkMeetingId: m.rtkMeetingId, token: added.token });
  } catch (err) {
    await db.update(schema.meetingAgents).set({ leftAt: new Date() }).where(eq(schema.meetingAgents.id, row.id));
    console.error('meeting agent could not join', { meetingId: m.id, agentId, err: (err as Error).message });
    throw new ApiError(502, 'meet_upstream', `${agent.name} could not join the meeting.`);
  }
  // Its own chat, so @mentions there reach it (a huddle's conversation is the people's, so not there).
  if (!m.channelId && m.chatChannelId) {
    await db.insert(schema.channelMembers).values({ channelId: m.chatChannelId, userId: agentId }).onConflictDoNothing();
  }
  try {
    await startRecording(ref, userId);
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'already_recording')) console.warn('meeting agent: recording did not start', { meetingId: m.id, err: (err as Error).message });
  }
  await reportJoined(m, row, agent).catch((err: Error) => console.error('meeting agent: join not reported', { meetingId: m.id, agentId, err: err.message }));
  return toDTO(row, agent.name);
}

/** The meeting as an event's object (`<org>/meet/meeting/<id>`). */
const meetingRef = (m: MeetingRow) => ({ organizationId: m.workspaceId, app: 'meet', kind: 'meeting', id: m.id });
const meetingLink = (m: MeetingRow) => `${config.webUrlBase.replace(/\/+$/, '')}/meet/${m.code}`;

/** Members' accounts and names by user id. */
async function membersOf(workspaceId: string, userIds: string[]): Promise<Map<string, { accountId: string | null; name: string; sponsor: string | null; kind: string }>> {
  if (!userIds.length) return new Map();
  const rows = await db
    .select({ userId: schema.users.id, name: schema.users.displayName, accountId: schema.workspaceMembers.accountId, kind: schema.workspaceMembers.kind, sponsor: schema.workspaceMembers.sponsorUserId, userSponsor: schema.users.sponsorUserId })
    .from(schema.users)
    .leftJoin(schema.workspaceMembers, and(eq(schema.workspaceMembers.userId, schema.users.id), eq(schema.workspaceMembers.workspaceId, workspaceId)))
    .where(inArray(schema.users.id, userIds));
  return new Map(rows.map((r) => [r.userId, { accountId: r.accountId ?? null, name: r.name, sponsor: r.sponsor ?? r.userSponsor ?? null, kind: r.kind ?? 'native' }]));
}

/**
 * `meet.agent_joined`: the server joined the agent on someone's behalf, which is no turn of the agent's, so without this
 * the agent would never know. Its actor is the agent, `invokedBy` whoever sent it; addressed to the agent (its sponsor
 * reads a personal agent's events too). Then the agent's Meeting notes automation is made, if it never was.
 */
async function reportJoined(m: MeetingRow, row: { agentId: string; sentBy: string; sessionId: string | null; joinedAt: Date }, agent: { name: string }): Promise<void> {
  if (!hooks) return;
  const who = await membersOf(m.workspaceId, [row.agentId, row.sentBy]);
  const a = who.get(row.agentId), sender = who.get(row.sentBy);
  if (!a?.accountId || !sender?.accountId) return;
  await hooks.publish({
    type: 'meet.agent_joined', organizationId: m.workspaceId, actor: a.accountId, invokedBy: sender.accountId, audience: `account:${a.accountId}`,
    about: [a.accountId, sender.accountId], ref: meetingRef(m), ts: row.joinedAt.toISOString(),
    data: { meetingId: m.id, title: m.title, link: meetingLink(m), sessionId: row.sessionId, agent: { accountId: a.accountId, name: agent.name }, sentBy: { accountId: sender.accountId, name: sender.name } },
  });
  // Its owner: a personal agent's sponsor; a shared agent's sponsor when it has one, else the person who first sent it.
  const sponsorAccount = a.sponsor ? (a.sponsor === row.sentBy ? sender.accountId : (await membersOf(m.workspaceId, [a.sponsor])).get(a.sponsor)?.accountId) : null;
  await hooks.ensureNotesAutomation({ agentAccountId: a.accountId, ownerAccountId: sponsorAccount ?? sender.accountId });
}

/** What became of a session's transcript, as `meet.ended` says it. */
export type TranscriptOutcome = 'saved' | 'silent' | 'not_recorded' | 'failed';

/** People and agents RTK saw in the session, by name (best-effort: empty when RTK does not answer). */
async function attendeesOf(m: MeetingRow, sessionId: string): Promise<{ name: string; kind: 'person' | 'agent' | 'guest' }[]> {
  const list = await rtk<{ custom_participant_id?: string; display_name?: string; name?: string }[] | { participants?: { custom_participant_id?: string; display_name?: string; name?: string }[] }>('GET', `/sessions/${sessionId}/participants`).catch(() => null);
  const people = Array.isArray(list) ? list : (list?.participants ?? []);
  const seen = new Map<string, { name: string; kind: 'person' | 'agent' | 'guest' }>();
  for (const p of people) {
    const id = p.custom_participant_id ?? '';
    const key = id || (p.display_name ?? p.name ?? '');
    if (!key || seen.has(key)) continue;
    seen.set(key, { name: p.display_name ?? p.name ?? 'Someone', kind: id.startsWith(AGENT_ID_PREFIX) ? 'agent' : id.startsWith('guest') ? 'guest' : 'person' });
  }
  return [...seen.values()];
}

/**
 * `meet.ended` for each agent that was in the session, once: when the session's transcript is saved (or could not be,
 * meetingRecordings.ts), or when RTK says the meeting ended and nobody recorded it (handleRtkWebhook). Addressed to the
 * agent, about the agent and its sender, `invokedBy` the sender; its data has the meeting, who came, and the recording's
 * and transcript's addresses. Attendance is recorded whatever became of the transcript.
 */
export async function reportMeetingEnded(m: MeetingRow, sessionId: string | null, files: { folder?: string; transcriptUrl?: string; transcript: TranscriptOutcome }): Promise<void> {
  if (!sessionId || !hooks) return;
  const claimed = await db
    .update(schema.meetingAgents)
    .set({ reportedAt: new Date() })
    .where(and(eq(schema.meetingAgents.meetingId, m.id), eq(schema.meetingAgents.sessionId, sessionId), isNull(schema.meetingAgents.reportedAt)))
    .returning();
  if (!claimed.length) return;
  // One event per agent, however many times it was sent in the session: its first sending names who sent it.
  const byJoin = [...claimed].sort((x, y) => x.joinedAt.getTime() - y.joinedAt.getTime());
  const firsts = byJoin.filter((r, i) => byJoin.findIndex((x) => x.agentId === r.agentId) === i);
  const who = await membersOf(m.workspaceId, [...new Set(firsts.flatMap((r) => [r.agentId, r.sentBy]))]);
  const [video] = await db
    .select({ videoUrl: schema.meetingRecordings.videoUrl, folder: schema.meetingRecordings.folder })
    .from(schema.meetingRecordings)
    .where(and(eq(schema.meetingRecordings.meetingId, m.id), eq(schema.meetingRecordings.sessionId, sessionId), isNotNull(schema.meetingRecordings.videoUrl)))
    .orderBy(asc(schema.meetingRecordings.startedAt))
    .limit(1);
  const attendees = await attendeesOf(m, sessionId);
  const absolute = (url: string) => new URL(url, config.webUrlBase).toString();
  const startedAt = (m.sessionStartedAt ?? firsts[0]!.joinedAt).toISOString();
  const agents = firsts.map((r) => ({ accountId: who.get(r.agentId)?.accountId ?? null, name: who.get(r.agentId)?.name ?? 'an agent' }));
  for (const r of firsts) {
    const a = who.get(r.agentId), sender = who.get(r.sentBy);
    if (!a?.accountId) continue;
    await hooks.publish({
      type: 'meet.ended', organizationId: m.workspaceId, actor: null, audience: `account:${a.accountId}`,
      ...(sender?.accountId ? { invokedBy: sender.accountId, about: [a.accountId, sender.accountId] } : { about: [a.accountId] }),
      ref: meetingRef(m), ts: new Date().toISOString(),
      data: {
        meetingId: m.id, sessionId, title: m.title, link: meetingLink(m), startedAt, endedAt: new Date().toISOString(),
        agent: { accountId: a.accountId, name: a.name, joinedAt: r.joinedAt.toISOString(), leftAt: r.leftAt?.toISOString() ?? null },
        sentBy: { accountId: sender?.accountId ?? null, name: sender?.name ?? 'someone' },
        attendees: attendees.length ? attendees : [{ name: sender?.name ?? 'someone', kind: 'person' as const }, ...agents.map((x) => ({ name: x.name, kind: 'agent' as const }))],
        transcript: files.transcript,
        ...(files.transcriptUrl ? { transcriptUrl: absolute(files.transcriptUrl) } : {}),
        ...(video?.videoUrl ? { recordingUrl: absolute(video.videoUrl) } : {}),
        ...(files.folder ?? video?.folder ? { folder: `Docs › ${files.folder ?? video!.folder}` } : {}),
      },
    }).catch((err: Error) => console.error('meeting ended: not published', { meetingId: m.id, agentId: r.agentId, err: err.message }));
  }
}

/**
 * RTK's `meeting.ended` for a session (handleRtkWebhook): with no recording of it, there will be no transcript, so its
 * agents are told now. A recorded session is reported when its transcript is saved.
 */
export async function meetingEndedForAgents(m: MeetingRow, sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  const [recorded] = await db
    .select({ id: schema.meetingRecordings.id })
    .from(schema.meetingRecordings)
    .where(and(eq(schema.meetingRecordings.meetingId, m.id), eq(schema.meetingRecordings.sessionId, sessionId)))
    .limit(1);
  if (!recorded) await reportMeetingEnded(m, sessionId, { transcript: 'not_recorded' });
}

// ---- the Meeting notes automation's tools (assistant/meetingTools.ts), as the agent ------------------------------------

/** The agent's sendings to this meeting's session; a 404 when it was not there (an agent reads only meetings it attended). */
async function attendance(agentUserId: string, meetingId: string, sessionId: string): Promise<{ m: MeetingRow; rows: (typeof schema.meetingAgents.$inferSelect)[] }> {
  const rows = await db
    .select()
    .from(schema.meetingAgents)
    .where(and(eq(schema.meetingAgents.meetingId, meetingId), eq(schema.meetingAgents.agentId, agentUserId), eq(schema.meetingAgents.sessionId, sessionId)))
    .orderBy(asc(schema.meetingAgents.joinedAt));
  if (!rows.length) throw new ApiError(404, 'not_attended', 'You were not in that meeting session. Use the meetingId and sessionId from the meet.ended event.');
  return { m: await meetingRow(meetingId), rows };
}

/** read_meeting_transcript: the session's transcript as Markdown (cut when very long), for an agent that was there. */
export async function agentMeetingTranscript(agentUserId: string, meetingId: string, sessionId: string): Promise<{ title: string; transcript: string; cut: boolean }> {
  const { m } = await attendance(agentUserId, meetingId, sessionId);
  const [rec] = await db
    .select({ startedAt: schema.meetingRecordings.startedAt, startedBy: schema.meetingRecordings.startedBy })
    .from(schema.meetingRecordings)
    .where(and(eq(schema.meetingRecordings.meetingId, m.id), eq(schema.meetingRecordings.sessionId, sessionId)))
    .orderBy(asc(schema.meetingRecordings.startedAt))
    .limit(1);
  if (!rec) throw new ApiError(404, 'no_transcript', 'That meeting was not recorded, so it has no transcript.');
  let lines;
  try {
    lines = await transcriptLines(sessionId);
  } catch {
    throw new ApiError(404, 'no_transcript', 'The transcript of that meeting cannot be read (the meeting service keeps it 7 days).');
  }
  const owner = await personOf(rec.startedBy);
  const text = transcriptMarkdown(m.title, folderDate(rec.startedAt, owner?.timezone), lines);
  const cut = text.length > MAX_TRANSCRIPT_CHARS;
  return { title: m.title, transcript: cut ? `${text.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[The rest of the transcript was cut.]` : text, cut };
}

/**
 * save_meeting_notes: the agent's notes of a session it attended, as a Markdown document in the My files of whoever sent
 * it, under `Meetings/<date> <title>/`. Named `Notes`, or `Notes · <agent>` when it is not the only agent that person
 * sent to the session. Returns its address.
 */
export async function saveAgentMeetingNotes(agentUserId: string, meetingId: string, sessionId: string, markdown: string): Promise<{ url: string; folder: string; owner: string }> {
  const text = markdown.trim();
  if (!text) throw new ApiError(400, 'no_notes', 'The notes are empty.');
  const { m, rows } = await attendance(agentUserId, meetingId, sessionId);
  const sentBy = rows[0]!.sentBy;
  const [sender, docs] = [await personOf(sentBy), meetingDocs()];
  if (!sender || !docs) throw new ApiError(503, 'docs_unavailable', 'Docs cannot save the notes just now.');
  const others = await db
    .selectDistinct({ agentId: schema.meetingAgents.agentId })
    .from(schema.meetingAgents)
    .where(and(eq(schema.meetingAgents.meetingId, m.id), eq(schema.meetingAgents.sessionId, sessionId), eq(schema.meetingAgents.sentBy, sentBy)));
  const agent = (await membersOf(m.workspaceId, [agentUserId])).get(agentUserId);
  const firstName = agent?.name.split(' ')[0] || 'Agent';
  const folder = meetingFolder(m.title, folderDate(m.sessionStartedAt ?? rows[0]!.joinedAt, sender.timezone));
  const saved = await docs(m.workspaceId).saveMeetingFiles(m.workspaceId, { userId: sentBy, email: sender.email }, {
    folder, private: true, markdown: { title: others.length > 1 ? `Notes · ${firstName}` : 'Notes', text },
  });
  if (!saved.markdown) throw new ApiError(502, 'docs_failed', 'Docs saved no notes.');
  await db.update(schema.meetingAgents).set({ notesUrl: saved.markdown.url }).where(inArray(schema.meetingAgents.id, rows.map((r) => r.id)));
  return { url: new URL(saved.markdown.url, config.webUrlBase).toString(), folder: `My files › ${folder}`, owner: sender.displayName };
}


/** GET /v1/meetings/:id/agents: the agents in the room now. */
export async function listAgents(ref: string, userId: string): Promise<MeetingAgentDTO[]> {
  const m = await meetingRow(ref);
  await requireRoomAccess(m, userId);
  const rows = await db
    .select({ r: schema.meetingAgents, name: schema.users.displayName })
    .from(schema.meetingAgents)
    .innerJoin(schema.users, eq(schema.users.id, schema.meetingAgents.agentId))
    .where(and(eq(schema.meetingAgents.meetingId, m.id), isNull(schema.meetingAgents.leftAt)))
    .orderBy(asc(schema.meetingAgents.joinedAt));
  return rows.map(({ r, name }) => toDTO(r, name));
}

/** DELETE /v1/meetings/:id/agents/:agentId: anyone in the room sends an agent away. Its Notes still come after the meeting. */
export async function recallAgent(ref: string, userId: string, agentId: string): Promise<{ ok: true }> {
  const m = await meetingRow(ref);
  await requireRoomAccess(m, userId);
  const rows = await db
    .select({ id: schema.meetingAgents.id })
    .from(schema.meetingAgents)
    .where(and(eq(schema.meetingAgents.meetingId, m.id), eq(schema.meetingAgents.agentId, agentId), isNull(schema.meetingAgents.leftAt)));
  for (const r of rows) {
    await hooks?.recall(r.id).catch((err: Error) => console.warn('meeting agent: recall failed', err.message));
    await agentLeft(r.id);
  }
  return { ok: true };
}

/** The agent's MeetingAgent object has left (everyone left, the meeting ended, or it was sent away). */
export async function agentLeft(meetingAgentId: string): Promise<void> {
  await db.update(schema.meetingAgents).set({ leftAt: new Date() }).where(and(eq(schema.meetingAgents.id, meetingAgentId), isNull(schema.meetingAgents.leftAt)));
}

