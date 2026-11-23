// Agents in Meet meetings (docs/specs/meetings.md phase 5, §1.6, §5.4; rulings R10 and 2026-11-23). Someone in a room
// sends an agent: their own hosted personal agent, or one of the organization's hosted shared agents. The agent joins as
// an RTK agent participant (its MeetingAgent object holds the connection), is added to the meeting's chat so it answers
// @mentions there, and turns recording on. It cannot hear the meeting: RTK agents get no audio, and live transcription
// is off (ruling 2026-11-23).
//
// What the agent did is in the event log (decision_log 2026-11-22, "agents remember through events"): `meet.agent.joined`
// when it is sent, and `meet.ended` once its session is over and the transcript is saved (meetingRecordings.ts), or
// ENDED_GRACE_MS after it left when no transcript came. Both are the agent's own events, which its sponsor reads too.
// The agent's built-in "Meeting notes" automation (assistant/meetingWake.ts) wakes on `meet.ended`: the agent reads the
// transcript, saves its Notes with save_meeting_notes (in the meeting's folder, owned by whoever sent it, linked in the
// meeting's chat) and writes what it learned in its own memory.
//
// Nobody's agent joins by itself (ruling 2026-11-23): only when someone sends it.
import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import type { PublishInput } from '../../events/core.js';
import { db, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { ApiError } from '../lib/errors.js';
import { meetingRow, pictureOf, requireRoomAccess, rtk, type MeetingRow } from './meetings.js';
import { config } from '../config.js';
import { AGENT_AVATAR_PRESETS, agentAvatarUrl } from '@flow/shared/assistant';
import { meetingDocs, postFileLine, sessionFolder, startRecording } from './meetingRecordings.js';

/** Our RTK preset for agents (scripts/rtk-presets.mjs makes it on each RTK app). */
export const AGENT_PRESET = 'flow_agent';
/** An agent's RTK custom participant id: `agent:<user id>` (a person's is their user id, a guest's `guest-…`). */
export const AGENT_ID_PREFIX = 'agent:';
/** How long after an agent left `meet.ended` waits for its session's transcript before it goes without one. */
export const ENDED_GRACE_MS = 30 * 60_000;
/** The event types (shared/manifests.ts, Meet's `events`). */
export const MEET_AGENT_JOINED = 'meet.agent.joined';
export const MEET_ENDED = 'meet.ended';
const TOKEN_TTL_MS = 5 * 60 * 60 * 1000;

/** What the organization's object does for this module with its bindings (object.ts). Tests hand over fakes. */
export interface MeetingAgentHooks {
  /** The agent's MeetingAgent object joins the room. */
  join(p: { organizationId: string; meetingAgentId: string; rtkMeetingId: string; token: string }): Promise<void>;
  /** It leaves. */
  recall(meetingAgentId: string): Promise<void>;
  /** Into the organization's event log. */
  publish(event: PublishInput): Promise<void>;
  /** The agent's built-in "Meeting notes" automation is there, unless its sponsor deleted it (assistant/meetingWake.ts). */
  ensureMeetingWake(p: { organizationId: string; agentAccountId: string }): Promise<void>;
  /** The organization's admin agent, which is never sent. */
  adminAgentId(): Promise<string | null>;
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

/** An agent with no picture of its own shows one of the preset agent pictures, the same one each time (by its id). */
export function defaultAgentPicture(agentId: string): string {
  let h = 0;
  for (const ch of agentId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return agentAvatarUrl(AGENT_AVATAR_PRESETS[h % AGENT_AVATAR_PRESETS.length]!);
}

const tokenExpiry = () => new Date(Date.now() + TOKEN_TTL_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The agent as a member of the room's organization, if it may be sent by this person: theirs, or a shared hosted one. */
async function sendable(m: MeetingRow, userId: string, agentId: string): Promise<{ name: string; accountId: string | null; avatarUrl: string | null } | null> {
  const [a] = await db
    .select({
      isAgent: schema.users.isAgent,
      name: schema.users.displayName,
      avatarUrl: schema.users.avatarUrl,
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
  const found = { name: a.name, accountId: a.accountId, avatarUrl: a.avatarUrl ?? null };
  if (a.kind === 'personal_agent') return a.sponsor === userId ? found : null;
  if (a.kind === 'native' && agentId !== (await hooks?.adminAgentId())) return found;
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
    // Its picture on its tile (it sends no video): a public address, as RTK loads it for everyone in the room.
    ...pictureOf(agent.avatarUrl ?? defaultAgentPicture(agentId)),
  });
  if (!added) throw new ApiError(502, 'meet_upstream', 'The meeting service did not answer');
  const row = { id: newId(), meetingId: m.id, agentId, sentBy: userId, sessionId: session.id, joinedAt: new Date(), leftAt: null, notesUrl: null, endedAt: null };
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
  await announceJoined(m, row, agent.accountId).catch((err: Error) => console.error('meeting agent: join not logged', { meetingId: m.id, agentId, err: err.message }));
  return toDTO(row, agent.name);
}

const meetingLink = (m: MeetingRow) => new URL(`/meet/${m.code ?? m.id}`, config.webUrlBase).toString();
const absolute = (url: string) => new URL(url, config.webUrlBase).toString();

async function accountAndName(workspaceId: string, userId: string): Promise<{ accountId: string | null; name: string; email: string; timezone: string | null } | null> {
  const [u] = await db
    .select({ name: schema.users.displayName, email: schema.users.email, timezone: schema.users.timezone, accountId: schema.workspaceMembers.accountId })
    .from(schema.users)
    .leftJoin(schema.workspaceMembers, and(eq(schema.workspaceMembers.userId, schema.users.id), eq(schema.workspaceMembers.workspaceId, workspaceId)))
    .where(eq(schema.users.id, userId))
    .limit(1);
  return u ? { accountId: u.accountId ?? null, name: u.name, email: u.email, timezone: u.timezone ?? null } : null;
}

/**
 * `meet.agent.joined`, the agent's own event (it is the actor, the person who sent it the one who asked), and the agent's
 * "Meeting notes" automation made if it has none yet, so the meeting's end wakes it.
 */
async function announceJoined(m: MeetingRow, row: { id: string; agentId: string; sentBy: string; sessionId: string; joinedAt: Date }, agentAccountId: string | null): Promise<void> {
  if (!hooks || !agentAccountId) return;
  const sender = await accountAndName(m.workspaceId, row.sentBy);
  await hooks.ensureMeetingWake({ organizationId: m.workspaceId, agentAccountId }).catch((err: Error) => console.error('meeting agent: no Meeting notes automation', { agentAccountId, err: err.message }));
  await hooks.publish({
    type: MEET_AGENT_JOINED,
    organizationId: m.workspaceId,
    actor: agentAccountId,
    ...(sender?.accountId && sender.accountId !== agentAccountId ? { invokedBy: sender.accountId } : {}),
    audience: `account:${agentAccountId}`,
    about: [agentAccountId],
    ts: row.joinedAt.toISOString(),
    data: {
      meetingId: m.id, title: m.title, link: meetingLink(m), sessionId: row.sessionId, chatChannelId: m.chatChannelId ?? m.channelId ?? null,
      sentBy: { accountId: sender?.accountId ?? null, name: sender?.name ?? null },
    },
  });
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

/** What `meet.ended` says of the session's transcript, when it was saved. */
export interface EndedTranscript {
  /** The transcript's document in Docs, which the agent reads with read_doc. */
  docId: string;
  url: string;
  /** Whether anyone said anything. */
  hadSpeech: boolean;
  /** The names of the people who spoke. */
  speakers: string[];
}

/**
 * `meet.ended` for each agent that was in the session and has none yet: its own event (audience its account, about it),
 * which wakes its "Meeting notes" automation. `transcript` is null when none came (the session was not recorded, or the
 * copy failed). Once per agent and session (`ended_at`), whichever of the transcript and the grace sweep comes first.
 */
export async function publishMeetingEnded(m: MeetingRow, sessionId: string, folder: string | null, transcript: EndedTranscript | null): Promise<number> {
  if (!hooks) return 0;
  const rows = await db
    .select({ r: schema.meetingAgents, accountId: schema.workspaceMembers.accountId })
    .from(schema.meetingAgents)
    .leftJoin(schema.workspaceMembers, and(eq(schema.workspaceMembers.userId, schema.meetingAgents.agentId), eq(schema.workspaceMembers.workspaceId, m.workspaceId)))
    .where(and(eq(schema.meetingAgents.meetingId, m.id), eq(schema.meetingAgents.sessionId, sessionId), isNull(schema.meetingAgents.endedAt)))
    .orderBy(asc(schema.meetingAgents.joinedAt));
  // One event per agent, however many times it was sent in the session.
  const agents = [...new Map(rows.map((x) => [x.r.agentId, x])).values()];
  let published = 0;
  for (const { r, accountId } of agents) {
    const claimed = await db
      .update(schema.meetingAgents)
      .set({ endedAt: new Date() })
      .where(and(eq(schema.meetingAgents.meetingId, m.id), eq(schema.meetingAgents.agentId, r.agentId), eq(schema.meetingAgents.sessionId, sessionId), isNull(schema.meetingAgents.endedAt)))
      .returning({ id: schema.meetingAgents.id, joinedAt: schema.meetingAgents.joinedAt, leftAt: schema.meetingAgents.leftAt });
    if (!claimed.length || !accountId) continue;
    const sender = await accountAndName(m.workspaceId, r.sentBy);
    const joinedAt = new Date(Math.min(...claimed.map((c) => c.joinedAt.getTime())));
    const lefts = claimed.map((c) => c.leftAt?.getTime() ?? Date.now());
    try {
      await hooks.publish({
        type: MEET_ENDED,
        organizationId: m.workspaceId,
        actor: null,
        audience: `account:${accountId}`,
        about: [accountId],
        ts: new Date().toISOString(),
        data: {
          meetingId: m.id, title: m.title, link: meetingLink(m), sessionId, chatChannelId: m.chatChannelId ?? m.channelId ?? null,
          sentBy: { accountId: sender?.accountId ?? null, name: sender?.name ?? null },
          joinedAt: joinedAt.toISOString(), leftAt: new Date(Math.max(...lefts)).toISOString(),
          folder,
          transcript: transcript
            ? { docId: transcript.docId, url: absolute(transcript.url), hadSpeech: transcript.hadSpeech, speakers: transcript.speakers }
            : null,
          notesSaved: !!r.notesUrl,
        },
      });
      published++;
    } catch (err) {
      console.error('meeting agent: meet.ended not published', { meetingId: m.id, agentId: r.agentId, err: (err as Error).message });
    }
  }
  return published;
}

/** When the grace sweep is next due (ms), or null: the earliest agent that left and has no `meet.ended` yet. */
export const MEETING_AGENTS_DUE_SQL = 'SELECT MIN(left_at) AS at FROM meeting_agents WHERE ended_at IS NULL AND left_at IS NOT NULL';

/**
 * The alarm's part (object.ts): an agent that left over ENDED_GRACE_MS ago with no `meet.ended` gets one without a
 * transcript, unless its session's transcript is still waiting to be copied (that copy publishes it).
 */
export async function endOverdueMeetingAgents(now = Date.now()): Promise<void> {
  const rows = await db
    .select({ meetingId: schema.meetingAgents.meetingId, sessionId: schema.meetingAgents.sessionId })
    .from(schema.meetingAgents)
    .where(and(isNull(schema.meetingAgents.endedAt), isNotNull(schema.meetingAgents.leftAt), lte(schema.meetingAgents.leftAt, new Date(now - ENDED_GRACE_MS))));
  const sessions = [...new Map(rows.map((r) => [`${r.meetingId}:${r.sessionId}`, r])).values()];
  for (const { meetingId, sessionId } of sessions) {
    const [m] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, meetingId)).limit(1);
    if (!m) continue;
    if (!sessionId) {
      await db.update(schema.meetingAgents).set({ endedAt: new Date() }).where(and(eq(schema.meetingAgents.meetingId, meetingId), isNull(schema.meetingAgents.sessionId)));
      continue;
    }
    const recordings = await db
      .select({ folder: schema.meetingRecordings.folder, pending: schema.meetingRecordings.transcriptDownloadUrl })
      .from(schema.meetingRecordings)
      .where(and(eq(schema.meetingRecordings.meetingId, meetingId), eq(schema.meetingRecordings.sessionId, sessionId)))
      .orderBy(asc(schema.meetingRecordings.startedAt));
    if (recordings.some((r) => r.pending)) continue;
    await publishMeetingEnded(m, sessionId, recordings[0]?.folder ?? null, null);
  }
}

/**
 * save_meeting_notes: an agent's Notes of a meeting it was sent to, saved in the session's folder in Docs (the recording's,
 * or a new one), owned by whoever sent it, and linked in the meeting's chat as the agent. `agentUserId` is the agent the
 * tool runs for; it must have been in that meeting (that session, when given: else its latest).
 */
export async function saveMeetingNotes(agentUserId: string, input: { meetingId: string; sessionId?: string; notes: string }): Promise<{ url: string; folder: string; docId: string }> {
  const m = await meetingRow(input.meetingId).catch(() => null);
  if (!m) throw new ApiError(404, 'meeting_not_found', 'No such meeting. Use the meetingId from the meet.ended event.');
  const rows = await db
    .select()
    .from(schema.meetingAgents)
    .where(and(eq(schema.meetingAgents.meetingId, m.id), eq(schema.meetingAgents.agentId, agentUserId), ...(input.sessionId ? [eq(schema.meetingAgents.sessionId, input.sessionId)] : [])))
    .orderBy(asc(schema.meetingAgents.joinedAt));
  const row = rows.at(-1);
  if (!row?.sessionId) throw new ApiError(403, 'not_in_meeting', 'You were not sent to that meeting, so you cannot save notes for it.');
  const text = input.notes.trim();
  if (!text) throw new ApiError(400, 'empty_notes', 'The notes are empty.');
  const docs = meetingDocs();
  const sender = await accountAndName(m.workspaceId, row.sentBy);
  if (!docs || !sender) throw new ApiError(503, 'docs_unavailable', 'Docs is not reachable just now.');
  const folder = await sessionFolder(m, row.sessionId, sender.timezone);
  const others = await db
    .select({ agentId: schema.meetingAgents.agentId })
    .from(schema.meetingAgents)
    .where(and(eq(schema.meetingAgents.meetingId, m.id), eq(schema.meetingAgents.sessionId, row.sessionId)));
  const [me] = await db.select({ name: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, agentUserId)).limit(1);
  const firstName = me?.name.split(' ')[0] || me?.name || 'The agent';
  const title = new Set(others.map((o) => o.agentId)).size > 1 ? `Notes · ${firstName}` : 'Notes';
  const saved = await docs(m.workspaceId).saveMeetingFiles(m.workspaceId, { userId: row.sentBy, email: sender.email }, { folder, markdown: { title, text } });
  if (!saved.markdown) throw new ApiError(502, 'docs_failed', 'Docs did not save the notes.');
  await db.update(schema.meetingAgents).set({ notesUrl: saved.markdown.url })
    .where(and(eq(schema.meetingAgents.meetingId, m.id), eq(schema.meetingAgents.agentId, agentUserId), eq(schema.meetingAgents.sessionId, row.sessionId)));
  await postFileLine(m, agentUserId, `${firstName}'s notes of this meeting are in Docs › ${folder}`, saved.markdown.url)
    .catch((err: Error) => console.warn('meeting notes: chat line not posted', err.message));
  return { url: absolute(saved.markdown.url), folder, docId: saved.markdown.id };
}
