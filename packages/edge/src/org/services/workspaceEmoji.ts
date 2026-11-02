// Custom emoji (#175): workspace-scoped images usable as message reactions.
//
// Two deliberate reuses, so this adds no parallel infrastructure:
//   - the image is an ordinary `files` row, uploaded through the existing
//     presign flow; this service only registers an already-uploaded file id.
//   - a reaction stores the `:shortcode:` string in the same `reactions.emoji`
//     column unicode reactions use, so aggregation, the notification path
//     (migration 0024) and the wire events are untouched.
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  CUSTOM_EMOJI_CODE_RE,
  EMOJI_SHORTCODES,
  type WorkspaceEmojiDTO,
} from '@flow/shared';
import { db, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { requireMembership, toWorkspaceDTO } from './workspaces.js';
import { publishEvent, subjectMeta } from '../bus.js';

const { workspaceEmoji, files, workspaces } = schema;

type EmojiRow = typeof workspaceEmoji.$inferSelect;

/** Custom emoji images are shown at ~22px; anything large is a mistake, and the
 * cost is paid on every message render by every client. */
const MAX_EMOJI_BYTES = 256 * 1024;

const ALLOWED_MIME = new Set(['image/png', 'image/gif', 'image/webp', 'image/jpeg']);

export function toWorkspaceEmojiDTO(r: EmojiRow): WorkspaceEmojiDTO {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    shortcode: r.shortcode,
    emoji: `:${r.shortcode}:`,
    fileId: r.fileId,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

async function requireAdmin(workspaceId: string, actorId: string) {
  const m = await requireMembership(workspaceId, actorId);
  if (m.role !== 'owner' && m.role !== 'admin') {
    throw forbidden('only owners and admins can manage custom emoji');
  }
  return m;
}

/** Every member can list — you need the images to render other people's
 * reactions, not just to add your own. */
export async function listEmoji(workspaceId: string, actorId: string): Promise<WorkspaceEmojiDTO[]> {
  await requireMembership(workspaceId, actorId);
  const rows = await db
    .select()
    .from(workspaceEmoji)
    .where(eq(workspaceEmoji.workspaceId, workspaceId))
    .orderBy(asc(workspaceEmoji.shortcode));
  return rows.map(toWorkspaceEmojiDTO);
}

export async function createEmoji(
  workspaceId: string,
  actorId: string,
  shortcode: string,
  fileId: string,
): Promise<WorkspaceEmojiDTO> {
  await requireAdmin(workspaceId, actorId);
  if (!CUSTOM_EMOJI_CODE_RE.test(shortcode)) {
    throw badRequest('invalid_shortcode', 'letters, digits, - and _ only; 2–32 characters');
  }
  // A custom `:fire:` would shadow the unicode one the composer already expands
  // (shared/emoji.ts expandShortcodes), so the same typed text would mean two
  // different things depending on where you typed it. Refuse the collision.
  if (EMOJI_SHORTCODES[shortcode]) {
    throw badRequest('reserved_shortcode', `:${shortcode}: is a standard emoji shortcode`);
  }

  const f = (
    await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.workspaceId, workspaceId)))
      .limit(1)
  )[0];
  if (!f || f.deletedAt) throw notFound('file not found');
  if (f.status !== 'ready') throw badRequest('file_not_ready', 'the upload has not completed');
  if (!ALLOWED_MIME.has(f.mimeType)) {
    throw badRequest('unsupported_image', 'custom emoji must be a PNG, GIF, WebP or JPEG image');
  }
  if (f.sizeBytes > MAX_EMOJI_BYTES) {
    throw badRequest('image_too_large', `custom emoji must be under ${MAX_EMOJI_BYTES / 1024}KB`);
  }

  const existing = (
    await db
      .select()
      .from(workspaceEmoji)
      .where(and(eq(workspaceEmoji.workspaceId, workspaceId), eq(workspaceEmoji.shortcode, shortcode)))
      .limit(1)
  )[0];
  if (existing) throw badRequest('shortcode_taken', `:${shortcode}: already exists`);

  const inserted = await db
    .insert(workspaceEmoji)
    .values({ id: newId(), workspaceId, shortcode, fileId, createdBy: actorId })
    .returning();
  const dto = toWorkspaceEmojiDTO(inserted[0]!);
  notifyWorkspace(workspaceId);
  return dto;
}

/**
 * Deleting an emoji leaves existing reactions that used it in place: the rows
 * are just strings and there is no workspace column on `reactions` to scope a
 * cleanup by. Clients render an unresolvable `:shortcode:` as literal text,
 * which is the honest outcome — the reaction still says who reacted and can
 * still be un-reacted.
 */
export async function deleteEmoji(emojiId: string, actorId: string): Promise<void> {
  const row = (await db.select().from(workspaceEmoji).where(eq(workspaceEmoji.id, emojiId)).limit(1))[0];
  if (!row) throw notFound('emoji not found');
  await requireAdmin(row.workspaceId, actorId);
  await db.delete(workspaceEmoji).where(eq(workspaceEmoji.id, emojiId));
  notifyWorkspace(row.workspaceId);
}

/** Do these `:shortcode:` strings all exist in the workspace? */
export async function resolveShortcodes(workspaceId: string, codes: string[]): Promise<Set<string>> {
  if (codes.length === 0) return new Set();
  const rows = await db
    .select({ shortcode: workspaceEmoji.shortcode })
    .from(workspaceEmoji)
    .where(and(eq(workspaceEmoji.workspaceId, workspaceId), inArray(workspaceEmoji.shortcode, codes)));
  return new Set(rows.map((r) => r.shortcode));
}

/**
 * Reuses `workspace.updated` rather than minting an event type shipped clients
 * don't know: every client already refetches workspace-level state on it, and
 * web additionally invalidates its emoji query.
 *
 * The payload must be a complete WorkspaceDTO — the macOS client decodes
 * `data` straight into `Workspace` and a partial object fails the whole event —
 * so this reloads the row rather than synthesising one. Fire-and-forget: an
 * emoji that was created must not fail because the fan-out did.
 */
function notifyWorkspace(workspaceId: string): void {
  void (async () => {
    const w = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0];
    if (!w) return;
    publishEvent(subjectMeta(workspaceId), {
      type: 'workspace.updated',
      workspaceId,
      ts: new Date().toISOString(),
      data: toWorkspaceDTO(w),
    });
  })().catch(() => {});
}
