// Huddles on the Node server (the legacy AWS origin). Huddles moved to Meet on
// Cloudflare RealtimeKit (docs/specs/meetings.md phase 2), which only the
// Worker runs, so this server no longer starts one: join and accept answer
// 503 huddles_unavailable, and /v1/config says `huddles: false`. What stays is
// leaving (idempotent, for an old client) and the replica roster sync.
import type { Event, HuddleUpdatedData } from '@flow/shared';
import { publishEvent, subjectHuddle, subjectHuddleAll, subscribeBus } from '../bus.js';
import { ApiError } from '../lib/errors.js';
import * as store from '../huddles.js';
import { toParticipantDTOs, type HuddleParticipant } from '../huddles.js';
import { requireChannelAccess } from './channels.js';
import { endInviteForChannel } from './huddleInvites.js';

/** Starting or answering a huddle: not on this server. */
export function huddlesUnavailable(): ApiError {
  return new ApiError(503, 'huddles_unavailable', 'Huddles run in Meet, which this server does not host.');
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

/** Leave an entity's huddle. Idempotent (no-op if the caller wasn't in it). */
export async function leaveHuddle(channelId: string, userId: string): Promise<void> {
  const { chan } = await requireChannelAccess(channelId, userId);
  const { before, after } = store.leaveHuddle(channelId, userId);
  if (rosterChanged(before, after)) publish(channelId, chan.workspaceId, after);
  if (chan.kind !== 'standard' && after.length === 0) await endInviteForChannel(channelId);
}

/**
 * Replica roster sync (phase 18 M2, design doc §1a): a leave REST call lands
 * on one replica, so the others' caches go stale.
 * Every `huddle.updated` event carries the channel's *full* roster, so each
 * replica applies every event — its own included — to converge. Applying our
 * own loopback is idempotent; ordering per subject is NATS-guaranteed, so the
 * worst case is a milliseconds-stale roster between a local write and the
 * loopback of the event before it.
 */
export function startHuddleRosterSync(): { stop(): void } {
  const sub = subscribeBus(subjectHuddleAll());
  void (async () => {
    for await (const m of sub) {
      try {
        const event = JSON.parse(new TextDecoder().decode(m.data)) as Event;
        if (event.type !== 'huddle.updated' || !event.channelId) continue;
        const data = event.data as HuddleUpdatedData;
        store.reconcileChannel(
          event.channelId,
          event.workspaceId,
          data.participants.map((p) => ({ userId: p.userId, joinedAt: Date.parse(p.joinedAt) })),
        );
      } catch {
        /* skip malformed */
      }
    }
  })();
  return {
    stop() {
      sub.unsubscribe();
    },
  };
}
