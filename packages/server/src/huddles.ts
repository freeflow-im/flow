// Huddle roster on the Node server (the legacy AWS origin): an in-memory map
// of who is in a conversation's huddle. Huddles now run in Meet on the Worker
// (docs/specs/meetings.md phase 2), so this server never adds anyone; the map
// stays for leave and the replica roster sync (services/huddles.ts).
import type { HuddleParticipantDTO } from '@flow/shared';

interface Entry {
  workspaceId: string;
  joinedAt: number; // epoch ms
}

/** channelId -> userId -> entry. Room name is the channel id (1:1), so this
 * map's keys are exactly the set of channels with a live huddle. */
const byChannel = new Map<string, Map<string, Entry>>();

export interface HuddleParticipant {
  userId: string;
  joinedAt: number; // epoch ms
}

function toParticipants(users: Map<string, Entry> | undefined): HuddleParticipant[] {
  if (!users) return [];
  return [...users].map(([userId, e]) => ({ userId, joinedAt: e.joinedAt })).sort((a, b) => a.joinedAt - b.joinedAt);
}

export function toParticipantDTOs(participants: HuddleParticipant[]): HuddleParticipantDTO[] {
  return participants.map((p) => ({ userId: p.userId, joinedAt: new Date(p.joinedAt).toISOString() }));
}

/** The channel's current roster — what clients render. Empty when no huddle is live. */
export function huddleParticipants(channelId: string): HuddleParticipant[] {
  return toParticipants(byChannel.get(channelId));
}

/** Rosters for many channels at once (the channel-list overlay). Only
 * channels with a live huddle appear in the returned map. */
export function huddleParticipantsMany(channelIds: string[]): Map<string, HuddleParticipant[]> {
  const out = new Map<string, HuddleParticipant[]>();
  for (const id of channelIds) {
    const p = huddleParticipants(id);
    if (p.length) out.set(id, p);
  }
  return out;
}

/**
 * Add (or idempotently re-affirm) a user in a channel's huddle. A rejoin
 * (tab refresh, reconnect) keeps the original `joinedAt` — it's the same
 * presence, not a new one. Returns the roster before/after so the caller can
 * publish only on a real aggregate change.
 */
export function joinHuddle(
  channelId: string,
  workspaceId: string,
  userId: string,
  now = Date.now(),
): { before: HuddleParticipant[]; after: HuddleParticipant[] } {
  const before = huddleParticipants(channelId);
  let users = byChannel.get(channelId);
  if (!users) {
    users = new Map();
    byChannel.set(channelId, users);
  }
  const existing = users.get(userId);
  users.set(userId, { workspaceId, joinedAt: existing?.joinedAt ?? now });
  return { before, after: huddleParticipants(channelId) };
}

/** Drop one user from a channel's huddle (no-op if they weren't in it).
 * Carries the departing entry's workspaceId for the caller's event. */
export function leaveHuddle(
  channelId: string,
  userId: string,
): { before: HuddleParticipant[]; after: HuddleParticipant[]; workspaceId: string | undefined } {
  const users = byChannel.get(channelId);
  const before = toParticipants(users);
  const workspaceId = users?.get(userId)?.workspaceId;
  users?.delete(userId);
  if (users?.size === 0) byChannel.delete(channelId);
  return { before, after: huddleParticipants(channelId), workspaceId };
}

/** Wipe a whole channel's huddle. */
export function clearChannelHuddle(channelId: string): { before: HuddleParticipant[]; workspaceId: string | undefined } {
  const users = byChannel.get(channelId);
  const before = toParticipants(users);
  const workspaceId = users ? [...users.values()][0]?.workspaceId : undefined;
  byChannel.delete(channelId);
  return { before, workspaceId };
}

/**
 * Replace one channel's roster with a full roster (the replica sync's
 * `huddle.updated` events).
 * `participants: []` clears the channel entirely.
 */
export function reconcileChannel(
  channelId: string,
  workspaceId: string,
  participants: HuddleParticipant[],
): { before: HuddleParticipant[]; after: HuddleParticipant[] } {
  const before = huddleParticipants(channelId);
  if (participants.length === 0) {
    byChannel.delete(channelId);
  } else {
    const users = new Map<string, Entry>();
    for (const p of participants) users.set(p.userId, { workspaceId, joinedAt: p.joinedAt });
    byChannel.set(channelId, users);
  }
  return { before, after: huddleParticipants(channelId) };
}

/**
 * The entity whose huddle this user is currently in, or undefined. Drives the
 * busy rule (#436): a callee already in a *DM* huddle is unavailable, while a
 * callee in a *channel* huddle still gets the ring (accepting drops them from
 * it). Only the caller knows which kind the returned id is — this store never
 * looks at channel rows.
 */
export function activeHuddleChannelForUser(userId: string): string | undefined {
  for (const [channelId, users] of byChannel) {
    if (users.has(userId)) return channelId;
  }
  return undefined;
}

/** Every channel id with a live huddle right now (channel-list overlay input, tests). */
export function activeHuddleChannelIds(): string[] {
  return [...byChannel.keys()];
}

/** Tests only: forget everything. */
export function resetHuddles(): void {
  byChannel.clear();
}
