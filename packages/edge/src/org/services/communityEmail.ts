// Community email (#481): an owner/admin broadcasts one message to every human
// member of a workspace, composed in the web Directory.
//
// Two rules shape this file. First, the *renderer is the single source of
// truth* — `previewBroadcast` and `sendBroadcast` both call
// renderBroadcastEmailHtml, so the composer's Preview tab is showing the
// literal output of the send path rather than a re-implementation of it.
// Second, a broadcast is a batch of independent sends: one address that
// bounces must not cost the other N-1 people their email, so each send is
// awaited inside its own try and only tallied.
import { and, eq, isNull } from 'drizzle-orm';
import { EMAIL_IMAGE_MAX_BYTES } from '@flow/shared';
import type {
  WorkspaceEmailImageDTO,
  WorkspaceEmailPreviewDTO,
  WorkspaceEmailResultDTO,
} from '@flow/shared';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { badRequest, forbidden, notFound, ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { newLinkToken } from '../lib/tokens.js';
import { rateAllow } from '../lib/rateLimit.js';
import { blobStore } from '../storage/index.js';
import { emailSender } from '../email/index.js';
import { renderBroadcastEmailHtml, renderBroadcastEmailText } from '../email/render.js';
import { readBlob } from './files.js';
import { requireMembership } from './workspaces.js';

const { files, users, workspaces, workspaceEmailImages, workspaceMembers } = schema;

/** One broadcast per workspace per 10 minutes — stops a double-clicked confirm
 * from mailing everyone twice, and caps the blast radius of a compromised
 * admin session. */
const BROADCAST_LIMIT = 1;
const BROADCAST_WINDOW_MS = 10 * 60_000;

/** A test send goes to one consenting address — the author's own — so it needs
 * a limit only as an anti-abuse floor, not as a blast-radius cap. Deliberately
 * a *separate* window from the broadcast one: checking a draft's rendering
 * must never be the reason the real send is refused. */
const TEST_LIMIT = 1;
const TEST_WINDOW_MS = 60_000;

/** Subject prefix on a test send. The point of testing in a real mail client
 * is that the mail looks real, so the subject is the one place left that can
 * tell the author this copy is not the broadcast. */
export const TEST_SUBJECT_PREFIX = '[Test] ';

/** Owner/admin gate. */
async function requireAdmin(workspaceId: string, actorId: string) {
  const m = await requireMembership(workspaceId, actorId);
  if (m.role !== 'owner' && m.role !== 'admin') {
    throw forbidden('only owners and admins can email the workspace');
  }
  return m;
}

interface BroadcastContext {
  senderName: string;
  workspaceName: string;
  recipients: { userId: string; email: string; displayName: string }[];
}

/**
 * Who gets it, and whose name goes in the footer.
 *
 * Recipients are human members only: agents and app bots carry synthetic
 * addresses (`agent-<uuid>@agents.flow.local`, `bot-<uuid>@apps.flow.local`)
 * that no mail server will accept, and a tombstoned user has had their `email`
 * vacated on removal, so all three are excluded at the query.
 */
async function loadContext(workspaceId: string, actorId: string): Promise<BroadcastContext> {
  const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const ws = wsRows[0];
  if (!ws) throw notFound('workspace not found');

  const actorRows = await db.select().from(users).where(eq(users.id, actorId)).limit(1);
  const actor = actorRows[0];
  if (!actor) throw notFound('user not found');

  const rows = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(users.isAgent, false),
        eq(users.isBot, false),
        isNull(users.deletedAt),
      ),
    )
    .orderBy(workspaceMembers.joinedAt);

  return {
    senderName: actor.displayName,
    workspaceName: ws.name,
    recipients: rows.map((r) => ({ userId: r.id, email: r.email, displayName: r.displayName })),
  };
}

/** Admin-gated preview: the exact HTML `sendBroadcast` would mail, plus the
 * recipient count, so the composer never has to guess at either. */
export async function previewBroadcast(
  workspaceId: string,
  actorId: string,
  markdown: string,
): Promise<WorkspaceEmailPreviewDTO> {
  await requireAdmin(workspaceId, actorId);
  const ctx = await loadContext(workspaceId, actorId);
  return {
    html: renderBroadcastEmailHtml({
      markdown,
      senderName: ctx.senderName,
      workspaceName: ctx.workspaceName,
    }),
    recipientCount: ctx.recipients.length,
  };
}

/** How many people a broadcast would reach right now — the number the composer
 * puts in its To chip and its confirm step. */
export async function countBroadcastRecipients(workspaceId: string, actorId: string): Promise<number> {
  await requireAdmin(workspaceId, actorId);
  const ctx = await loadContext(workspaceId, actorId);
  return ctx.recipients.length;
}

/**
 * Send it. Returns `{sent, failed}` — a per-address tally, not a boolean, so
 * the admin learns that 41 of 42 landed instead of seeing one exception and
 * assuming nothing went out.
 */
export async function sendBroadcast(
  workspaceId: string,
  actorId: string,
  subject: string,
  markdown: string,
): Promise<WorkspaceEmailResultDTO> {
  await requireAdmin(workspaceId, actorId);
  // Rate-limited per workspace, not per admin: two admins hitting send on the
  // same announcement is exactly the double-send this prevents. Checked after
  // the role gate so a non-admin probe can't burn the workspace's window.
  if (!rateAllow(`ws-email:${workspaceId}`, BROADCAST_LIMIT, BROADCAST_WINDOW_MS)) {
    throw new ApiError(429, 'rate_limited', 'only one broadcast per workspace every 10 minutes');
  }

  const ctx = await loadContext(workspaceId, actorId);
  const html = renderBroadcastEmailHtml({
    markdown,
    senderName: ctx.senderName,
    workspaceName: ctx.workspaceName,
  });
  const text = renderBroadcastEmailText({
    markdown,
    senderName: ctx.senderName,
    workspaceName: ctx.workspaceName,
  });

  const sender = emailSender();
  let sent = 0;
  let failed = 0;
  for (const r of ctx.recipients) {
    try {
      // A display name on the From header (#493): "Free Flow <noreply@…>"
      // reads as a sender, a naked noreply address reads as spam.
      await sender.send({ to: r.email, subject, text, html, fromName: config.emailFromName });
      sent += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[ws-email] send failed workspace=${workspaceId} to=${r.email}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  console.log(`[ws-email] workspace=${workspaceId} by=${actorId} sent=${sent} failed=${failed}`);
  return { sent, failed };
}

/**
 * Mail the current draft to the author alone (#484).
 *
 * Same renderer, same footer, same plain-text alternative as `sendBroadcast` —
 * the whole value of the button is that what lands in the inbox is what the
 * workspace would get, so the only difference permitted here is the subject
 * prefix and the recipient list of one.
 */
export async function sendTestBroadcast(
  workspaceId: string,
  actorId: string,
  subject: string,
  markdown: string,
): Promise<WorkspaceEmailResultDTO> {
  await requireAdmin(workspaceId, actorId);
  // Per *user*, not per workspace, and on its own key: a test must not consume
  // the workspace's broadcast window (a composer that made you wait ten
  // minutes to send after checking your draft would just stop being used).
  if (!rateAllow(`ws-email-test:${actorId}`, TEST_LIMIT, TEST_WINDOW_MS)) {
    throw new ApiError(429, 'rate_limited', 'only one test email per minute');
  }

  const ctx = await loadContext(workspaceId, actorId);
  const to = ctx.recipients.find((r) => r.userId === actorId)?.email;
  // An admin whose address the broadcast would skip (tombstoned, synthetic)
  // has nowhere to send a test — better a 400 than a silent success.
  if (!to) throw new ApiError(400, 'no_address', 'your account has no address to send a test to');

  const args = { markdown, senderName: ctx.senderName, workspaceName: ctx.workspaceName };
  try {
    await emailSender().send({
      to,
      subject: `${TEST_SUBJECT_PREFIX}${subject}`,
      text: renderBroadcastEmailText(args),
      html: renderBroadcastEmailHtml(args),
      fromName: config.emailFromName,
    });
    console.log(`[ws-email] test workspace=${workspaceId} by=${actorId} to=${to}`);
    return { sent: 1, failed: 0 };
  } catch (err) {
    console.error(
      `[ws-email] test send failed workspace=${workspaceId} to=${to}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { sent: 0, failed: 1 };
  }
}

// ---- pasted images (#492) --------------------------------------------------
//
// A broadcast is HTML in a stranger's mail client: no Flow session, no bearer
// token, often a proxy fetching the image on the reader's behalf (Gmail does).
// So `/v1/files/:id`, which checks workspace membership, renders as a broken
// image in every inbox — the images need a public URL, and that is the whole
// reason this section exists.
//
// The bytes still travel by the ordinary presign→PUT→complete flow, which is
// what keeps client-side downscaling, thumbnails and R2 in one place. Adoption
// is a second, tiny step that mints the capability token and tells the orphan
// sweeper the file is load-bearing.

/** The cap is defined in @flow/shared and enforced *here*: the web client
 * downscales to 1024px on the way up, so most pastes never approach it, but a
 * client-side limit is a suggestion and this is the only place it binds.
 * Re-exported so the composer and this service quote the same number. */
export { EMAIL_IMAGE_MAX_BYTES };

/** What a mail client will actually paint. Deliberately the same set the
 * server thumbnails (`IMAGE_MIMES` in services/files.ts) minus nothing: an
 * SVG in an email is a scripting surface, and no major client renders it. */
const EMAIL_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Absolute, because the only reader is a mail client with no base URL to
 * resolve against — and the sanitizer drops relative and protocol-relative
 * sources for exactly that reason. */
export function emailImageUrl(token: string): string {
  return `${config.webUrlBase.replace(/\/+$/, '')}/v1/email-images/${token}`;
}

/**
 * Turn an uploaded file into a broadcast image and hand back its public URL.
 *
 * Idempotent per file: re-adopting returns the original token, so a composer
 * that retries never leaves a second permanent URL for the same bytes.
 */
export async function adoptEmailImage(
  workspaceId: string,
  actorId: string,
  fileId: string,
): Promise<WorkspaceEmailImageDTO> {
  await requireAdmin(workspaceId, actorId);

  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.workspaceId, workspaceId), isNull(files.deletedAt)))
    .limit(1);
  const f = rows[0];
  // Same 404 for "no such file" and "not in this workspace": an admin of one
  // workspace should not be able to probe another's file ids.
  if (!f || f.status !== 'ready') throw notFound('file not found');
  if (!EMAIL_IMAGE_MIMES.has(f.mimeType)) {
    throw badRequest('unsupported_image', `${f.mimeType} can't be embedded in an email`);
  }
  if (f.sizeBytes > EMAIL_IMAGE_MAX_BYTES) {
    throw badRequest('image_too_large', `email images are limited to ${EMAIL_IMAGE_MAX_BYTES} bytes`);
  }

  const existing = await db
    .select({ token: workspaceEmailImages.token })
    .from(workspaceEmailImages)
    .where(eq(workspaceEmailImages.fileId, fileId))
    .limit(1);
  if (existing[0]) return { url: emailImageUrl(existing[0].token) };

  const token = newLinkToken();
  await db.insert(workspaceEmailImages).values({
    id: newId(),
    workspaceId,
    fileId,
    createdBy: actorId,
    token,
  });
  return { url: emailImageUrl(token) };
}

export type EmailImageDownload =
  | { redirect: string }
  | { content: { data: Buffer; mimeType: string } };

/**
 * Serve one by its token — the unauthenticated half. The token *is* the access
 * check; there is no user to check anything else against.
 */
export async function getEmailImage(token: string): Promise<EmailImageDownload> {
  const rows = await db
    .select({ storageKey: files.storageKey, encKeyId: files.encKeyId, mimeType: files.mimeType })
    .from(workspaceEmailImages)
    .innerJoin(files, eq(files.id, workspaceEmailImages.fileId))
    .where(and(eq(workspaceEmailImages.token, token), isNull(files.deletedAt)))
    .limit(1);
  const f = rows[0];
  if (!f) throw notFound('image not found');

  if (!f.encKeyId) {
    // `inline`, not `attachment`: this URL is the src of an <img>, and a
    // download disposition makes some clients refuse to paint it.
    const url = await blobStore().presignGet(f.storageKey, {
      contentType: f.mimeType,
      inline: true,
      ttlSeconds: config.presignGetTtlSeconds,
    });
    if (url) return { redirect: url };
  }
  return { content: { data: await readBlob(f.storageKey, f.encKeyId), mimeType: f.mimeType } };
}
