// Everything an organization owns goes to its object: the path names the organization, or an id the directory can look up.
import { Hono, type Context } from 'hono';
import { WebhookReceiver } from 'livekit-server-sdk';
import { getCookie } from 'hono/cookie';
import { PatchMeBody, type UserDTO } from '@flow/shared';
import type { AuthKind } from '../directory/core';
import { hashToken, newId } from '../directory/core';
import { listVar } from '../directory/authHandoff';
import { ApiError, badRequest, notFound, unauthorized } from '../errors';
import { directory, type AuthEnv } from './auth';

export interface OrgRouteEnv extends AuthEnv {
  BLOBS: R2Bucket;
  GOOGLE_CLIENT_ID?: string;
  APPLE_AUDIENCE?: string;
  FLOW_SERVER_NAME?: string;
  FLOW_MAX_FILE_BYTES?: string;
  /** Huddles (LiveKit Cloud): all three set turns them on, as on the Node server. */
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
  LIVEKIT_URL?: string;
  /** Pushes: `apns` with the three credentials sends to Apple (org/push); anything else is the dev driver. */
  FLOW_PUSH_DRIVER?: string;
  FLOW_APNS_KEY?: string;
  FLOW_APNS_KEY_ID?: string;
  FLOW_APNS_TEAM_ID?: string;
  FLOW_HANDOFF_RETURN_URLS?: string;
}

const huddlesEnabled = (env: OrgRouteEnv) => !!(env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET && env.LIVEKIT_URL);
const pushEnabled = (env: OrgRouteEnv) => env.FLOW_PUSH_DRIVER === 'apns' && !!(env.FLOW_APNS_KEY && env.FLOW_APNS_KEY_ID && env.FLOW_APNS_TEAM_ID);
type C = Context<{ Bindings: OrgRouteEnv }>;

const orgStub = (c: C, id: string) => c.env.ORG.get(c.env.ORG.idFromName(id));
const IN_PATH = /^\/v1\/workspaces\/([0-9a-f-]{36})(?:\/|$)/;
const BY_ID = /^\/v1\/(?:channels|messages|files|artifacts|scheduled-messages|huddle\/invites)\/([0-9a-f-]{36})(?:\/|$)/;

async function caller(c: C): Promise<{ user: UserDTO | null; token: string | null; authKind: AuthKind | null; ip: string }> {
  const header = c.req.header('authorization');
  const token = (header?.startsWith('Bearer ') ? header.slice(7).trim() : getCookie(c, 'sid')) || null;
  const ip = c.req.header('cf-connecting-ip') ?? '';
  if (!token) return { user: null, token: null, authKind: null, ip };
  const { user, kind } = await directory(c, 'authenticate', token);
  return { user, token, authKind: kind, ip };
}

export const orgRoutes = new Hono<{ Bindings: OrgRouteEnv }>();

/** One socket per organization: `/v1/ws?workspace=<id>` (docs/specs/cloudflare-spikes.md, spike A). */
orgRoutes.get('/v1/ws', (c) => {
  const id = c.req.query('workspace');
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw notFound('name an organization: /v1/ws?workspace=<id>');
  return orgStub(c, id).fetch(c.req.raw);
});

/** The organizations a person belongs to, each answered by its own object. */
orgRoutes.get('/v1/me/workspaces', async (c) => {
  const who = await caller(c);
  if (!who.user) throw unauthorized('missing bearer token');
  const ids = await directory(c, 'organizationsOf', who.user.id);
  const answers = await Promise.all(ids.map((id) => orgStub(c, id).workspaceFor(who.user!) as Promise<unknown[]>));
  return c.json({ workspaces: answers.flat() });
});

orgRoutes.post('/v1/workspaces', async (c) => {
  const who = await caller(c);
  if (!who.user) throw unauthorized('missing bearer token');
  const id = newId();
  const slug = ((await c.req.raw.clone().json().catch(() => ({}))) as { slug?: unknown }).slug;
  if (typeof slug === 'string') await directory(c, 'reserveSlug', slug, id);
  const res = await orgStub(c, id).handle(c.req.raw, who, id);
  if (res.status >= 300 && typeof slug === 'string') await directory(c, 'releaseSlug', slug, id);
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
orgRoutes.get('/v1/config', (c) => c.json({
  google: !!c.env.GOOGLE_CLIENT_ID,
  googleClientId: c.env.GOOGLE_CLIENT_ID ?? null,
  apple: !!c.env.APPLE_AUDIENCE,
  maxFileBytes: Number(c.env.FLOW_MAX_FILE_BYTES ?? 100 * 1024 * 1024),
  huddles: huddlesEnabled(c.env),
}));

/**
 * LiveKit's webhook names no organization, only a room, whose name is the channel's id. The signature is checked here
 * first, so an unsigned request never wakes an object; the organization's object checks it again and applies it.
 * A room that is no channel of ours is acknowledged and dropped, so LiveKit does not retry it.
 */
orgRoutes.post('/v1/livekit/webhook', async (c) => {
  const invalid = () => c.json({ error: { code: 'invalid_webhook', message: 'invalid webhook' } }, 400);
  if (!huddlesEnabled(c.env)) return invalid();
  const body = await c.req.text();
  let room: string | undefined;
  try {
    const event = await new WebhookReceiver(c.env.LIVEKIT_API_KEY!, c.env.LIVEKIT_API_SECRET!).receive(body, c.req.header('authorization') ?? '');
    room = event.room?.name;
  } catch (err) {
    console.warn('livekit webhook rejected', String(err));
    return invalid();
  }
  const id = room && /^[0-9a-f-]{36}$/.test(room) ? await directory(c, 'organizationOfId', room) : null;
  if (!id) return c.json({ ok: true });
  const forward = new Request(c.req.url, { method: 'POST', headers: c.req.raw.headers, body });
  return orgStub(c, id).handle(forward, { user: null, token: null, authKind: null, ip: c.req.header('cf-connecting-ip') ?? '' }, null);
});

/** A person's profile lives in the directory, with a copy in each of their organizations. */
async function afterProfileChange(c: C, user: UserDTO): Promise<void> {
  const ids = await directory(c, 'organizationsOf', user.id);
  await Promise.all(ids.map((id) => orgStub(c, id).syncUser(user)));
}

orgRoutes.patch('/v1/me', async (c) => {
  const who = await caller(c);
  if (!who.user) throw unauthorized('missing bearer token');
  const parsed = PatchMeBody.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw badRequest('validation', parsed.error.issues[0]?.message ?? 'invalid request');
  const user = await directory(c, 'patchUser', who.user.id, parsed.data);
  await afterProfileChange(c, user);
  return c.json(user);
});

orgRoutes.delete('/v1/me', async (c) => {
  const who = await caller(c);
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
  const who = await caller(c);
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

orgRoutes.get('/v1/avatars/:key', async (c) => {
  if (!(await caller(c)).user) throw unauthorized('missing bearer token');
  const key = c.req.param('key');
  // Avatars from before the move are stored under the same names, all webp.
  const object = /^[0-9a-f-]{36}-\d+(\.[a-z]+)?$/.test(key) || AVATAR_KEY.test(key) ? await c.env.BLOBS.get(`avatars/${key}`) : null;
  if (!object) throw notFound('avatar not found');
  return new Response(object.body, { headers: { 'content-type': object.httpMetadata?.contentType ?? 'image/webp', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
});

/** The same request to each of a person's organizations, with the answers joined: lists concatenated, counts added. */
async function acrossOrganizations(c: C, sortKey?: string, limit?: number): Promise<Response> {
  const who = await caller(c);
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

orgRoutes.all('/v1/*', async (c) => {
  const { pathname } = new URL(c.req.url);
  const who = await caller(c);
  let id = IN_PATH.exec(pathname)?.[1] ?? null;
  const named = BY_ID.exec(pathname)?.[1];
  if (!id && named) {
    id = await directory(c, 'organizationOfId', named);
    if (!id) throw notFound();
  }
  id ??= await organizationOfToken(c, pathname);
  id ??= await organizationInRequest(c);
  if (!id) {
    // Paths that name no organization (join links, a member's own notifications, avatars) go to the caller's first one for now.
    if (!who.user) throw unauthorized('missing bearer token');
    id = (await directory(c, 'organizationsOf', who.user.id))[0] ?? null;
    if (!id) throw notFound();
  }
  return orgStub(c, id).handle(c.req.raw, who, null);
});
