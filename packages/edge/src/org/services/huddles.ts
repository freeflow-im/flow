// Huddles: who is in a conversation's call, and who may start one. Since Meet phase 2 (docs/specs/meetings.md) a huddle
// is the conversation's Meet meeting on Cloudflare RealtimeKit: services/meetings.ts starts it (`startHuddle`) and its
// room's join and leave move the roster kept here. LiveKit is gone.
//
// The roster (../huddles.ts) is a cache of who is in the room, as before (decision log 2026-08-20, ADR 0002): the Meet
// room's join and leave calls are the primary path, and RealtimeKit's webhook is the safety net for a tab that closed
// without leaving. Every change publishes `huddle.updated`, which Chat's header, the sidebar and the native apps draw.
// The ring (./huddleInvites.ts) is unchanged: starting a huddle rings the conversation's people.
import { and, eq } from 'drizzle-orm';
import type { HuddleUpdatedData } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { publishEvent, subjectHuddle } from '../bus.js';
import { ApiError, badRequest } from '../lib/errors.js';
import * as store from '../huddles.js';
import { toParticipantDTOs, type HuddleParticipant } from '../huddles.js';
import { requireChannelAccess } from './channels.js';
import { endInviteForChannel } from './huddleInvites.js';

/** A huddle starts only in a room this small (ruling R5); a bigger one starts a meeting from Meet instead. */
export const HUDDLE_MAX_PEOPLE = 6;

function rosterChanged(before: HuddleParticipant[], after: HuddleParticipant[]): boolean {
  if (before.length !== after.length) return true;
  const beforeIds = new Set(before.map((p) => p.userId));
  return after.some((p) => !beforeIds.has(p.userId));
}

function publish(channelId: string, workspaceId: string, participants: HuddleParticipant[]): void {
  const data: HuddleUpdatedData = { channelId, participants: toParticipantDTOs(participants) };
  publishEvent(subjectHuddle(workspaceId, channelId), {
    type: 'huddle.updated',
    workspaceId,
    channelId,
    ts: new Date().toISOString(),
    data,
  });
}

/**
 * Any conversation you can reach — channel, DM or group DM — as long as it isn't archived. A DM huddle additionally
 * requires membership: you cannot ring a conversation you are only able to see.
 */
export async function requireHuddleEligible(channelId: string, userId: string) {
  const { chan, isMember } = await requireChannelAccess(channelId, userId);
  if (chan.archivedAt) throw badRequest('channel_archived', 'channel is archived');
  if (chan.kind !== 'standard' && !isMember) throw badRequest('not_a_member', 'not a member of this conversation');
  return { chan, isMember };
}

/** The people (not agents) in a conversation: the count R5 limits. */
export async function humanMemberCount(channelId: string): Promise<number> {
  const rows = await db
    .select({ userId: schema.channelMembers.userId })
    .from(schema.channelMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.channelMembers.userId))
    .where(and(eq(schema.channelMembers.channelId, channelId), eq(schema.users.isAgent, false)));
  return rows.length;
}

/** A new huddle may start here: refused (409) in a room of more than six people, unless one is already running. */
export async function requireHuddleSize(channelId: string): Promise<void> {
  if (store.huddleParticipants(channelId).length > 0) return;
  if ((await humanMemberCount(channelId)) > HUDDLE_MAX_PEOPLE) {
    throw new ApiError(409, 'room_too_large', `Huddles are for conversations of ${HUDDLE_MAX_PEOPLE} or fewer people. Start a meeting from Meet instead.`);
  }
}

/** Someone's Meet room joined the conversation's huddle. */
export function enterHuddle(channelId: string, workspaceId: string, userId: string): void {
  const { before, after } = store.joinHuddle(channelId, workspaceId, userId);
  if (rosterChanged(before, after)) publish(channelId, workspaceId, after);
}

/** Someone left the conversation's huddle (their room's leave, or the webhook). The last one out ends the ring. */
export async function exitHuddle(channelId: string, userId: string): Promise<void> {
  const { before, after, workspaceId } = store.leaveHuddle(channelId, userId);
  if (workspaceId && rosterChanged(before, after)) publish(channelId, workspaceId, after);
  if (after.length === 0) await endInviteForChannel(channelId);
}

/** The conversation's huddle ended for everyone (RealtimeKit's meeting.ended). */
export async function clearHuddle(channelId: string): Promise<void> {
  const { before, workspaceId } = store.clearChannelHuddle(channelId);
  if (workspaceId && before.length > 0) publish(channelId, workspaceId, []);
  await endInviteForChannel(channelId);
}

/** Leave a conversation's huddle (the older route, kept for clients that still call it). Idempotent. */
export async function leaveHuddle(channelId: string, userId: string): Promise<void> {
  await requireChannelAccess(channelId, userId);
  await exitHuddle(channelId, userId);
}
