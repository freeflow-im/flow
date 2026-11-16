// Meet (docs/specs/meetings.md): meeting rooms on Cloudflare RealtimeKit (RTK). Phase 1 is members only: a member
// creates a room, anyone in the organization joins it by its link, and RTK carries the media. This module keeps our
// side (the room and one RTK participant per person) and asks RTK for the rest: a participant token on every join,
// and who is in a room now (Live now). No webhooks yet: RTK is asked directly, which also works on a laptop.
import { and, desc, eq, gt } from 'drizzle-orm';
import type { LiveMeetingDTO, MeetingDTO, MeetingJoinDTO, MeetingPersonDTO } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import { ApiError, notFound } from '../lib/errors.js';
import { requireMembership } from './workspaces.js';

const HOST_PRESET = 'group_call_host';
const MEMBER_PRESET = 'group_call_participant';
/** Live now only asks RTK about rooms joined this recently. */
const LIVE_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_TITLE = 120;

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
  workspaceId: m.workspaceId,
  title: m.title,
  createdBy: m.createdBy,
  createdAt: m.createdAt.toISOString(),
});

async function meetingRow(meetingId: string): Promise<MeetingRow> {
  const [m] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, meetingId)).limit(1);
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
  const row = { id: newId(), workspaceId, rtkMeetingId: created.id, title: name, createdBy: userId, createdAt: new Date() };
  await db.insert(schema.meetings).values(row);
  return toDTO({ ...row, lastJoinedAt: null });
}

export async function getMeeting(meetingId: string, userId: string): Promise<MeetingDTO> {
  const m = await meetingRow(meetingId);
  await requireMembership(m.workspaceId, userId);
  return toDTO(m);
}

/**
 * A token for this person in this room. The first join adds them to RTK as a participant (the creator as host); later
 * joins refresh that participant's token, so RTK sees one person, not one per join.
 */
export async function joinMeeting(meetingId: string, userId: string): Promise<MeetingJoinDTO> {
  const m = await meetingRow(meetingId);
  await requireMembership(m.workspaceId, userId);
  const expiresOn = new Date(Date.now() + config.rtkTokenTtlMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const [existing] = await db
    .select()
    .from(schema.meetingParticipants)
    .where(and(eq(schema.meetingParticipants.meetingId, m.id), eq(schema.meetingParticipants.userId, userId)))
    .limit(1);
  let authToken: string | undefined;
  let host = m.createdBy === userId;
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
  return { meeting: toDTO(m), authToken, host };
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
