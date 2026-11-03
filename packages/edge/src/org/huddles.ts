// Voice huddle (Phase 1) — the roster of who's live in a channel's
// ambient audio call. See CONTEXT.md for the Huddle glossary entry and
// decision_log.md (2026-08-20) for the rulings behind this design.
//
// Unlike channelIndicators (../indicators.ts), this store is NOT the source of
// truth — LiveKit is. A participant's aliveness is a real RTC connection that
// LiveKit's own server already tracks and times out; this map is a cache of
// that, kept in sync by three writers:
//   1. REST join/leave (services/huddles.ts), the primary path,
//   2. the LiveKit webhook (participant_left / room_finished), the
//      reconciliation safety net for a client that vanished without calling
//      leave,
//   3. on Node, boot-time reconciliation against LiveKit's REST API, since a
//      server restart wiped its map while LiveKit's rooms kept running.
// There is deliberately no TTL sweep here (contrast channelIndicators):
// LiveKit's webhook already fires on a dead peer, so there's no "forgot to
// refresh" failure mode to guard against.
// On Workers the roster is a table in the organization's database, not a module-level map: an Org object is evicted
// from memory between requests (its sockets hibernate), and a map would forget every live huddle each time. The
// functions keep the Node signatures, synchronous, because the object's SQLite is.
import { sql } from 'drizzle-orm';
import type { HuddleParticipantDTO } from '@flow/shared';
import { db } from './db/index.js';

/** Created by the Org object on start (object.ts), beside its migrations. */
export const HUDDLE_ROSTER_DDL = 'CREATE TABLE IF NOT EXISTS _huddle_participants (channel_id TEXT NOT NULL, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (channel_id, user_id))';

interface Row { channel_id: string; user_id: string; workspace_id: string; joined_at: number }

const rows = (channelId: string): Row[] =>
  db.all<Row>(sql`SELECT * FROM _huddle_participants WHERE channel_id = ${channelId} ORDER BY joined_at, user_id`);

export interface HuddleParticipant {
  userId: string;
  joinedAt: number; // epoch ms
}

function toParticipants(list: Row[]): HuddleParticipant[] {
  return list.map((r) => ({ userId: r.user_id, joinedAt: r.joined_at }));
}

export function toParticipantDTOs(participants: HuddleParticipant[]): HuddleParticipantDTO[] {
  return participants.map((p) => ({ userId: p.userId, joinedAt: new Date(p.joinedAt).toISOString() }));
}

/** The channel's current roster — what clients render. Empty when no huddle is live. */
export function huddleParticipants(channelId: string): HuddleParticipant[] {
  return toParticipants(rows(channelId));
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
  db.run(sql`INSERT INTO _huddle_participants (channel_id, user_id, workspace_id, joined_at) VALUES (${channelId}, ${userId}, ${workspaceId}, ${now})
    ON CONFLICT (channel_id, user_id) DO UPDATE SET workspace_id = excluded.workspace_id`);
  return { before, after: huddleParticipants(channelId) };
}

/** Drop one user from a channel's huddle (no-op if they weren't in it).
 * Used by both the REST leave path and the webhook's `participant_left`
 * safety net — LiveKit's room name is the channel id, so both name the same
 * entry. Carries the departing entry's workspaceId, since a webhook caller
 * has no other way to know it. */
export function leaveHuddle(
  channelId: string,
  userId: string,
): { before: HuddleParticipant[]; after: HuddleParticipant[]; workspaceId: string | undefined } {
  const list = rows(channelId);
  const workspaceId = list.find((r) => r.user_id === userId)?.workspace_id;
  db.run(sql`DELETE FROM _huddle_participants WHERE channel_id = ${channelId} AND user_id = ${userId}`);
  return { before: toParticipants(list), after: huddleParticipants(channelId), workspaceId };
}

/** Wipe a whole channel's huddle — the webhook's `room_finished` safety net
 * (LiveKit itself says the room is gone, so every participant is gone). */
export function clearChannelHuddle(channelId: string): { before: HuddleParticipant[]; workspaceId: string | undefined } {
  const list = rows(channelId);
  db.run(sql`DELETE FROM _huddle_participants WHERE channel_id = ${channelId}`);
  return { before: toParticipants(list), workspaceId: list[0]?.workspace_id };
}

/**
 * Boot-time reconciliation: replace one channel's roster with LiveKit's real
 * participant list (LiveKit is the source of truth — see module doc).
 * `participants: []` clears the channel entirely.
 */
export function reconcileChannel(
  channelId: string,
  workspaceId: string,
  participants: HuddleParticipant[],
): { before: HuddleParticipant[]; after: HuddleParticipant[] } {
  const before = huddleParticipants(channelId);
  db.run(sql`DELETE FROM _huddle_participants WHERE channel_id = ${channelId}`);
  for (const p of participants) {
    db.run(sql`INSERT INTO _huddle_participants (channel_id, user_id, workspace_id, joined_at) VALUES (${channelId}, ${p.userId}, ${workspaceId}, ${p.joinedAt})`);
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
  return db.all<{ channel_id: string }>(sql`SELECT channel_id FROM _huddle_participants WHERE user_id = ${userId} ORDER BY joined_at LIMIT 1`)[0]?.channel_id;
}

/** Every channel id with a live huddle right now (channel-list overlay input, tests). */
export function activeHuddleChannelIds(): string[] {
  return db.all<{ channel_id: string }>(sql`SELECT DISTINCT channel_id FROM _huddle_participants`).map((r) => r.channel_id);
}

/** Tests only: forget everything. */
export function resetHuddles(): void {
  db.run(sql`DELETE FROM _huddle_participants`);
}
