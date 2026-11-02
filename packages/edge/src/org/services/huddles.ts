// Huddles: authorization, LiveKit token minting, fan-out, and the
// webhook/boot reconciliation that keeps ../huddles.ts in sync with LiveKit
// (the source of truth — see that module's doc comment and decision_log.md
// 2026-08-20).
//
// A huddle is now scoped to an *entity*, not a channel (#436): channels stay
// ambient (join freely, no ring) while DMs and group DMs ring their members.
// The room is the same either way — room name is the entity id — so everything
// here is shared, and the DM-only half (the ring, its 30s timeout, the
// transcript line) lives in ./huddleInvites.ts and is reached from exactly two
// places below: the join path starts a ring, and every path that empties a
// room ends one.
import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import { TrackSource } from '@livekit/protocol';
import { eq } from 'drizzle-orm';
import type { Event, HuddleJoinDTO, HuddleUpdatedData } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { publishEvent, subjectHuddle, subjectHuddleAll } from '../bus.js';
import { config } from '../config.js';
import { ApiError, badRequest } from '../lib/errors.js';
import * as store from '../huddles.js';
import { toParticipantDTOs, type HuddleParticipant } from '../huddles.js';
import { requireChannelAccess } from './channels.js';
import { endInviteForChannel, startOrJoinRing } from './huddleInvites.js';
import { mintAgentInferenceToken } from './huddleInference.js';

const { channels } = schema;

function requireLiveKitConfigured(): { apiKey: string; apiSecret: string; url: string } {
  const { livekitApiKey: apiKey, livekitApiSecret: apiSecret, livekitUrl: url } = config;
  if (!apiKey || !apiSecret || !url) throw new ApiError(503, 'huddles_unavailable', 'voice huddles are not configured');
  return { apiKey, apiSecret, url };
}

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
 * Any entity you can reach — channel, DM or group DM (#436) — as long as it
 * isn't archived. A DM huddle additionally requires membership: you cannot
 * ring a conversation you are only able to see.
 */
async function requireHuddleEligible(channelId: string, userId: string) {
  const { chan, isMember } = await requireChannelAccess(channelId, userId);
  if (chan.archivedAt) throw badRequest('channel_archived', 'channel is archived');
  if (chan.kind !== 'standard' && !isMember) throw badRequest('not_a_member', 'not a member of this conversation');
  return { chan, isMember };
}

/**
 * Join an entity's huddle: mints a LiveKit access token scoped to that room
 * (room name = entity id) and records the join. Idempotent — calling this
 * while already an active participant re-mints a fresh token rather than
 * erroring (decision log 2026-08-20); this is also the reconnect path.
 *
 * The grant covers microphone, camera and screen share (#435). It used to be
 * microphone-only, which did not merely hide the camera button — LiveKit
 * *silently* refuses to publish a source outside the grant, so a client that
 * tried got a dead track and no error. Joining still starts muted, camera off
 * and not sharing; the grant says what you *may* publish, the client says what
 * you actually are.
 *
 * In a DM this also starts (or answers) the ring — see ./huddleInvites.ts.
 */
export async function joinHuddle(
  channelId: string,
  userId: string,
  options: { includeInferenceToken?: boolean } = {},
): Promise<HuddleJoinDTO> {
  const { apiKey, apiSecret, url } = requireLiveKitConfigured();
  const { chan } = await requireHuddleEligible(channelId, userId);

  const { before, after } = store.joinHuddle(channelId, chan.workspaceId, userId);
  if (rosterChanged(before, after)) publish(channelId, chan.workspaceId, after);

  const at = new AccessToken(apiKey, apiSecret, { identity: userId, ttl: config.livekitTokenTtl });
  at.addGrant({
    room: channelId,
    roomJoin: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    canSubscribe: true,
  });
  const token = await at.toJwt();

  // Speech inference is authenticated separately from the room. Only an
  // already-authenticated agent bridge receives this capability; human
  // clients never receive it, and the LiveKit project secret never leaves
  // the Flow server. It is deliberately short-lived and scoped to inference.
  let inferenceToken: string | undefined;
  if (options.includeInferenceToken) {
    inferenceToken = await mintAgentInferenceToken(apiKey, apiSecret, userId);
  }

  const inference = inferenceToken ? { inferenceToken } : {};
  if (chan.kind === 'standard') return { token, url, ...inference, invite: null, unavailable: [] };
  const { invite, unavailable } = await startOrJoinRing(chan, userId);
  return { token, url, ...inference, invite, unavailable };
}

/** Leave an entity's huddle. Idempotent (no-op if the caller wasn't in it). */
export async function leaveHuddle(channelId: string, userId: string): Promise<void> {
  const { chan } = await requireChannelAccess(channelId, userId);
  const { before, after } = store.leaveHuddle(channelId, userId);
  if (rosterChanged(before, after)) publish(channelId, chan.workspaceId, after);
  if (chan.kind !== 'standard' && after.length === 0) await endInviteForChannel(channelId);
}

/**
 * LiveKit webhook — the reconciliation safety net for a participant/room that
 * vanished without a REST leave call (network drop, tab killed, crash).
 * Signature-verified via `WebhookReceiver`; not a Flow user, so no requireAuth.
 */
export async function handleLiveKitWebhook(rawBody: string, authHeader: string): Promise<void> {
  const { apiKey, apiSecret } = requireLiveKitConfigured();
  const receiver = new WebhookReceiver(apiKey, apiSecret);
  const event = await receiver.receive(rawBody, authHeader);

  if (event.event === 'participant_left') {
    const channelId = event.room?.name;
    const userId = event.participant?.identity;
    if (!channelId || !userId) return;
    const { before, after, workspaceId } = store.leaveHuddle(channelId, userId);
    if (workspaceId && rosterChanged(before, after)) publish(channelId, workspaceId, after);
    if (after.length === 0) await endInviteForChannel(channelId);
  } else if (event.event === 'room_finished') {
    const channelId = event.room?.name;
    if (!channelId) return;
    const { before, workspaceId } = store.clearChannelHuddle(channelId);
    if (workspaceId && before.length > 0) publish(channelId, workspaceId, []);
    await endInviteForChannel(channelId);
  }
}

/**
 * Boot-time reconciliation (decision log 2026-08-20): a server restart wipes
 * ../huddles.ts's in-memory map while LiveKit's rooms — hosted separately on
 * LiveKit Cloud — keep running with real participants. Rebuild the cache from
 * LiveKit's own REST API and republish corrected rosters so already-connected
 * clients stop showing a stale huddle state from before the restart.
 */
export async function reconcileHuddlesFromLiveKit(): Promise<void> {
  if (!config.livekitEnabled) return;
  const { livekitApiKey: apiKey, livekitApiSecret: apiSecret, livekitUrl: url } = config;
  const svc = new RoomServiceClient(url!, apiKey, apiSecret);
  const rooms = await svc.listRooms();

  for (const room of rooms) {
    const channelId = room.name;
    const chanRows = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    const chan = chanRows[0];
    if (!chan) continue; // stale/foreign room name — not one of ours

    const participants = await svc.listParticipants(channelId);
    const mapped: HuddleParticipant[] = participants.map((p) => ({
      userId: p.identity,
      joinedAt: Number(p.joinedAtMs),
    }));
    const { before, after } = store.reconcileChannel(channelId, chan.workspaceId, mapped);
    if (rosterChanged(before, after)) publish(channelId, chan.workspaceId, after);
  }
}

