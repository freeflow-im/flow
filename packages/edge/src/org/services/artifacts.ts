// Artifacts (phase 13): per-channel shared objects — a named file pinned to a
// channel, visible to every member (privacy = use a private channel). The
// backing file is mutable: an agent "updates" an artifact by re-pointing it at
// a freshly uploaded file. owns_file marks artifacts whose file was uploaded
// for them (agent-generated), so deleting/re-pointing can reap the file.
//
// Link artifacts: a second kind — 'link' — pins a URL instead of a file. A link
// artifact opens in a shared "mini-browser" and is co-browsed: any member
// changing its url re-points the artifact (artifact.updated) and everyone's
// viewer follows. Link rows have url set and file_id null; the CHECK in
// migration 0020 keeps each row well-formed. Joins on files are therefore LEFT
// joins so link artifacts (no file) are not filtered out.
//
// Supersedes the phase-9 per-user model (operator ruling 2026-07-23): artifacts
// were personal bookmarks fanned out per recipient; they are now shared per
// channel. Events ride a per-channel subject; the gateway's visible() filter
// gates them by channel membership, so private channels stay private.
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, isNotNull, or } from 'drizzle-orm';
import type { AppArtifactSecretDTO, AppTokenDTO, ArtifactDTO } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { decryptBody, encryptBody } from '../crypto/index.js';
import { mintAppToken } from '../lib/appToken.js';
import { reapFileIfUnreferenced, requireFileAccess, toFileDTO } from './files.js';
import { requireChannelAccess } from './channels.js';
import { requireMembership } from './workspaces.js';
import { publishEvent, subjectArtifact } from '../bus.js';

const { artifacts, channels, files, channelMembers, users, workspaceMembers } = schema;

type ArtifactRow = typeof artifacts.$inferSelect;
type FileRow = typeof files.$inferSelect;

function toArtifactDTO(a: ArtifactRow, f: FileRow | null): ArtifactDTO {
  return {
    id: a.id,
    workspaceId: a.workspaceId,
    channelId: a.channelId,
    kind: a.kind === 'link' ? 'link' : 'file',
    fileId: a.fileId,
    url: a.url,
    name: a.name,
    ownsFile: a.ownsFile,
    isApp: a.appSecret !== null,
    requesterUserId: a.requesterUserId,
    sourceThreadRootId: a.sourceThreadRootId,
    operationId: a.operationId,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    file: f ? toFileDTO(f) : null,
  };
}

function publishArtifactEvent(type: 'artifact.created' | 'artifact.updated' | 'artifact.deleted', dto: ArtifactDTO): void {
  publishEvent(subjectArtifact(dto.workspaceId, dto.channelId), {
    type,
    workspaceId: dto.workspaceId,
    channelId: dto.channelId,
    ts: new Date().toISOString(),
    data: dto,
  });
}

/** Require the caller to be a member of the channel (not just able to see it).
 * Managing shared artifacts is a member action. */
async function requireChannelMember(channelId: string, userId: string) {
  const { chan, isMember } = await requireChannelAccess(channelId, userId);
  if (!isMember) throw forbidden('join the channel to manage its artifacts');
  return chan;
}

// ---- mini apps (docs/design/MINI_APPS.md) --------------------------
// An "app" link artifact owns a 32-byte secret. Flow HMACs short-lived member
// identity tokens with it; a guard in front of the app verifies them offline.
// The secret is written encrypted (message-body envelope) and leaves the server
// exactly twice per generation: the create response and the rotate response.

const APP_SECRET_BYTES = 32;

/** The four encrypted-secret columns for a fresh random secret, plus the raw
 * bytes to hand back once. */
function newAppSecretColumns(): { secret: Buffer; cols: Partial<ArtifactRow> } {
  const secret = randomBytes(APP_SECRET_BYTES);
  const enc = encryptBody(secret.toString('base64'));
  return {
    secret,
    cols: {
      appSecret: enc.body,
      appSecretNonce: enc.bodyNonce,
      appEncKeyId: enc.encKeyId,
      appEncScheme: enc.encScheme,
    },
  };
}

/** The row's secret, or null when the artifact is not an app. */
function readAppSecret(a: ArtifactRow): Buffer | null {
  if (!a.appSecret || !a.appSecretNonce || !a.appEncKeyId || a.appEncScheme === null) return null;
  return Buffer.from(
    decryptBody({ body: a.appSecret, bodyNonce: a.appSecretNonce, encKeyId: a.appEncKeyId, encScheme: a.appEncScheme }),
    'base64',
  );
}

/** A friendly default name for a link artifact: the host without a leading www. */
function linkName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

/**
 * Pin a file (`fileId`) or a link (`url`) as an artifact in a channel. Any
 * member can pin. Both pin paths are idempotent per channel — re-pinning the
 * same file (ownsFile=false) or the same url returns the existing row.  Owned
 * artifacts (ownsFile=true, an agent uploaded the file) are always distinct rows.
 */
export async function createArtifact(
  userId: string,
  channelId: string,
  opts: {
    fileId?: string | undefined;
    url?: string | undefined;
    name?: string | undefined;
    ownsFile?: boolean | undefined;
    app?: boolean | undefined;
    requesterUserId?: string | undefined;
    sourceThreadRootId?: string | undefined;
    operationId?: string | undefined;
  },
): Promise<ArtifactDTO | AppArtifactSecretDTO> {
  if (opts.app && opts.url === undefined) throw badRequest('bad_request', 'app is only valid with url');
  const chan = await requireChannelMember(channelId, userId);
  if (opts.requesterUserId) {
    const [actor] = await db.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, userId)).limit(1);
    if (!actor?.isAgent) throw forbidden('only an agent can set a report requester');
    await requireChannelMember(channelId, opts.requesterUserId);
  }
  if (opts.sourceThreadRootId) {
    const [root] = await db.select().from(schema.messages).where(and(
      eq(schema.messages.id, opts.sourceThreadRootId), eq(schema.messages.channelId, channelId),
      isNull(schema.messages.threadRootId), isNull(schema.messages.deletedAt),
    )).limit(1);
    if (!root) throw badRequest('bad_thread', 'artifact thread must be a live root in this channel');
  }
  // An operation key identifies a delivery, not the report title. Retrying a
  // timed-out creation returns the persisted report and reaps only surplus uploads.
  const retryResult = async (): Promise<ArtifactDTO | undefined> => {
    if (!opts.operationId) return undefined;
    const [row] = await db.select().from(artifacts).where(and(
      eq(artifacts.channelId, channelId), eq(artifacts.createdBy, userId), eq(artifacts.operationId, opts.operationId),
    )).limit(1);
    if (!row) return undefined;
    if (opts.ownsFile && opts.fileId && row.fileId !== opts.fileId) {
      const supplied = await requireFileAccess(opts.fileId, userId);
      if (supplied.userId === userId) await reapFileIfUnreferenced(opts.fileId);
    }
    return getArtifact(row.id, userId);
  };
  const prior = await retryResult();
  if (prior) return prior;

  // ---- link artifact -------------------------------------------------
  if (opts.url !== undefined) {
    if (!/^https?:\/\//i.test(opts.url)) throw badRequest('bad_url', 'url must be http(s)');
    const existing = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.channelId, channelId), eq(artifacts.kind, 'link'), eq(artifacts.url, opts.url)))
      .limit(1);
    if (existing[0]) {
      // Link pins are idempotent per channel. With `app: true` that would mean
      // handing back a row whose secret we cannot show — so promote a plain pin
      // into an app (returning the fresh secret), and refuse when it is already
      // one: rotation is the documented way to get another secret, and doing it
      // silently here would kill every token the existing app has out.
      if (!opts.app) return toArtifactDTO(existing[0], null);
      if (existing[0].appSecret) {
        throw conflict('app_exists', 'that url is already pinned as an app in this channel; rotate its secret instead');
      }
      const { secret, cols } = newAppSecretColumns();
      const promoted = await db
        .update(artifacts)
        .set({ ...cols, updatedAt: new Date() })
        .where(eq(artifacts.id, existing[0].id))
        .returning();
      const dto = toArtifactDTO(promoted[0]!, null);
      publishArtifactEvent('artifact.updated', dto);
      return { ...dto, appSecret: secret.toString('base64url') };
    }
    const app = opts.app ? newAppSecretColumns() : null;
    const inserted = await db
      .insert(artifacts)
      .values({
        id: newId(),
        workspaceId: chan.workspaceId,
        channelId,
        kind: 'link',
        url: opts.url,
        ownsFile: false,
        name: opts.name ?? linkName(opts.url),
        createdBy: userId,
        ...(app?.cols ?? {}),
      })
      .returning();
    const dto = toArtifactDTO(inserted[0]!, null);
    publishArtifactEvent('artifact.created', dto);
    return app ? { ...dto, appSecret: app.secret.toString('base64url') } : dto;
  }

  // ---- file artifact -------------------------------------------------
  if (opts.fileId === undefined) throw badRequest('bad_request', 'provide exactly one of fileId or url');
  const f = await requireFileAccess(opts.fileId, userId);
  const ownsFile = opts.ownsFile ?? false;

  if (!ownsFile && !opts.operationId) {
    const existing = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.channelId, channelId), eq(artifacts.fileId, opts.fileId), eq(artifacts.ownsFile, false)))
      .limit(1);
    if (existing[0]) return toArtifactDTO(existing[0], f);
  }

  const inserted = await db
    .insert(artifacts)
    .values({
      id: newId(),
      workspaceId: chan.workspaceId,
      channelId,
      kind: 'file',
      fileId: opts.fileId,
      ownsFile,
      requesterUserId: opts.requesterUserId ?? null,
      sourceThreadRootId: opts.sourceThreadRootId ?? null,
      operationId: opts.operationId ?? null,
      name: opts.name ?? f.name,
      createdBy: userId,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted[0]) {
    const retried = await retryResult();
    if (retried) return retried;
    // Concurrent ordinary pins converge on the existing file pin.
    const [pin] = await db.select().from(artifacts).where(and(
      eq(artifacts.channelId, channelId), eq(artifacts.fileId, opts.fileId), eq(artifacts.ownsFile, false),
    )).limit(1);
    if (pin) return toArtifactDTO(pin, f);
    throw badRequest('artifact_conflict', 'artifact creation conflicted; retry the operation');
  }
  const dto = toArtifactDTO(inserted[0], f);
  publishArtifactEvent('artifact.created', dto);
  return dto;
}

/** The caller's visible artifacts in a workspace — those in channels they're a
 * member of, newest first. File artifacts whose file was since soft-deleted are
 * hidden; link artifacts always show. Clients group by channelId to nest under
 * each channel. */
export async function listArtifacts(workspaceId: string, userId: string): Promise<ArtifactDTO[]> {
  const memberChannels = db
    .select({ id: channelMembers.channelId })
    .from(channelMembers)
    .where(eq(channelMembers.userId, userId));
  const rows = await db
    .select({ a: artifacts, f: files })
    .from(artifacts)
    .leftJoin(files, eq(files.id, artifacts.fileId))
    .where(and(eq(artifacts.workspaceId, workspaceId), inArray(artifacts.channelId, memberChannels)))
    .orderBy(desc(artifacts.updatedAt));
  return rows
    .filter((r) => r.a.kind === 'link' || (r.f !== null && r.f.deletedAt === null))
    .map((r) => toArtifactDTO(r.a, r.f));
}

/**
 * Mini apps across the whole workspace (#394) — what the sidebar's "Apps"
 * section lists. Deliberately wider than `listArtifacts`: a *public* channel's
 * app is public, so it is listed whether or not the caller has joined (clicking
 * it joins them). Private channels contribute only the ones the caller is
 * already in, so this introduces no new permission model — it is exactly the
 * visibility rule `listChannels` already uses, applied to app artifacts.
 *
 * Ordered by app name (case-insensitive, like the sidebar's other lists) then
 * channel id, so two same-named apps in different channels keep a stable
 * relative position across reloads. Sorted here rather than in SQL so every
 * client agrees on the order without depending on the database collation.
 */
export async function listAppArtifacts(workspaceId: string, userId: string): Promise<ArtifactDTO[]> {
  await requireMembership(workspaceId, userId);
  const memberChannels = db
    .select({ id: channelMembers.channelId })
    .from(channelMembers)
    .where(eq(channelMembers.userId, userId));
  const rows = await db
    .select({ a: artifacts, f: files })
    .from(artifacts)
    .innerJoin(channels, eq(channels.id, artifacts.channelId))
    .leftJoin(files, eq(files.id, artifacts.fileId))
    .where(
      and(
        eq(artifacts.workspaceId, workspaceId),
        isNotNull(artifacts.appSecret), // isApp
        isNull(channels.archivedAt),
        or(eq(channels.isPrivate, false), inArray(artifacts.channelId, memberChannels)),
      ),
    )
    .orderBy(asc(artifacts.name));
  return rows
    .map((r) => toArtifactDTO(r.a, r.f))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
        a.channelId.localeCompare(b.channelId),
    );
}

async function requireArtifactMember(artifactId: string, userId: string): Promise<{ a: ArtifactRow; f: FileRow | null }> {
  const rows = await db
    .select({ a: artifacts, f: files })
    .from(artifacts)
    .leftJoin(files, eq(files.id, artifacts.fileId))
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('artifact not found');
  await requireChannelMember(row.a.channelId, userId);
  return row;
}

/**
 * Rename, re-point a file artifact at a new file (the agent "update" path), or
 * re-point a link artifact at a new url (the co-browse navigation path — this
 * is what a member's URL-bar edit persists, so every viewer follows). If a file
 * changes and the old file was owned by this artifact, the old file is reaped
 * once unreferenced. Any channel member may update.
 */
export async function getArtifact(artifactId: string, userId: string): Promise<ArtifactDTO> {
  const { a, f } = await requireArtifactMember(artifactId, userId);
  if (a.kind === 'file' && (!f || f.deletedAt)) throw notFound('artifact file unavailable');
  return toArtifactDTO(a, f);
}

export async function updateArtifact(
  artifactId: string,
  userId: string,
  patch: { name?: string | undefined; fileId?: string | undefined; url?: string | undefined; ownsFile?: boolean | undefined },
): Promise<ArtifactDTO> {
  const { a } = await requireArtifactMember(artifactId, userId);
  const set: Partial<ArtifactRow> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;

  // Link artifacts only accept url (and name) changes; file artifacts only fileId.
  if (a.kind === 'link') {
    if (patch.fileId !== undefined) throw badRequest('bad_request', 'cannot attach a file to a link artifact');
    if (patch.url !== undefined && patch.url !== a.url) {
      if (!/^https?:\/\//i.test(patch.url)) throw badRequest('bad_url', 'url must be http(s)');
      // The (channel, url) pin is unique — re-pointing onto a url another
      // link artifact in this channel already pins would hit the
      // artifacts_channel_link_pin index raw and 500 (#315). Answer 409
      // instead; the racy window between this check and the UPDATE is
      // closed by mapping the index violation to the same conflict.
      const clash = await db
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(and(eq(artifacts.channelId, a.channelId), eq(artifacts.kind, 'link'), eq(artifacts.url, patch.url)))
        .limit(1);
      if (clash[0] && clash[0].id !== artifactId) {
        throw conflict('link_exists', 'that url is already pinned in this channel');
      }
      set.url = patch.url;
    }
    let updated: ArtifactRow[];
    try {
      updated = await db.update(artifacts).set(set).where(eq(artifacts.id, artifactId)).returning();
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('link_exists', 'that url is already pinned in this channel');
      }
      throw err;
    }
    const dto = toArtifactDTO(updated[0]!, null);
    publishArtifactEvent('artifact.updated', dto);
    return dto;
  }

  if (patch.url !== undefined) throw badRequest('bad_request', 'cannot set a url on a file artifact');
  let newFile: FileRow | null = null;
  const oldFileId = a.fileId;
  const oldOwned = a.ownsFile;
  if (patch.fileId !== undefined && patch.fileId !== a.fileId) {
    newFile = await requireFileAccess(patch.fileId, userId);
    set.fileId = patch.fileId;
    set.ownsFile = patch.ownsFile ?? false;
  } else if (patch.ownsFile !== undefined) {
    set.ownsFile = patch.ownsFile;
  }

  const updated = await db.update(artifacts).set(set).where(eq(artifacts.id, artifactId)).returning();
  const row = updated[0]!;
  // Re-pointed to a new file: reap the old one if this artifact owned it and
  // nothing else references it now.
  if (newFile && oldOwned && oldFileId && oldFileId !== row.fileId) {
    await reapFileIfUnreferenced(oldFileId);
  }
  const f = newFile ?? (row.fileId ? (await db.select().from(files).where(eq(files.id, row.fileId)).limit(1))[0]! : null);
  const dto = toArtifactDTO(row, f);
  publishArtifactEvent('artifact.updated', dto);
  return dto;
}

/** Rename an artifact (thin wrapper over updateArtifact for the PATCH route). */
export async function renameArtifact(artifactId: string, userId: string, name: string): Promise<ArtifactDTO> {
  return updateArtifact(artifactId, userId, { name });
}

/** Delete an artifact. If it owned its backing file, reap the file too (guarded
 * — a file still attached to a message or pinned elsewhere is kept). Link
 * artifacts have no file to reap. */
export async function deleteArtifact(artifactId: string, userId: string): Promise<void> {
  const rows = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
  const a = rows[0];
  if (!a) return; // idempotent
  await requireChannelMember(a.channelId, userId);
  const fRows = a.fileId ? await db.select().from(files).where(eq(files.id, a.fileId)).limit(1) : [];
  await db.delete(artifacts).where(eq(artifacts.id, artifactId));
  if (a.ownsFile && a.fileId) await reapFileIfUnreferenced(a.fileId);
  publishArtifactEvent('artifact.deleted', toArtifactDTO(a, fRows[0] ?? null));
}

/**
 * Mint a short-lived identity token for the caller against an app artifact
 * (MINI_APPS.md §"The token"). The gate is the same one every artifact
 * operation uses — membership of the artifact's channel — which is the whole
 * point: membership stays enforced where it already lives, and a removed member
 * simply fails their next mint. Verification is offline, so nothing here is
 * recorded; the token's 5-minute life and single-use `jti` bound the damage if
 * it leaks.
 */
export async function mintArtifactAppToken(artifactId: string, userId: string): Promise<AppTokenDTO> {
  const { a } = await requireArtifactMember(artifactId, userId);
  const secret = readAppSecret(a);
  if (!secret) throw badRequest('not_an_app', 'artifact is not an app');
  const who = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!who) throw notFound('user not found');
  const { token, expiresAt } = mintAppToken(secret, {
    artifactId: a.id,
    channelId: a.channelId,
    workspaceId: a.workspaceId,
    userId: who.id,
    displayName: who.displayName,
    isAgent: who.isAgent,
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * Rotate an app's secret — the revocation lever beyond kicking members: every
 * token minted under the old secret stops verifying the moment this returns.
 * Creator or workspace owner/admin, because it is destructive to everyone
 * currently inside the app, not just to the caller.
 */
export async function rotateArtifactAppSecret(artifactId: string, userId: string): Promise<AppArtifactSecretDTO> {
  const { a } = await requireArtifactMember(artifactId, userId);
  if (!a.appSecret) throw badRequest('not_an_app', 'artifact is not an app');
  if (a.createdBy !== userId) {
    const m = (
      await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, a.workspaceId), eq(workspaceMembers.userId, userId)))
        .limit(1)
    )[0];
    if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
      throw forbidden('only the app’s creator or a workspace admin can rotate its secret');
    }
  }
  const { secret, cols } = newAppSecretColumns();
  const updated = await db
    .update(artifacts)
    .set({ ...cols, updatedAt: new Date() })
    .where(eq(artifacts.id, artifactId))
    .returning();
  const dto = toArtifactDTO(updated[0]!, null);
  publishArtifactEvent('artifact.updated', dto);
  return { ...dto, appSecret: secret.toString('base64url') };
}
