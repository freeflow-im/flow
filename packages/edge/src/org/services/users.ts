// User profiles (phase2.md §6): PATCH /me, avatar upload, profile fetch.
//
// Avatars bypass the files table (approved deviation, decision log 2026-07-18):
// stored via the blob-store interface, unencrypted (they are not message
// content and §6 requires cacheability), referenced by users.avatar_url. The
// URL embeds a fresh key per upload, so clients may cache immutably.
import sharp from '../lib/sharp';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { NotificationPrefs, UserDTO } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { blobStore } from '../storage/index.js';
import { config } from '../config.js';
import { publishEvent, subjectMeta } from '../bus.js';
import { toUserDTO } from './auth.js';
import { inList } from '../sqlList.js';

const { users, workspaceMembers } = schema;

const AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const AVATAR_KEY_RE = /^[0-9a-f-]{36}-\d+\.webp$/;

async function broadcastUserUpdated(user: typeof users.$inferSelect): Promise<void> {
  const wsRows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, user.id));
  const ts = new Date().toISOString();
  for (const r of wsRows) {
    publishEvent(subjectMeta(r.workspaceId), {
      type: 'user.updated',
      workspaceId: r.workspaceId,
      ts,
      // No viewer: this goes to every member of the workspace, so a
      // privacy-mode address is redacted for all of them. The owner's own
      // clients refetch /v1/me on this event and get their real address back.
      data: toUserDTO(user),
    });
  }
}

export async function patchMe(
  userId: string,
  patch: {
    displayName?: string | undefined;
    timezone?: string | undefined;
    statusEmoji?: string | undefined;
    statusText?: string | undefined;
    website?: string | undefined;
    bio?: string | undefined;
    title?: string | undefined;
    notificationPrefs?: NotificationPrefs | undefined;
    statusSuppressAlerts?: boolean | undefined;
    unfurlOwnLinks?: boolean | undefined;
    privacyMode?: boolean | undefined;
  },
): Promise<UserDTO> {
  const set: Partial<{
    displayName: string;
    timezone: string;
    statusEmoji: string;
    statusText: string;
    website: string;
    bio: string;
    title: string;
    statusSuppressAlerts: boolean;
    unfurlOwnLinks: boolean;
    privacyMode: boolean;
    notificationPrefs: SQL;
  }> = {};
  // #489: only ever the caller's own row — `userId` is the session's user.
  if (patch.privacyMode !== undefined) set.privacyMode = patch.privacyMode;
  if (patch.unfurlOwnLinks !== undefined) set.unfurlOwnLinks = patch.unfurlOwnLinks;
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.timezone !== undefined) set.timezone = patch.timezone;
  if (patch.statusEmoji !== undefined) set.statusEmoji = patch.statusEmoji;
  if (patch.statusText !== undefined) set.statusText = patch.statusText;
  if (patch.website !== undefined) set.website = patch.website;
  if (patch.bio !== undefined) set.bio = patch.bio;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.statusSuppressAlerts !== undefined) set.statusSuppressAlerts = patch.statusSuppressAlerts;
  // shallow-merge over the stored prefs: only the keys sent change
  if (patch.notificationPrefs !== undefined) {
    set.notificationPrefs = sql`json_patch(${users.notificationPrefs}, ${JSON.stringify(patch.notificationPrefs)})`;
  }
  const updated = await db.update(users).set(set).where(eq(users.id, userId)).returning();
  if (!updated[0]) throw notFound('user not found');
  await broadcastUserUpdated(updated[0]);
  return toUserDTO(updated[0], userId);
}

/** Square-crop to 512px webp (phase2.md §6), store unencrypted, update avatar_url. */
export async function setAvatar(userId: string, data: Buffer, mimeType: string): Promise<UserDTO> {
  if (!AVATAR_MIMES.has(mimeType)) throw badRequest('bad_image', 'avatar must be png, jpeg, gif, or webp');
  if (data.length > config.maxServerUploadBytes) throw badRequest('file_too_large', 'avatar image too large');
  let webp: Buffer;
  try {
    webp = await sharp(data)
      .resize({ width: config.avatarPx, height: config.avatarPx, fit: 'cover' }) // square crop
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw badRequest('bad_image', 'could not decode image');
  }

  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!rows[0]) throw notFound('user not found');
  const oldUrl = rows[0].avatarUrl;

  const key = `${userId}-${Date.now()}.webp`;
  await blobStore().put(`avatars/${key}`, webp);
  const updated = await db
    .update(users)
    .set({ avatarUrl: `/v1/avatars/${key}` })
    .where(eq(users.id, userId))
    .returning();

  // best-effort cleanup of the replaced blob
  if (oldUrl?.startsWith('/v1/avatars/')) {
    const oldKey = oldUrl.slice('/v1/avatars/'.length);
    if (AVATAR_KEY_RE.test(oldKey)) await blobStore().delete(`avatars/${oldKey}`).catch(() => {});
  }

  await broadcastUserUpdated(updated[0]!);
  return toUserDTO(updated[0]!, userId);
}

/** Serve an avatar blob. Requires auth (any signed-in user); immutable-cacheable. */
export async function getAvatar(key: string): Promise<Buffer> {
  if (!AVATAR_KEY_RE.test(key)) throw notFound('avatar not found');
  try {
    return await blobStore().get(`avatars/${key}`);
  } catch {
    throw notFound('avatar not found');
  }
}

/** GET /v1/users/:id — profile visible to workspace co-members only (phase2.md §6). */
export async function getUser(targetId: string, requesterId: string): Promise<UserDTO> {
  const rows = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
  const user = rows[0];
  if (!user) throw notFound('user not found');
  if (targetId !== requesterId) {
    const myWs = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, requesterId));
    const wsIds = myWs.map((r) => r.workspaceId);
    const shared =
      wsIds.length > 0
        ? await db
            .select({ workspaceId: workspaceMembers.workspaceId })
            .from(workspaceMembers)
            .where(and(eq(workspaceMembers.userId, targetId), inList(workspaceMembers.workspaceId, wsIds)))
            .limit(1)
        : [];
    if (shared.length === 0) throw notFound('user not found'); // don't leak existence
  }
  return toUserDTO(user, requesterId);
}
