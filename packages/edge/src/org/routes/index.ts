import type { z, ZodTypeAny } from 'zod';
import {
  AcceptInviteBody,
  DeclineInviteBody,
  WorkspaceInviteBody,
  AddChannelMemberBody,
  CreateChannelBody,
  CreateDmBody,
  CreateInviteBody,
  CreateWorkspaceBody,
  CreateWorkspaceEmojiBody,
  DeviceTokenParam,
  EditMessageBody,
  EmojiParam,
  ListChannelFilesQuery,
  ListMessagesQuery,
  ListNotificationsQuery,
  ListThreadQuery,
  AppLinkExchangeBody,
  CompleteSignupBody,
  ForgotPasswordBody,
  GoogleAuthBody,
  AppleAuthBody,
  LoginBody,
  ResetPasswordBody,
  SigninLinkBody,
  ConsumeSigninLinkBody,
  MarkNotificationsReadBody,
  MarkReadBody,
  PatchMeBody,
  PresignUploadBody,
  RegisterBody,
  CreateArtifactBody,
  UpdateArtifactBody,
  AgentLoginBody,
  RedeemAgentInviteBody,
  RedeemJoinLinkBody,
  CreateScheduledMessageBody,
  ListScheduledMessagesQuery,
  UpdateScheduledMessageBody,
  SendMessageBody,
  SendWorkspaceEmailBody,
  PreviewWorkspaceEmailBody,
  AdoptEmailImageBody,
  SetChannelEmojiBody,
  SetChannelIndicatorBody,
  SetMemberRoleBody,
  HuddleInviteReplyBody,
  SetNotifyLevelBody,
  UpdateChannelBody,
  UpdateWorkspaceBody,
  type UserDTO,
} from '@flow/shared';
import { ApiError, badRequest, notFound, unauthorized } from '../lib/errors.js';
import { rateAllow } from '../lib/rateLimit.js';
import { rateAllowDb } from '../lib/rateLimitDb.js';
import { parseByteRange } from '../lib/httpRange.js';
import { blobStore } from '../storage/index.js';

/** Blob-store key the notarized macOS DMG is uploaded to (see /download/mac). */
const DOWNLOAD_MAC_KEY = 'downloads/Flow.dmg';
/** Sparkle auto-update assets (appcast + update archives) live under this prefix. */
const UPDATE_MAC_PREFIX = 'downloads/mac/';
/** Only the shapes Sparkle fetches — never an arbitrary blob key.
 * Deltas are `Flow<to>-<from>.delta` (no hyphen after "Flow"), so they need
 * their own alternative; the feed advertises them and a 404 here silently
 * costs every updater the full ~5 MB archive instead of ~500 KB. */
const UPDATE_ASSET_RE = /^(appcast\.xml|Flow-[A-Za-z0-9._-]+\.zip|Flow[0-9]+-[0-9]+\.delta)$/;
import { config } from '../config';
import type { AuthKind } from '../../directory/core';
import { detachUserFromWorkspace, disconnectUser } from '../sockets';
import type { CompatApp as FastifyInstance, CompatReply as FastifyReply, CompatRequest as FastifyRequest } from './compat';
import * as ws from '../services/workspaces.js';
import * as ch from '../services/channels.js';
import * as ci from '../services/channelIndicators.js';
import * as ce from '../services/channelEmoji.js';
import * as hd from '../services/huddles.js';
import * as hi from '../services/huddleInvites.js';
import * as msg from '../services/messages.js';
import * as rx from '../services/reactions.js';
import * as wse from '../services/workspaceEmoji.js';
import * as fl from '../services/files.js';
import * as dv from '../services/devices.js';
import * as nt from '../services/notifications.js';
import * as us from '../services/users.js';
import * as cem from '../services/communityEmail.js';
import { deleteMyAccount } from '../services/accountDeletion.js';
import * as unfurl from '../services/unfurl/index.js';
import * as ag from '../services/agents.js';
import * as wi from '../services/workspaceInvites.js';
import * as ar from '../services/artifacts.js';
import * as sm from '../services/scheduledMessages.js';


function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw badRequest('validation', issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid request');
  }
  return r.data;
}

import { requireAuth } from './compat';

/** Read a single multipart file part into a buffer (20 MB cap enforced by the plugin). */
async function readUpload(req: FastifyRequest): Promise<{ filename: string; mimeType: string; data: Buffer }> {
  const part = await (req as FastifyRequest & { file(): Promise<undefined | { filename?: string; mimetype: string; toBuffer(): Promise<Buffer> }> }).file();
  if (!part) throw badRequest('no_file', 'multipart file field required');
  const data = await part.toBuffer();
  return { filename: part.filename ?? 'file', mimeType: part.mimetype, data };
}


export function registerRoutes(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, _req: unknown, reply: FastifyReply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    const fastifyErr = err as { statusCode?: number; message?: string };
    if (fastifyErr.statusCode && fastifyErr.statusCode < 500) {
      return reply
        .status(fastifyErr.statusCode)
        .send({ error: { code: 'bad_request', message: fastifyErr.message ?? 'bad request' } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'internal server error' } });
  });



  // Public bootstrap payload: which auth options this deployment offers, so the
  // signed-out client knows without a failed round-trip. A Google OAuth *web*
  // client id is public by design — it ships in the page that calls Google.
  // Built-in help docs (#383). Public like /v1/config and served raw: the
  // content is documentation checked into the repo, and each client renders the
  // markdown with its own pipeline. Lives under /v1 like the rest of the API;
  // /api is reserved for the Workspace app (docs/specs/freeflow-suite.md).



  // Public macOS app download (operator feature): 302 to a short-lived signed
  // URL for the notarized DMG in blob storage. No auth — it's linked from the
  // signed-out page. The DMG is uploaded out-of-band to key `downloads/Flow.dmg`
  // (see docs/ops/DEPLOYMENT.md § macOS download); 404s until it exists.
  app.get('/download/mac', async (_req, reply) => {
    const store = blobStore();
    const signed = await store.presignGet(DOWNLOAD_MAC_KEY, {
      filename: 'Flow.dmg',
      contentType: 'application/x-apple-diskimage',
    });
    if (signed) return reply.redirect(signed, 302);
    // Local driver can't presign: proxy the bytes if the object exists, else 404.
    const head = await store.head(DOWNLOAD_MAC_KEY);
    if (!head) throw notFound('no macOS build available');
    const data = await store.get(DOWNLOAD_MAC_KEY);
    return reply
      .header('content-type', 'application/x-apple-diskimage')
      .header('content-disposition', "attachment; filename*=UTF-8''Flow.dmg")
      .send(data);
  });

  // Sparkle auto-update assets: the appcast the installed app polls, and the
  // update archives it names. Same publish-by-overwrite model as the DMG — a
  // new build ships by uploading these, no code deploy. Public by design (the
  // app checks before anyone signs in); integrity comes from the EdDSA
  // signature in the feed, which the app verifies against the public key baked
  // into its bundle, not from the transport.
  app.get('/download/mac/:asset', async (req, reply) => {
    const { asset } = req.params as { asset: string };
    if (!UPDATE_ASSET_RE.test(asset)) throw notFound('unknown update asset');
    const key = UPDATE_MAC_PREFIX + asset;
    const isFeed = asset.endsWith('.xml');
    const contentType = isFeed
      ? 'application/xml'
      : asset.endsWith('.delta')
        ? 'application/octet-stream'
        : 'application/zip';
    const store = blobStore();
    // The feed must never be cached stale — it IS the "is there an update"
    // answer. Archives are immutable (versioned filenames) and cache freely.
    reply.header('cache-control', isFeed ? 'no-cache' : 'public, max-age=31536000, immutable');
    const signed = await store.presignGet(key, { filename: asset, contentType });
    if (signed) return reply.redirect(signed, 302);
    const head = await store.head(key);
    if (!head) throw notFound('no update available');
    const data = await store.get(key);
    return reply.header('content-type', contentType).send(data);
  });

  // ---- auth ----------------------------------------------------

  // Signup-link "finish your account" form (email-first registration).




  // Passwordless sign-in: request a one-time link (open, no enumeration),
  // then redeem it for a session (open).


  // Google Sign-In (phase 16). Open, like login — the ID token IS the proof.
  // Sign-in and registration are one operation; the response also names any
  // workspaces the user's email domain auto-enrolled them into.

  // Sign in with Apple (native iOS flow). Same contract as /v1/auth/google:
  // open, the identity token IS the proof, sign-in and registration are one
  // operation, and the response names any auto-enrolled workspaces.


  // The session as the cookie too (lib/sessionCookie.ts), for a client that holds only the bearer — a session
  // from before the cookie existed — and is leaving for the Workspace app, whose pages carry the cookie alone.

  // Web-to-app handoff: mint a one-time code (auth'd), exchange it (open).


  // Bound handoff endpoints are separate so old app-link exchanges cannot downgrade PKCE.

  // ---- me ------------------------------------------------------

  // Self-service account deletion (App Store 5.1.1(v)). The clients gate this
  // behind an explicit confirmation; the server just needs a valid session.

  app.post('/v1/me/avatar', { preHandler: requireAuth }, async (req) => {
    const { mimeType, data } = await readUpload(req);
    return us.setAvatar(req.user.id, data, mimeType);
  });

  app.get('/v1/me/workspaces', { preHandler: requireAuth }, async (req) => ({
    workspaces: await ws.myWorkspaces(req.user.id),
  }));

  app.get('/v1/me/notifications', { preHandler: requireAuth }, async (req) => {
    const q = parse(ListNotificationsQuery, req.query);
    return nt.listNotifications(req.user.id, q.before, q.limit, q.workspaceId);
  });

  app.post('/v1/me/notifications/read', { preHandler: requireAuth }, async (req) => {
    const body = parse(MarkNotificationsReadBody, req.body);
    const { unreadCount } = await nt.markNotificationsRead(req.user.id, body);
    return { ok: true, unreadCount };
  });

  // ---- push devices (#245) -------------------------------------
  // Registration is idempotent and called on every cold start; the upsert
  // rebinds a token that has changed hands rather than duplicating it.
  app.post('/v1/me/devices', { preHandler: requireAuth }, async (req) => {
    const body = parse(dv.ConnectionDeviceBody, req.body);
    return dv.registerDevice(req.user.id, body);
  });

  // Sign-out. The client must call this *before* it discards the session
  // token — afterwards it cannot authenticate, the row leaks, and the next
  // owner of the phone gets someone else's pushes until APNs 410s the token.
  app.delete('/v1/me/devices/:token', { preHandler: requireAuth }, async (req) => {
    const { token } = req.params as { token: string };
    const { routingId } = parse(dv.UnregisterDeviceQuery, req.query);
    return dv.unregisterDevice(req.user.id, parse(DeviceTokenParam, token), routingId);
  });

  // ---- users / avatars -----------------------------------------
  app.get('/v1/users/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return us.getUser(id, req.user.id);
  });

  app.get('/v1/avatars/:key', { preHandler: requireAuth }, async (req, reply) => {
    const { key } = req.params as { key: string };
    const data = await us.getAvatar(key);
    return reply
      .header('content-type', 'image/webp')
      .header('cache-control', 'private, max-age=31536000, immutable') // key changes per upload
      .header('x-content-type-options', 'nosniff')
      .send(data);
  });

  // Phase 11 §6: proxied link-preview images. Content-addressed and derived
  // from public pages, but still auth'd — an open image proxy is an abuse
  // vector, and this keeps the client's loading path identical to avatars.
  app.get('/v1/unfurl-images/:key', { preHandler: requireAuth }, async (req, reply) => {
    const { key } = req.params as { key: string };
    const data = await unfurl.getUnfurlImage(key);
    return reply
      .header('content-type', 'image/webp')
      .header('cache-control', 'private, max-age=31536000, immutable') // key is a content hash
      .header('x-content-type-options', 'nosniff')
      .send(data);
  });

  // ---- workspaces ----------------------------------------------
  app.post('/v1/workspaces', { preHandler: requireAuth }, async (req, reply) => {
    const body = parse(CreateWorkspaceBody, req.body);
    const dto = await ws.createWorkspace(req.user.id, body.name, body.slug, body.googleSelfRegisterDomain);
    return reply.status(201).send(dto);
  });

  app.get('/v1/workspaces/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return ws.getWorkspace(id, req.user.id);
  });

  // workspace branding (phase 3.5): owner/admin only
  app.patch('/v1/workspaces/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(UpdateWorkspaceBody, req.body);
    return ws.updateWorkspace(id, req.user.id, body);
  });

  // workspace avatar (#336): owner/admin sets or clears the image mark; both
  // paths broadcast `workspace.updated` so every client restyles live.
  app.post('/v1/workspaces/:id/avatar', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const { mimeType, data } = await readUpload(req);
    return ws.setWorkspaceAvatar(id, req.user.id, data, mimeType);
  });

  app.delete('/v1/workspaces/:id/avatar', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return ws.clearWorkspaceAvatar(id, req.user.id);
  });

  // ---- Community email (#481, owner/admin, web-only UI) ----
  // Markdown in, sanitized HTML out — rendered by the same service function
  // the preview route calls, so what the composer shows is what ships.
  app.post('/v1/workspaces/:id/email', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(SendWorkspaceEmailBody, req.body);
    return cem.sendBroadcast(id, req.user.id, body.subject, body.markdown);
  });

  // "Send test to me" (#484): the same draft, to the author alone, on its own
  // lighter rate limit — so checking the rendering never costs the broadcast.
  app.post('/v1/workspaces/:id/email/test', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(SendWorkspaceEmailBody, req.body);
    return cem.sendTestBroadcast(id, req.user.id, body.subject, body.markdown);
  });

  app.post('/v1/workspaces/:id/email/preview', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(PreviewWorkspaceEmailBody, req.body);
    return cem.previewBroadcast(id, req.user.id, body.markdown);
  });

  // The To chip's number, from the server that decides who is a recipient —
  // the client filtering the roster itself would be a second implementation of
  // the rule, free to drift.
  app.get('/v1/workspaces/:id/email/recipients', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return { recipientCount: await cem.countBroadcastRecipients(id, req.user.id) };
  });

  // Pasted images (#492): the bytes went up through the normal presign flow;
  // this adopts one as a broadcast image and returns the public URL that goes
  // into the markdown.
  app.post('/v1/workspaces/:id/email/images', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(AdoptEmailImageBody, req.body);
    return reply.status(201).send(await cem.adoptEmailImage(id, req.user.id, body.fileId));
  });

  // ...and the unauthenticated read. Deliberately no `requireAuth`: the thing
  // fetching this is a mail client (or Gmail's image proxy) with no session,
  // and the token in the path is the entire access check.
  app.get('/v1/email-images/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const img = await cem.getEmailImage(token);
    if ('redirect' in img) return reply.redirect(img.redirect, 302);
    return reply
      .header('content-type', img.content.mimeType)
      .header('content-disposition', 'inline')
      // Immutable: the token names one file's bytes forever, and mail clients
      // and image proxies re-fetch aggressively.
      .header('cache-control', 'public, max-age=604800, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(img.content.data);
  });

  // ---- First-class AI agents (AGENT_MEMBERS.md): invite-code onboarding ----
  // Sponsor side: mint a one-time invite code for a workspace they belong to.
  app.post('/v1/workspaces/:id/agent-invites', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = await ag.createAgentInvite(id, req.user.id);
    return reply.status(201).send(dto); // raw code — shown once
  });

  // Agent side: redeem the code (the code IS the auth). Creates the agent and
  // joins it immediately; returns the token synchronously. Rate-limited.
  app.post('/v1/agents/redeem', async (req, reply) => {
    if (!rateAllow(`agent-redeem:${req.ip}`, 20, 10 * 60_000)) {
      throw new ApiError(429, 'rate_limited', 'too many attempts — try again later');
    }
    const body = parse(RedeemAgentInviteBody, req.body);
    const res = await ag.redeemAgentInvite(body);
    return reply.status(201).send(res); // raw token — shown once
  });

  // Unauthenticated: username + key → fresh token (revokes prior tokens).
  app.post('/v1/agents/login', async (req, reply) => {
    if (!rateAllow(`agent-login:${req.ip}`, 20, 10 * 60_000)) {
      throw new ApiError(429, 'rate_limited', 'too many login attempts — try again later');
    }
    const body = parse(AgentLoginBody, req.body);
    const res = await ag.agentLogin(body.username, body.key);
    return reply.status(201).send(res); // raw token — shown once
  });

  app.delete('/v1/workspaces/:id/agents/:userId', { preHandler: requireAuth }, async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    await ag.removeAgent(id, userId, req.user.id);
    return { ok: true };
  });

  // Two shapes, one route (#577): `emails` returns a per-address result list,
  // `email` keeps the single-invite DTO current macOS/iOS clients parse.
  app.post('/v1/workspaces/:id/invites', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(CreateInviteBody, req.body);
    if (body.emails) {
      const results = await ws.createInvites(id, req.user.id, body.emails);
      return reply.status(201).send({ results });
    }
    const dto = await ws.createInvite(id, req.user.id, body.email!);
    return reply.status(201).send(dto);
  });

  app.post('/v1/invites/accept', { preHandler: requireAuth }, async (req) => {
    const body = parse(AcceptInviteBody, req.body);
    return ws.acceptInvite(req.user.id, body);
  });

  // ---- "Invite to workspace" from a profile popup (#357 agents / #359 people)
  // The picker's list: my workspaces this member isn't in yet. Same question
  // for an agent and a person, so one route answers both.
  app.get('/v1/users/:id/workspace-invites', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return wi.workspaceInviteTargets(id, req.user.id);
  });

  // Agents join on the spot — the inviter vouches for them and becomes their
  // sponsor in the target workspace (#357).
  app.post('/v1/agents/:id/workspace-invites', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(WorkspaceInviteBody, req.body);
    const res = await ag.inviteAgentToWorkspace(id, body.workspaceId, req.user.id);
    return reply.status(201).send(res);
  });

  // People are asked, not added (#359): this creates a pending invitation they
  // accept or decline. Repeating it returns the invitation already in flight.
  app.post('/v1/users/:id/workspace-invites', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(WorkspaceInviteBody, req.body);
    const res = await wi.inviteUserToWorkspace(id, body.workspaceId, req.user.id);
    return reply.status(res.created ? 201 : 200).send(res);
  });

  // The invitee's side: their live invitations, and the "no thanks" that ends one.
  app.get('/v1/me/workspace-invites', { preHandler: requireAuth }, async (req) => {
    return { invites: await wi.listMyWorkspaceInvites(req.user.id) };
  });

  app.post('/v1/invites/decline', { preHandler: requireAuth }, async (req) => {
    const body = parse(DeclineInviteBody, req.body);
    await ws.declineInvite(req.user.id, body.inviteId);
    return { ok: true };
  });

  // ---- Persistent workspace join link (issue #85): one live link per
  // workspace, managed by owners/admins, redeemable by anyone who has it.
  app.get('/v1/workspaces/:id/join-link', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return ws.getJoinLink(id, req.user.id);
  });

  app.post('/v1/workspaces/:id/join-link', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return ws.createJoinLink(id, req.user.id);
  });

  app.delete('/v1/workspaces/:id/join-link', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return ws.revokeJoinLink(id, req.user.id);
  });

  // Unauthenticated on purpose: the landing page names the workspace before
  // the visitor has signed up. The token is the authorization — which makes
  // this the one guessing oracle on the join-link surface, so it is capped.
  // The limit is loose because a link pasted in a busy channel means many
  // legitimate people clicking from behind one NAT address.
  app.get('/v1/join-links/:token', async (req) => {
    if (!rateAllow(`join-preview:${req.ip}`, 60, 10 * 60_000)) {
      throw new ApiError(429, 'rate_limited', 'too many attempts — try again later');
    }
    const { token } = req.params as { token: string };
    return ws.previewJoinLink(token);
  });

  // Keyed by user, not IP: redeeming already costs an account, and an office
  // full of people joining off the same link shares one egress address.
  app.post('/v1/join-links/redeem', { preHandler: requireAuth }, async (req) => {
    // per-user key → DB-backed window, counted across replicas (phase 18 M1)
    if (!(await rateAllowDb(`join-redeem:${req.user.id}`, 20, 10 * 60_000))) {
      throw new ApiError(429, 'rate_limited', 'too many attempts — try again later');
    }
    const body = parse(RedeemJoinLinkBody, req.body);
    return ws.redeemJoinLink(req.user.id, body.token);
  });

  app.get('/v1/workspaces/:id/members', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return { members: await ws.listMembers(id, req.user.id) };
  });

  // The sole owner's only way out (#340 follow-up): they cannot leave a
  // workspace with nobody to transfer it to, so they can end it instead.
  app.delete('/v1/workspaces/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await ws.deleteWorkspace(id, req.user.id);
    detachUserFromWorkspace(req.user.id, id);
    return { ok: true };
  });

  // Self-service departure (#340). Not under the admin block below: any
  // member may leave, and the only one who may not is the owner.
  app.post('/v1/workspaces/:id/leave', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await ws.leaveWorkspace(id, req.user.id);
    // Sockets last: the service published member.left, and detaching writes it
    // straight to this user's other clients before dropping the subscription.
    detachUserFromWorkspace(req.user.id, id);
    return { ok: true };
  });

  // ---- admin panel: manage users (owner/admin, web-only UI) ----
  app.patch('/v1/workspaces/:id/members/:userId/role', { preHandler: requireAuth }, async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const body = parse(SetMemberRoleBody, req.body);
    return ws.setMemberRole(id, req.user.id, userId, body.role);
  });

  app.delete('/v1/workspaces/:id/members/:userId', { preHandler: requireAuth }, async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    await ws.removeMember(id, req.user.id, userId);
    return { ok: true };
  });

  // ---- channels ------------------------------------------------
  app.post('/v1/workspaces/:id/channels', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(CreateChannelBody, req.body);
    const dto = await ch.createChannel(id, req.user.id, body.name, body.topic, body.isPrivate, body.parentId);
    return reply.status(201).send(dto);
  });

  app.get('/v1/workspaces/:id/channels', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const { includeArchived } = req.query as { includeArchived?: string };
    const opts = { includeArchived: includeArchived === '1' || includeArchived === 'true' };
    return { channels: await ch.listChannels(id, req.user.id, opts) };
  });

  // DM upsert (phase2.md §1): returns the existing channel for this member set or creates it
  app.post('/v1/workspaces/:id/dms', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(CreateDmBody, req.body);
    const dto = await ch.createDm(id, req.user.id, body.userIds);
    return reply.status(201).send(dto);
  });

  app.post('/v1/channels/:id/join', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return ch.joinChannel(id, req.user.id);
  });

  // rename / topic (ui_nits item 5): any channel member
  app.patch('/v1/channels/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(UpdateChannelBody, req.body);
    return ch.updateChannel(id, req.user.id, { name: body.name, topic: body.topic });
  });

  // ---- channel membership management (phase2.md §5) ------------
  app.get('/v1/channels/:id/members', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return { userIds: await ch.listMemberIds(id, req.user.id) };
  });

  app.post('/v1/channels/:id/members', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(AddChannelMemberBody, req.body);
    await ch.addMember(id, req.user.id, body.userId);
    return reply.status(201).send({ ok: true });
  });

  app.delete('/v1/channels/:id/members/:userId', { preHandler: requireAuth }, async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    await ch.removeMember(id, req.user.id, userId);
    return { ok: true };
  });

  app.post('/v1/channels/:id/leave', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await ch.removeMember(id, req.user.id, req.user.id);
    return { ok: true };
  });

  app.post('/v1/channels/:id/archive', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return ch.archiveChannel(id, req.user.id);
  });

  // Activity indicator (#137): agents spin the sidebar row while they work.
  // Transient — see services/channelIndicators.ts for how it can't get stuck on.
  app.put('/v1/channels/:id/indicator', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(SetChannelIndicatorBody, req.body);
    return ci.setChannelIndicator(id, req.user.id, body.state, body.ttlSeconds);
  });

  // Channel emoji (#396): a persistent glyph after the channel's name, drawn in
  // the same sidebar slot as the indicator above and its opposite in kind — a
  // column, not a TTL'd claim. `{ "emoji": null }` (or "") clears it.
  app.put('/v1/channels/:id/emoji', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(SetChannelEmojiBody, req.body);
    return ce.setChannelEmoji(id, req.user.id, body.emoji);
  });

  // Huddles (LiveKit Cloud): entity-scoped voice/video. Ambient in a channel,
  // a ring in a DM or group DM (#436). See CONTEXT.md (Huddle, Huddle invite)
  // and services/huddles.ts for the join/leave/webhook design. Join is
  // idempotent — re-mints a fresh token, also the reconnect path — and in a DM
  // it is what starts the ring.
  app.post('/v1/channels/:id/huddle/join', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return hd.joinHuddle(id, req.user.id);
  });

  app.post('/v1/channels/:id/huddle/leave', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await hd.leaveHuddle(id, req.user.id);
    return { ok: true };
  });

  // Answering a ring is joining: accept marks the target answered (so the
  // user's other devices dismiss with "Answered on another device") and then
  // takes the ordinary join path for the token — there is no second way in.
  // Agent-token callers additionally get a short-lived speech-only grant;
  // ordinary joins and all human clients never receive one.
  app.post('/v1/huddle/invites/:id/accept', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(HuddleInviteReplyBody, req.body ?? {});
    const invite = await hi.acceptInvite(id, req.user.id, body.sessionId);
    if (!invite) throw new ApiError(404, 'invite_not_found', 'that huddle is no longer ringing');
    return hd.joinHuddle(invite.channelId, req.user.id, { includeInferenceToken: req.authKind === 'agent' });
  });

  app.post('/v1/huddle/invites/:id/decline', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(HuddleInviteReplyBody, req.body ?? {});
    await hi.declineInvite(id, req.user.id, body.sessionId);
    return { ok: true };
  });

  // The caller giving up before anyone answered. Leaving the room does this
  // too (the roster empties); this is the explicit "never mind" button.
  app.post('/v1/huddle/invites/:id/cancel', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await hi.cancelInvite(id, req.user.id);
    return { ok: true };
  });

  app.put('/v1/channels/:id/notify', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(SetNotifyLevelBody, req.body);
    await ch.setNotifyLevel(id, req.user.id, body.level);
    return { ok: true };
  });

  app.post('/v1/channels/:id/read', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(MarkReadBody, req.body);
    await ch.markRead(id, req.user.id, body.lastReadMsgId, body.threadRootId);
    return { ok: true };
  });

  // ---- messages ------------------------------------------------
  app.get('/v1/channels/:id/messages', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(ListMessagesQuery, req.query);
    return msg.listMessages(id, req.user.id, q.before, q.limit);
  });

  // Channel Files panel (#347): every file shared in the channel, sorted and
  // cursor-paged. Membership is checked in the service, same as reading.
  app.get('/v1/channels/:id/files', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(ListChannelFilesQuery, req.query);
    return fl.listChannelFiles(id, req.user.id, q.sort, q.before, q.limit);
  });

  app.get('/v1/channels/:id/pins', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return { messages: await msg.listPinnedMessages(id, req.user.id) };
  });

  app.post('/v1/channels/:id/messages', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(SendMessageBody, req.body);
    const dto = await msg.sendMessage(
      id,
      req.user.id,
      body.clientMsgId,
      body.body,
      body.threadRootId,
      body.fileIds,
      body.mentions,
      // #415: an API-posted `@Name` becomes a real mention. On by default for
      // agent/bot tokens only — the composer resolves its own mentions, and a
      // client session posting raw `@Name` meant it literally.
      { expandMentions: body.expandMentions ?? req.authKind === 'agent' },
    );
    return reply.status(201).send(dto);
  });

  app.patch('/v1/messages/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(EditMessageBody, req.body);
    return msg.editMessage(id, req.user.id, body.body);
  });

  app.delete('/v1/messages/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    // ?purge=true fully removes the row (no tombstone); default is a soft delete.
    const { purge } = req.query as { purge?: string };
    await msg.deleteMessage(id, req.user.id, {
      hard: purge === 'true' || purge === '1',
      // The bridge's agent status row must vanish on completion;
      // session-authenticated human authors stay on the soft-delete path
      // unless they are owner/admin.
      allowOwnPermanentDelete: req.user.isAgent,
    });
    return { ok: true };
  });

  app.put('/v1/messages/:id/pin', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return msg.pinMessage(id, req.user.id);
  });

  app.delete('/v1/messages/:id/pin', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return msg.unpinMessage(id, req.user.id);
  });

  app.get('/v1/messages/:id/thread', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(ListThreadQuery, req.query);
    return msg.listThread(id, req.user.id, q.after, q.limit);
  });

  // Phase 11 §10: the sender removes one link preview from their message.
  // Writes a tombstone, so a re-render (or an edit) can't resurrect it.
  app.delete('/v1/messages/:id/unfurls/:urlHash', { preHandler: requireAuth }, async (req) => {
    const { id, urlHash } = req.params as { id: string; urlHash: string };
    await unfurl.deleteUnfurlAsUser(id, urlHash, req.user.id);
    return { ok: true };
  });

  // ---- reactions (phase2.md §2) --------------------------------
  app.put('/v1/messages/:id/reactions/:emoji', { preHandler: requireAuth }, async (req) => {
    const { id, emoji } = req.params as { id: string; emoji: string };
    const parsed = parse(EmojiParam, decodeURIComponent(emoji));
    return { reactions: await rx.addReaction(id, req.user.id, parsed) };
  });

  app.delete('/v1/messages/:id/reactions/:emoji', { preHandler: requireAuth }, async (req) => {
    const { id, emoji } = req.params as { id: string; emoji: string };
    const parsed = parse(EmojiParam, decodeURIComponent(emoji));
    return { reactions: await rx.removeReaction(id, req.user.id, parsed) };
  });

  // ---- custom emoji (#175) -------------------------------------
  // Listing is member-level (you need the images to render other people's
  // reactions); create/delete are owner/admin, enforced in the service.
  app.get('/v1/workspaces/:id/emoji', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return { emoji: await wse.listEmoji(id, req.user.id) };
  });

  app.post('/v1/workspaces/:id/emoji', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(CreateWorkspaceEmojiBody, req.body);
    const dto = await wse.createEmoji(id, req.user.id, body.shortcode, body.fileId);
    return reply.status(201).send(dto);
  });

  app.delete('/v1/workspaces/:id/emoji/:emojiId', { preHandler: requireAuth }, async (req) => {
    const { emojiId } = req.params as { emojiId: string };
    await wse.deleteEmoji(emojiId, req.user.id);
    return { ok: true };
  });

  // ---- files (phase2.md §3; presigned direct uploads 2026-07-20) ----
  app.post('/v1/workspaces/:id/files', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { filename, mimeType, data } = await readUpload(req);
    const dto = await fl.uploadFile(id, req.user.id, filename, mimeType, data);
    return reply.status(201).send(dto);
  });

  // presign → client PUTs the bytes (direct to R2, or the /content fallback) → complete
  app.post('/v1/workspaces/:id/files/presign', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(PresignUploadBody, req.body);
    const dto = await fl.createPresignedUpload(id, req.user.id, body.filename, body.mimeType, body.sizeBytes);
    return reply.status(201).send(dto);
  });

  app.put('/v1/files/:id/content', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    if (!Buffer.isBuffer(req.body)) throw badRequest('no_body', 'raw request body required');
    await fl.putPendingContent(id, req.user.id, req.body as Buffer);
    return { ok: true };
  });

  app.post('/v1/files/:id/complete', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return fl.completeUpload(id, req.user.id);
  });

  app.get('/v1/files/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dl = await fl.getFileDownload(id, req.user.id);
    if ('redirect' in dl) {
      // R2 serves the bytes (and handles Range itself). The URL is short-lived
      // and access was just checked, so a plain 302 is safe to hand out.
      return reply.redirect(dl.redirect, 302);
    }
    const f = dl.content;
    reply
      .header('accept-ranges', 'bytes') // video players probe this before seeking
      .header('content-type', f.mimeType)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .header('x-content-type-options', 'nosniff'); // never execute uploaded HTML on our origin
    const range = parseByteRange(req.headers.range, f.data.length);
    if (range === 'unsatisfiable') {
      return reply.status(416).header('content-range', `bytes */${f.data.length}`).send();
    }
    if (range) {
      return reply
        .status(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${f.data.length}`)
        .send(f.data.subarray(range.start, range.end + 1));
    }
    return reply.send(f.data);
  });

  // streaming URL for in-place playback (<video src>): JSON, not a redirect,
  // so clients can hand it straight to a media element / player
  app.get('/v1/files/:id/url', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return fl.getStreamUrl(id, req.user.id);
  });

  // Short-lived thumbnail URL for direct use by <img>. Keeping the presign in
  // JSON avoids making a bearer-authenticated fetch cross the R2 redirect.
  app.get('/v1/files/:id/thumb/url', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return fl.getThumbUrl(id, req.user.id);
  });

  // ---- artifacts (phase 13: per-channel shared objects) ----
  app.post('/v1/artifacts', { preHandler: requireAuth }, async (req, reply) => {
    const body = parse(CreateArtifactBody, req.body);
    const dto = await ar.createArtifact(req.user.id, body.channelId, {
      fileId: body.fileId,
      url: body.url,
      name: body.name,
      ownsFile: body.ownsFile,
      app: body.app,
      requesterUserId: body.requesterUserId,
      sourceThreadRootId: body.sourceThreadRootId,
      operationId: body.operationId,
    });
    // With `app: true` this DTO carries `appSecret` — the only time it ever
    // travels besides a rotation (MINI_APPS.md).
    return reply.status(201).send(dto);
  });

  // ---- mini apps (docs/design/MINI_APPS.md) ----
  // Mint a 5-minute identity token for the caller; members only, same gate as
  // every other artifact operation. The app's guard verifies it offline.
  app.post('/v1/artifacts/:id/app-token', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return ar.mintArtifactAppToken(id, req.user.id);
  });

  // Rotate the app's secret — returned once, and every token minted under the
  // old one stops verifying. Creator or workspace admin.
  app.post('/v1/artifacts/:id/app-secret', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return ar.rotateArtifactAppSecret(id, req.user.id);
  });

  app.get('/v1/workspaces/:id/artifacts', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return { artifacts: await ar.listArtifacts(id, req.user.id) };
  });

  // Mini apps across the workspace (#394) — the sidebar's "Apps" section. Wider
  // than the list above: apps in *public* channels are listed whether or not the
  // caller has joined one, which is what makes them discoverable.
  app.get('/v1/workspaces/:id/app-artifacts', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return { artifacts: await ar.listAppArtifacts(id, req.user.id) };
  });

  app.get('/v1/artifacts/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return ar.getArtifact(id, req.user.id);
  });

  // rename and/or re-point at a new file (the agent "update" path)
  app.patch('/v1/artifacts/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(UpdateArtifactBody, req.body);
    return ar.updateArtifact(id, req.user.id, body);
  });

  app.delete('/v1/artifacts/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await ar.deleteArtifact(id, req.user.id);
    return { ok: true };
  });

  // ---- scheduled messages (#419) ----
  // A scheduled message is a pending message, so these are message-shaped
  // endpoints, not job endpoints: create/edit/delete, plus the two verbs a
  // schedule needs that a message doesn't (pause/resume, run now).
  app.post('/v1/scheduled-messages', { preHandler: requireAuth }, async (req, reply) => {
    const body = parse(CreateScheduledMessageBody, req.body);
    return reply.status(201).send(await sm.createScheduledMessage(req.user.id, body));
  });

  // Visibility-scoped: rows you authored, plus rows destined for a channel you
  // are in. `mine=true` is the panel's "Owned by me" filter.
  app.get('/v1/scheduled-messages', { preHandler: requireAuth }, async (req) => {
    const q = parse(ListScheduledMessagesQuery, req.query);
    const scheduledMessages = await sm.listScheduledMessages(q.workspaceId, req.user.id, q.mine === 'true');
    return { scheduledMessages };
  });

  app.patch('/v1/scheduled-messages/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return sm.updateScheduledMessage(id, req.user.id, parse(UpdateScheduledMessageBody, req.body));
  });

  app.delete('/v1/scheduled-messages/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await sm.deleteScheduledMessage(id, req.user.id);
    return { ok: true };
  });

  app.post('/v1/scheduled-messages/:id/pause', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return sm.setScheduledMessageEnabled(id, req.user.id, false);
  });

  app.post('/v1/scheduled-messages/:id/resume', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return sm.setScheduledMessageEnabled(id, req.user.id, true);
  });

  // Post it now, out of band. The cadence is untouched — this is "send it
  // again", not "reschedule".
  app.post('/v1/scheduled-messages/:id/run', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return sm.runScheduledMessageNow(id, req.user.id);
  });

  app.get('/v1/files/:id/thumb', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dl = await fl.getThumbDownload(id, req.user.id);
    if ('redirect' in dl) return reply.redirect(dl.redirect, 302);
    const f = dl.content;
    return reply
      .header('content-type', f.mimeType)
      .header('content-disposition', 'inline')
      .header('cache-control', 'private, max-age=31536000, immutable') // thumbs never change for a file id
      .header('x-content-type-options', 'nosniff')
      .send(f.data);
  });
}
