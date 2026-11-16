// Meet (docs/specs/meetings.md): meeting rooms on Cloudflare RealtimeKit (RTK), members only for now. A member creates
// a room, anyone in the organization joins it by its link, and RTK carries the media. This module keeps our side (the
// room and one RTK participant per person) and asks RTK for the rest: a participant token on every join, and who is in
// a room now (Live now).
//
// A conversation's huddle is a room too (phase 2): `startHuddle` makes the conversation's one room and rings its
// people; the room's join and leave move the huddle roster (./huddles.ts), and RTK's webhook is the safety net for a
// tab closed without leaving.
import { and, desc, eq, gt, or } from 'drizzle-orm';
import type { HuddleStartDTO, LiveMeetingDTO, MeetingDTO, MeetingJoinDTO, MeetingPersonDTO } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import { ApiError, notFound } from '../lib/errors.js';
import { isUniqueViolation, requireMembership } from './workspaces.js';
import { clearHuddle, enterHuddle, exitHuddle, requireHuddleEligible, requireHuddleSize } from './huddles.js';
import { startOrJoinRing } from './huddleInvites.js';

const HOST_PRESET = 'group_call_host';
const MEMBER_PRESET = 'group_call_participant';
/** Live now only asks RTK about rooms joined this recently. */
const LIVE_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_TITLE = 120;
/** Letters for a meeting code: no i, l or o, which read as 1 or 0 when a link is typed from a screen. */
const CODE_LETTERS = 'abcdefghjkmnpqrstuvwxyz';
const CODE_SHAPE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** A meeting's short code, `kqd-wmzt-fra`: 23^10 (about 4e13) codes, so a clash is not a practical worry. */
export function newMeetingCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(10);
  const letters = [...bytes].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]);
  return `${letters.slice(0, 3).join('')}-${letters.slice(3, 7).join('')}-${letters.slice(7).join('')}`;
}

type MeetingRow = typeof schema.meetings.$inferSelect;

function requireMeet(): { accountId: string; appId: string; token: string } {
  const { rtkAccountId: accountId, rtkAppId: appId, rtkApiToken: token } = config;
  if (!accountId || !appId || !token) throw new ApiError(503, 'meet_unavailable', 'Meet is not set up on this server');
  return { accountId, appId, token };
}

/** One call to RTK's REST API. Returns `data`, or null for a 404 (no active session); anything else that fails throws. */
async function rtk<T>(method: string, path: string, body?: unknown): Promise<T | null> {
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
});

/** Who may be in a room: any member of its organization, and for a huddle, whoever may be in that conversation. */
async function requireRoomAccess(m: MeetingRow, userId: string): Promise<void> {
  await requireMembership(m.workspaceId, userId);
  if (m.channelId) await requireHuddleEligible(m.channelId, userId);
}

/** A room by its link: the short code, or the id (older links). */
async function meetingRow(ref: string): Promise<MeetingRow> {
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
  const row = { id: newId(), code: newMeetingCode(), workspaceId, rtkMeetingId: created.id, title: name, createdBy: userId, createdAt: new Date(), channelId: null };
  await db.insert(schema.meetings).values(row);
  return toDTO({ ...row, lastJoinedAt: null });
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
  const expiresOn = new Date(Date.now() + config.rtkTokenTtlMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
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
  if (m.channelId) enterHuddle(m.channelId, m.workspaceId, userId);
  return { meeting: toDTO(m), authToken, host };
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
  const row = { id: newId(), code: newMeetingCode(), workspaceId: chan.workspaceId, rtkMeetingId: created.id, title, createdBy: userId, createdAt: new Date(), channelId: chan.id, lastJoinedAt: null };
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

/** A RealtimeKit webhook, already verified by the Worker (routes/org.ts). Only huddles care, to drop who left. */
export async function handleRtkWebhook(event: {
  event?: string;
  meeting?: { id?: string };
  participant?: { customParticipantId?: string };
}): Promise<void> {
  const rtkMeetingId = event.meeting?.id;
  if (!rtkMeetingId) return;
  const [m] = await db.select().from(schema.meetings).where(eq(schema.meetings.rtkMeetingId, rtkMeetingId)).limit(1);
  if (!m?.channelId) return;
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
