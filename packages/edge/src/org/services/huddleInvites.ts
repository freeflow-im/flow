// DM huddle invites (#436) — the ring, its timeout, and the transcript line it
// leaves behind.
//
// A huddle in a *channel* is ambient: you see it in the sidebar and drop in.
// A huddle in a *DM* is a call — starting one rings the other member(s), and
// the DM has to show afterwards that it happened, whether or not anyone
// answered. That difference is the whole of this module: services/huddles.ts
// still owns the LiveKit room and the roster, and calls in here only when the
// entity is a DM or group DM.
//
// **Track A only.** "Reachable" means *a live socket right now* — there is no
// push, so a closed tab or a backgrounded iPhone is simply unavailable and the
// call is missed instantly. That is a deliberate, temporary shape (Track B
// adds APNs/PushKit/Web Push later); it is why `unavailable` is a distinct
// target status from `missed`, and why the caller is told which names could
// not be reached rather than being left to watch a ring that will never land.
//
// State lives in Postgres (`huddle_invites` + `huddle_invite_targets`) so a
// missed call survives a restart, with exactly one piece of process-local
// state: the 30s timers. Timers cannot survive a restart, so `sweepStaleOnBoot`
// resolves any invite still marked `ringing` at startup — the alternative,
// leaving a row ringing forever, would show a phantom incoming call to
// everyone who reconnects.
import { and, eq, inArray } from 'drizzle-orm';
import type {
  HuddleInviteDTO,
  HuddleInviteStatus,
  HuddleInviteTargetStatus,
  HuddleInviteData,
} from '@flow/shared';
import { db, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { publishEvent, subjectUserNotify } from '../bus.js';
import { hasAnyConnection } from '../presence.js';
import * as store from '../huddles.js';
import { postHuddleSystemMessage } from './messages.js';

const { huddleInvites, huddleInviteTargets, channelMembers, channels, users } = schema;

/** Spec (#436): 30 seconds of ringing, then it's a missed call. */
export const RING_TIMEOUT_MS = Number(process.env.FLOW_HUDDLE_RING_MS ?? 30_000);

type ChannelRow = typeof channels.$inferSelect;
type InviteRow = typeof huddleInvites.$inferSelect;
type TargetRow = typeof huddleInviteTargets.$inferSelect;

/** inviteId -> its ring timer. Process-local by nature; see the module doc. */
const timers = new Map<string, NodeJS.Timeout>();

function clearTimer(inviteId: string): void {
  const t = timers.get(inviteId);
  if (t) {
    clearTimeout(t);
    timers.delete(inviteId);
  }
}

function toDTO(invite: InviteRow, targets: TargetRow[]): HuddleInviteDTO {
  return {
    id: invite.id,
    workspaceId: invite.workspaceId,
    channelId: invite.channelId,
    startedBy: invite.startedBy,
    status: invite.status as HuddleInviteStatus,
    startedAt: invite.startedAt.toISOString(),
    answeredAt: invite.answeredAt?.toISOString() ?? null,
    endedAt: invite.endedAt?.toISOString() ?? null,
    targets: targets.map((t) => ({
      userId: t.userId,
      status: t.status as HuddleInviteTargetStatus,
      respondedAt: t.respondedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Fan the invite out on the notify subject of everyone it concerns — the
 * caller and every target. One event type for "you're being rung" and "the
 * ring resolved": clients decide from `invite.status` plus their own target
 * row (see HuddleInviteData), which is what makes a second device dismiss its
 * overlay when the first one answers, with no extra plumbing.
 */
function publishInvite(dto: HuddleInviteDTO, extra?: Omit<HuddleInviteData, 'invite'>): void {
  const recipients = new Set<string>([dto.startedBy, ...dto.targets.map((t) => t.userId)]);
  for (const userId of recipients) {
    const data: HuddleInviteData = {
      invite: dto,
      ...(extra?.answeredBySessionId ? { answeredBySessionId: extra.answeredBySessionId } : {}),
      // The unreachable-names list is the caller's "X isn't available" text;
      // nobody else has any use for it.
      ...(userId === dto.startedBy && extra?.unavailable?.length ? { unavailable: extra.unavailable } : {}),
    };
    publishEvent(subjectUserNotify(userId), {
      type: 'huddle.invite',
      workspaceId: dto.workspaceId,
      channelId: dto.channelId,
      ts: new Date().toISOString(),
      data,
    });
  }
}

async function loadTargets(inviteId: string): Promise<TargetRow[]> {
  return db.select().from(huddleInviteTargets).where(eq(huddleInviteTargets.inviteId, inviteId));
}

async function loadInvite(inviteId: string): Promise<{ invite: InviteRow; targets: TargetRow[] } | null> {
  const rows = await db.select().from(huddleInvites).where(eq(huddleInvites.id, inviteId)).limit(1);
  const invite = rows[0];
  if (!invite) return null;
  return { invite, targets: await loadTargets(inviteId) };
}

/** The DM's live invite, if any — one call per entity, same rule as the room. */
async function liveInviteFor(channelId: string): Promise<InviteRow | undefined> {
  const rows = await db
    .select()
    .from(huddleInvites)
    .where(and(eq(huddleInvites.channelId, channelId), inArray(huddleInvites.status, ['ringing', 'active'])));
  return rows[0];
}

/**
 * Can this callee be rung right now? Four ways to be unavailable, all of which
 * the spec treats identically (instant miss, caller told immediately):
 *   - no live socket anywhere (Track A's hard limit),
 *   - Do Not Disturb (`statusSuppressAlerts`),
 *   - this DM muted (`notifyLevel` 0) — muting a conversation mutes its calls,
 *   - already in *another DM* huddle (busy). A *channel* huddle does not make
 *     you busy: the ring still shows, and accepting drops you out of it.
 */
async function reachability(
  chan: ChannelRow,
  userIds: string[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (userIds.length === 0) return out;

  const dnd = new Map(
    (await db.select({ id: users.id, suppress: users.statusSuppressAlerts }).from(users).where(inArray(users.id, userIds)))
      .map((r) => [r.id, r.suppress]),
  );
  const levels = new Map(
    (
      await db
        .select({ userId: channelMembers.userId, notifyLevel: channelMembers.notifyLevel })
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, chan.id), inArray(channelMembers.userId, userIds)))
    ).map((r) => [r.userId, r.notifyLevel]),
  );
  // One query for every DM the busy check might name, rather than one per callee.
  const busyChannelIds = new Set<string>();
  const activeChannelByUser = new Map<string, string>();
  for (const userId of userIds) {
    const active = store.activeHuddleChannelForUser(userId);
    if (active) {
      activeChannelByUser.set(userId, active);
      busyChannelIds.add(active);
    }
  }
  const dmChannelIds = new Set(
    busyChannelIds.size > 0
      ? (
          await db
            .select({ id: channels.id, kind: channels.kind })
            .from(channels)
            .where(inArray(channels.id, [...busyChannelIds]))
        )
          .filter((c) => c.kind !== 'standard')
          .map((c) => c.id)
      : [],
  );

  for (const userId of userIds) {
    const active = activeChannelByUser.get(userId);
    const busy = active !== undefined && active !== chan.id && dmChannelIds.has(active);
    const reachable =
      hasAnyConnection(userId) && dnd.get(userId) !== true && levels.get(userId) !== 0 && !busy;
    out.set(userId, reachable);
  }
  return out;
}

async function displayNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, userIds));
  return new Map(rows.map((r) => [r.id, r.displayName]));
}

function minutesLabel(seconds: number): string {
  if (seconds < 60) return `${Math.max(seconds, 1)} sec`;
  const mins = Math.round(seconds / 60);
  return `${mins} min`;
}

/**
 * Close an invite out: terminal status, and the one transcript line the DM
 * keeps. `ended` is the only outcome with a duration, since it is the only one
 * where a call actually happened.
 */
async function finalize(
  invite: InviteRow,
  status: Extract<HuddleInviteStatus, 'ended' | 'declined' | 'missed' | 'cancelled'>,
  now = new Date(),
): Promise<void> {
  clearTimer(invite.id);
  const durationSeconds =
    status === 'ended' && invite.answeredAt
      ? Math.max(0, Math.round((now.getTime() - invite.answeredAt.getTime()) / 1000))
      : null;

  // Every still-ringing target of a finished call missed it.
  await db
    .update(huddleInviteTargets)
    .set({ status: 'missed', respondedAt: now })
    .where(and(eq(huddleInviteTargets.inviteId, invite.id), eq(huddleInviteTargets.status, 'ringing')));

  const updated = (
    await db
      .update(huddleInvites)
      .set({ status, endedAt: now, durationSeconds })
      .where(and(eq(huddleInvites.id, invite.id), inArray(huddleInvites.status, ['ringing', 'active'])))
      .returning()
  )[0];
  if (!updated) return; // someone else finalized it first — don't double-post

  const chan = (await db.select().from(channels).where(eq(channels.id, invite.channelId)).limit(1))[0];
  if (chan) {
    // "Cancelled" is not its own line: from the callee's side a caller who
    // hung up before they could answer is exactly a missed call, and that is
    // the reading the DM should keep.
    const body =
      status === 'ended'
        ? `Call ended · ${minutesLabel(durationSeconds ?? 0)}`
        : status === 'declined'
          ? 'Call declined'
          : 'Missed huddle';
    const kind = status === 'ended' ? 'huddle_ended' : status === 'declined' ? 'huddle_declined' : 'huddle_missed';
    const posted = await postHuddleSystemMessage(chan, invite.startedBy, kind, body);
    if (posted) {
      await db.update(huddleInvites).set({ systemMessageId: posted.id }).where(eq(huddleInvites.id, invite.id));
    }
  }

  const targets = await loadTargets(invite.id);
  publishInvite(toDTO(updated, targets));
}

/** Arm the 30s ring timer (spec: no answer in 30s is a missed call). */
function armTimeout(inviteId: string): void {
  clearTimer(inviteId);
  const t = setTimeout(() => {
    timers.delete(inviteId);
    void (async () => {
      const loaded = await loadInvite(inviteId);
      // Only a still-*ringing* invite times out. One that reached `active`
      // (someone accepted) now ends when the room empties, not on a clock.
      if (loaded && loaded.invite.status === 'ringing') await finalize(loaded.invite, 'missed');
    })().catch((err) => console.error('huddle ring timeout failed', { inviteId, err }));
  }, RING_TIMEOUT_MS);
  // A ring must never hold the process open at shutdown.
  t.unref?.();
  timers.set(inviteId, t);
}

/**
 * Start (or join) a DM huddle's ring. Called from services/huddles.ts's join
 * path, only for DM/group-DM entities.
 *
 * Joining a DM huddle that is already ringing or active does *not* ring again
 * — that is the callee accepting, or a late joiner in a group DM. Only a
 * genuinely new call creates an invite.
 */
export async function startOrJoinRing(
  chan: ChannelRow,
  callerId: string,
): Promise<{ invite: HuddleInviteDTO | null; unavailable: string[] }> {
  const existing = await liveInviteFor(chan.id);
  if (existing) {
    // A target joining the room *is* an accept — the client normally calls
    // accept explicitly, but a plain join must not leave them stuck ringing.
    await markAnswered(existing, callerId);
    const loaded = await loadInvite(existing.id);
    return { invite: loaded ? toDTO(loaded.invite, loaded.targets) : null, unavailable: [] };
  }

  const memberRows = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(eq(channelMembers.channelId, chan.id));
  const callees = memberRows.map((r) => r.userId).filter((id) => id !== callerId);
  // A "DM" with only you in it (your own notes) has nobody to ring; it behaves
  // like an ambient huddle rather than a call that instantly misses itself.
  if (callees.length === 0) return { invite: null, unavailable: [] };

  const reachable = await reachability(chan, callees);
  const now = new Date();
  const inviteId = newId();
  const anyReachable = callees.some((id) => reachable.get(id));

  const [invite] = await db
    .insert(huddleInvites)
    .values({
      id: inviteId,
      workspaceId: chan.workspaceId,
      channelId: chan.id,
      startedBy: callerId,
      status: 'ringing',
      startedAt: now,
    })
    .returning();
  if (!invite) return { invite: null, unavailable: [] };

  await db.insert(huddleInviteTargets).values(
    callees.map((userId) => ({
      inviteId,
      userId,
      status: (reachable.get(userId) ? 'ringing' : 'unavailable') as HuddleInviteTargetStatus,
      respondedAt: reachable.get(userId) ? null : now,
    })),
  );

  const names = await displayNames(callees.filter((id) => !reachable.get(id)));
  const unavailable = [...names.values()];

  if (!anyReachable) {
    // Nobody could be rung: the call is over before it began. The caller is
    // still connected to the room at this point — their client shows "X isn't
    // available" and leaves.
    publishInvite(toDTO(invite, await loadTargets(inviteId)), { unavailable });
    await finalize(invite, 'missed', now);
    // Re-read: finalize() moved the row to `missed`, and the caller's client
    // keys "X isn't available, we're done here" off the status it gets back.
    const resolved = await loadInvite(inviteId);
    return { invite: resolved ? toDTO(resolved.invite, resolved.targets) : null, unavailable };
  }

  armTimeout(inviteId);
  const dto = toDTO(invite, await loadTargets(inviteId));
  publishInvite(dto, { unavailable });
  return { invite: dto, unavailable };
}

/** Flip one target to accepted and, on the first accept, the invite to active. */
async function markAnswered(invite: InviteRow, userId: string, sessionId?: string): Promise<void> {
  const now = new Date();
  const updatedTarget = (
    await db
      .update(huddleInviteTargets)
      .set({ status: 'accepted', respondedAt: now })
      .where(
        and(
          eq(huddleInviteTargets.inviteId, invite.id),
          eq(huddleInviteTargets.userId, userId),
          eq(huddleInviteTargets.status, 'ringing'),
        ),
      )
      .returning()
  )[0];
  if (!updatedTarget) return; // not a target, or already answered — nothing to announce

  // First accept makes the call real and stops the 30s clock; later accepts in
  // a group DM are ordinary late joins.
  const activated = (
    await db
      .update(huddleInvites)
      .set({ status: 'active', answeredAt: now })
      .where(and(eq(huddleInvites.id, invite.id), eq(huddleInvites.status, 'ringing')))
      .returning()
  )[0];
  if (activated) clearTimer(invite.id);

  const loaded = await loadInvite(invite.id);
  if (loaded) publishInvite(toDTO(loaded.invite, loaded.targets), sessionId ? { answeredBySessionId: sessionId } : undefined);
}

/**
 * Accept a ring. Returns the invite so the caller (routes) can then mint a
 * token through the ordinary join path — accepting is joining, and there is no
 * second way into the room.
 */
export async function acceptInvite(inviteId: string, userId: string, sessionId?: string): Promise<InviteRow | null> {
  const loaded = await loadInvite(inviteId);
  if (!loaded) return null;
  if (loaded.invite.status !== 'ringing' && loaded.invite.status !== 'active') return null;
  await markAnswered(loaded.invite, userId, sessionId);
  return loaded.invite;
}

/**
 * Decline a ring. In a group DM one decline is not the end of the call —
 * others may still be ringing — so the invite only finalizes when *every*
 * target has said no.
 */
export async function declineInvite(inviteId: string, userId: string, sessionId?: string): Promise<void> {
  const loaded = await loadInvite(inviteId);
  if (!loaded || loaded.invite.status !== 'ringing') return;
  const now = new Date();
  const updated = (
    await db
      .update(huddleInviteTargets)
      .set({ status: 'declined', respondedAt: now })
      .where(
        and(
          eq(huddleInviteTargets.inviteId, inviteId),
          eq(huddleInviteTargets.userId, userId),
          eq(huddleInviteTargets.status, 'ringing'),
        ),
      )
      .returning()
  )[0];
  if (!updated) return;

  const targets = await loadTargets(inviteId);
  if (targets.some((t) => t.status === 'ringing')) {
    publishInvite(toDTO(loaded.invite, targets), sessionId ? { answeredBySessionId: sessionId } : undefined);
    return;
  }
  await finalize(loaded.invite, targets.some((t) => t.status === 'declined') ? 'declined' : 'missed', now);
}

/**
 * The caller backed out before anyone accepted. Recorded `cancelled`, but the
 * DM line reads "Missed huddle" — see finalize().
 */
export async function cancelInvite(inviteId: string, callerId: string): Promise<void> {
  const loaded = await loadInvite(inviteId);
  if (!loaded || loaded.invite.startedBy !== callerId || loaded.invite.status !== 'ringing') return;
  await finalize(loaded.invite, 'cancelled');
}

/**
 * The DM's huddle room emptied — end whatever invite is live for it. Called
 * from services/huddles.ts on every roster change that reaches zero, which
 * covers a clean leave, a dropped connection (LiveKit webhook) and a finished
 * room alike.
 *
 * A `ringing` invite whose caller left is a cancel; an `active` one is a
 * finished call with a duration.
 */
export async function endInviteForChannel(channelId: string): Promise<void> {
  const invite = await liveInviteFor(channelId);
  if (!invite) return;
  await finalize(invite, invite.status === 'active' ? 'ended' : 'cancelled');
}

/**
 * Boot sweep. Ring timers are the one piece of state this module keeps in
 * memory, so a restart leaves `ringing` rows with nothing to resolve them —
 * every reconnecting client would raise an overlay for a call that ended
 * whenever the old process died. `active` rows are left alone: the LiveKit
 * room outlives our process, and huddles.ts's own boot reconciliation decides
 * whether that call is still up.
 */
export async function sweepStaleOnBoot(): Promise<number> {
  const stale = await db.select().from(huddleInvites).where(eq(huddleInvites.status, 'ringing'));
  for (const invite of stale) await finalize(invite, 'missed');
  return stale.length;
}

/** Tests only: drop the pending ring timers. */
export function resetHuddleInviteTimers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
