// APNs delivery outbox (#247, PUSH_APNS.md § "Delivery: outbox, not
// fire-and-forget").
//
// Outbox pattern, same as the Events API (decision log 2026-07-18 ruling 3):
// pending_push rows are written in the SAME transaction as the notification
// row, then drained by the in-process worker below — at-least-once, surviving
// restarts. WS publish can afford to drop, because a client that reconnects
// backfills over REST; a phone with no socket has nothing to backfill from, so
// a dropped push is a notification the user never learns about.
//
// `services/appEvents.ts` is the model, deliberately down to the constants:
// MAX_ATTEMPTS, the 5s/20s/80s backoff, the FOR UPDATE SKIP LOCKED claim with a
// lease, and the auto-disable-on-sustained-failure behaviour.
//
// ONE ROW PER NOTIFICATION, not per device. The fan-out to a user's devices
// happens here, at send time: devices change between commit and delivery, and
// the badge count is computed once per notification instead of once per phone.
import { and, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { USER_MENTION_RE, type NotificationKind, type NotificationSubkind } from '@flow/shared';
import { db, schema, type Tx } from '../db/index.js';
import { decryptBody } from '../crypto/index.js';
import { newId } from '../lib/ids.js';
import { sendPush, pushSender, type ApnsHeaders, type ApnsPayload, type PushDevice } from '../push/index.js';
import {
  buildMutedBadgePayload,
  buildPushPayload,
  pushHeadersFor,
  type ChannelKind,
  type PushContext,
} from '../push/payload.js';
import { noteAlertPush } from './badgeSync.js';
import { suppressAlertFor, unreadCount, type AlertContext } from './notifications.js';

const { channelMembers, channels, deviceTokens, messages, notifications, pendingPush, users } = schema;

/** 1 initial + 3 retries, same as the Events API outbox. */
const MAX_ATTEMPTS = 4;
/** Consecutive permanently-failed pushes for one user before their devices are
 * disabled — the appEvents `AUTO_DISABLE_AFTER` analogue. */
const AUTO_DISABLE_AFTER = 5;
/** Rows claimed per drain pass. */
const BATCH = 20;
/** How long a claimed row is invisible to other drains. A batch's sends finish
 * well inside this; the lease only matters when a replica dies mid-batch, and
 * then its rows retry this soon with no attempts consumed. */
const CLAIM_LEASE_MS = 120_000;

// ---- enqueue (same-transaction) ---------------------------------

/** A notification that wants a push: whose it is, and which row it came from. */
export interface PushIntent {
  userId: string;
  notificationId: string;
}

/**
 * Enqueue pushes inside the notification's own transaction.
 *
 * Users with no live device are skipped here — the `eligibleApps` move from
 * appEvents, and the reason is the same: an outbox row nobody can receive is
 * pure write amplification. This is an eligibility check, not the fan-out: the
 * *devices* are still resolved at send time, so a phone registered between
 * commit and delivery still gets the push.
 */
export async function enqueuePendingPush(tx: Tx, intents: PushIntent[]): Promise<void> {
  if (intents.length === 0) return;
  const userIds = [...new Set(intents.map((i) => i.userId))];
  const live = await tx
    .selectDistinct({ userId: deviceTokens.userId })
    .from(deviceTokens)
    .where(and(inArray(deviceTokens.userId, userIds), isNull(deviceTokens.disabledAt)));
  const hasDevice = new Set(live.map((r) => r.userId));
  const rows = intents.filter((i) => hasDevice.has(i.userId));
  if (rows.length === 0) return;
  await tx.insert(pendingPush).values(
    rows.map((i) => ({ id: newId(), userId: i.userId, notificationId: i.notificationId })),
  );
}

// ---- hydration for the payload builder (#248) --------------------

/** The columns the drain reads per notification, before decryption. */
type CtxRow = {
  notificationId: string;
  workspaceId: string;
  channelId: string;
  /** Whose notification it is — the DM subtitle is named from their side (#460). */
  recipientId: string;
  channelName: string | null;
  channelKind: ChannelKind;
  messageId: string;
  threadRootId: string | null;
  kind: number;
  /** Which mention variant fired, for the alert gate. Null on legacy rows. */
  subkind: string | null;
  reactionEmoji: string | null;
  actorId: string | null;
  authorId: string;
  deletedAt: Date | null;
  body: Buffer;
  bodyNonce: Buffer;
  encKeyId: string;
  encScheme: number;
};

/**
 * Rows → what the payload builder needs, with every display name the batch's
 * titles and bodies want fetched in one query: the actors, plus whoever the
 * bodies mention.
 *
 * The Mac loads the whole (cached, small) user table to render mention tokens;
 * a server that speaks for every workspace cannot, so the tokens are parsed
 * out of the bodies first and only those ids are fetched. Unknown ids still
 * render "@someone", exactly as they do there. A deleted message pushes no
 * preview — `toMessageDTO` blanks it the same way.
 *
 * The subtitle's name (#460) rides the same query: a DM has no `name` column,
 * so its members are read here and their display names join the ids the users
 * lookup was already going to fetch.
 */
export async function hydratePushContexts(rows: CtxRow[]): Promise<Map<string, PushContext>> {
  const bodies = new Map(rows.map((r) => [r.notificationId, r.deletedAt ? '' : decryptBody(r)]));
  const dmChannelIds = [...new Set(rows.filter((r) => r.channelKind !== 'standard').map((r) => r.channelId))];
  const dmMembers = dmChannelIds.length
    ? await db
        .select({ channelId: channelMembers.channelId, userId: channelMembers.userId })
        .from(channelMembers)
        .where(inArray(channelMembers.channelId, dmChannelIds))
    : [];
  const membersByChannel = new Map<string, string[]>();
  for (const m of dmMembers) membersByChannel.set(m.channelId, [...(membersByChannel.get(m.channelId) ?? []), m.userId]);

  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.actorId ?? r.authorId);
    for (const m of (bodies.get(r.notificationId) ?? '').matchAll(USER_MENTION_RE)) ids.add(m[1]!);
  }
  for (const m of dmMembers) ids.add(m.userId);
  const found = ids.size
    ? await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, [...ids]))
    : [];
  const names = Object.fromEntries(found.map((u) => [u.id, u.displayName]));
  return new Map(
    rows.map((r) => [
      r.notificationId,
      {
        notificationId: r.notificationId,
        workspaceId: r.workspaceId,
        channelId: r.channelId,
        messageId: r.messageId,
        threadRootId: r.threadRootId,
        kind: r.kind as NotificationKind,
        actorName: names[r.actorId ?? r.authorId] ?? null,
        reactionEmoji: r.reactionEmoji,
        body: bodies.get(r.notificationId) ?? '',
        names,
        channelKind: r.channelKind,
        conversationName:
          r.channelKind === 'standard'
            ? r.channelName
            : dmName(membersByChannel.get(r.channelId) ?? [], r.recipientId, names),
        soloDmWithActor:
          r.channelKind === 'dm'
          && isSoloDmWithActor(membersByChannel.get(r.channelId) ?? [], r.recipientId, r.actorId ?? r.authorId),
      },
    ]),
  );
}

/**
 * What a DM or group DM calls itself *to this recipient*: the other members'
 * display names, sorted and joined — the server-side port of the web client's
 * `dmTitle` (`packages/web/src/lib/channelTitle.ts`), so the subtitle on the
 * phone matches the row the sidebar shows it under. A DM whose only member is
 * you is the persistent self-DM, and reads the way it does there.
 */
function dmName(memberIds: string[], recipientId: string, names: Record<string, string>): string | null {
  const others = counterparts(memberIds, recipientId);
  if (others.length === 0) return memberIds.length ? `${names[recipientId] ?? 'You'} (you)` : null;
  return others.map((id) => names[id] ?? 'Unknown').sort().join(', ');
}

/**
 * Whether this DM's only counterpart is the person the title already names
 * (the #460 ruling — see `subtitleFor`). Decided on ids, so it holds however
 * the title happens to be phrased, and two people who share a display name
 * cannot collapse into one.
 */
function isSoloDmWithActor(memberIds: string[], recipientId: string, actorId: string): boolean {
  const others = counterparts(memberIds, recipientId);
  // The self-DM has no counterpart but you; if you are also the actor, the
  // subtitle repeats the title there too.
  const speakers = others.length ? others : memberIds.filter((id) => id === recipientId);
  return speakers.length === 1 && speakers[0] === actorId;
}

/** The members of a DM other than whoever is being pushed. */
function counterparts(memberIds: string[], recipientId: string): string[] {
  return memberIds.filter((id) => id !== recipientId);
}

/**
 * Whether this push must not ring (#251).
 *
 * Until now the outbox pushed every notification row it was handed, so the
 * per-user prefs and the DND status gated banners on web and macOS while the
 * phone in the same pocket rang anyway — the one client where "mute reactions"
 * matters most was the one that ignored it. Same function the REST list and
 * the WS fan-out use, so the three cannot drift.
 *
 * Read at SEND time, not enqueue time: prefs and status are exactly the kind of
 * thing someone changes in the seconds before the push goes out, and the value
 * that should decide is the one they hold when the phone would ring.
 */
export function mutedFor(row: { kind: number; subkind: string | null }, ctx: AlertContext): boolean {
  return suppressAlertFor(
    row.kind as NotificationKind,
    (row.subkind as NotificationSubkind | null) ?? null,
    ctx,
  );
}

// ---- delivery worker --------------------------------------------

interface Logger {
  info(o: unknown, msg?: string): void;
  warn(o: unknown, msg?: string): void;
}

/**
 * One drain pass. Exported for tests/QA; the interval loop calls it. Returns
 * the number of rows resolved as delivered.
 *
 * Rows are claimed with `FOR UPDATE SKIP LOCKED` in a short transaction that
 * pushes `nextAttemptAt` forward as a lease, so two replicas draining is
 * throughput rather than double delivery. Sending happens outside that
 * transaction; the success/backoff writes below overwrite the lease.
 */
export async function drainPendingPush(log: Logger): Promise<number> {
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(pendingPush)
      .where(
        and(
          isNull(pendingPush.deliveredAt),
          isNull(pendingPush.failedAt),
          lte(pendingPush.nextAttemptAt, new Date()),
        ),
      )
      .orderBy(pendingPush.id)
      .limit(BATCH)
      .for('update', { skipLocked: true });
    if (rows.length > 0) {
      await tx
        .update(pendingPush)
        .set({ nextAttemptAt: new Date(Date.now() + CLAIM_LEASE_MS) })
        .where(
          inArray(
            pendingPush.id,
            rows.map((r) => r.id),
          ),
        );
    }
    return rows;
  });
  if (claimed.length === 0) return 0;

  // Notification context and devices are both read HERE, not at enqueue: this
  // is the send-time fan-out the one-row-per-notification shape exists for.
  // The message body comes along encrypted and is decrypted below (#248), the
  // same way every read path does it.
  const ctxRows = await db
    .select({
      notificationId: notifications.id,
      workspaceId: channels.workspaceId,
      channelId: notifications.channelId,
      recipientId: notifications.userId,
      channelName: channels.name,
      channelKind: channels.kind,
      messageId: notifications.messageId,
      threadRootId: messages.threadRootId,
      kind: notifications.kind,
      subkind: notifications.subkind,
      reactionEmoji: notifications.reactionEmoji,
      // #251: the recipient's alert prefs ride the query that was already
      // joining for the payload, so honouring them costs no extra round trip.
      prefs: users.notificationPrefs,
      statusSuppressAlerts: users.statusSuppressAlerts,
      // Legacy rows carry no actor — the author was it (listNotifications does
      // the same fallback).
      actorId: notifications.actorId,
      authorId: messages.userId,
      deletedAt: messages.deletedAt,
      body: messages.body,
      bodyNonce: messages.bodyNonce,
      encKeyId: messages.encKeyId,
      encScheme: messages.encScheme,
    })
    .from(notifications)
    .innerJoin(messages, eq(messages.id, notifications.messageId))
    .innerJoin(channels, eq(channels.id, notifications.channelId))
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(inArray(notifications.id, [...new Set(claimed.map((r) => r.notificationId))]));
  const ctxById = await hydratePushContexts(ctxRows);
  /** notificationId → does this one ring, and does it make a sound (#251). */
  const gateById = new Map(
    ctxRows.map((r) => [
      r.notificationId,
      {
        muted: mutedFor(r, { prefs: r.prefs, statusSuppressAlerts: r.statusSuppressAlerts }),
        sound: r.prefs.sound !== false,
      },
    ]),
  );

  const deviceRows = await db
    .select()
    .from(deviceTokens)
    .where(
      and(
        inArray(deviceTokens.userId, [...new Set(claimed.map((r) => r.userId))]),
        isNull(deviceTokens.disabledAt),
      ),
    );
  const devicesByUser = new Map<string, (typeof deviceRows)[number][]>();
  for (const d of deviceRows) devicesByUser.set(d.userId, [...(devicesByUser.get(d.userId) ?? []), d]);

  const sender = pushSender();
  let delivered = 0;
  for (const row of claimed) {
    const ctx = ctxById.get(row.notificationId);
    if (!ctx) {
      // The notification went away between claim and read (a hard-deleted
      // message cascades). Nothing to push, and no retry would find it.
      await resolve(row.id, { failed: false });
      continue;
    }
    const devices = devicesByUser.get(row.userId) ?? [];
    if (devices.length === 0) {
      // Every device unregistered since enqueue. Nothing owed, so the row is
      // done — a retry would find the same nothing.
      await resolve(row.id, { failed: false });
      delivered += 1;
      continue;
    }

    // Once per notification — the whole point of not having a row per device.
    const badge = await unreadCount(row.userId);
    // A muted kind (or a DND status) still owes the phone its badge — it just
    // owes it silently. See `buildMutedBadgePayload`.
    const gate = gateById.get(row.notificationId) ?? { muted: false, sound: true };
    const payload = gate.muted ? buildMutedBadgePayload(badge) : buildPushPayload(ctx, badge, gate.sound);
    const headers = pushHeadersFor(ctx, gate.muted);

    let anyOk = false;
    let anyRetryable = false;
    for (const device of devices) {
      const result = await send(sender, device, payload, headers);
      if (result.ok) {
        anyOk = true;
        continue;
      }
      if (result.disableDevice) {
        // APNs 410 / BadDeviceToken, FCM UNREGISTERED: the app is gone or the token rotated.
        // Kept, not deleted — the next cold start's register revives the row.
        await db
          .update(deviceTokens)
          .set({ disabledAt: new Date() })
          .where(eq(deviceTokens.id, device.id));
        log.info({ deviceId: device.id, reason: result.reason }, 'push device disabled by the push service');
      } else if (result.retryable) {
        anyRetryable = true;
      } else {
        log.warn({ notificationId: row.notificationId, reason: result.reason }, 'push permanently rejected');
      }
    }

    if (anyOk) {
      // At-least-once is per notification, not per device: one phone that took
      // it is enough, and retrying the row would re-deliver to that phone.
      // A delivered alert already carries the current count, so a badge-sync
      // queued for this user has nothing left to say (PUSH_APNS.md § "Silent
      // pushes keep the badge honest"). Noted only on success: an alert that
      // never landed has silenced nothing.
      noteAlertPush(row.userId, badge);
      delivered += 1;
      await resolve(row.id, { failed: false });
      continue;
    }
    const attempts = row.attempts + 1;
    if (anyRetryable && attempts < MAX_ATTEMPTS) {
      const delayMs = 5_000 * Math.pow(4, attempts - 1); // 5s, 20s, 80s
      await db
        .update(pendingPush)
        .set({ attempts, nextAttemptAt: new Date(Date.now() + delayMs) })
        .where(eq(pendingPush.id, row.id));
      continue;
    }
    await db
      .update(pendingPush)
      .set({ failedAt: new Date(), attempts })
      .where(eq(pendingPush.id, row.id));
    await maybeAutoDisable(row.userId, log);
  }
  return delivered;
}

/** Mark a claimed row resolved — the lease it holds is overwritten either way.
 *
 * The two nothing-to-do cases above resolve as *delivered*, where appEvents
 * uses `failedAt` for its equivalent (a deleted app row). Deliberate: the
 * sustained-failure streak below is keyed on the user, so counting "this user's
 * message was deleted" as a failure would eventually silence a phone that
 * nothing is actually wrong with. appEvents keys its streak on the app whose
 * endpoint is the thing being judged, so it has no such confusion to avoid. */
async function resolve(id: string, opts: { failed: boolean }): Promise<void> {
  await db
    .update(pendingPush)
    .set(opts.failed ? { failedAt: new Date() } : { deliveredAt: new Date() })
    .where(eq(pendingPush.id, id));
}

/** A driver that throws is a transient outage, not a rejected push. */
async function send(
  sender: ReturnType<typeof pushSender>,
  device: PushDevice,
  payload: ApnsPayload,
  headers: ApnsHeaders,
): Promise<{ ok: true } | { ok: false; reason: string; retryable: boolean; disableDevice: boolean }> {
  try {
    const r = await sendPush(sender, device, payload, headers);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason, retryable: r.retryable, disableDevice: r.disableDevice };
  } catch (err) {
    return { ok: false, reason: String(err), retryable: true, disableDevice: false };
  }
}

/**
 * Sustained failure → stop pushing to this user's devices (the appEvents
 * auto-disable analogue, where it clears `eventUrlVerifiedAt`).
 *
 * Unlike an app endpoint this is self-healing and needs no operator: the iOS
 * client re-registers on every cold start and `registerDevice` clears
 * `disabled_at`, so the phone that comes back gets pushes again.
 */
async function maybeAutoDisable(userId: string, log: Logger): Promise<void> {
  const recent = await db
    .select({ failedAt: pendingPush.failedAt })
    .from(pendingPush)
    .where(eq(pendingPush.userId, userId))
    .orderBy(desc(pendingPush.id))
    .limit(AUTO_DISABLE_AFTER);
  if (recent.length < AUTO_DISABLE_AFTER || !recent.every((r) => r.failedAt !== null)) return;
  const disabled = await db
    .update(deviceTokens)
    .set({ disabledAt: new Date() })
    .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.disabledAt)))
    .returning({ id: deviceTokens.id });
  if (disabled.length > 0) {
    log.warn({ userId, devices: disabled.length }, 'push delivery auto-disabled after sustained failure');
  }
}

let workerTimer: ReturnType<typeof setInterval> | null = null;

export function startPushWorker(log: Logger): void {
  if (workerTimer) return;
  // Build the driver once at boot so a half-configured `apns` deploy says so
  // here, next to the deploy that caused it, instead of at whatever hour the
  // first notification happens to fire (#250).
  try {
    pushSender();
  } catch (err) {
    log.warn(err, 'push driver is misconfigured — no push will be delivered');
  }
  const tick = async () => {
    try {
      await drainPendingPush(log);
    } catch (err) {
      log.warn(err, 'push outbox drain failed');
    }
  };
  workerTimer = setInterval(tick, 1_000);
  workerTimer.unref();
  void tick();
}

/** Tests only: let a suite stop the interval it started. */
export function _stopPushWorkerForTests(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}
