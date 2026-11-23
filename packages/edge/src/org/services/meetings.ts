// Meet (docs/specs/meetings.md): meeting rooms on Cloudflare RealtimeKit (RTK), members only for now. A member creates
// a room, anyone in the organization joins it by its link, and RTK carries the media. This module keeps our side (the
// room and one RTK participant per person) and asks RTK for the rest: a participant token on every join, and who is in
// a room now (Live now).
//
// A conversation's huddle is a room too (phase 2): `startHuddle` makes the conversation's one room and rings its
// people; the room's join and leave move the huddle roster (./huddles.ts), and RTK's webhook is the safety net for a
// tab closed without leaving.
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type {
  HuddleStartDTO,
  LiveMeetingDTO,
  MeetingChatDTO,
  MeetingDTO,
  MeetingGuestJoinDTO,
  MeetingJoinDTO,
  MeetingPersonDTO,
  MeetingPreviewDTO,
} from '@flow/shared';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import { ApiError, badRequest, notFound } from '../lib/errors.js';
import { isUniqueViolation, requireMembership } from './workspaces.js';
import { clearHuddle, enterHuddle, exitHuddle, requireHuddleEligible, requireHuddleSize } from './huddles.js';
import { startOrJoinRing } from './huddleInvites.js';
import { toChannelDTO } from './channels.js';
import { postMeetingStartedLine } from './messages.js';
import { addMeetingGuestVisitor, endMeetingVisits } from './visitors.js';
import { handleRecordingUpdate, handleTranscript, type RecordingWebhook, type TranscriptWebhook } from './meetingRecordings.js';

const HOST_PRESET = 'group_call_host';
const MEMBER_PRESET = 'group_call_participant';
/** Our own guest preset, with no waiting room (scripts/rtk-presets.mjs makes it on each RTK app). */
const GUEST_PRESET = 'flow_guest';
/** A guest's RTK custom participant id starts with this; a member's is their user id. */
export const GUEST_ID_PREFIX = 'guest-';
const MAX_GUEST_NAME = 60;
/** Live now only asks RTK about rooms joined this recently. */
const LIVE_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_TITLE = 120;
/** Letters for a meeting code: no i, l or o, which read as 1 or 0 when a link is typed from a screen. */
const CODE_LETTERS = 'abcdefghjkmnpqrstuvwxyz';
const CODE_SHAPE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
/** Joins this close to a session's start belong to it: RTK may not report a session until its first person connects. */
const SESSION_GAP_MS = 2 * 60_000;

/** A meeting's short code, `kqd-wmzt-fra`: 23^10 (about 4e13) codes, so a clash is not a practical worry. */
export function newMeetingCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(10);
  const letters = [...bytes].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]);
  return `${letters.slice(0, 3).join('')}-${letters.slice(3, 7).join('')}-${letters.slice(7).join('')}`;
}

export type MeetingRow = typeof schema.meetings.$inferSelect;
type ChannelRow = typeof schema.channels.$inferSelect;

function requireMeet(): { accountId: string; appId: string; token: string } {
  const { rtkAccountId: accountId, rtkAppId: appId, rtkApiToken: token } = config;
  if (!accountId || !appId || !token) throw new ApiError(503, 'meet_unavailable', 'Meet is not set up on this server');
  return { accountId, appId, token };
}

/** One call to RTK's REST API. Returns `data`, or null for a 404 (no active session); anything else that fails throws. */
export async function rtk<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const { accountId, appId, token } = requireMeet();
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/kit/${appId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404) return null;
  const json = (await res.json().catch(() => null)) as { success?: boolean; data?: T } | null;
  if (!res.ok || !json?.success || json.data === undefined) {
    console.warn('realtimekit call failed', method, path, res.status);
    throw new ApiError(502, 'meet_upstream', 'The meeting service did not answer');
  }
  return json.data;
}

const toDTO = (m: MeetingRow): MeetingDTO => ({
  id: m.id,
  // A room made before codes existed has none; its id still works in the link.
  code: m.code ?? m.id,
  workspaceId: m.workspaceId,
  title: m.title,
  createdBy: m.createdBy,
  createdAt: m.createdAt.toISOString(),
  channelId: m.channelId ?? null,
  locked: m.locked ?? false,
  chatChannelId: m.chatChannelId ?? null,
});

/** Who may be in a room: any member of its organization, and for a huddle, whoever may be in that conversation. */
export async function requireRoomAccess(m: MeetingRow, userId: string): Promise<void> {
  await requireMembership(m.workspaceId, userId);
  if (m.channelId) await requireHuddleEligible(m.channelId, userId);
}

/** A room by its link: the short code, or the id (older links). */
export async function meetingRow(ref: string): Promise<MeetingRow> {
  const where = CODE_SHAPE.test(ref) ? eq(schema.meetings.code, ref) : or(eq(schema.meetings.id, ref), eq(schema.meetings.code, ref));
  const [m] = await db.select().from(schema.meetings).where(where).limit(1);
  if (!m) throw notFound('meeting not found');
  return m;
}

export async function createMeeting(workspaceId: string, userId: string, title?: string): Promise<MeetingDTO> {
  await requireMembership(workspaceId, userId);
  requireMeet();
  const [me] = await db.select({ displayName: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  const name = (title ?? '').trim().slice(0, MAX_TITLE) || `${me?.displayName?.split(' ')[0] || 'A'}'s meeting`;
  const created = await rtk<{ id: string }>('POST', '/meetings', { title: name });
  if (!created) throw new ApiError(502, 'meet_upstream', 'The meeting service did not answer');
  const row = { id: newId(), code: newMeetingCode(), workspaceId, rtkMeetingId: created.id, title: name, createdBy: userId, createdAt: new Date(), channelId: null, locked: false };
  await db.insert(schema.meetings).values(row);
  return toDTO({ ...row, lastJoinedAt: null, chatChannelId: null, sessionStartedAt: null });
}

/**
 * A meeting made for a member by their account (the booking page's "FreeFlow Meet" location, phase 3: the Calendar object
 * has the account, not the user). Its short code, or null when the account is not a member here.
 */
export async function createMeetingForAccount(accountId: string, title: string): Promise<string | null> {
  const [member] = await db
    .select({ userId: schema.workspaceMembers.userId, workspaceId: schema.workspaceMembers.workspaceId })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.accountId, accountId))
    .limit(1);
  if (!member) return null;
  return (await createMeeting(member.workspaceId, member.userId, title)).code;
}

export async function getMeeting(ref: string, userId: string): Promise<MeetingDTO> {
  const m = await meetingRow(ref);
  await requireRoomAccess(m, userId);
  return toDTO(m);
}

/**
 * A token for this person in this room. The first join adds them to RTK as a participant (the creator as host); later
 * joins refresh that participant's token, so RTK sees one person, not one per join.
 */
export async function joinMeeting(ref: string, userId: string): Promise<MeetingJoinDTO> {
  const m = await meetingRow(ref);
  await requireRoomAccess(m, userId);
  const expiresOn = tokenExpiry();
  const [existing] = await db
    .select()
    .from(schema.meetingParticipants)
    .where(and(eq(schema.meetingParticipants.meetingId, m.id), eq(schema.meetingParticipants.userId, userId)))
    .limit(1);
  let authToken: string | undefined;
  // A huddle has no organizer: everyone in the conversation hosts it (docs/specs/meetings.md §3).
  let host = m.createdBy === userId || !!m.channelId;
  if (existing) {
    host = existing.preset === HOST_PRESET;
    const refreshed = await rtk<{ token: string }>('POST', `/meetings/${m.rtkMeetingId}/participants/${existing.rtkParticipantId}/token`, { expires_on: expiresOn });
    authToken = refreshed?.token;
  }
  if (!authToken) {
    // No participant yet, or RTK no longer has it (a 404 on refresh): add one.
    const [me] = await db
      .select({ displayName: schema.users.displayName, avatarUrl: schema.users.avatarUrl })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const preset = host ? HOST_PRESET : MEMBER_PRESET;
    const added = await rtk<{ id: string; token: string }>('POST', `/meetings/${m.rtkMeetingId}/participants`, {
      name: me?.displayName || 'Someone',
      preset_name: preset,
      custom_participant_id: userId,
      expires_on: expiresOn,
      // RTK fetches the picture itself, so only an absolute URL is any use to it.
      ...(me?.avatarUrl && /^https:\/\//.test(me.avatarUrl) ? { picture: me.avatarUrl } : {}),
    });
    if (!added) throw new ApiError(502, 'meet_upstream', 'The meeting service did not answer');
    authToken = added.token;
    await db
      .insert(schema.meetingParticipants)
      .values({ meetingId: m.id, userId, rtkParticipantId: added.id, preset })
      .onConflictDoUpdate({
        target: [schema.meetingParticipants.meetingId, schema.meetingParticipants.userId],
        set: { rtkParticipantId: added.id, preset },
      });
  }
  await db.update(schema.meetings).set({ lastJoinedAt: new Date() }).where(eq(schema.meetings.id, m.id));
  if (m.channelId) {
    enterHuddle(m.channelId, m.workspaceId, userId);
    return { meeting: toDTO(m), authToken, host };
  }
  // Any other room has its chat (phase 3b): the member is in it from their first join on.
  const chat = await meetingChat(m);
  await db.insert(schema.channelMembers).values({ channelId: chat.id, userId }).onConflictDoNothing();
  await noteSession(m, chat, userId);
  return { meeting: toDTO({ ...m, chatChannelId: chat.id }), authToken, host };
}

// ---- the meeting's chat (docs/specs/meetings.md §9 3b) ------------------------------------------------------------------

/**
 * The room's chat: a private channel of kind `meeting` with no name, made the first time anyone joins (never for a
 * huddle), with the room's creator as its first member. One per room, not per session.
 */
async function meetingChat(m: MeetingRow): Promise<ChannelRow> {
  if (m.chatChannelId) {
    const [c] = await db.select().from(schema.channels).where(eq(schema.channels.id, m.chatChannelId)).limit(1);
    if (c) return c;
  }
  const chan: ChannelRow = {
    id: newId(), workspaceId: m.workspaceId, name: null, kind: 'meeting', dmKey: null, topic: null, isPrivate: true,
    createdBy: m.createdBy, createdAt: new Date(), archivedAt: null, parentId: null, emoji: null,
  };
  await db.insert(schema.channels).values(chan);
  const won = await db
    .update(schema.meetings)
    .set({ chatChannelId: chan.id })
    .where(and(eq(schema.meetings.id, m.id), or(isNull(schema.meetings.chatChannelId), eq(schema.meetings.chatChannelId, m.chatChannelId ?? ''))))
    .returning({ id: schema.meetings.id });
  if (!won.length) {
    // Someone else's join made it first: theirs is the one.
    await db.delete(schema.channels).where(eq(schema.channels.id, chan.id));
    const [again] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, m.id)).limit(1);
    if (!again?.chatChannelId) throw notFound('meeting not found');
    return meetingChat(again);
  }
  m.chatChannelId = chan.id;
  await db.insert(schema.channelMembers).values({ channelId: chan.id, userId: m.createdBy }).onConflictDoNothing();
  return chan;
}

/** "Mon 16 Nov" in a person's time zone (UTC when theirs is unknown). */
export function sessionDate(at: Date, timeZone: string | null | undefined): string {
  const fmt = (tz: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).format(at).replace(/,/g, '');
  try {
    return fmt(timeZone || 'UTC');
  } catch {
    return fmt('UTC');
  }
}

/**
 * A session begins (the first join while RTK has none running, or RTK's meeting.started): the room's chat gets its date
 * line, "Meeting started · Mon 16 Nov", and the visits of earlier sessions' guests end. Joins within a couple of minutes
 * of a start belong to that session (RTK reports a session only once someone connects), so two people arriving together
 * post one line. Returns the session's start when this call began one, else null.
 */
async function beginSession(m: MeetingRow, chat: ChannelRow, authorId: string, at = new Date()): Promise<Date | null> {
  const began = await db
    .update(schema.meetings)
    .set({ sessionStartedAt: at })
    .where(
      and(
        eq(schema.meetings.id, m.id),
        or(isNull(schema.meetings.sessionStartedAt), lt(schema.meetings.sessionStartedAt, new Date(at.getTime() - SESSION_GAP_MS))),
      ),
    )
    .returning({ id: schema.meetings.id });
  if (!began.length) return null;
  m.sessionStartedAt = at;
  await endMeetingVisits(chat.id, at);
  const [author] = await db.select({ timezone: schema.users.timezone }).from(schema.users).where(eq(schema.users.id, authorId)).limit(1);
  await postMeetingStartedLine(chat, authorId, `Meeting started · ${sessionDate(at, author?.timezone)}`, at);
  return at;
}

/** On a join: begins a session when RTK has none running. An RTK that does not answer begins none (no line is better than ending guests' visits by mistake). */
async function noteSession(m: MeetingRow, chat: ChannelRow, authorId: string): Promise<Date | null> {
  let running: boolean;
  try {
    const session = await rtk<RtkSession>('GET', `/meetings/${m.rtkMeetingId}/active-session`);
    running = !!session && session.live_participants !== 0;
  } catch {
    return null;
  }
  return running ? null : beginSession(m, chat, authorId);
}

/**
 * GET /v1/workspaces/:id/meetings/chats: the meeting chats the caller is in (Chat's "Meetings"), live ones first, then
 * newest session or message first. Each has its channel (unreadNotifications counts only mentions), meeting and people.
 */
export async function meetingChats(workspaceId: string, userId: string): Promise<MeetingChatDTO[]> {
  await requireMembership(workspaceId, userId);
  const rows = await db
    .select({ m: schema.meetings, c: schema.channels, lastReadMsgId: schema.channelMembers.lastReadMsgId, notifyLevel: schema.channelMembers.notifyLevel })
    .from(schema.meetings)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.meetings.chatChannelId))
    .innerJoin(schema.channelMembers, and(eq(schema.channelMembers.channelId, schema.channels.id), eq(schema.channelMembers.userId, userId)))
    .where(and(eq(schema.meetings.workspaceId, workspaceId), isNull(schema.channels.archivedAt)));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.c.id);
  const [members, lastMessages, mentions] = await Promise.all([
    db.select({ channelId: schema.channelMembers.channelId, userId: schema.channelMembers.userId }).from(schema.channelMembers).where(inArray(schema.channelMembers.channelId, ids)),
    db
      .select({ channelId: schema.messages.channelId, at: sql<number>`max(${schema.messages.createdAt})` })
      .from(schema.messages)
      .where(and(inArray(schema.messages.channelId, ids), isNull(schema.messages.deletedAt)))
      .groupBy(schema.messages.channelId),
    db
      .select({ channelId: schema.notifications.channelId, n: sql<number>`count(*)` })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt), inArray(schema.notifications.channelId, ids)))
      .groupBy(schema.notifications.channelId),
  ]);
  const people = new Map<string, string[]>();
  for (const r of members) people.set(r.channelId, [...(people.get(r.channelId) ?? []), r.userId]);
  const lastAt = new Map(lastMessages.map((r) => [r.channelId, Number(r.at)]));
  const unread = new Map(mentions.map((r) => [r.channelId, Number(r.n)]));
  const recent = Date.now() - LIVE_WINDOW_MS;
  const live = await Promise.all(
    rows.map(async ({ m }) => (config.rtkEnabled && m.lastJoinedAt && m.lastJoinedAt.getTime() > recent ? await liveSession(m).catch(() => null) : null)),
  );
  const chats = rows.map(({ m, c, lastReadMsgId, notifyLevel }, i): MeetingChatDTO => {
    const meeting = toDTO(m);
    const last = lastAt.get(c.id);
    return {
      channel: toChannelDTO(c, {
        isMember: true, lastReadMsgId, notifyLevel, unreadCount: 0, unreadNotifications: unread.get(c.id) ?? 0,
        meeting: { code: meeting.code, title: m.title },
      }),
      meeting,
      peopleIds: people.get(c.id) ?? [],
      lastSessionAt: m.sessionStartedAt?.toISOString() ?? null,
      lastMessageAt: last ? new Date(last).toISOString() : null,
      live: !!live[i],
      livePeople: live[i]?.people ?? [],
    };
  });
  const newest = (x: MeetingChatDTO) => Math.max(Date.parse(x.lastSessionAt ?? '') || 0, Date.parse(x.lastMessageAt ?? '') || 0, Date.parse(x.channel.createdAt));
  return chats.sort((a, b) => Number(b.live) - Number(a.live) || newest(b) - newest(a));
}

/** RTK's expiry format: whole seconds, UTC. */
const tokenExpiry = () => new Date(Date.now() + config.rtkTokenTtlMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] || 'Someone';

/** A room by its link's short code only: the public guest routes never take an id. */
async function meetingByCode(code: string): Promise<MeetingRow> {
  if (!CODE_SHAPE.test(code)) throw notFound('meeting not found');
  return meetingRow(code);
}

/** Whether this person hosts the room: they made it, or they were added to it as a host. A huddle has no lock. */
async function isHost(m: MeetingRow, userId: string): Promise<boolean> {
  if (m.createdBy === userId) return true;
  const [p] = await db
    .select({ preset: schema.meetingParticipants.preset })
    .from(schema.meetingParticipants)
    .where(and(eq(schema.meetingParticipants.meetingId, m.id), eq(schema.meetingParticipants.userId, userId)))
    .limit(1);
  return p?.preset === HOST_PRESET;
}

/**
 * What a meeting's link shows before joining, to anyone who has it (the check screen, phase 3): the title, who made
 * it, and the first names of who is in. A huddle says guests may not join.
 */
export async function previewMeeting(code: string): Promise<MeetingPreviewDTO> {
  requireMeet();
  const m = await meetingByCode(code);
  const [maker] = await db.select({ name: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, m.createdBy)).limit(1);
  const live = await liveSession(m).catch(() => null);
  return {
    code: m.code ?? code,
    title: m.title,
    hostName: firstName(maker?.name),
    people: (live?.people ?? []).map((p) => firstName(p.name)),
    locked: m.locked,
    guestsAllowed: !m.channelId,
  };
}

/**
 * A guest's way in (ruling R2: straight in, no waiting room). Each join is a new RTK guest: a guest has no account to
 * tie a participant to. Refused for a huddle (a conversation's call is for its members) and while a host has locked it.
 */
export async function joinAsGuest(code: string, name: string): Promise<{ join: MeetingGuestJoinDTO; visitorToken: string | null }> {
  requireMeet();
  const shown = name.replace(/\s+/g, ' ').trim().slice(0, MAX_GUEST_NAME);
  if (!shown) throw badRequest('validation', 'name: enter your name');
  const m = await meetingByCode(code);
  if (m.channelId) throw new ApiError(403, 'guests_not_allowed', 'This call is only for the people in its conversation.');
  if (m.locked) throw new ApiError(403, 'meeting_locked', 'This meeting is locked. Ask the host to unlock it.');
  const guestId = `${GUEST_ID_PREFIX}${crypto.randomUUID()}`;
  const added = await rtk<{ id: string; token: string }>('POST', `/meetings/${m.rtkMeetingId}/participants`, {
    name: shown,
    preset_name: GUEST_PRESET,
    custom_participant_id: guestId,
    expires_on: tokenExpiry(),
  });
  if (!added) throw new ApiError(502, 'meet_upstream', 'The meeting service did not answer');
  await db.update(schema.meetings).set({ lastJoinedAt: new Date() }).where(eq(schema.meetings.id, m.id));
  // Phase 3b: the guest is a visitor of the meeting's chat, seeing from the moment they joined (from their session's date
  // line when their join began the session), until the session ends.
  const chat = await meetingChat(m);
  const began = await noteSession(m, chat, m.createdBy);
  const visit = await addMeetingGuestVisitor(chat, shown, began ?? new Date());
  return {
    join: { code: m.code ?? code, title: m.title, authToken: added.token, chatChannelId: visit ? chat.id : null },
    visitorToken: visit?.sessionToken ?? null,
  };
}

/** Lock or unlock a meeting (hosts only; not a huddle). Locked keeps new guests out; members still join. */
export async function setMeetingLocked(ref: string, userId: string, locked: boolean): Promise<MeetingDTO> {
  const m = await meetingRow(ref);
  await requireRoomAccess(m, userId);
  if (m.channelId) throw badRequest('not_for_huddles', 'A huddle cannot be locked: guests cannot join it.');
  if (!(await isHost(m, userId))) throw new ApiError(403, 'not_host', 'Only a host can lock this meeting.');
  await db.update(schema.meetings).set({ locked }).where(eq(schema.meetings.id, m.id));
  return toDTO({ ...m, locked });
}

/**
 * Renames a meeting (Calendar names a meeting made before its event had a title; docs/specs/meetings.md §1.2). A host
 * only; a huddle keeps its conversation's name. An empty title changes nothing.
 */
export async function setMeetingTitle(ref: string, userId: string, title: string): Promise<MeetingDTO> {
  const m = await meetingRow(ref);
  await requireRoomAccess(m, userId);
  if (m.channelId) throw badRequest('not_for_huddles', 'A huddle is named after its conversation.');
  if (!(await isHost(m, userId))) throw new ApiError(403, 'not_host', 'Only a host can rename this meeting.');
  const name = title.trim().slice(0, MAX_TITLE);
  if (!name || name === m.title) return toDTO(m);
  await db.update(schema.meetings).set({ title: name }).where(eq(schema.meetings.id, m.id));
  return toDTO({ ...m, title: name });
}

/** The room says this person left (Leave, or the tab closing). Moves a huddle's roster; nothing to do for a meeting. */
export async function leaveMeeting(ref: string, userId: string): Promise<void> {
  const m = await meetingRow(ref);
  await requireMembership(m.workspaceId, userId);
  if (m.channelId) await exitHuddle(m.channelId, userId);
}

/** What a huddle's room is called: the channel's name, or the other people's first names in a DM. */
async function huddleTitle(chan: { id: string; kind: string; name: string | null }, userId: string): Promise<string> {
  if (chan.kind === 'standard' && chan.name) return `#${chan.name}`;
  const others = await db
    .select({ name: schema.users.displayName })
    .from(schema.channelMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.channelMembers.userId))
    .where(eq(schema.channelMembers.channelId, chan.id));
  const [me] = await db.select({ name: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  const names = others.map((o) => o.name.split(' ')[0]).filter((n) => n && n !== me?.name.split(' ')[0]);
  return names.length ? `Huddle with ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and others' : ''}` : 'Huddle';
}

/** The conversation's one room, made the first time someone starts a huddle there. */
async function channelRoom(chan: { id: string; workspaceId: string; kind: string; name: string | null }, userId: string): Promise<MeetingRow> {
  const [existing] = await db.select().from(schema.meetings).where(eq(schema.meetings.channelId, chan.id)).limit(1);
  if (existing) return existing;
  const title = await huddleTitle(chan, userId);
  const created = await rtk<{ id: string }>('POST', '/meetings', { title });
  if (!created) throw new ApiError(502, 'meet_upstream', 'The meeting service did not answer');
  const row = { id: newId(), code: newMeetingCode(), workspaceId: chan.workspaceId, rtkMeetingId: created.id, title, createdBy: userId, createdAt: new Date(), channelId: chan.id, lastJoinedAt: null, locked: false, chatChannelId: null, sessionStartedAt: null };
  try {
    await db.insert(schema.meetings).values(row);
    return row;
  } catch (err) {
    // Two people started it at once: the other's room is the one.
    if (!isUniqueViolation(err)) throw err;
    const [won] = await db.select().from(schema.meetings).where(eq(schema.meetings.channelId, chan.id)).limit(1);
    if (!won) throw err;
    return won;
  }
}

/**
 * "Huddle" in a conversation (rulings R4, R5): its Meet room, made on first use, and a ring for its people. Refused in
 * a room of more than six people unless a huddle is already running there. The caller then opens `/meet/<code>`; being
 * in the room (joinMeeting) is what puts them on the roster.
 */
export async function startHuddle(channelId: string, userId: string): Promise<HuddleStartDTO> {
  requireMeet();
  const { chan } = await requireHuddleEligible(channelId, userId);
  await requireHuddleSize(chan.id);
  const room = await channelRoom(chan, userId);
  const { invite, unavailable } = await startOrJoinRing(chan, userId);
  return { meeting: toDTO(room), invite, unavailable };
}

/**
 * A RealtimeKit webhook, already verified by the Worker (routes/org.ts). A recording or transcript is noted for the copy
 * to Docs (phase 4). Huddles drop who left; a meeting's chat gets its date line on meeting.started (if a join has not
 * already posted it) and ends its guests' visits on meeting.ended.
 */
export async function handleRtkWebhook(event: {
  event?: string;
  meeting?: { id?: string; sessionId?: string };
  participant?: { customParticipantId?: string };
} & RecordingWebhook & TranscriptWebhook): Promise<void> {
  const rtkMeetingId = event.meeting?.id;
  if (!rtkMeetingId) return;
  const [m] = await db.select().from(schema.meetings).where(eq(schema.meetings.rtkMeetingId, rtkMeetingId)).limit(1);
  if (!m) return;
  // Recording (phase 4): for every room, huddle or not. The copy to Docs is the alarm's (meetingRecordings.ts).
  if (event.event === 'recording.statusUpdate') return void (await handleRecordingUpdate(m, event));
  if (event.event === 'meeting.transcript') return void (await handleTranscript(m, event));
  if (!m.channelId) {
    if (!m.chatChannelId) return;
    const [chat] = await db.select().from(schema.channels).where(eq(schema.channels.id, m.chatChannelId)).limit(1);
    if (!chat) return;
    if (event.event === 'meeting.started') await beginSession(m, chat, m.createdBy);
    else if (event.event === 'meeting.ended') await endMeetingVisits(chat.id);
    return;
  }
  if (event.event === 'meeting.participantLeft' && event.participant?.customParticipantId) {
    await exitHuddle(m.channelId, event.participant.customParticipantId);
  } else if (event.event === 'meeting.ended') {
    await clearHuddle(m.channelId);
  }
}

interface RtkSession {
  id: string;
  started_at?: string;
  live_participants?: number;
}
interface RtkSessionParticipant {
  custom_participant_id?: string;
  display_name?: string;
  name?: string;
  left_at?: string | null;
}

/** Who is in a room now, from RTK. Null when no session is running. */
async function liveSession(m: MeetingRow): Promise<{ people: MeetingPersonDTO[]; startedAt: string | null } | null> {
  const session = await rtk<RtkSession>('GET', `/meetings/${m.rtkMeetingId}/active-session`);
  if (!session) return null;
  const list = await rtk<RtkSessionParticipant[] | { participants?: RtkSessionParticipant[] }>('GET', `/sessions/${session.id}/participants`).catch(() => null);
  const rows = Array.isArray(list) ? list : (list?.participants ?? []);
  const people = rows
    .filter((p) => !p.left_at)
    .map((p) => ({ userId: p.custom_participant_id ?? null, name: p.display_name ?? p.name ?? 'Someone' }));
  // One person on two devices is one person in the list.
  const seen = new Set<string>();
  const unique = people.filter((p) => !p.userId || (!seen.has(p.userId) && !!seen.add(p.userId)));
  if (unique.length === 0 && !session.live_participants) return null;
  return { people: unique, startedAt: session.started_at ?? null };
}

/** Meet's Live now: the organization's rooms used in the last hours that have a session running. */
export async function liveMeetings(workspaceId: string, userId: string): Promise<LiveMeetingDTO[]> {
  await requireMembership(workspaceId, userId);
  if (!config.rtkEnabled) return [];
  const recent = await db
    .select()
    .from(schema.meetings)
    .where(and(eq(schema.meetings.workspaceId, workspaceId), gt(schema.meetings.lastJoinedAt, new Date(Date.now() - LIVE_WINDOW_MS))))
    .orderBy(desc(schema.meetings.lastJoinedAt))
    .limit(20);
  const live = await Promise.all(recent.map(async (m) => ({ m, s: await liveSession(m).catch(() => null) })));
  return live.flatMap(({ m, s }) => (s ? [{ ...toDTO(m), people: s.people, startedAt: s.startedAt }] : []));
}
