// Files: blobs + thumbnails (phase2.md §3), R2-era direct uploads (2026-07-20).
//
// Upload-then-attach: clients either POST multipart to /files (legacy path,
// server writes the blob) or presign→PUT→complete (direct-to-R2; the server
// never sees the bytes). New blobs are stored as PLAINTEXT — R2 encrypts at
// rest and every URL is minted after an access check (decision log, R2
// ruling). Legacy rows (enc_key_id set) still decrypt through the keyring.
// Orphaned uploads — never attached, or presigned but never completed — are
// swept at boot + daily in-process (decision log ruling 5).
import path from 'node:path';
import sharp from '../lib/sharp';
import { and, asc, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { ChannelFilePage, FileDTO, PresignedUploadDTO } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { LOCK_KEYS, runExclusive } from '../lib/singleton.js';
import { badRequest, notFound } from '../lib/errors.js';
import { decryptBlob } from '../crypto/index.js';
import { blobStore } from '../storage/index.js';
import { config } from '../config.js';
import { requireMembership } from './workspaces.js';
import { requireChannelAccess } from './channels.js';
import { requireRole } from '../access.js';
import { inList } from '../sqlList.js';

const { files, messageFiles, messages, users } = schema;

type FileRow = typeof files.$inferSelect;

// What we ask sharp to thumbnail. Deliberately no HEIC (#243): the prebuilt
// libvips parses the HEIF container but can't decode HEVC pixels, so
// `metadata()` succeeds and `toBuffer()` throws `bad seek` — adding it here
// would buy the same null sidecar for the cost of pulling every photo into
// memory. All three clients now downscale and re-encode before upload
// (`ImagePrep` on macOS/iOS, `lib/imagePrep.ts` on web), so a raw .heic only
// reaches us from a browser that can't decode it either, and the server has no
// way to rescue that one.
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function toFileDTO(f: FileRow): FileDTO {
  return {
    id: f.id,
    workspaceId: f.workspaceId,
    userId: f.userId,
    name: f.name,
    mimeType: f.mimeType,
    sizeBytes: f.sizeBytes,
    width: f.width,
    height: f.height,
    hasThumb: f.thumbKey !== null,
    createdAt: f.createdAt.toISOString(),
  };
}

/** Multipart upload → encrypted blob (+ thumbnail for images) → files row. */
export async function uploadFile(
  workspaceId: string,
  userId: string,
  filename: string,
  mimeType: string,
  data: Buffer,
): Promise<FileDTO> {
  await requireMembership(workspaceId, userId);
  if (data.length === 0) throw badRequest('empty_file', 'file is empty');
  if (data.length > config.maxServerUploadBytes) {
    // this path buffers server-side; bigger files must use the presign flow
    throw badRequest('file_too_large', `multipart uploads are limited to ${config.maxServerUploadBytes} bytes`);
  }

  const id = newId();
  const storageKey = `files/${id}`;
  // sanitize the original name for display: strip any path components
  const name = path.basename(filename || 'file').slice(0, 255) || 'file';

  const store = blobStore();
  await store.put(storageKey, data);
  const { width, height, thumbKey } = await makeThumbnail(id, mimeType, data);

  const inserted = await db
    .insert(files)
    .values({
      id,
      workspaceId,
      userId,
      name,
      mimeType,
      sizeBytes: data.length,
      storageKey,
      encKeyId: null,
      width,
      height,
      thumbKey,
    })
    .returning();
  return toFileDTO(inserted[0]!);
}

/** Image sidecar: dimensions + max-512px webp thumbnail stored at thumbs/<id>. */
async function makeThumbnail(
  id: string,
  mimeType: string,
  data: Buffer,
): Promise<{ width: number | null; height: number | null; thumbKey: string | null }> {
  if (!IMAGE_MIMES.has(mimeType)) return { width: null, height: null, thumbKey: null };
  try {
    const img = sharp(data, { animated: false });
    const meta = await img.metadata();
    // max-512px thumbnail (fit inside, never enlarge), webp keeps alpha
    const thumb = await img
      .resize({ width: config.thumbMaxPx, height: config.thumbMaxPx, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    const thumbKey = `thumbs/${id}`;
    await blobStore().put(thumbKey, thumb);
    return { width: meta.width ?? null, height: meta.height ?? null, thumbKey };
  } catch {
    // not actually a decodable image — keep the file, skip the preview
    return { width: null, height: null, thumbKey: null };
  }
}

/**
 * Presigned direct upload, step 1: reserve a files row ('pending') and mint an
 * upload URL. On R2 the URL goes straight to the bucket with the declared
 * content-length/type baked into the signature (the size cap holds without the
 * server seeing bytes). On the local driver we fall back to a server-proxied
 * PUT (/v1/files/:id/content) so clients keep a single code path.
 */
export async function createPresignedUpload(
  workspaceId: string,
  userId: string,
  filename: string,
  mimeType: string,
  sizeBytes: number,
): Promise<PresignedUploadDTO> {
  await requireMembership(workspaceId, userId);
  if (sizeBytes <= 0) throw badRequest('empty_file', 'file is empty');
  if (sizeBytes > config.maxFileBytes) {
    throw badRequest('file_too_large', `files are limited to ${config.maxFileBytes} bytes`);
  }

  const id = newId();
  const storageKey = `files/${id}`;
  const name = path.basename(filename || 'file').slice(0, 255) || 'file';

  const inserted = await db
    .insert(files)
    .values({
      id,
      workspaceId,
      userId,
      name,
      mimeType,
      sizeBytes,
      storageKey,
      encKeyId: null,
      status: 'pending',
    })
    .returning();

  const presigned = await blobStore().presignPut(storageKey, { contentType: mimeType, contentLength: sizeBytes });
  const upload = presigned ? { ...presigned, method: 'PUT' as const } : {
    url: `/v1/files/${id}/content`,
    method: 'PUT' as const,
    headers: { 'content-type': mimeType },
  };
  return { file: toFileDTO(inserted[0]!), upload };
}

/** Local-driver fallback for the presigned flow: accept the bytes ourselves. */
export async function putPendingContent(fileId: string, userId: string, data: Buffer): Promise<void> {
  const f = await requirePendingOwned(fileId, userId);
  // mirror R2's signed-content-length contract: the declared size is binding
  if (data.length !== f.sizeBytes) {
    throw badRequest('size_mismatch', `expected ${f.sizeBytes} bytes, got ${data.length}`);
  }
  await blobStore().put(f.storageKey, data);
}

/**
 * Presigned direct upload, step 2: client says the PUT finished. Verify the
 * object really exists with the declared size, generate the image sidecar
 * (dimensions + thumbnail), and flip the row to 'ready'. Idempotent.
 */
export async function completeUpload(fileId: string, userId: string): Promise<FileDTO> {
  const rows = await db.select().from(files).where(and(eq(files.id, fileId), isNull(files.deletedAt))).limit(1);
  const f = rows[0];
  if (!f || f.userId !== userId) throw notFound('file not found');
  if (f.status === 'ready') return toFileDTO(f);

  const store = blobStore();
  const head = await store.head(f.storageKey);
  if (!head) throw badRequest('upload_incomplete', 'no object was uploaded for this file');
  if (head.size !== f.sizeBytes) {
    // R2 signs content-length so this can't happen there; guards the local fallback
    throw badRequest('size_mismatch', `expected ${f.sizeBytes} bytes, found ${head.size}`);
  }

  let sidecar: { width: number | null; height: number | null; thumbKey: string | null } = {
    width: null,
    height: null,
    thumbKey: null,
  };
  // sidecar generation pulls the object into memory — skip absurdly large "images"
  if (IMAGE_MIMES.has(f.mimeType) && f.sizeBytes <= config.thumbSourceMaxBytes) {
    sidecar = await makeThumbnail(f.id, f.mimeType, await store.get(f.storageKey));
  }

  const updated = await db
    .update(files)
    .set({ status: 'ready', width: sidecar.width, height: sidecar.height, thumbKey: sidecar.thumbKey })
    .where(and(eq(files.id, fileId), eq(files.status, 'pending')))
    .returning();
  // lost a race with a concurrent complete — both saw the same object, re-read is safe
  return toFileDTO(updated[0] ?? { ...f, status: 'ready', ...sidecar });
}

async function requirePendingOwned(fileId: string, userId: string): Promise<FileRow> {
  const rows = await db.select().from(files).where(and(eq(files.id, fileId), isNull(files.deletedAt))).limit(1);
  const f = rows[0];
  if (!f || f.userId !== userId) throw notFound('file not found');
  if (f.status !== 'pending') throw badRequest('already_uploaded', 'file upload was already completed');
  return f;
}

/**
 * Access rule (org/access.ts, platform phase 3.4): viewer on the file. The
 * uploader is its owner; anyone else must be a workspace member with a role
 * through what makes the file visible: an artifact it backs (a member of that
 * artifact's channel, or someone the artifact is shared with), or a message it
 * is attached to (public channel → the organization; private → its members).
 * Otherwise an unattached file is the uploader's alone. 404 either way.
 */
export async function requireFileAccess(fileId: string, userId: string): Promise<FileRow> {
  await requireRole(userId, 'file', fileId, 'viewer');
  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), isNull(files.deletedAt), eq(files.status, 'ready')))
    .limit(1);
  if (!rows[0]) throw notFound('file not found');
  return rows[0];
}

export interface FileContent {
  data: Buffer;
  mimeType: string;
  name: string;
}

/** Access-checked download: a short-lived signed URL when the driver can mint
 * one (client is 302'd straight to R2), else the proxied bytes. */
export type FileDownload = { redirect: string } | { content: FileContent };

/** Bytes for a storage key, decrypting legacy rows. No access check — every
 * caller does its own first (community-email images carry a capability token
 * instead of a membership, #492). */
export function readBlob(key: string, encKeyId: string | null): Promise<Buffer> {
  return blobStore()
    .get(key)
    .then((blob) => (encKeyId ? decryptBlob(blob, encKeyId) : blob));
}

export async function getFileDownload(fileId: string, userId: string): Promise<FileDownload> {
  const f = await requireFileAccess(fileId, userId);
  if (!f.encKeyId) {
    // legacy encrypted rows can't be served by R2 directly — proxy those
    const url = await blobStore().presignGet(f.storageKey, { filename: f.name, contentType: f.mimeType });
    if (url) return { redirect: url };
  }
  return { content: { data: await readBlob(f.storageKey, f.encKeyId), mimeType: f.mimeType, name: f.name } };
}

/** In-place streaming URL (e.g. <video src>): a longer-TTL presigned GET so
 * playback and seeking survive a feature-length video, or null when the driver
 * can't presign (local dev) / the row is legacy-encrypted — the client then
 * falls back to fetching the bytes through the proxy route. */
export async function getStreamUrl(
  fileId: string,
  userId: string,
): Promise<{ url: string | null; expiresInSeconds: number }> {
  const f = await requireFileAccess(fileId, userId);
  if (f.encKeyId) return { url: null, expiresInSeconds: 0 };
  const url = await blobStore().presignGet(f.storageKey, {
    contentType: f.mimeType,
    inline: true,
    ttlSeconds: config.streamUrlTtlSeconds,
  });
  return { url, expiresInSeconds: url ? config.streamUrlTtlSeconds : 0 };
}

/** Access-checked thumbnail URL for direct use by an image element. Unlike
 * GET /thumb, this JSON response does not make an authenticated fetch follow
 * a cross-origin redirect before the browser can paint the image. Local and
 * legacy-encrypted rows return null so the web client can keep using its
 * authenticated blob fallback. */
export async function getThumbUrl(
  fileId: string,
  userId: string,
): Promise<{ url: string | null; expiresInSeconds: number }> {
  const f = await requireFileAccess(fileId, userId);
  if (!f.thumbKey) throw notFound('no thumbnail for this file');
  if (f.encKeyId) return { url: null, expiresInSeconds: 0 };
  const url = await blobStore().presignGet(f.thumbKey, {
    contentType: 'image/webp',
    inline: true,
    ttlSeconds: config.presignGetTtlSeconds,
  });
  return { url, expiresInSeconds: url ? config.presignGetTtlSeconds : 0 };
}

export async function getThumbDownload(fileId: string, userId: string): Promise<FileDownload> {
  const f = await requireFileAccess(fileId, userId);
  if (!f.thumbKey) throw notFound('no thumbnail for this file');
  if (!f.encKeyId) {
    const url = await blobStore().presignGet(f.thumbKey, { contentType: 'image/webp', inline: true });
    if (url) return { redirect: url };
  }
  return {
    content: { data: await readBlob(f.thumbKey, f.encKeyId), mimeType: 'image/webp', name: `${f.name}.thumb.webp` },
  };
}

/**
 * Validate that fileIds may be attached by this sender to a message in this
 * workspace: files must exist, live in the same workspace, and belong to the
 * sender (you attach your own uploads). Returns rows for DTO hydration.
 */
export async function validateAttachments(
  fileIds: string[],
  workspaceId: string,
  senderId: string,
): Promise<FileRow[]> {
  if (fileIds.length === 0) return [];
  if (fileIds.length > config.maxFilesPerMessage) {
    throw badRequest('too_many_files', `at most ${config.maxFilesPerMessage} files per message`);
  }
  const rows = await db
    .select()
    .from(files)
    .where(and(inList(files.id, fileIds), isNull(files.deletedAt), eq(files.status, 'ready')));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const fid of fileIds) {
    const f = byId.get(fid);
    if (!f || f.workspaceId !== workspaceId) throw badRequest('bad_file', `file ${fid} not found in this workspace`);
    if (f.userId !== senderId) throw badRequest('bad_file', `file ${fid} was not uploaded by you`);
  }
  // de-dupe, preserving order
  return [...new Set(fileIds)].map((fid) => byId.get(fid)!);
}

/** Files attached to a set of messages, for DTO hydration. Returns messageId -> FileDTO[]. */
export async function filesForMessages(messageIds: string[]): Promise<Map<string, FileDTO[]>> {
  const out = new Map<string, FileDTO[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({ messageId: messageFiles.messageId, f: files })
    .from(messageFiles)
    .innerJoin(files, eq(files.id, messageFiles.fileId))
    .where(inList(messageFiles.messageId, messageIds))
    .orderBy(files.id);
  for (const r of rows) {
    const list = out.get(r.messageId) ?? [];
    list.push(toFileDTO(r.f));
    out.set(r.messageId, list);
  }
  return out;
}

/**
 * Orphan sweep (decision log ruling 5): hard-delete files never attached to a
 * message within 24h, blobs included. Runs at boot and on a daily in-process
 * timer — no scheduler infrastructure. Avatars never enter the files table
 * (approved deviation), so no special-casing here.
 */
export async function sweepOrphanFiles(): Promise<number> {
  const cutoff = new Date(Date.now() - config.orphanFileTtlHours * 3600_000);
  const orphans = await db
    .select({ id: files.id, storageKey: files.storageKey, thumbKey: files.thumbKey })
    .from(files)
    .where(
      and(
        lt(files.createdAt, cutoff),
        sql`NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = ${files.id})`,
        // phase 9: artifact-only files (e.g. MCP create_artifact uploads) are
        // never attached to a message but must not be reaped
        sql`NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.file_id = ${files.id})`,
        // #492: an image pasted into a community email is never attached to a
        // message either, and reaping it would break the picture in mail that
        // has already been delivered.
        sql`NOT EXISTS (SELECT 1 FROM workspace_email_images ei WHERE ei.file_id = ${files.id})`,
      ),
    );
  const store = blobStore();
  for (const o of orphans) {
    await db.delete(files).where(eq(files.id, o.id));
    await store.delete(o.storageKey);
    if (o.thumbKey) await store.delete(o.thumbKey);
  }
  return orphans.length;
}

/** Phase 13: delete a file + its blob iff nothing references it — no message
 * attachment and no (other) artifact. Used when an owned artifact is deleted or
 * re-pointed at a new file; a file still shared in a message or pinned
 * elsewhere is kept untouched. Best-effort: never throws. */
export async function reapFileIfUnreferenced(fileId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: files.id, storageKey: files.storageKey, thumbKey: files.thumbKey })
      .from(files)
      .where(
        and(
          eq(files.id, fileId),
          sql`NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = ${files.id})`,
          sql`NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.file_id = ${files.id})`,
          sql`NOT EXISTS (SELECT 1 FROM workspace_email_images ei WHERE ei.file_id = ${files.id})`,
        ),
      )
      .limit(1);
    const f = rows[0];
    if (!f) return false; // still referenced — leave it
    const store = blobStore();
    await db.delete(files).where(eq(files.id, f.id));
    await store.delete(f.storageKey);
    if (f.thumbKey) await store.delete(f.thumbKey);
    return true;
  } catch {
    return false;
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Boot-time sweep + daily timer. Errors are logged by the caller; never fatal.
 * Phase 18 M1: the sweep body runs on at most one replica per round — deleting
 * the same orphan twice is harmless, but N replicas listing the whole blob
 * store daily is waste. Skipped rounds are made up at the next cadence. */
export function startOrphanSweep(log: { info(o: unknown, msg: string): void; error(o: unknown, msg: string): void }): void {
  const run = async () => {
    try {
      const { ran, result } = await runExclusive(LOCK_KEYS.orphanSweep, sweepOrphanFiles);
      if (ran && result && result > 0) log.info({ swept: result }, 'orphan file sweep');
    } catch (err) {
      log.error(err, 'orphan file sweep failed');
    }
  };
  void run();
  if (!sweepTimer) {
    sweepTimer = setInterval(run, 24 * 3600_000);
    sweepTimer.unref();
  }
}

// ---- Channel Files panel (#347) ---------------------------------
//
// Every file attached to a live message in one channel, in one of four sort
// orders. Paging is cursor-based rather than offset-based so a new upload
// mid-scroll can't shift rows past the reader. The cursor is opaque to
// clients: it packs the sort key of the last row seen plus the (messageId,
// fileId) pair that identifies it, and the query resumes strictly after that
// tuple, which keeps paging stable under ties (two files the same size, or
// two attachments on the same message).

const CHANNEL_FILE_SORTS = {
  newest: { key: 'created', dir: 'desc' },
  oldest: { key: 'created', dir: 'asc' },
  name: { key: 'name', dir: 'asc' },
  size: { key: 'size', dir: 'desc' },
} as const;

type ChannelFileSortName = keyof typeof CHANNEL_FILE_SORTS;

function encodeFileCursor(key: string, messageId: string, fileId: string): string {
  return Buffer.from([key, messageId, fileId].join('|'), 'utf8').toString('base64url');
}

function decodeFileCursor(cursor: string): { key: string; messageId: string; fileId: string } {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (parts.length !== 3 || !parts[1] || !parts[2]) throw badRequest('bad_cursor', 'invalid cursor');
  return { key: parts[0]!, messageId: parts[1]!, fileId: parts[2]! };
}

/**
 * List the files shared in a channel. Reading follows normal channel
 * visibility (`requireChannelAccess`, the same rule as reading the messages
 * they came from), and attachments of deleted messages are excluded: deleting
 * a message takes its files out of the panel too.
 */
export async function listChannelFiles(
  channelId: string,
  userId: string,
  sort: ChannelFileSortName,
  before: string | undefined,
  limit: number,
): Promise<ChannelFilePage> {
  await requireChannelAccess(channelId, userId);
  const { key, dir } = CHANNEL_FILE_SORTS[sort] ?? CHANNEL_FILE_SORTS.newest;

  // The sort key doubles as the cursor key, so it has to be a stable string:
  // messages.id is a v7 uuid (time-ordered), lower(name) sorts case-blind, and
  // size is left-padded so it compares lexically the way it compares
  // numerically. All three then break ties on (messageId, fileId).
  const sortKey =
    key === 'name'
      ? sql<string>`lower(${files.name})`
      : key === 'size'
        ? sql<string>`printf('%020d', ${files.sizeBytes})`
        : sql<string>`${messages.id}`;

  const live = and(
    eq(messages.channelId, channelId),
    isNull(messages.deletedAt),
    isNull(files.deletedAt),
    eq(files.status, 'ready'),
  );

  const conds = [live];
  if (before) {
    const c = decodeFileCursor(before);
    // strict tuple comparison: everything ordered after the row the cursor names
    conds.push(
      dir === 'desc'
        ? sql`(${sortKey}, ${messages.id}, ${files.id}) < (${c.key}, ${c.messageId}, ${c.fileId})`
        : sql`(${sortKey}, ${messages.id}, ${files.id}) > (${c.key}, ${c.messageId}, ${c.fileId})`,
    );
  }

  const order =
    dir === 'desc'
      ? [sql`${sortKey} desc`, desc(messages.id), desc(files.id)]
      : [sql`${sortKey} asc`, asc(messages.id), asc(files.id)];

  const rows = await db
    .select({
      f: files,
      messageId: messages.id,
      sharedAt: messages.createdAt,
      uploaderName: users.displayName,
      sortKey,
    })
    .from(messageFiles)
    .innerJoin(messages, eq(messages.id, messageFiles.messageId))
    .innerJoin(files, eq(files.id, messageFiles.fileId))
    .innerJoin(users, eq(users.id, files.userId))
    .where(and(...conds))
    .orderBy(...order)
    .limit(limit + 1);

  const totalRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(messageFiles)
    .innerJoin(messages, eq(messages.id, messageFiles.messageId))
    .innerJoin(files, eq(files.id, messageFiles.fileId))
    .where(live);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    files: page.map((r) => ({
      id: r.f.id,
      name: r.f.name,
      mimeType: r.f.mimeType,
      sizeBytes: r.f.sizeBytes,
      width: r.f.width,
      height: r.f.height,
      hasThumb: r.f.thumbKey !== null,
      userId: r.f.userId,
      uploaderName: r.uploaderName,
      createdAt: r.sharedAt.toISOString(),
      messageId: r.messageId,
    })),
    total: totalRows[0]?.n ?? 0,
    nextCursor: hasMore && last ? encodeFileCursor(String(last.sortKey), last.messageId, last.f.id) : null,
  };
}
