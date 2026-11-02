// APNs device-token registry (#245, PUSH_APNS.md § "Device-token registry").
// Nothing here sends a push — this is only the two writes that keep the token
// list current, so the sender (#246+) has something true to read.
import { and, eq, isNull } from 'drizzle-orm';
import { RegisterDeviceBody } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';

import { z } from 'zod';
const RoutingId = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const ConnectionDeviceBody = RegisterDeviceBody.extend({
  routingId: RoutingId.optional(),
  badgeMode: z.literal('omit').optional(),
}).superRefine((v, ctx) => {
  if ((v.routingId !== undefined) !== (v.badgeMode !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'routingId and badgeMode: omit must be supplied together' });
  }
});
export const UnregisterDeviceQuery = z.object({ routingId: RoutingId.optional() }).strict();
const { deviceTokens } = schema;

/** Tokens are hex and case-insensitive; one canonical form keeps the unique
 * index doing its job when a client changes its mind about capitalization. */
function normalize(token: string): string {
  return token.toLowerCase();
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
  const token = normalize(body.token);
  const now = new Date();
  await db
    .insert(deviceTokens)
    .values({
      id: newId(),
      userId,
      token,
      routingId: body.routingId ?? null,
      platform: body.platform,
      environment: body.environment,
      bundleId: body.bundleId,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: deviceTokens.token,
      set: {
        userId,
        routingId: body.routingId ?? null,
        platform: body.platform,
        environment: body.environment,
        bundleId: body.bundleId,
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
  await db
    .delete(deviceTokens)
    .where(and(eq(deviceTokens.userId, userId), eq(deviceTokens.token, normalize(rawToken)), routingId === undefined ? isNull(deviceTokens.routingId) : eq(deviceTokens.routingId, routingId)));
  return { ok: true };
}
