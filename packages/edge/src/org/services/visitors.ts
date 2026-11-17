// Channel visitors (docs/specs/chat-visitors.md): a person with no account, let into one public channel by a link, who
// sees only what was posted after they joined. A visitor is a users row (is_visitor) with no workspace_members row, so
// every member route refuses them as it is; the visitor routes (routes/visitors.ts) check the visitor's session and run
// the members' services inside `visitorGrant`, with the "sees from" cut (§2) applied. The socket filter is
// `visitorMayReceive`, which the Org object applies to every event it sends a visitor's socket.
import { and, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type {
  ChannelVisitorDTO,
  Event,
  MessageDTO,
  VisitorChannelPersonDTO,
  VisitorLinkDTO,
  VisitorMeDTO,
  VisitorPreviewDTO,
} from '@flow/shared';
import { db, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { hashToken, newLinkToken, newToken } from '../lib/tokens.js';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { config } from '../config.js';
import { disconnectUser } from '../sockets.js';
import { requireChannelAccess } from './channels.js';
import { postSystemMessage } from './messages.js';
import { requireMembership, visitorGrant, workspacePolicies, type VisitorGrant } from './workspaces.js';

const { users, channels, channelMembers, workspaces, messages, messageFiles, files, visitorLinks, channelVisitors, visitorSessions } = schema;

/** V7: a link works for 24 hours after it is made. */
export const VISITOR_LINK_MS = 24 * 3_600_000;
/** V8: a visitor's access ends 30 days after their last visit. */
export const VISITOR_IDLE_MS = 30 * 86_400_000;
export const VISITOR_NAME_MAX = 40;
/** The visitor's cookie: `<organization id>.<random>`, HttpOnly, path /v1/visitor. The prefix is how the Worker finds the
 * organization's object (routes/org.ts); only the hash of the whole value is kept here. */
export const VISITOR_COOKIE = 'vsid';
const LINK_GONE = 'This link no longer works. Ask the person who sent it for a new one.';

type ChannelRow = typeof channels.$inferSelect;

/**
 * Which channels take visitors (V6): public standard channels that are not archived. Meeting channels (the meeting chat
 * phase of docs/specs/meetings.md) are their own kind and will take visitors too: add that kind here.
 */
export function channelTakesVisitors(chan: Pick<ChannelRow, 'kind' | 'isPrivate' | 'archivedAt'>): boolean {
  if (chan.archivedAt) return false;
  return chan.kind === 'standard' && !chan.isPrivate;
}

async function visitorsOn(workspaceId: string): Promise<boolean> {
  const w = (await db.select({ policies: workspaces.policies }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0];
  return !!w && workspacePolicies(w).visitors !== 'off';
}

// ---- members: links and visitors --------------------------------------------------------------------------------------

/** A member who may make and turn off links in this channel: in it, and no guest account (§1.1). */
async function requireLinkMaker(channelId: string, actorId: string): Promise<ChannelRow> {
  const { chan, isMember } = await requireChannelAccess(channelId, actorId);
  const m = await requireMembership(chan.workspaceId, actorId);
  if (m.kind === 'guest') throw forbidden('guests cannot invite visitors');
  if (!channelTakesVisitors(chan)) throw badRequest('visitors_not_allowed', 'visitor links are for public channels only');
  if (!isMember) throw forbidden('join the channel to invite a visitor');
  return chan;
}

function toLinkDTO(l: typeof visitorLinks.$inferSelect, visitorCount: number, url?: string): VisitorLinkDTO {
  return {
    id: l.id,
    channelId: l.channelId,
    createdBy: l.createdBy,
    createdAt: l.createdAt.toISOString(),
    expiresAt: l.expiresAt.toISOString(),
    revokedAt: l.revokedAt?.toISOString() ?? null,
    visitorCount,
    ...(url ? { url } : {}),
  };
}

/** POST /v1/channels/:id/visitor-links: a link for 24 hours. The URL is in this answer only. */
export async function createVisitorLink(channelId: string, actorId: string): Promise<VisitorLinkDTO> {
  const chan = await requireLinkMaker(channelId, actorId);
  if (!(await visitorsOn(chan.workspaceId))) throw new ApiError(403, 'visitors_off', 'visitors are turned off in this organization');
  const token = newLinkToken();
  const now = new Date();
  const row = (await db
    .insert(visitorLinks)
    .values({ id: newId(), channelId, tokenHash: hashToken(token), createdBy: actorId, createdAt: now, expiresAt: new Date(now.getTime() + VISITOR_LINK_MS) })
    .returning())[0]!;
  return toLinkDTO(row, 0, `${config.webUrlBase}/chat/visit/${token}`);
}

/** GET /v1/channels/:id/visitor-links: the channel's open links, with how many came in by each. */
export async function listVisitorLinks(channelId: string, actorId: string): Promise<VisitorLinkDTO[]> {
  await requireChannelAccess(channelId, actorId);
  const rows = await db
    .select()
    .from(visitorLinks)
    .where(and(eq(visitorLinks.channelId, channelId), isNull(visitorLinks.revokedAt), gt(visitorLinks.expiresAt, new Date())))
    .orderBy(visitorLinks.createdAt);
  if (!rows.length) return [];
  const counts = await db
    .select({ linkId: channelVisitors.linkId, n: sql<number>`count(*)` })
    .from(channelVisitors)
    .where(inArray(channelVisitors.linkId, rows.map((r) => r.id)))
    .groupBy(channelVisitors.linkId);
  const byLink = new Map(counts.map((c) => [c.linkId, Number(c.n)]));
  return rows.map((r) => toLinkDTO(r, byLink.get(r.id) ?? 0));
}

/** DELETE /v1/visitor-links/:id: the link stops working, and everyone who came in by it is removed (§1.1). */
export async function revokeVisitorLink(linkId: string, actorId: string): Promise<{ ok: true; removed: number }> {
  const link = (await db.select().from(visitorLinks).where(eq(visitorLinks.id, linkId)).limit(1))[0];
  if (!link) throw notFound('link not found');
  const { chan } = await requireChannelAccess(link.channelId, actorId);
  const m = await requireMembership(chan.workspaceId, actorId);
  if (m.kind === 'guest') throw forbidden('guests cannot turn off visitor links');
  if (!link.revokedAt) await db.update(visitorLinks).set({ revokedAt: new Date() }).where(eq(visitorLinks.id, linkId));
  const removed = await removeVisitorsWhere(eq(channelVisitors.linkId, linkId));
  return { ok: true, removed };
}

/**
 * GET /v1/channels/:id/visitors: the channel's current visitors; with `?all=1` also those whose visit ended (marked
 * `removedAt`), so members' clients can still name the author of an older visitor message.
 */
export async function listChannelVisitors(channelId: string, actorId: string, includeRemoved = false): Promise<ChannelVisitorDTO[]> {
  await requireChannelAccess(channelId, actorId);
  const rows = await db
    .select({ v: channelVisitors, displayName: users.displayName })
    .from(channelVisitors)
    .innerJoin(users, eq(users.id, channelVisitors.userId))
    .where(includeRemoved ? eq(channelVisitors.channelId, channelId) : and(eq(channelVisitors.channelId, channelId), isNull(channelVisitors.removedAt)))
    .orderBy(channelVisitors.seesFrom);
  return rows.map(({ v, displayName }) => ({
    userId: v.userId,
    displayName,
    visitor: true,
    linkId: v.linkId,
    seesFrom: v.seesFrom.toISOString(),
    lastSeenAt: v.lastSeenAt.toISOString(),
    ...(v.removedAt ? { removedAt: v.removedAt.toISOString() } : {}),
  }));
}

/** DELETE /v1/channels/:id/visitors/:userId: any member of the organization who can see the channel (§1.4). */
export async function removeChannelVisitor(channelId: string, actorId: string, visitorId: string): Promise<void> {
  const { chan } = await requireChannelAccess(channelId, actorId);
  const m = await requireMembership(chan.workspaceId, actorId);
  if (m.kind === 'guest') throw forbidden('guests cannot remove visitors');
  const removed = await removeVisitorsWhere(and(eq(channelVisitors.channelId, channelId), eq(channelVisitors.userId, visitorId))!);
  if (!removed) throw notFound('no such visitor in this channel');
}

// ---- ending visits ----------------------------------------------------------------------------------------------------

/**
 * Ends the visits `where` names: the row marked removed (the users row stays, so old messages keep their name), the
 * session deleted, the socket closed. Returns how many ended.
 */
/** Archiving a channel ends its visits (a live socket would otherwise keep receiving its events). */
export async function removeChannelVisitors(channelId: string): Promise<number> {
  return removeVisitorsWhere(eq(channelVisitors.channelId, channelId));
}

async function removeVisitorsWhere(where: SQL): Promise<number> {
  const rows = await db.select({ userId: channelVisitors.userId }).from(channelVisitors).where(and(where, isNull(channelVisitors.removedAt)));
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.userId);
  await db.update(channelVisitors).set({ removedAt: new Date() }).where(and(where, isNull(channelVisitors.removedAt)));
  await db.delete(visitorSessions).where(inArray(visitorSessions.userId, ids));
  for (const id of ids) disconnectUser(id);
  return ids.length;
}

/** Visitors turned off for the organization (workspaces.ts `updateWorkspace`): every current visitor loses access. */
export function removeAllVisitors(): Promise<number> {
  return removeVisitorsWhere(sql`1 = 1`);
}

/** The visitor's own Leave (POST /v1/visitor/leave). */
export function endVisit(v: VisitorContext): Promise<number> {
  return removeVisitorsWhere(and(eq(channelVisitors.channelId, v.channelId), eq(channelVisitors.userId, v.userId))!);
}

/** The daily sweep (Org.alarm, V8): visitors not seen for 30 days lose access. */
export function sweepIdleVisitors(now = Date.now()): Promise<number> {
  return removeVisitorsWhere(sql`${channelVisitors.lastSeenAt} < ${now - VISITOR_IDLE_MS}`);
}

// ---- the public link --------------------------------------------------------------------------------------------------

/** A link that still works: known, not turned off, not past its 24 hours, visitors on, its channel still public. */
async function liveLink(token: string) {
  const row = (await db
    .select({ link: visitorLinks, chan: channels })
    .from(visitorLinks)
    .innerJoin(channels, eq(channels.id, visitorLinks.channelId))
    .where(eq(visitorLinks.tokenHash, hashToken(token)))
    .limit(1))[0];
  if (!row || row.link.revokedAt || row.link.expiresAt.getTime() <= Date.now()) return null;
  if (!channelTakesVisitors(row.chan) || !(await visitorsOn(row.chan.workspaceId))) return null;
  return row;
}

/** GET /v1/visit/:token: the name screen's organization and channel. */
export async function previewVisitorLink(token: string): Promise<VisitorPreviewDTO> {
  const row = await liveLink(token);
  if (!row) throw notFound(LINK_GONE);
  const w = (await db.select().from(workspaces).where(eq(workspaces.id, row.chan.workspaceId)).limit(1))[0]!;
  return {
    organization: { name: w.name, avatarUrl: w.avatarUrl },
    channel: { name: row.chan.name ?? '', topic: row.chan.topic },
    expiresAt: row.link.expiresAt.toISOString(),
  };
}

/**
 * V10: the Turnstile check on the name screen, against Cloudflare's siteverify, when TURNSTILE_SECRET is set. Unset (local
 * development, until the operator makes the widget), the check is skipped.
 */
export async function verifyTurnstile(response: unknown, ip: string): Promise<void> {
  const secret = config.turnstileSecret;
  if (!secret) {
    // Production (https) never runs without the check: refuse rather than let anyone in unchecked.
    if (config.secureCookies) throw new ApiError(503, 'turnstile_unavailable', 'Joining is not available right now.');
    return;
  }
  if (typeof response !== 'string' || !response) throw badRequest('turnstile_required', 'complete the check first');
  const form = new URLSearchParams({ secret, response });
  if (ip) form.set('remoteip', ip);
  let ok = false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    ok = res.ok && ((await res.json()) as { success?: boolean }).success === true;
  } catch (err) {
    console.error(`[visitors] turnstile: ${(err as Error).message}`);
  }
  if (!ok) throw new ApiError(403, 'turnstile_failed', 'the check did not pass; try again');
}

export function cleanVisitorName(name: unknown): string {
  if (typeof name !== 'string') throw badRequest('validation', 'name: expected a string');
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > VISITOR_NAME_MAX) throw badRequest('bad_name', `a name is 1 to ${VISITOR_NAME_MAX} characters`);
  return clean;
}

/**
 * POST /v1/visit/:token: makes the visitor (a users row, no member row), their place in the channel with "sees from" now,
 * and their session; posts "<name> joined as a visitor". The caller has checked Turnstile. Returns the cookie's value once.
 */
export async function joinByVisitorLink(token: string, rawName: unknown): Promise<{ me: VisitorMeDTO; sessionToken: string }> {
  const name = cleanVisitorName(rawName);
  const row = await liveLink(token);
  if (!row) throw notFound(LINK_GONE);
  const { link, chan } = row;
  const userId = newId();
  const now = new Date();
  const sessionToken = `${chan.workspaceId}.${newToken()}`;
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId, email: `visitor-${userId}@visitors.flow.local`, passwordHash: '!visitor', displayName: name, isVisitor: true, createdAt: now,
    });
    await tx.insert(channelVisitors).values({ channelId: chan.id, userId, linkId: link.id, seesFrom: now, lastSeenAt: now });
    await tx.insert(visitorSessions).values({ tokenHash: hashToken(sessionToken), userId, channelId: chan.id, createdAt: now });
  });
  const v: VisitorContext = { userId, workspaceId: chan.workspaceId, channelId: chan.id, seesFrom: now, displayName: name };
  await asVisitor(v, () => postSystemMessage(chan, userId, 'member_joined', 'joined as a visitor'));
  return { me: await visitorMe(v), sessionToken };
}

// ---- the visitor's session --------------------------------------------------------------------------------------------

export interface VisitorContext extends VisitorGrant { seesFrom: Date; displayName: string }

/** The `vsid` cookie's value in a Cookie header. */
export function visitorCookie(header: string | undefined): string | null {
  const m = /(?:^|;\s*)vsid=([^;]+)/.exec(header ?? '');
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/**
 * The visitor a session token names, or null when the visit has ended: no such session, removed, the channel no longer
 * public, or visitors turned off. A live visit is marked seen now (V8 counts from the last visit).
 */
export async function visitorBySession(token: string): Promise<VisitorContext | null> {
  const row = (await db
    .select({ v: channelVisitors, chan: channels, name: users.displayName })
    .from(visitorSessions)
    .innerJoin(channelVisitors, and(eq(channelVisitors.channelId, visitorSessions.channelId), eq(channelVisitors.userId, visitorSessions.userId)))
    .innerJoin(channels, eq(channels.id, visitorSessions.channelId))
    .innerJoin(users, eq(users.id, visitorSessions.userId))
    .where(eq(visitorSessions.tokenHash, hashToken(token)))
    .limit(1))[0];
  if (!row || row.v.removedAt) return null;
  if (!channelTakesVisitors(row.chan) || !(await visitorsOn(row.chan.workspaceId))) return null;
  const now = new Date();
  if (now.getTime() - row.v.lastSeenAt.getTime() >= VISITOR_IDLE_MS) return null;
  await db.update(channelVisitors).set({ lastSeenAt: now }).where(and(eq(channelVisitors.channelId, row.v.channelId), eq(channelVisitors.userId, row.v.userId)));
  return { userId: row.v.userId, workspaceId: row.chan.workspaceId, channelId: row.chan.id, seesFrom: row.v.seesFrom, displayName: row.name };
}

/** Runs the members' services as this visitor (workspaces.ts `visitorGrant`). */
export function asVisitor<T>(v: VisitorContext, fn: () => T): T {
  return visitorGrant.run({ userId: v.userId, workspaceId: v.workspaceId, channelId: v.channelId }, fn);
}

/** GET /v1/visitor/me: the visitor, their channel and the people in it (names and avatars only, §2). */
export async function visitorMe(v: VisitorContext): Promise<VisitorMeDTO> {
  const chan = (await db.select().from(channels).where(eq(channels.id, v.channelId)).limit(1))[0]!;
  const w = (await db.select().from(workspaces).where(eq(workspaces.id, v.workspaceId)).limit(1))[0]!;
  const members = await db
    .select({ userId: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, isAgent: users.isAgent })
    .from(channelMembers)
    .innerJoin(users, eq(users.id, channelMembers.userId))
    .where(and(eq(channelMembers.channelId, v.channelId), isNull(users.deletedAt)));
  const visitors = await db
    .select({ userId: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(channelVisitors)
    .innerJoin(users, eq(users.id, channelVisitors.userId))
    .where(and(eq(channelVisitors.channelId, v.channelId), isNull(channelVisitors.removedAt)));
  const people: VisitorChannelPersonDTO[] = [
    ...members.map((m) => ({ userId: m.userId, displayName: m.displayName, avatarUrl: m.avatarUrl, isAgent: m.isAgent })),
    ...visitors.map((p) => ({ ...p, isAgent: false, visitor: true })),
  ];
  return {
    user: { id: v.userId, displayName: v.displayName, visitor: true },
    organization: { id: w.id, name: w.name, avatarUrl: w.avatarUrl },
    channel: { id: chan.id, name: chan.name ?? '', topic: chan.topic, people },
    seesFrom: v.seesFrom.toISOString(),
  };
}

// ---- the "sees from" cut (§2) -----------------------------------------------------------------------------------------

/** A message the visitor may see: in their channel, and it or its thread's first message at or after "sees from". */
export async function visibleMessageRow(v: VisitorContext, messageId: string): Promise<typeof messages.$inferSelect> {
  const row = (await db.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0];
  if (!row || row.channelId !== v.channelId) throw notFound('message not found');
  const root = row.threadRootId ? (await db.select().from(messages).where(eq(messages.id, row.threadRootId)).limit(1))[0] : row;
  if (!root || root.createdAt < v.seesFrom) throw notFound('message not found');
  return row;
}

/** A file the visitor may open: their own upload, or one on a live message they can see (§2). */
export async function visitorFile(v: VisitorContext, fileId: string): Promise<typeof files.$inferSelect> {
  const f = (await db.select().from(files).where(and(eq(files.id, fileId), isNull(files.deletedAt), eq(files.status, 'ready'))).limit(1))[0];
  if (!f) throw notFound('file not found');
  if (f.userId === v.userId) return f;
  const on = await db
    .select({ id: messages.id })
    .from(messageFiles)
    .innerJoin(messages, eq(messages.id, messageFiles.messageId))
    .where(and(eq(messageFiles.fileId, fileId), eq(messages.channelId, v.channelId), isNull(messages.deletedAt)));
  for (const m of on) {
    if (await visibleMessageRow(v, m.id).then(() => true, () => false)) return f;
  }
  throw notFound('file not found');
}

/**
 * A visitor's message before it is sent (V5, §3): mentions of agents are dropped and written out as plain names, so no
 * agent is asked; mentions of anyone but the organization's people are dropped; group mentions (<!channel> and the like)
 * become plain text, so a visitor cannot notify a whole channel.
 */
export async function cleanVisitorPost(body: string, mentions: string[] | undefined): Promise<{ body: string; mentions: string[] }> {
  const named = [...new Set([...(mentions ?? []), ...[...body.matchAll(/<@([0-9a-f-]{36})>/g)].map((m) => m[1]!)])];
  const rows = named.length
    ? await db
        .select({ id: users.id, displayName: users.displayName, isAgent: users.isAgent, member: schema.workspaceMembers.userId })
        .from(users)
        .leftJoin(schema.workspaceMembers, eq(schema.workspaceMembers.userId, users.id))
        .where(inArray(users.id, named))
    : [];
  const agents = new Map(rows.filter((r) => r.isAgent).map((r) => [r.id, r.displayName]));
  const people = new Set(rows.filter((r) => !r.isAgent && r.member).map((r) => r.id));
  const clean = body
    .replace(/<@([0-9a-f-]{36})>/g, (whole, id: string) => (agents.has(id) ? `@${agents.get(id)}` : whole))
    .replace(/<!(channel|here|everyone)>/g, '@$1');
  return { body: clean, mentions: (mentions ?? []).filter((id) => people.has(id)) };
}

/** What a visitor's socket needs to judge an event: their channel and their "sees from" time (ms). */
export interface VisitorSocket { userId: string; channelId: string; seesFrom: number }
/** A message's creation time (ms) and thread root, or null when it is gone. */
export type MessageTimes = (id: string) => { createdAt: number; threadRootId: string | null } | null;

const USER_SUBJECT = /(?:^|\.)user\.([0-9a-f-]{36})(?:\.|$)/;
/** Events about the channel itself and its people (§2: name, topic and people are open to a visitor). */
const CHANNEL_EVENTS = new Set(['channel.updated', 'channel.archived', 'member.joined', 'member.left']);

/**
 * Whether a visitor's socket gets an event (§2, §6, V4): only events of their own channel; a message, reply, edit,
 * delete or reaction only when the message (or its thread's first message) is at or after "sees from"; typing outside an
 * older thread; the channel's name, topic and people. Never anyone's own subject, other channels or the organization.
 */
export function visitorMayReceive(v: VisitorSocket, subject: string, event: Event, times: MessageTimes): boolean {
  if (USER_SUBJECT.test(subject) || event.channelId !== v.channelId) return false;
  const rootVisible = (rootId: string) => {
    const root = times(rootId);
    return !!root && root.createdAt >= v.seesFrom;
  };
  switch (event.type) {
    case 'message.created':
    case 'thread.reply':
    case 'message.updated':
    case 'message.deleted':
    case 'message.purged': {
      const m = event.data as MessageDTO;
      if (m.channelId !== v.channelId) return false;
      return m.threadRootId ? rootVisible(m.threadRootId) : Date.parse(m.createdAt) >= v.seesFrom;
    }
    case 'reaction.added':
    case 'reaction.removed': {
      const m = times((event.data as { messageId: string }).messageId);
      if (!m) return false;
      return m.threadRootId ? rootVisible(m.threadRootId) : m.createdAt >= v.seesFrom;
    }
    case 'typing': {
      const root = (event.data as { threadRootId?: string }).threadRootId;
      return !root || rootVisible(root);
    }
    default:
      return CHANNEL_EVENTS.has(event.type);
  }
}
