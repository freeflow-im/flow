// Everything an organization owns goes to its object: the path names the organization, or an id the directory can look up.
import { Hono, type Context } from 'hono';
import { verifyRtkWebhook } from '../rtkWebhook';
import { PatchMeBody, type UserDTO } from '@flow/shared';
import { AGENT_AVATAR_PRESETS, agentAvatarUrl, type AgentAvatarPreset } from '@flow/shared/assistant';
import { accountGate, hashToken, newId } from '../directory/core';
import { listVar } from '../directory/authHandoff';
import { ApiError, badRequest, notFound, unauthorized } from '../errors';
import { directory, resolveCaller, type AuthEnv } from './auth';
import { publishPlatformDomain, type PlatformDnsEnv } from '../directory/providers/cloudflareDns';
import { organizationDomain } from '../directory/addresses';
import { hostedMailEnabled, mailProviderFor, type MailProviderEnv } from '../mailprovider/index';

export interface OrgRouteEnv extends AuthEnv, PlatformDnsEnv, MailProviderEnv {
  BLOBS: R2Bucket;
  GOOGLE_CLIENT_ID?: string;
  APPLE_AUDIENCE?: string;
  FLOW_SERVER_NAME?: string;
  FLOW_MAX_FILE_BYTES?: string;
  /** Meet (Cloudflare RealtimeKit): all three set turns it on (docs/specs/meetings.md). */
  RTK_ACCOUNT_ID?: string;
  RTK_APP_ID?: string;
  RTK_API_TOKEN?: string;
  /** Pushes: `apns` with the three credentials sends to Apple (org/push); anything else is the dev driver. */
  FLOW_PUSH_DRIVER?: string;
  FLOW_APNS_KEY?: string;
  FLOW_APNS_KEY_ID?: string;
  FLOW_APNS_TEAM_ID?: string;
  FLOW_HANDOFF_RETURN_URLS?: string;
  PROVISIONING?: Queue<unknown>;
}

const meetEnabled = (env: OrgRouteEnv) => !!(env.RTK_ACCOUNT_ID && env.RTK_APP_ID && env.RTK_API_TOKEN);
const pushEnabled = (env: OrgRouteEnv) => env.FLOW_PUSH_DRIVER === 'apns' && !!(env.FLOW_APNS_KEY && env.FLOW_APNS_KEY_ID && env.FLOW_APNS_TEAM_ID);
type C = Context<{ Bindings: OrgRouteEnv }>;

const orgStub = (c: C, id: string) => c.env.ORG.get(c.env.ORG.idFromName(id));
const IN_PATH = /^\/v1\/workspaces\/([0-9a-f-]{36})(?:\/|$)/;
/** A Meet link's short code (org/services/meetings.ts `newMeetingCode`), indexed like an id. */
const MEETING_GUEST = /^\/v1\/meetings\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/guest$/;
const MEETING_CODE = /^\/v1\/meetings\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/;
const BY_ID = /^\/v1\/(?:channels|messages|files|artifacts|scheduled-messages|huddle\/invites|meetings|visitor-links)\/([0-9a-f-]{36})(?:\/|$)/;

export const orgRoutes = new Hono<{ Bindings: OrgRouteEnv }>();

/** One socket per organization: `/v1/ws?workspace=<id>` (docs/specs/cloudflare-spikes.md, spike A). */
orgRoutes.get('/v1/ws', async (c) => {
  const id = c.req.query('workspace');
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw notFound('name an organization: /v1/ws?workspace=<id>');
  // An id nobody belongs to would wake (and make) an object for nothing; the socket still authenticates in its first frame.
  if (!(await directory(c, 'organizationKnown', id))) throw notFound('no such organization');
  return orgStub(c, id).fetch(c.req.raw);
});

/** The organizations a person belongs to, each answered by its own object. */
orgRoutes.get('/v1/me/workspaces', async (c) => {
  const who = await resolveCaller(c);
  if (!who.user) throw unauthorized('missing bearer token');
  const ids = await directory(c, 'organizationsOf', who.user.id);
  const answers = await Promise.all(ids.map((id) => orgStub(c, id).workspaceFor(who.user!) as Promise<unknown[]>));
  return c.json({ workspaces: answers.flat() });
});

orgRoutes.post('/v1/workspaces', async (c) => {
  const id = newId();
  // The organization is new, so the caller has no account in it yet: the context names it with a null account.
  const who = await resolveCaller(c, id);
  if (!who.user) throw unauthorized('missing bearer token');
  // An agent cannot own an organization (platform.md §2.2).
  if (who.user.isAgent) throw new ApiError(403, 'agent_forbidden', 'an agent cannot create an organization');
  const slug = ((await c.req.raw.clone().json().catch(() => ({}))) as { slug?: unknown }).slug;
  if (typeof slug === 'string') await directory(c, 'reserveSlug', slug, id);
  const res = await orgStub(c, id).handle(c.req.raw, who, id);
  if (res.status >= 300 && typeof slug === 'string') await directory(c, 'releaseSlug', slug, id);
  // The platform subdomain's MX, SPF and DMARC (directory/providers/cloudflareDns.ts). A failure is logged; provisioning
  // (phase 5.3) writes them again.
  else if (typeof slug === 'string') {
    c.executionCtx.waitUntil(mailProviderFor(c.env).records(organizationDomain(slug)).then((r) => publishPlatformDomain(c.env, slug, r)).catch((err) => console.error(`platform dns ${slug}: ${(err as Error).message}`)));
  }
  return res;
});

// ---- what names no organization -------------------------------------------

orgRoutes.get('/healthz', (c) => c.json({ ok: true }));
orgRoutes.get('/v1/client-info', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({
    protocolVersion: 1,
    displayName: c.env.FLOW_SERVER_NAME ?? 'Flow',
    authMethods: ['password', 'email-link', ...(c.env.GOOGLE_CLIENT_ID ? ['google'] : []), ...(c.env.APPLE_AUDIENCE ? ['apple'] : [])],
    registrationAvailable: true,
    capabilities: { browserConnections: true, authHandoff: listVar(c.env.FLOW_HANDOFF_RETURN_URLS).length > 0, push: pushEnabled(c.env), pushRouting: true, desktop: true, socketPerOrganization: true },
  });
});
orgRoutes.get('/v1/config', (c) => {
  const hostedMail = hostedMailEnabled(c.env);
  // The provider's hosts, for a person setting up a mail client (the Admin app's Mail card); the address is only a shape.
  const settings = hostedMail ? mailProviderFor(c.env).mailSettings('someone@example.invalid') : null;
  return c.json({
    google: !!c.env.GOOGLE_CLIENT_ID,
    googleClientId: c.env.GOOGLE_CLIENT_ID ?? null,
    apple: !!c.env.APPLE_AUDIENCE,
    maxFileBytes: Number(c.env.FLOW_MAX_FILE_BYTES ?? 100 * 1024 * 1024),
    // Huddles were LiveKit calls; they are Meet rooms now (docs/specs/meetings.md phase 2), which clients find by `meet`.
    // Always false, so an app from before Meet hides its LiveKit huddle button instead of failing to join.
    huddles: false,
    meet: meetEnabled(c.env),
    hostedMail,
    ...(settings ? { mail: { imapHost: settings.imap.host, smtpHost: settings.smtp.host } } : {}),
  });
});

/**
 * RealtimeKit's webhook names its own meeting id, which the organization's object indexed when it made the room
 * (object.ts `_index_meeting_rtk`). The signature is checked here, so an unsigned request never wakes an object; a
 * meeting that is not ours is acknowledged and dropped, so RealtimeKit does not retry it. Only huddles use it.
 */
orgRoutes.post('/v1/rtk/webhook', async (c) => {
  const body = await c.req.text();
  if (!meetEnabled(c.env) || !(await verifyRtkWebhook(body, c.req.header('rtk-signature')))) {
    console.warn('realtimekit webhook rejected');
    return c.json({ error: { code: 'invalid_webhook', message: 'invalid webhook' } }, 401);
  }
  const rtkMeetingId = (JSON.parse(body) as { meeting?: { id?: string } }).meeting?.id;
  const id = rtkMeetingId && /^[0-9a-f-]{36}$/.test(rtkMeetingId) ? await directory(c, 'organizationOfId', rtkMeetingId) : null;
  if (!id) return c.json({ ok: true });
  const forward = new Request(c.req.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-flow-rtk-verified': '1' }, body });
  return orgStub(c, id).handle(forward, { user: null, token: null, authKind: null, ip: c.req.header('cf-connecting-ip') ?? '', organizationId: id, account: null }, null);
});

/** A person's profile lives in the directory, with a copy in each of their organizations. */
async function afterProfileChange(c: C, user: UserDTO): Promise<void> {
  const ids = await directory(c, 'organizationsOf', user.id);
  await Promise.all(ids.map((id) => orgStub(c, id).syncUser(user)));
}

orgRoutes.patch('/v1/me', async (c) => {
  const who = await resolveCaller(c);
  if (!who.user) throw unauthorized('missing bearer token');
  const parsed = PatchMeBody.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw badRequest('validation', parsed.error.issues[0]?.message ?? 'invalid request');
  const user = await directory(c, 'patchUser', who.user.id, parsed.data);
  await afterProfileChange(c, user);
  return c.json(user);
});

orgRoutes.delete('/v1/me', async (c) => {
  const who = await resolveCaller(c);
  if (!who.user) throw unauthorized('missing bearer token');
  if (who.user.isAgent) throw new ApiError(403, 'forbidden', 'agent accounts are removed by their sponsor or a workspace admin');
  const ids = await directory(c, 'organizationsOf', who.user.id);
  await Promise.all(ids.map((id) => orgStub(c, id).removeAccount(who.user!)));
  await directory(c, 'tombstoneUser', who.user.id);
  return c.json({ ok: true });
});

const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const AVATAR_KEY = /^[0-9a-f-]{36}-\d+\.[a-z]+$/;

orgRoutes.post('/v1/me/avatar', async (c) => {
  const who = await resolveCaller(c);
  if (!who.user) throw unauthorized('missing bearer token');
  const file = [...(await c.req.raw.formData()).values()].find((v): v is File => typeof v !== 'string');
  if (!file) throw badRequest('no_file', 'multipart file field required');
  if (!AVATAR_TYPES.has(file.type)) throw badRequest('bad_image', 'avatar must be png, jpeg, gif, or webp');
  const key = `${who.user.id}-${Date.now()}.${file.type.split('/')[1]}`;
  await c.env.BLOBS.put(`avatars/${key}`, file.stream(), { httpMetadata: { contentType: file.type } });
  const user = await directory(c, 'patchUser', who.user.id, { avatarUrl: `/v1/avatars/${key}` });
  await afterProfileChange(c, user);
  return c.json(user);
});

/**
 * The person's own assistant's picture (agents.md §1.1): a preset (`PUT {preset}`, or `{preset: null}` for none) or an
 * upload (`POST`, multipart, stored as a person's is). The organization's copy follows, so Chat shows it at once.
 */
/**
 * The agent whose picture a request sets: the caller's assistant, or the hosted agent `?agent=` names (agents.md §1.3) if
 * the caller may change it: one of their own private agents, or a shared one they sponsor or, as an owner or admin, run.
 */
async function myAssistant(c: C): Promise<{ agentId: string; organizationId: string }> {
  const organizationId = c.req.param('id')!;
  const who = await resolveCaller(c, organizationId);
  if (!who.user || !who.account) throw unauthorized('missing bearer token');
  if (who.account.kind === 'guest') throw new ApiError(403, 'guest', 'guests use Chat only; the assistant is for the organization\'s members');
  const named = c.req.query('agent');
  if (named) {
    const a = await directory(c, 'accountFor', named, organizationId);
    const admin = who.account.role === 'owner' || who.account.role === 'admin';
    const mine = a?.sponsorId === who.user.id;
    if (!a || a.state === 'removed' || a.agentRuntime !== 'hosted' || !(a.agentMode === 'personal' ? mine : a.agentMode === 'shared' && (mine || admin))) throw notFound('no such agent of yours here');
    return { agentId: named, organizationId };
  }
  const agentId = await directory(c, 'assistantOf', who.user.id, organizationId);
  if (!agentId) throw notFound('you have no assistant here');
  return { agentId, organizationId };
}
async function setAssistantPicture(c: C, agentId: string, organizationId: string, avatarUrl: string | null): Promise<UserDTO> {
  const user = await directory(c, 'patchUser', agentId, { avatarUrl });
  await orgStub(c, organizationId).syncUser(user);
  return user;
}
orgRoutes.put('/v1/workspaces/:id/assistant/avatar', async (c) => {
  const { agentId, organizationId } = await myAssistant(c);
  const body = (await c.req.json().catch(() => ({}))) as { preset?: unknown };
  const preset = body.preset === null ? null : (AGENT_AVATAR_PRESETS as readonly unknown[]).includes(body.preset) ? (body.preset as AgentAvatarPreset) : undefined;
  if (preset === undefined) throw badRequest('bad_preset', `preset: one of ${AGENT_AVATAR_PRESETS.join(', ')}, or null`);
  const user = await setAssistantPicture(c, agentId, organizationId, preset ? agentAvatarUrl(preset) : null);
  return c.json({ avatarUrl: user.avatarUrl ?? null });
});
orgRoutes.post('/v1/workspaces/:id/assistant/avatar', async (c) => {
  const { agentId, organizationId } = await myAssistant(c);
  const file = [...(await c.req.raw.formData()).values()].find((v): v is File => typeof v !== 'string');
  if (!file) throw badRequest('no_file', 'multipart file field required');
  if (!AVATAR_TYPES.has(file.type)) throw badRequest('bad_image', 'the picture must be png, jpeg, gif, or webp');
  if (file.size > 5 * 1024 * 1024) throw badRequest('too_large', 'the picture must be 5 MB or less');
  const key = `${agentId}-${Date.now()}.${file.type.split('/')[1]}`;
  await c.env.BLOBS.put(`avatars/${key}`, file.stream(), { httpMetadata: { contentType: file.type } });
  const user = await setAssistantPicture(c, agentId, organizationId, `/v1/avatars/${key}`);
  return c.json({ avatarUrl: user.avatarUrl ?? null });
});

orgRoutes.get('/v1/avatars/:key', async (c) => {
  if (!(await resolveCaller(c)).user) throw unauthorized('missing bearer token');
  const key = c.req.param('key');
  // Avatars from before the move are stored under the same names, all webp.
  const object = /^[0-9a-f-]{36}-\d+(\.[a-z]+)?$/.test(key) || AVATAR_KEY.test(key) ? await c.env.BLOBS.get(`avatars/${key}`) : null;
  if (!object) throw notFound('avatar not found');
  return new Response(object.body, { headers: { 'content-type': object.httpMetadata?.contentType ?? 'image/webp', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
});

/** The same request to each of a person's organizations, with the answers joined: lists concatenated, counts added. */
async function acrossOrganizations(c: C, sortKey?: string, limit?: number): Promise<Response> {
  const who = await resolveCaller(c);
  if (!who.user) throw unauthorized('missing bearer token');
  const ids = await directory(c, 'organizationsOf', who.user.id);
  const body = c.req.method === 'GET' ? null : await c.req.raw.clone().text();
  const answers = await Promise.all(ids.map(async (id) => {
    const res = await orgStub(c, id).handle(new Request(c.req.url, { method: c.req.method, headers: c.req.raw.headers, body }), who, null);
    return res.ok ? ((await res.json()) as Record<string, unknown>) : {};
  }));
  const joined: Record<string, unknown> = {};
  for (const answer of answers) {
    for (const [key, value] of Object.entries(answer)) {
      const have = joined[key];
      if (Array.isArray(value)) joined[key] = [...((have as unknown[]) ?? []), ...value];
      else if (typeof value === 'number') joined[key] = ((have as number) ?? 0) + value;
      else if (have === undefined || have === null) joined[key] = value;
    }
  }
  if (sortKey) {
    const list = joined[sortKey];
    if (Array.isArray(list)) joined[sortKey] = list.sort((a, b) => String(b.id).localeCompare(String(a.id))).slice(0, limit);
  }
  return c.json(joined);
}

orgRoutes.get('/v1/me/notifications', (c) => {
  const limit = Number(c.req.query('limit')) || 50;
  return acrossOrganizations(c, 'notifications', limit);
});
orgRoutes.post('/v1/me/notifications/read', (c) => acrossOrganizations(c));
orgRoutes.post('/v1/me/devices', (c) => acrossOrganizations(c));
orgRoutes.delete('/v1/me/devices/:token', (c) => acrossOrganizations(c));
orgRoutes.get('/v1/me/workspace-invites', (c) => acrossOrganizations(c));

/** An invitation or join link names its organization only through its token, whose hash the object reported when it was made. */
const TOKEN_PATH = /^\/v1\/(?:invites\/(?:accept|decline)|join-links\/redeem|agents\/redeem)$/;
const JOIN_PREVIEW = /^\/v1\/join-links\/([^/]+)$/;

async function organizationOfToken(c: C, pathname: string): Promise<string | null> {
  const preview = c.req.method === 'GET' ? JOIN_PREVIEW.exec(pathname)?.[1] : undefined;
  const body = preview || !TOKEN_PATH.test(pathname) ? {} : ((await c.req.raw.clone().json().catch(() => ({}))) as { token?: string; code?: string; inviteId?: string });
  if (body.inviteId) return directory(c, 'organizationOfId', body.inviteId);
  const token = preview ?? body.token ?? body.code;
  return token ? directory(c, 'organizationOfId', await hashToken(token)) : null;
}

/** A few paths name their organization in the query or the body. */
async function organizationInRequest(c: C): Promise<string | null> {
  const query = c.req.query('workspaceId');
  if (query) return query;
  if (c.req.method === 'GET' || !c.req.header('content-type')?.includes('json')) return null;
  const body = (await c.req.raw.clone().json().catch(() => ({}))) as { workspaceId?: string; channelId?: string };
  if (body.workspaceId) return body.workspaceId;
  return body.channelId ? directory(c, 'organizationOfId', body.channelId) : null;
}

// ---- channel visitors (docs/specs/chat-visitors.md) ---------------------------------------------------------------------

/** No one signed in: a visitor, or someone opening a visitor link. The object checks the link or the visitor's cookie. */
const nobody = (c: C, organizationId: string) => ({ user: null, token: null, authKind: null, ip: c.req.header('cf-connecting-ip') ?? '', organizationId, account: null });
const VISIT_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const LINK_GONE = 'This link no longer works. Ask the person who sent it for a new one.';

/** A visitor link names its organization only by its token, whose hash the object reported when it was made (§4). */
orgRoutes.on(['GET', 'POST'], '/v1/visit/:token', async (c) => {
  const token = c.req.param('token');
  const id = VISIT_TOKEN.test(token) ? await directory(c, 'organizationOfId', await hashToken(token)) : null;
  if (!id) throw notFound(LINK_GONE);
  return orgStub(c, id).handle(c.req.raw, nobody(c, id), null);
});

/**
 * The visitor's own routes and socket, by the `vsid` cookie: `<organization id>.<random>`. The prefix routes the request
 * to the organization's object, which checks the whole value's hash against its sessions; a forged prefix only reaches
 * an object that refuses it.
 */
orgRoutes.all('/v1/visitor/*', async (c) => {
  const id = /(?:^|;\s*)vsid=([0-9a-f-]{36})\./.exec(c.req.header('cookie') ?? '')?.[1];
  if (!id || !(await directory(c, 'organizationKnown', id))) throw unauthorized('your visit has ended');
  if (c.req.header('upgrade')?.toLowerCase() === 'websocket') return orgStub(c, id).fetch(c.req.raw);
  return orgStub(c, id).handle(c.req.raw, nobody(c, id), null);
});

orgRoutes.all('/v1/*', async (c) => {
  const { pathname } = new URL(c.req.url);
  let id = IN_PATH.exec(pathname)?.[1] ?? null;
  const named = BY_ID.exec(pathname)?.[1] ?? MEETING_CODE.exec(pathname)?.[1];
  if (!id && named) {
    id = await directory(c, 'organizationOfId', named);
    if (!id) throw notFound();
  }
  // An invitation or join link is how one comes (back) into an organization, so it is not refused for a removed account.
  const viaToken = id ? null : await organizationOfToken(c, pathname);
  if (viaToken) return orgStub(c, viaToken).handle(c.req.raw, { ...(await resolveCaller(c)), organizationId: viaToken }, null);
  id ??= await organizationInRequest(c);
  // A meeting's public guest routes work for anyone: a stale or expired session cookie makes the caller nobody there,
  // rather than refusing the guest (Meet docs/specs/meetings.md, guests by link).
  let who = id && MEETING_GUEST.test(pathname) ? await resolveCaller(c, id).catch((e) => { if (e instanceof ApiError && e.statusCode === 401) return nobody(c, id!); throw e; }) : await resolveCaller(c, id);
  if (!id) {
    // Paths that name no organization (join links, a member's own notifications, avatars) go to the caller's first one for now.
    if (!who.user) throw unauthorized('missing bearer token');
    id = (await directory(c, 'organizationsOf', who.user.id))[0] ?? null;
    if (!id) throw notFound();
    const account = await directory(c, 'accountFor', who.user.id, id);
    const refused = accountGate(account);
    if (refused) throw refused;
    who = { ...who, organizationId: id, account };
  }
  return orgStub(c, id).handle(c.req.raw, who, null);
});
