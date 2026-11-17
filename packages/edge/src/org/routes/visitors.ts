// Channel visitors' routes (docs/specs/chat-visitors.md §5). Three sets:
//  - public (no session): the link's preview and the join, rate limited per address and per link;
//  - the visitor's own (/v1/visitor/*), authenticated by the HttpOnly `vsid` cookie, each checking the visitor's session
//    and then calling the members' services inside `asVisitor`, with the "sees from" cut (§2);
//  - the members' (links, the channel's visitors), behind requireAuth like every member route.
// A visitor has no workspace_members row, so the member routes keep refusing a visitor without a change.
import type { z, ZodTypeAny } from 'zod';
import {
  EditMessageBody,
  EmojiParam,
  ListChannelFilesQuery,
  ListMessagesQuery,
  ListThreadQuery,
  PresignUploadBody,
  SendMessageBody,
} from '@flow/shared';
import { ApiError, badRequest, unauthorized } from '../lib/errors.js';
import { rateAllow } from '../lib/rateLimit.js';
import { hashToken } from '../lib/tokens.js';
import { config } from '../config.js';
import { requireAuth, type CompatApp, type CompatReply, type CompatRequest } from './compat';
import * as msg from '../services/messages.js';
import * as rx from '../services/reactions.js';
import * as fl from '../services/files.js';
import * as vs from '../services/visitors.js';

function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw badRequest('validation', issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid request');
  }
  return r.data;
}

const TEN_MINUTES = 10 * 60_000;
const limited = () => new ApiError(429, 'rate_limited', 'Too many tries. Wait a few minutes.');

/**
 * The visitor's cookie: HttpOnly, only sent to /v1/visitor, never cross-site; kept 30 days, renewed on each visit. Also
 * set by a Meet guest's join (routes/index.ts), which makes the guest a visitor of the meeting's chat.
 */
export function setVisitorCookie(reply: CompatReply, token: string | null): void {
  const maxAge = token ? Math.floor(vs.VISITOR_IDLE_MS / 1000) : 0;
  reply.header(
    'set-cookie',
    `${vs.VISITOR_COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=/v1/visitor; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`,
  );
}

/** The visitor this request's cookie names; 401 when the visit has ended (the client then shows the link page). */
async function visitorOf(req: CompatRequest): Promise<vs.VisitorContext> {
  const token = vs.visitorCookie(req.headers.cookie);
  const v = token ? await vs.visitorBySession(token) : null;
  if (!v) throw unauthorized('your visit has ended');
  return v;
}

/** Serves a file download the way the member route does (routes/index.ts GET /v1/files/:id). */
function sendDownload(reply: CompatReply, dl: fl.FileDownload, inline: boolean) {
  if ('redirect' in dl) return reply.redirect(dl.redirect, 302);
  const f = dl.content;
  return reply
    .header('content-type', f.mimeType)
    .header('content-disposition', inline ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`)
    .header('x-content-type-options', 'nosniff')
    .send(f.data);
}

export function registerVisitorRoutes(app: CompatApp): void {
  // ---- public: the link -------------------------------------------------------------------------------------------
  // No sign-in: the token is the invitation, so both are capped per address, and joining per link too (V10).
  app.get('/v1/visit/:token', async (req) => {
    if (!rateAllow(`visit-preview:${req.ip}`, 120, TEN_MINUTES)) throw limited();
    const { token } = req.params as { token: string };
    return vs.previewVisitorLink(token);
  });

  app.post('/v1/visit/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const link = hashToken(token).toString('hex');
    if (!rateAllow(`visit-join:${req.ip}`, 20, TEN_MINUTES) || !rateAllow(`visit-join-link:${link}`, 100, TEN_MINUTES)) throw limited();
    const body = (req.body ?? {}) as { name?: unknown; turnstile?: unknown };
    vs.cleanVisitorName(body.name);
    await vs.verifyTurnstile(body.turnstile, req.ip);
    const { me, sessionToken } = await vs.joinByVisitorLink(token, body.name);
    setVisitorCookie(reply, sessionToken);
    return reply.status(201).send(me);
  });

  // ---- the visitor's own ------------------------------------------------------------------------------------------
  app.get('/v1/visitor/me', async (req, reply) => {
    const v = await visitorOf(req);
    setVisitorCookie(reply, vs.visitorCookie(req.headers.cookie));
    return reply.send(await vs.visitorMe(v));
  });

  app.post('/v1/visitor/leave', async (req, reply) => {
    const v = await visitorOf(req);
    await vs.endVisit(v);
    setVisitorCookie(reply, null);
    return reply.send({ ok: true });
  });

  app.get('/v1/visitor/messages', async (req) => {
    const v = await visitorOf(req);
    const q = parse(ListMessagesQuery, req.query);
    return vs.asVisitor(v, () => msg.listMessages(v.channelId, v.userId, q.before, q.limit, { since: v.seesFrom }));
  });

  app.get('/v1/visitor/messages/:id', async (req) => {
    const v = await visitorOf(req);
    const { id } = req.params as { id: string };
    await vs.visibleMessageRow(v, id);
    return vs.asVisitor(v, () => msg.getMessageFor(id, v.userId));
  });

  app.get('/v1/visitor/messages/:id/thread', async (req) => {
    const v = await visitorOf(req);
    const { id } = req.params as { id: string };
    const q = parse(ListThreadQuery, req.query);
    return vs.asVisitor(v, () => msg.listThread(id, v.userId, q.after, q.limit, { since: v.seesFrom }));
  });

  app.post('/v1/visitor/messages', async (req, reply) => {
    const v = await visitorOf(req);
    if (!rateAllow(`visitor-post:${v.userId}`, 30, 60_000)) throw limited();
    const body = parse(SendMessageBody, req.body);
    if (body.threadRootId) await vs.visibleMessageRow(v, body.threadRootId);
    const clean = await vs.cleanVisitorPost(body.body, body.mentions);
    const dto = await vs.asVisitor(v, () =>
      msg.sendMessage(v.channelId, v.userId, body.clientMsgId, clean.body, body.threadRootId, body.fileIds, clean.mentions, { expandMentions: false }),
    );
    return reply.status(201).send(dto);
  });

  app.patch('/v1/visitor/messages/:id', async (req) => {
    const v = await visitorOf(req);
    const { id } = req.params as { id: string };
    await vs.visibleMessageRow(v, id);
    const body = parse(EditMessageBody, req.body);
    const clean = await vs.cleanVisitorPost(body.body, []);
    return vs.asVisitor(v, () => msg.editMessage(id, v.userId, clean.body));
  });

  app.delete('/v1/visitor/messages/:id', async (req) => {
    const v = await visitorOf(req);
    const { id } = req.params as { id: string };
    await vs.visibleMessageRow(v, id);
    await vs.asVisitor(v, () => msg.deleteMessage(id, v.userId));
    return { ok: true };
  });

  app.put('/v1/visitor/messages/:id/reactions/:emoji', async (req) => {
    const v = await visitorOf(req);
    const { id, emoji } = req.params as { id: string; emoji: string };
    if (!rateAllow(`visitor-react:${v.userId}`, 60, 60_000)) throw limited();
    await vs.visibleMessageRow(v, id);
    const parsed = parse(EmojiParam, decodeURIComponent(emoji));
    return { reactions: await vs.asVisitor(v, () => rx.addReaction(id, v.userId, parsed)) };
  });

  app.delete('/v1/visitor/messages/:id/reactions/:emoji', async (req) => {
    const v = await visitorOf(req);
    const { id, emoji } = req.params as { id: string; emoji: string };
    await vs.visibleMessageRow(v, id);
    const parsed = parse(EmojiParam, decodeURIComponent(emoji));
    return { reactions: await vs.asVisitor(v, () => rx.removeReaction(id, v.userId, parsed)) };
  });

  // Files (V9), with the normal limits: a multipart upload, or the presigned flow for larger files.
  app.post('/v1/visitor/files', async (req, reply) => {
    const v = await visitorOf(req);
    if (!rateAllow(`visitor-upload:${v.userId}`, 30, TEN_MINUTES)) throw limited();
    const part = await req.file();
    if (!part) throw badRequest('no_file', 'multipart file field required');
    const data = await part.toBuffer();
    const dto = await vs.asVisitor(v, () => fl.uploadFile(v.workspaceId, v.userId, part.filename ?? 'file', part.mimetype, data));
    return reply.status(201).send(dto);
  });

  app.post('/v1/visitor/files/presign', async (req, reply) => {
    const v = await visitorOf(req);
    if (!rateAllow(`visitor-upload:${v.userId}`, 30, TEN_MINUTES)) throw limited();
    const body = parse(PresignUploadBody, req.body);
    const dto = await vs.asVisitor(v, () => fl.createPresignedUpload(v.workspaceId, v.userId, body.filename, body.mimeType, body.sizeBytes));
    return reply.status(201).send(dto);
  });

  app.put('/v1/visitor/files/:id/content', async (req) => {
    const v = await visitorOf(req);
    const { id } = req.params as { id: string };
    if (!Buffer.isBuffer(req.body)) throw badRequest('no_body', 'raw request body required');
    await fl.putPendingContent(id, v.userId, req.body as Buffer);
    return { ok: true };
  });

  app.post('/v1/visitor/files/:id/complete', async (req) => {
    const v = await visitorOf(req);
    const { id } = req.params as { id: string };
    return fl.completeUpload(id, v.userId);
  });

  // The channel's files, cut like its messages (§2).
  app.get('/v1/visitor/files', async (req) => {
    const v = await visitorOf(req);
    const q = parse(ListChannelFilesQuery, req.query);
    return vs.asVisitor(v, () => fl.listChannelFiles(v.channelId, v.userId, q.sort, q.before, q.limit, { since: v.seesFrom }));
  });

  // A file opens only through a message the visitor can see (or their own upload).
  app.get('/v1/visitor/files/:id', async (req, reply) => {
    const v = await visitorOf(req);
    const { id } = req.params as { id: string };
    return sendDownload(reply, await fl.downloadOfFile(await vs.visitorFile(v, id)), false);
  });

  app.get('/v1/visitor/files/:id/thumb', async (req, reply) => {
    const v = await visitorOf(req);
    const { id } = req.params as { id: string };
    return sendDownload(reply, await fl.thumbOfFile(await vs.visitorFile(v, id)), true);
  });

  // ---- members ----------------------------------------------------------------------------------------------------
  app.post('/v1/channels/:id/visitor-links', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.status(201).send(await vs.createVisitorLink(id, req.user.id));
  });

  app.get('/v1/channels/:id/visitor-links', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return { links: await vs.listVisitorLinks(id, req.user.id) };
  });

  app.delete('/v1/visitor-links/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return vs.revokeVisitorLink(id, req.user.id);
  });

  app.get('/v1/channels/:id/visitors', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const all = (req.query as { all?: string } | undefined)?.all === '1';
    return { visitors: await vs.listChannelVisitors(id, req.user.id, all) };
  });

  app.delete('/v1/channels/:id/visitors/:userId', { preHandler: requireAuth }, async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    await vs.removeChannelVisitor(id, req.user.id, userId);
    return { ok: true };
  });
}
