// Scheduled messages (#419): store, scheduler loop, and the CRUD service the
// REST routes sit on.
//
// The design in one line: a scheduled message is a *pending message*, not a
// job. Firing it calls the ordinary `sendMessage` path as the author, so NATS
// fanout, unreads, push and agent mentions all behave
// exactly as they do for a typed message — the only difference downstream is
// `messages.scheduled = true`, which clients render as a badge.
//
// Everything about *when* lives in `next_run_at` (absolute) and `recurrence` +
// `timezone` (local terms); see lib/recurrence.ts for why that split matters.
import { and, asc, desc, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type {
  CreateScheduledMessageBody,
  Recurrence,
  ScheduledMessageDTO,
  ScheduledRunStatus,
  UpdateScheduledMessageBody,
} from '@flow/shared';
import { db, schema, type Tx } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { decryptBody, encryptBody } from '../crypto/index.js';
import { isValidTimezone, nextOccurrence } from '../lib/recurrence.js';
import { requireChannelAccess, createDm } from './channels.js';
import { requireMembership } from './workspaces.js';
import { sendMessage } from './messages.js';

const { scheduledMessages, channels, channelMembers, users } = schema;

type Row = typeof scheduledMessages.$inferSelect;

/** How often the in-process ticker looks for due rows. The acceptance bar is
 * "fires within one tick of its due time", so this is also the worst-case
 * lateness a user should ever see. */
export const TICK_MS = 30_000;
/** Rows claimed per tick. A cap keeps one busy workspace from starving the
 * others and bounds how long a tick holds its transaction open. */
const CLAIM_LIMIT = 50;

// ---- DTO -------------------------------------------------------

export function toScheduledMessageDTO(row: Row, canManage: boolean): ScheduledMessageDTO {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    channelId: row.channelId,
    authorUserId: row.authorUserId,
    body: decryptBody(row),
    recurrence: row.recurrence,
    timezone: row.timezone,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunStatus: row.lastRunStatus ?? null,
    lastMessageId: row.lastMessageId ?? null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canManage,
  };
}

// ---- authorization ---------------------------------------------

/** Author or workspace admin/owner — the edit/delete/pause/run rule (#419). */
async function mayManage(row: Row, userId: string): Promise<boolean> {
  if (row.authorUserId === userId) return true;
  const member = await requireMembership(row.workspaceId, userId);
  return member.role === 'owner' || member.role === 'admin';
}

async function requireManageable(id: string, userId: string): Promise<Row> {
  const row = await getRow(id);
  if (!(await mayManage(row, userId))) {
    throw forbidden('only the author or a workspace admin can manage this scheduled message');
  }
  return row;
}

async function getRow(id: string): Promise<Row> {
  const rows = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound('scheduled message not found');
  return row;
}

/** Is `userId` a member of the destination conversation right now? Both the
 * creation-time validation and the pre-fire safety check go through this. */
async function isDestinationMember(channelId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

// ---- validation ------------------------------------------------

function resolveTimezone(requested: string | undefined, authorTimezone: string): string {
  const tz = requested ?? authorTimezone ?? 'UTC';
  if (!isValidTimezone(tz)) throw badRequest('bad_timezone', `unknown timezone: ${tz}`);
  return tz;
}

/** Next fire time for a rule, rejecting one that can never fire again — a
 * one-shot set in the past is a user mistake worth surfacing at create time
 * rather than a row that silently never runs. */
function requireNextRun(recurrence: Recurrence, timezone: string, after: Date): Date {
  let next: Date | null;
  try {
    next = nextOccurrence(recurrence, timezone, after);
  } catch (err) {
    throw badRequest('bad_recurrence', err instanceof Error ? err.message : 'invalid recurrence');
  }
  if (!next) throw badRequest('bad_recurrence', 'that schedule has no future occurrence');
  return next;
}

// ---- CRUD ------------------------------------------------------

export async function createScheduledMessage(
  userId: string,
  input: CreateScheduledMessageBody,
): Promise<ScheduledMessageDTO> {
  const { chan } = await requireChannelAccess(input.channelId, userId);
  if (chan.archivedAt) throw badRequest('channel_archived', 'channel is archived');
  if (!(await isDestinationMember(input.channelId, userId))) {
    throw forbidden('join the destination before scheduling a message into it');
  }
  const author = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!author) throw notFound('user not found');

  const timezone = resolveTimezone(input.timezone, author.timezone);
  const nextRunAt = requireNextRun(input.recurrence, timezone, new Date());
  const enc = encryptBody(input.body);
  const id = newId();
  await db.insert(scheduledMessages).values({
    id,
    workspaceId: chan.workspaceId,
    channelId: input.channelId,
    authorUserId: userId,
    body: enc.body,
    bodyNonce: enc.bodyNonce,
    encKeyId: enc.encKeyId,
    encScheme: enc.encScheme,
    recurrence: input.recurrence,
    timezone,
    nextRunAt,
  });
  return toScheduledMessageDTO(await getRow(id), true);
}

export async function updateScheduledMessage(
  id: string,
  userId: string,
  input: UpdateScheduledMessageBody,
): Promise<ScheduledMessageDTO> {
  const row = await requireManageable(id, userId);

  const patch: Partial<typeof scheduledMessages.$inferInsert> = { updatedAt: new Date() };
  if (input.channelId !== undefined && input.channelId !== row.channelId) {
    const { chan } = await requireChannelAccess(input.channelId, row.authorUserId);
    if (chan.workspaceId !== row.workspaceId) {
      throw badRequest('bad_destination', 'destination must be in the same workspace');
    }
    if (!(await isDestinationMember(input.channelId, row.authorUserId))) {
      throw forbidden('the author is not a member of that destination');
    }
    patch.channelId = input.channelId;
  }
  if (input.body !== undefined) {
    const enc = encryptBody(input.body);
    patch.body = enc.body;
    patch.bodyNonce = enc.bodyNonce;
    patch.encKeyId = enc.encKeyId;
    patch.encScheme = enc.encScheme;
  }

  const timezone = input.timezone !== undefined ? resolveTimezone(input.timezone, row.timezone) : row.timezone;
  const recurrence = input.recurrence ?? row.recurrence;
  if (input.timezone !== undefined) patch.timezone = timezone;
  if (input.recurrence !== undefined) patch.recurrence = recurrence;
  const enabled = input.enabled ?? row.enabled;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  // A deliberate pause replaces whatever reason the server had for stopping the
  // row: `lastError` means "it stopped itself", which is what clients tell
  // "Failed" and "Paused" apart.
  if (input.enabled === false) patch.lastError = null;

  // Any change to *when* — including resuming a paused row — re-derives the
  // next occurrence from now, so a row that sat paused for a week doesn't wake
  // up owing a run.
  const rescheduling =
    input.recurrence !== undefined || input.timezone !== undefined || (input.enabled === true && !row.enabled);
  if (rescheduling && enabled) {
    patch.nextRunAt = requireNextRun(recurrence, timezone, new Date());
    patch.lastError = null;
  }

  await db.update(scheduledMessages).set(patch).where(eq(scheduledMessages.id, id));
  return toScheduledMessageDTO(await getRow(id), true);
}

export async function deleteScheduledMessage(id: string, userId: string): Promise<void> {
  await requireManageable(id, userId);
  await db.delete(scheduledMessages).where(eq(scheduledMessages.id, id));
}

/** Pause (enabled=false) or resume (recomputes `next_run_at` from now). */
export async function setScheduledMessageEnabled(
  id: string,
  userId: string,
  enabled: boolean,
): Promise<ScheduledMessageDTO> {
  return updateScheduledMessage(id, userId, { enabled });
}

/**
 * Fire now, out of band. The scheduled cadence is untouched: this is "send it
 * again", not "reschedule", so `next_run_at` keeps pointing where it did.
 */
export async function runScheduledMessageNow(id: string, userId: string): Promise<ScheduledMessageDTO> {
  const row = await requireManageable(id, userId);
  await fireRow(row, { manual: true });
  return toScheduledMessageDTO(await getRow(id), true);
}

/**
 * Rows the caller may see: everything they authored, plus rows destined for a
 * channel they are a member of. A row destined to someone's self-DM is only
 * ever visible to them, which falls out of the membership rule — a self-DM has
 * exactly one member.
 */
export async function listScheduledMessages(
  workspaceId: string,
  userId: string,
  onlyMine: boolean,
): Promise<ScheduledMessageDTO[]> {
  const member = await requireMembership(workspaceId, userId);
  const myChannels = db
    .select({ id: channelMembers.channelId })
    .from(channelMembers)
    .where(eq(channelMembers.userId, userId));

  const visible = onlyMine
    ? eq(scheduledMessages.authorUserId, userId)
    : or(eq(scheduledMessages.authorUserId, userId), inArray(scheduledMessages.channelId, myChannels));

  const rows = await db
    .select()
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.workspaceId, workspaceId), visible))
    .orderBy(desc(scheduledMessages.createdAt));

  const isAdmin = member.role === 'owner' || member.role === 'admin';
  return rows.map((r) => toScheduledMessageDTO(r, isAdmin || r.authorUserId === userId));
}

// ---- the scheduler ---------------------------------------------

/**
 * Claim every row that is due, advancing each one's `next_run_at` inside the
 * same transaction that locked it. `FOR UPDATE SKIP LOCKED` is what makes a
 * multi-instance deployment safe: a second server's tick simply doesn't see the
 * rows this one is holding.
 *
 * The next occurrence is computed from **now**, not from the missed
 * `next_run_at` — that is the whole catch-up policy (#419): a server that was
 * down over three occurrences fires once on boot and then resumes its normal
 * cadence, rather than replaying three messages into the channel.
 */
async function claimDue(now: Date, limit = CLAIM_LIMIT): Promise<Row[]> {
  return db.transaction(async (tx: Tx) => {
    const due = await tx
      .select()
      .from(scheduledMessages)
      .where(
        and(
          eq(scheduledMessages.enabled, true),
          isNotNull(scheduledMessages.nextRunAt),
          lte(scheduledMessages.nextRunAt, now),
        ),
      )
      .orderBy(asc(scheduledMessages.nextRunAt))
      .limit(limit)
      .for('update', { skipLocked: true });

    for (const row of due) {
      let next: Date | null = null;
      try {
        next = nextOccurrence(row.recurrence, row.timezone, now);
      } catch {
        next = null; // unparseable rule: stop rather than spin
      }
      await tx
        .update(scheduledMessages)
        .set({ nextRunAt: next, enabled: next !== null, updatedAt: now })
        .where(eq(scheduledMessages.id, row.id));
    }
    return due;
  });
}

/** Pause a row and tell its author why — the safety valve for "the author left
 * the destination" and for a send that failed outright.
 *
 * The note is sent once per reason, not once per attempt: a row already paused
 * for this exact reason is being re-tried by hand (run-now on a row that can't
 * post), and telling its author the same thing again is just noise. */
async function pauseWithError(row: Row, reason: string, notify: boolean): Promise<void> {
  const alreadyToldThem = !row.enabled && row.lastError === reason;
  await db
    .update(scheduledMessages)
    .set({
      enabled: false,
      nextRunAt: null,
      lastRunAt: new Date(),
      lastRunStatus: 'failed' as ScheduledRunStatus,
      lastError: reason,
      updatedAt: new Date(),
    })
    .where(eq(scheduledMessages.id, row.id));
  if (notify && !alreadyToldThem) await notifyAuthor(row, reason);
}

/**
 * Tell the author their scheduled message stopped, in their own "Just me"
 * conversation — the one place a message addressed to exactly one person is
 * guaranteed to land, and one they will see next time they open Flow.
 * Best-effort: a failed courtesy note must never keep a row from being paused.
 */
async function notifyAuthor(row: Row, reason: string): Promise<void> {
  try {
    const author = (await db.select().from(users).where(eq(users.id, row.authorUserId)).limit(1))[0];
    if (!author || author.deletedAt) return;
    const chan = (await db.select().from(channels).where(eq(channels.id, row.channelId)).limit(1))[0];
    const where = chan?.name ? `#${chan.name}` : 'a conversation';
    const selfDm = await createDm(row.workspaceId, row.authorUserId, []);
    const preview = decryptBody(row).slice(0, 120);
    await sendMessage(
      selfDm.id,
      row.authorUserId,
      newId(),
      `🕐 Your scheduled message to ${where} was paused — ${reason}.\n\n> ${preview}`,
      undefined,
      undefined,
      undefined,
      { expandMentions: false },
    );
  } catch (err) {
    console.error('scheduled message: could not notify author', { id: row.id, err });
  }
}

/**
 * Post one row. Runs the same checks a person would face — the author must
 * still exist and still be a member of the destination — and then goes through
 * the ordinary send path so nothing downstream can tell the difference.
 */
async function fireRow(row: Row, opts?: { manual?: boolean }): Promise<void> {
  const author = (await db.select().from(users).where(eq(users.id, row.authorUserId)).limit(1))[0];
  if (!author || author.deletedAt) {
    await pauseWithError(row, 'the author’s account is no longer active', false);
    return;
  }
  if (!(await isDestinationMember(row.channelId, row.authorUserId))) {
    await pauseWithError(row, 'you are no longer a member of that conversation', true);
    return;
  }

  try {
    const posted = await sendMessage(
      row.channelId,
      row.authorUserId,
      newId(),
      decryptBody(row),
      undefined,
      undefined,
      undefined,
      // Bodies are composed in a plain text box, so `@Name` is expanded here
      // the way an API-posted message is (#415) — a scheduled message that
      // mentions an agent has to ping it exactly like a typed one.
      { expandMentions: true, scheduled: true },
    );
    await db
      .update(scheduledMessages)
      .set({
        lastRunAt: new Date(),
        lastRunStatus: 'ok' as ScheduledRunStatus,
        lastMessageId: posted.id,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(scheduledMessages.id, row.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'send failed';
    if (opts?.manual) throw err; // a run-now failure belongs in the caller's response
    await pauseWithError(row, message, true);
  }
}

/** One pass: claim what's due and post it. Exported for tests, which drive it
 * directly rather than waiting on the interval. */
export async function runSchedulerTick(now: Date = new Date()): Promise<number> {
  const due = await claimDue(now);
  for (const row of due) await fireRow(row);
  return due.length;
}

let ticking = false;

/**
 * Start the in-process ticker. The first pass runs immediately: rows that came
 * due while the server was down are overdue at boot and fire once, right then.
 */
export function startScheduler(log?: FastifyBaseLogger): { stop(): void } {
  const tick = async (): Promise<void> => {
    if (ticking) return; // a slow pass must not overlap the next one
    ticking = true;
    try {
      const fired = await runSchedulerTick();
      if (fired > 0) log?.info({ fired }, 'scheduled messages posted');
    } catch (err) {
      log?.error({ err }, 'scheduled message tick failed');
    } finally {
      ticking = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
