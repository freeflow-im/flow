// APNs device-token registry (#245, PUSH_APNS.md § "Device-token registry").
// Nothing here sends a push — this is only the two writes that keep the token
// list current, so the sender (#246+) has something true to read.
import { and, eq, isNull, or } from 'drizzle-orm';
import { RegisterDeviceFields, refineDevicePlatform } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';

import { z } from 'zod';
const RoutingId = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const ConnectionDeviceBody = RegisterDeviceFields.extend({
  routingId: RoutingId.optional(),
  badgeMode: z.literal('omit').optional(),
})
  .superRefine(refineDevicePlatform) // the per-platform rule from RegisterDeviceBody
  .superRefine((v, ctx) => {
    if ((v.routingId !== undefined) !== (v.badgeMode !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'routingId and badgeMode: omit must be supplied together' });
    }
  });
export const UnregisterDeviceQuery = z.object({ routingId: RoutingId.optional() }).strict();
const { deviceTokens } = schema;

/** APNs tokens are hex and case-insensitive, so they get one canonical form —
 * that keeps the unique index doing its job when a client changes its mind
 * about capitalization. FCM tokens are opaque and case-sensitive: stored as
 * sent (ANDROID.md phase 3). */
function normalize(token: string, platform: string): string {
  return platform === 'ios' ? token.toLowerCase() : token;
}

/**
 * Register this device for push, or refresh what we already knew about it.
 *
 * Called on every cold start, not just when the token changes: APNs tokens
 * rotate silently (restore from backup, reinstall), so re-registering
 * unconditionally is the cheapest way to stay correct.
 *
 * The conflict target is `token` alone, deliberately. A phone handed to
 * someone else re-registers the same token under the new account, and this
 * must **rebind** the row to the new user rather than insert a second one —
 * otherwise the previous owner's notifications keep landing on a phone that is
 * no longer theirs. `disabled_at` is cleared too: a token APNs once answered
 * 410 for is live again the moment a device asks for it back.
 */
export async function registerDevice(
  userId: string,
  body: z.infer<typeof ConnectionDeviceBody>,
): Promise<{ ok: true }> {
  const token = normalize(body.token, body.platform);
  const now = new Date();
  await db
    .insert(deviceTokens)
    .values({
      id: newId(),
      userId,
      token,
      routingId: body.routingId ?? null,
      platform: body.platform,
      environment: body.environment ?? null, // APNs only; null for android
      bundleId: body.bundleId ?? null,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: deviceTokens.token,
      set: {
        userId,
        routingId: body.routingId ?? null,
        platform: body.platform,
        environment: body.environment ?? null,
        bundleId: body.bundleId ?? null,
        lastSeenAt: now,
        disabledAt: null,
      },
    });
  return { ok: true };
}

/**
 * Unregister a device — the sign-out path.
 *
 * Scoped to the caller's own rows, so signing out cannot silence someone
 * else's phone by guessing a token. Idempotent: a token that is already gone
 * (or was rebound to another account in the meantime) is still `{ ok: true }`,
 * because the client's only sane response to a 404 here would be to carry on
 * signing out anyway.
 */
export async function unregisterDevice(userId: string, rawToken: string, routingId?: string): Promise<{ ok: true }> {
  // The platform is not in the request, so match either spelling: the
  // lower-cased form an ios row was stored under, or the exact FCM token.
  await db
    .delete(deviceTokens)
    .where(
      and(
        eq(deviceTokens.userId, userId),
        or(eq(deviceTokens.token, rawToken), eq(deviceTokens.token, rawToken.toLowerCase())),
        routingId === undefined ? isNull(deviceTokens.routingId) : eq(deviceTokens.routingId, routingId),
      ),
    );
  return { ok: true };
}
