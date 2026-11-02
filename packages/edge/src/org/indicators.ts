// Channel activity indicators (#137) — the small spinner an agent turns on at
// the end of a channel's sidebar row while it works on a turn.
//
// Transient by design, like presence (../presence.ts): this is in-memory state,
// never a DB column. A spinner is a claim about *right now*, and the failure
// mode that matters is a run crashing mid-turn and leaving a channel spinning
// forever. Three independent things clear it, so no single failure can:
//   1. the setter clears it explicitly (the bridge does, including error paths),
//   2. the entry expires — every set carries a TTL the setter must refresh,
//   3. the setter's last socket closes (see gateway/index.ts).
// Rebooting the server clears everything, which is the correct answer too.
//
// Distributed the same way presence is (phase 18 M2, design doc §1a): each
// replica's per-channel *aggregates* ride the presence heartbeat, and a
// remote view of the other replicas' aggregates merges into every read. The
// per-user entries stay local — only the setter's replica needs them; the
// aggregate is all any other replica renders or publishes.
import type { ChannelIndicatorState } from '@flow/shared';

interface Entry {
  state: ChannelIndicatorState;
  workspaceId: string;
  /** epoch ms; the entry is dead at or after this instant */
  expiresAt: number;
}

/** channelId -> userId -> entry. Per-setter, so one agent clearing its own
 * indicator can't switch off another agent still working in the same channel. */
const byChannel = new Map<string, Map<string, Entry>>();

/** One channel's aggregate as another replica reported it. */
export interface RemoteIndicator {
  workspaceId: string;
  state: ChannelIndicatorState;
}

interface RemoteReplicaIndicators {
  channels: Map<string, RemoteIndicator>;
  lastSeen: number;
}

/** replicaId -> that replica's last-heartbeat aggregate snapshot. */
const remote = new Map<string, RemoteReplicaIndicators>();

function remoteIndicator(channelId: string): ChannelIndicatorState | null {
  for (const r of remote.values()) {
    const entry = r.channels.get(channelId);
    if (entry) return entry.state;
  }
  return null;
}

/** Default lifetime of a set that is never refreshed. Comfortably longer than
 * the bridge's refresh interval, short enough that an abandoned spinner is a
 * blip rather than a permanent lie. */
export const DEFAULT_TTL_MS = 90_000;

/** Drop this channel's dead entries; returns the live ones (or undefined). */
function prune(channelId: string, now: number): Map<string, Entry> | undefined {
  const users = byChannel.get(channelId);
  if (!users) return undefined;
  for (const [userId, e] of users) if (e.expiresAt <= now) users.delete(userId);
  if (users.size === 0) {
    byChannel.delete(channelId);
    return undefined;
  }
  return users;
}

/** The channel's aggregate indicator — what clients render, merged across
 * replicas. Any live setter anywhere means the row spins; several agents at
 * once still show one spinner. */
export function channelIndicator(channelId: string, now = Date.now()): ChannelIndicatorState | null {
  const users = prune(channelId, now);
  if (users) for (const e of users.values()) return e.state;
  return remoteIndicator(channelId);
}

/** Aggregate state for many channels at once (the channel-list overlay). Only
 * channels with a live indicator appear in the returned map. */
export function channelIndicators(channelIds: string[], now = Date.now()): Map<string, ChannelIndicatorState> {
  const out = new Map<string, ChannelIndicatorState>();
  for (const id of channelIds) {
    const state = channelIndicator(id, now);
    if (state) out.set(id, state);
  }
  return out;
}

/**
 * Set (or refresh) one user's indicator in a channel. Returns the channel's
 * aggregate before and after, so the caller can publish an event only when the
 * visible state actually changed — a refresh every 30s must not spam the bus.
 */
export function setIndicator(
  channelId: string,
  workspaceId: string,
  userId: string,
  state: ChannelIndicatorState,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
): { before: ChannelIndicatorState | null; after: ChannelIndicatorState | null } {
  const before = channelIndicator(channelId, now);
  let users = byChannel.get(channelId);
  if (!users) {
    users = new Map();
    byChannel.set(channelId, users);
  }
  users.set(userId, { state, workspaceId, expiresAt: now + ttlMs });
  return { before, after: channelIndicator(channelId, now) };
}

/** Clear one user's indicator in a channel (no-op if they had none). */
export function clearIndicator(
  channelId: string,
  userId: string,
  now = Date.now(),
): { before: ChannelIndicatorState | null; after: ChannelIndicatorState | null } {
  const before = channelIndicator(channelId, now);
  byChannel.get(channelId)?.delete(userId);
  if (byChannel.get(channelId)?.size === 0) byChannel.delete(channelId);
  return { before, after: channelIndicator(channelId, now) };
}

export interface ChannelRef {
  channelId: string;
  workspaceId: string;
}

/** Clear every indicator this user set — the disconnect path. Returns the
 * channels whose aggregate went quiet as a result (nothing to publish for a
 * channel where another agent is still working). */
export function clearIndicatorsForUser(userId: string, now = Date.now()): ChannelRef[] {
  const cleared: ChannelRef[] = [];
  for (const [channelId, users] of [...byChannel]) {
    const entry = users.get(userId);
    if (!entry) continue;
    const { before, after } = clearIndicator(channelId, userId, now);
    if (before !== null && after === null) cleared.push({ channelId, workspaceId: entry.workspaceId });
  }
  return cleared;
}

/** Drop expired entries everywhere; returns the channels that just went quiet
 * so the sweeper can tell clients (nothing else would — an expiry has no
 * request behind it). Quiet means the *merged* aggregate is gone: a channel
 * still spinning via another replica is not announced quiet. */
export function sweepExpired(now = Date.now()): ChannelRef[] {
  const quieted: ChannelRef[] = [];
  for (const [channelId, users] of [...byChannel]) {
    const workspaceId = [...users.values()][0]?.workspaceId;
    if (!workspaceId) continue; // empty map — nothing was showing
    prune(channelId, now);
    // the channel key survives iff at least one local entry is still live
    if (!byChannel.has(channelId) && remoteIndicator(channelId) === null) {
      quieted.push({ channelId, workspaceId });
    }
  }
  return quieted;
}

// ---- distributed layer (phase 18 M2) — fed by presenceSync.ts ----

/** This replica's live aggregates, heartbeat-shaped. */
export function localIndicatorSnapshot(now = Date.now()): Record<string, RemoteIndicator> {
  const out: Record<string, RemoteIndicator> = {};
  for (const [channelId, users] of [...byChannel]) {
    const workspaceId = [...users.values()][0]?.workspaceId;
    if (!workspaceId) continue;
    const state = channelIndicatorLocal(channelId, now);
    if (state) out[channelId] = { workspaceId, state };
  }
  return out;
}

/** Local-only aggregate (snapshot building must not echo remote state back). */
function channelIndicatorLocal(channelId: string, now = Date.now()): ChannelIndicatorState | null {
  const users = prune(channelId, now);
  if (!users) return null;
  for (const e of users.values()) return e.state;
  return null;
}

/**
 * Absorb another replica's aggregate snapshot. Returns the channels the diff
 * turned quiet in the *merged* view — the origin replica's clearing event may
 * have been suppressed against a then-live view of us, so presenceSync's
 * elected emitter re-announces them (duplicate clears are idempotent).
 */
export function applyRemoteIndicators(
  replicaId: string,
  channels: Record<string, RemoteIndicator>,
  now = Date.now(),
): ChannelRef[] {
  const previous = remote.get(replicaId);
  const parsed = new Map<string, RemoteIndicator>(Object.entries(channels));
  remote.set(replicaId, { channels: parsed, lastSeen: now });
  if (!previous) return [];
  const quieted: ChannelRef[] = [];
  for (const [channelId, entry] of previous.channels) {
    if (parsed.has(channelId)) continue;
    if (channelIndicator(channelId, now) === null) quieted.push({ channelId, workspaceId: entry.workspaceId });
  }
  return quieted;
}

/** Drop remote replicas not heard from within `ttlMs` (a crash — its spinners
 * must not survive it). Returns the channels whose merged aggregate went
 * quiet, for the elected emitter to announce. */
export function expireRemoteIndicators(ttlMs: number, now = Date.now()): ChannelRef[] {
  const dropped: RemoteReplicaIndicators[] = [];
  for (const [replicaId, r] of remote) {
    if (now - r.lastSeen <= ttlMs) continue;
    remote.delete(replicaId);
    dropped.push(r);
  }
  const quieted: ChannelRef[] = [];
  const seen = new Set<string>();
  for (const r of dropped) {
    for (const [channelId, entry] of r.channels) {
      if (seen.has(channelId)) continue;
      seen.add(channelId);
      if (channelIndicator(channelId, now) === null) quieted.push({ channelId, workspaceId: entry.workspaceId });
    }
  }
  return quieted;
}

/** Tests only: forget everything, local and remote. */
export function resetIndicators(): void {
  byChannel.clear();
  remote.clear();
}
