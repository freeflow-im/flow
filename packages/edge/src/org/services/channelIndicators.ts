// Channel activity indicators (#137): authorization, fan-out and expiry around
// the in-memory store in ../indicators.ts. The store holds the state and knows
// nothing about the bus or the database; this module is the only writer.
//
// Events ride a per-channel subject under the workspace wildcard, exactly like
// artifacts: the envelope carries channelId, so the gateway's visible() filter
// delivers only to people who can see the channel and private channels stay
// private for free.
import type { ChannelIndicatorData, ChannelIndicatorState } from '@flow/shared';
import { publishEvent, subjectIndicator } from '../bus.js';
import {
  DEFAULT_TTL_MS,
  clearIndicator,
  clearIndicatorsForUser,
  setIndicator,
  sweepExpired,
  type ChannelRef,
} from '../indicators.js';
import { requireChannelAccess } from './channels.js';

/** How often expired entries are swept. The TTL is the guarantee; this is just
 * how promptly a lapsed spinner stops being drawn. */
const SWEEP_INTERVAL_MS = 10_000;

function publish(channelId: string, workspaceId: string, state: ChannelIndicatorState | null): void {
  const data: ChannelIndicatorData = { channelId, state };
  publishEvent(subjectIndicator(workspaceId, channelId), {
    type: 'channel.indicator',
    workspaceId,
    channelId,
    ts: new Date().toISOString(),
    data,
  });
}

/**
 * Turn this user's indicator in a channel on or off. Any member of a channel
 * may set it — the same bar as posting, which is the action it annotates.
 *
 * Only a change in the channel's *aggregate* is published: refreshing a live
 * indicator every 30s (what the bridge does) must not put an event on the bus
 * each time.
 */
export async function setChannelIndicator(
  channelId: string,
  userId: string,
  state: ChannelIndicatorState | 'none',
  ttlSeconds?: number,
): Promise<{ state: ChannelIndicatorState | null }> {
  const { chan } = await requireChannelAccess(channelId, userId);
  const ttlMs = ttlSeconds !== undefined ? ttlSeconds * 1000 : DEFAULT_TTL_MS;
  const { before, after } =
    state === 'none'
      ? clearIndicator(channelId, userId)
      : setIndicator(channelId, chan.workspaceId, userId, state, ttlMs);
  if (before !== after) publish(channelId, chan.workspaceId, after);
  return { state: after };
}

/** Disconnect path: drop everything this user was showing. Called from the
 * gateway when their last socket closes. */
export function clearIndicatorsOnDisconnect(userId: string): void {
  for (const ref of clearIndicatorsForUser(userId)) publish(ref.channelId, ref.workspaceId, null);
}

/** Expiry path: a lapsed indicator has no request behind it, so nothing would
 * tell clients to stop drawing it without this. */
export function startIndicatorSweeper(): { stop(): void } {
  const timer = setInterval(() => {
    for (const ref of sweepExpired()) publish(ref.channelId, ref.workspaceId, null);
  }, SWEEP_INTERVAL_MS);
  timer.unref(); // never hold the process open
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

export type { ChannelRef };
