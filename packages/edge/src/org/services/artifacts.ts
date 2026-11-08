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
//
// Who may do what is one function (org/access.ts, platform phase 3.4): the
// reader's role on the artifact, over its chain (the artifact, then its
// channel, where membership is an implicit `editor` grant). Reading needs
// viewer; pinning, renaming, re-pointing, deleting and minting an app token
// need editor (a member, as before); sharing and rotating need manager (the
// creator, who is owner, or a workspace admin in the channel). An explicit
// grant (`account:`, `channel:`, `org`) lets someone outside the channel open
// the artifact by id; listing stays per channel.
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, isNotNull, or } from 'drizzle-orm';
import { formatReference, type AppArtifactSecretDTO, type AppTokenDTO, type ArtifactDTO } from '@flow/shared';
import { parsePrincipal, type Grant, type Role } from '@flow/shared/grants';
import { db, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { decryptBody, encryptBody } from '../crypto/index.js';
import { mintAppToken } from '../lib/appToken.js';
import { reapFileIfUnreferenced, requireFileAccess, toFileDTO } from './files.js';
import { requireMembership } from './workspaces.js';
import { reportRevoke, reportShare } from './shares.js';
import { publishEvent, subjectArtifact } from '../bus.js';
import { requireRole, grantsOn, type ChatReader } from '../access.js';
import { config } from '../config.js';

const { artifacts, channels, files, channelMembers, users, workspaceMembers, grants } = schema;

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

/** Require the caller to be able to pin into the channel: editor on it, which a
 * member is (an implicit grant, org/access.ts). */
async function requireChannelEditor(channelId: string, userId: string) {
  const { chain } = await requireRole(userId, 'channel', channelId, 'editor');
  return { workspaceId: chain.workspaceId };
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
  const chan = await requireChannelEditor(channelId, userId);
  if (opts.requesterUserId) {
    const [actor] = await db.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, userId)).limit(1);
    if (!actor?.isAgent) throw forbidden('only an agent can set a report requester');
    await requireChannelEditor(channelId, opts.requesterUserId);
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

/** The artifact (and its file) when the caller's role on it is at least `needed`. */
async function requireArtifactRole(artifactId: string, userId: string, needed: Role): Promise<{ a: ArtifactRow; f: FileRow | null; role: Role; reader: ChatReader }> {
  const { role, reader } = await requireRole(userId, 'artifact', artifactId, needed);
  const rows = await db
    .select({ a: artifacts, f: files })
    .from(artifacts)
    .leftJoin(files, eq(files.id, artifacts.fileId))
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('artifact not found');
  return { ...row, role, reader };
}

/**
 * Rename, re-point a file artifact at a new file (the agent "update" path), or
 * re-point a link artifact at a new url (the co-browse navigation path — this
 * is what a member's URL-bar edit persists, so every viewer follows). If a file
 * changes and the old file was owned by this artifact, the old file is reaped
 * once unreferenced. Any channel member may update.
 */
export async function getArtifact(artifactId: string, userId: string): Promise<ArtifactDTO> {
  const { a, f } = await requireArtifactRole(artifactId, userId, 'viewer');
  if (a.kind === 'file' && (!f || f.deletedAt)) throw notFound('artifact file unavailable');
  return toArtifactDTO(a, f);
}

export async function updateArtifact(
  artifactId: string,
  userId: string,
  patch: { name?: string | undefined; fileId?: string | undefined; url?: string | undefined; ownsFile?: boolean | undefined },
): Promise<ArtifactDTO> {
  const { a } = await requireArtifactRole(artifactId, userId, 'editor');
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
  const { reader } = await requireRole(userId, 'artifact', artifactId, 'editor');
  const fRows = a.fileId ? await db.select().from(files).where(eq(files.id, a.fileId)).limit(1) : [];
  const shared = await grantsOn('artifact', artifactId);
  await db.delete(artifacts).where(eq(artifacts.id, artifactId));
  // Its grants go with it, and the share index hears so.
  await db.delete(grants).where(and(eq(grants.objectKind, 'artifact'), eq(grants.objectId, artifactId)));
  for (const g of shared) await reportRevoke({ ref: artifactRef(a), principal: g.principal, revokedBy: reader.accountId });
  if (a.ownsFile && a.fileId) await reapFileIfUnreferenced(a.fileId);
  publishArtifactEvent('artifact.deleted', toArtifactDTO(a, fRows[0] ?? null));
}

/**
 * Mint a short-lived identity token for the caller against an app artifact
 * (MINI_APPS.md §"The token"). The gate is editor on the artifact — what a
 * member of its channel is — so membership stays enforced where it already
 * lives, and a removed member simply fails their next mint. Someone the app is
 * shared with as a viewer sees it but gets no token: the token says "a member". Verification is offline, so nothing here is
 * recorded; the token's 5-minute life and single-use `jti` bound the damage if
 * it leaks.
 */
export async function mintArtifactAppToken(artifactId: string, userId: string): Promise<AppTokenDTO> {
  const { a } = await requireArtifactRole(artifactId, userId, 'editor');
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
 * Manager: the creator (owner) or a workspace owner/admin in the channel,
 * because it is destructive to everyone currently inside the app.
 */
export async function rotateArtifactAppSecret(artifactId: string, userId: string): Promise<AppArtifactSecretDTO> {
  const { a, role } = await requireArtifactRole(artifactId, userId, 'viewer');
  if (!a.appSecret) throw badRequest('not_an_app', 'artifact is not an app');
  if (role !== 'manager' && role !== 'owner') throw forbidden('only the app’s creator or a workspace admin can rotate its secret');
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


// ---- explicit grants (platform.md §4.3, phase 3.4) ----------------------------

/** An artifact's reference (platform.md §4.1): what the share index and the bus name it by. */
const artifactRef = (a: Pick<ArtifactRow, 'workspaceId' | 'id'>) => formatReference({ organizationId: a.workspaceId, app: 'chat', kind: 'artifact', id: a.id });

/** What the grants routes answer: the artifact's explicit grants and the caller's role on it. */
export interface ArtifactGrantsDTO { grants: Grant[]; role: Role | null }

const GRANTABLE: readonly Role[] = ['viewer', 'editor', 'manager'];

/** GET /v1/artifacts/:id/grants — viewer and up. */
export async function listArtifactGrants(artifactId: string, userId: string): Promise<ArtifactGrantsDTO> {
  const { role } = await requireArtifactRole(artifactId, userId, 'viewer');
  return { grants: await grantsOn('artifact', artifactId), role };
}

/** The principal, checked: an account or a channel of this workspace, or `org`. A link is not offered yet. */
async function checkPrincipal(workspaceId: string, principal: string): Promise<void> {
  let p: ReturnType<typeof parsePrincipal>;
  try {
    p = parsePrincipal(principal);
  } catch {
    throw badRequest('bad_principal', 'principal must be account:<id>, channel:<id> or org');
  }
  if (p.kind === 'link') throw badRequest('not_supported', 'link sharing is not offered for artifacts yet');
  if (p.kind === 'account') {
    const m = await db.select({ u: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.accountId, p.id!))).limit(1);
    if (!m[0]) throw badRequest('bad_principal', 'no such account in this workspace');
  } else if (p.kind === 'channel') {
    const c = await db.select({ id: channels.id }).from(channels).where(and(eq(channels.id, p.id!), eq(channels.workspaceId, workspaceId))).limit(1);
    if (!c[0]) throw badRequest('bad_principal', 'no such channel in this workspace');
  }
}

/** PUT /v1/artifacts/:id/grants — manager and up: give (or change) one principal's role, and tell the share index. */
export async function grantArtifact(artifactId: string, userId: string, principal: string, role: Role): Promise<ArtifactGrantsDTO> {
  const { a, role: mine, reader } = await requireArtifactRole(artifactId, userId, 'manager');
  if (!GRANTABLE.includes(role)) throw badRequest('bad_role', 'role must be viewer, editor or manager');
  await checkPrincipal(a.workspaceId, principal);
  const at = Date.now();
  await db
    .insert(grants)
    .values({ objectKind: 'artifact', objectId: artifactId, principal, role, grantedBy: reader.accountId, grantedAt: at, expiresAt: null })
    .onConflictDoUpdate({ target: [grants.objectKind, grants.objectId, grants.principal], set: { role, grantedBy: reader.accountId, grantedAt: at, expiresAt: null } });
  await reportShare({ ref: artifactRef(a), principal, role, grantedBy: reader.accountId, title: a.name, kind: 'artifact' }, config.webUrlBase);
  return { grants: await grantsOn('artifact', artifactId), role: mine };
}

/** DELETE /v1/artifacts/:id/grants/:principal — manager and up. Idempotent. */
export async function revokeArtifactGrant(artifactId: string, userId: string, principal: string): Promise<ArtifactGrantsDTO> {
  const { a, reader } = await requireArtifactRole(artifactId, userId, 'manager');
  const gone = await db.delete(grants).where(and(eq(grants.objectKind, 'artifact'), eq(grants.objectId, artifactId), eq(grants.principal, principal))).returning();
  if (gone[0]) await reportRevoke({ ref: artifactRef(a), principal, revokedBy: reader.accountId });
  // The caller's role may have come from the grant just taken away (a manager revoking their own): null then.
  const role = await requireRole(userId, 'artifact', artifactId, 'viewer').then((r) => r.role, () => null);
  return { grants: await grantsOn('artifact', artifactId), role };
}
