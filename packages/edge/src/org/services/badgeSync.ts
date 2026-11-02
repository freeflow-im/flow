// Silent badge-sync pushes (#248, PUSH_APNS.md § "Silent pushes keep the badge
// honest").
//
// The counterpart to the alert push: read a mention on your laptop and the
// phone in your pocket should drop its badge. Every `notification.read` event
// already carries the fresh total, so this mirrors it to the user's devices as
// a background push — no alert, no sound, just the count, applied in
// `didReceiveRemoteNotification` without waking the UI.
//
// Deliberately NOT through `pending_push`. That outbox exists because a missed
// *notification* is one the user never learns about; a missed badge correction
// is self-healing — the next read or the next alert carries the current count,
// and the count is absolute rather than a delta. Durability would buy an
// at-least-once guarantee on a number that is stale by the time it is retried.
//
// Three suppressions, all because Apple meters background pushes on a per-app
// budget and an app that burns it stops getting them delivered at all:
//
//   1. THROTTLE — at most one per user per WINDOW_MS, trailing-edge, so a
//      sweep that reads forty rows one at a time sends one push, not forty.
//   2. REDUNDANCY — dropped outright when an alert push to the same user has
//      landed since this sync was queued. That alert carried a badge computed
//      after the read committed, so it is at least as fresh as anything this
//      sync could say. The spec asks only for the equal-count case; dropping on
//      any later alert is the same idea taken one step further, and it also
//      stops a coalesced sync from re-asserting a count the alert has since
//      moved past.
//   3. HOURLY BUDGET (#251) — at most BACKGROUND_PUSHES_PER_HOUR per user per
//      rolling hour. (1) bounds a burst and does nothing about an hour: at one
//      push per 30 s, a person working a busy workspace all morning spends 120
//      of them, and someone reading once every two minutes still spends 30 —
//      both an order of magnitude past what Apple will deliver. Measured, not
//      assumed: `test/badgeSyncBudget.test.ts` replays those profiles through
//      this module and counts. Over budget iOS delays or drops the pushes
//      itself, which is the same staleness this cap causes but chosen by
//      someone who cannot see which count matters — better to spend the
//      allowance deliberately.
//
// The cap HOLDS rather than drops: the newest count stays pending and goes out
// when the oldest send in the window ages out. A badge is absolute, so an hour
// of heavy reading owes the phone exactly one truthful number, and dropping
// would leave it owing nothing.
//
// The state is per process. With several replicas the throttle is per replica —
// acceptable, because a user's read requests are not sharded by user and Apple's
// own budget is the real backstop; a durable cross-replica throttle would cost
// a round trip per read to save a push nobody asked for.
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { sendPush, pushSender, type PushDevice } from '../push/index.js';
import { badgeSyncHeaders, buildBadgeSyncPayload } from '../push/payload.js';

const { deviceTokens } = schema;

/**
 * The two delays, in one mutable object so a test can shrink them to
 * milliseconds and still exercise real timers — faking the clock here would
 * fake it for the postgres driver too. Nothing in production writes to it.
 *
 * `windowMs`: at most one badge-sync per user per this long. Apple's guidance
 * is "a few per hour"; 30 s bounds a burst without letting a real read sit for
 * minutes.
 *
 * `settleMs`: how long the first sync in a quiet period waits before going out.
 * Not politeness — it is what makes suppression (2) above reachable. The outbox
 * worker ticks once a second, so a read that races an incoming mention would
 * otherwise send its silent push before the alert that renders it redundant.
 */
export const badgeSyncTiming = { windowMs: 30_000, settleMs: 2_000, budgetWindowMs: 3_600_000 };

/**
 * Background pushes one user's badge may cost per `budgetWindowMs` (#251).
 *
 * Apple documents the budget as "a few per hour" and never as a number, so
 * this is a judgement rather than a constant read off a spec: six spends it at
 * roughly one every ten minutes, which is frequent enough that a phone put
 * down after a read settles within minutes, and modest enough to leave room
 * for the same app's other background work. The measurements that motivated it
 * are in `test/badgeSyncBudget.test.ts`.
 */
export const BACKGROUND_PUSHES_PER_HOUR = 6;
/** Idle user state is dropped after this, so the maps don't grow with the user table. */
const IDLE_TTL_MS = 10 * 60_000;

interface UserState {
  /** Newest count owed, or null when nothing is pending. */
  pending: number | null;
  /** When `pending` was queued — the instant suppression (2) compares against. */
  queuedAt: number;
  /** Last badge-sync actually handed to the sender. */
  lastSentAt: number;
  /**
   * When each of the last `BACKGROUND_PUSHES_PER_HOUR` sends went out, oldest
   * first — the rolling window suppression (3) meters. Capped by construction,
   * so this is a handful of numbers per active user, not a log.
   */
  sentAt: number[];
  timer: ReturnType<typeof setTimeout> | null;
}

const states = new Map<string, UserState>();
/** When the last alert push was delivered per user, and the badge it carried
 * (kept for logging/parity with the spec's wording, not for the decision). */
const lastAlert = new Map<string, { badge: number; at: number }>();

function stateFor(userId: string): UserState {
  let st = states.get(userId);
  if (!st) {
    st = { pending: null, queuedAt: 0, lastSentAt: 0, sentAt: [], timer: null };
    states.set(userId, st);
  }
  return st;
}

/** Drop state for users who have been quiet for a while. O(map), run on queue. */
function sweep(now: number): void {
  for (const [userId, st] of states) {
    if (st.timer === null && st.pending === null && now - st.lastSentAt > IDLE_TTL_MS) {
      states.delete(userId);
      lastAlert.delete(userId);
    }
  }
}

/**
 * An alert push landed for this user carrying `badge`. Recorded so a badge-sync
 * queued before it can notice it has nothing left to do.
 */
export function noteAlertPush(userId: string, badge: number): void {
  lastAlert.set(userId, { badge, at: Date.now() });
}

/**
 * Mirror a `notification.read` to this user's devices. Cheap and synchronous:
 * it schedules, it does not send, so no read path pays for a push.
 */
export function queueBadgeSync(userId: string, badge: number): void {
  const now = Date.now();
  sweep(now);
  const st = stateFor(userId);
  st.pending = badge;
  st.queuedAt = now;
  // A timer already running is the coalescing: it will pick up this newer count
  // when it fires, which is exactly the point.
  if (st.timer) return;
  const wait = Math.max(badgeSyncTiming.settleMs, st.lastSentAt + badgeSyncTiming.windowMs - now);
  st.timer = setTimeout(() => {
    void flush(userId);
  }, wait);
  st.timer.unref?.();
}

async function flush(userId: string): Promise<void> {
  const st = stateFor(userId);
  st.timer = null;
  const badge = st.pending;
  if (badge === null) return;

  const alert = lastAlert.get(userId);
  if (alert && alert.at >= st.queuedAt) {
    st.pending = null;
    return; // suppression (2)
  }

  // Suppression (3): the hour's allowance. Held, not dropped — the pending
  // count stays owed and goes out as soon as the oldest send ages out of the
  // window, so the phone still ends up with the truth, just later.
  const now = Date.now();
  st.sentAt = st.sentAt.filter((t) => now - t < badgeSyncTiming.budgetWindowMs);
  if (st.sentAt.length >= BACKGROUND_PUSHES_PER_HOUR) {
    const wait = Math.max(st.sentAt[0]! + badgeSyncTiming.budgetWindowMs - now, badgeSyncTiming.settleMs);
    st.timer = setTimeout(() => {
      void flush(userId);
    }, wait);
    st.timer.unref?.();
    return;
  }

  st.pending = null;
  // The window opens when the send STARTS, not when it finishes: the device
  // query below is a round trip, and a read landing inside it would otherwise
  // see an un-advanced window and schedule a second push immediately.
  const previousSentAt = st.lastSentAt;
  st.lastSentAt = now;

  const devices = await db
    .select()
    .from(deviceTokens)
    .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.disabledAt)));
  if (devices.length === 0) {
    // Only a real send opens a new throttle window — a user with no live device
    // shouldn't have their next genuine sync delayed by a no-op.
    st.lastSentAt = previousSentAt;
    return;
  }
  st.sentAt.push(now);
  const payload = buildBadgeSyncPayload(badge);
  const headers = badgeSyncHeaders();
  const sender = pushSender();
  for (const device of devices) {
    try {
      const result = await sendPush(sender, device as PushDevice, payload, headers);
      if (!result.ok && result.disableDevice) {
        // APNs 410 / BadDeviceToken, same handling as the outbox: kept, not
        // deleted, so the next cold start's register revives the row.
        await db.update(deviceTokens).set({ disabledAt: new Date() }).where(eq(deviceTokens.id, device.id));
      }
    } catch {
      // A background badge correction is not worth a retry: the next read or
      // alert carries a fresher count than this one anyway.
    }
  }
}

/** Tests only: forget every timer and window. */
export function _resetBadgeSyncForTests(): void {
  for (const st of states.values()) if (st.timer) clearTimeout(st.timer);
  states.clear();
  lastAlert.clear();
}
