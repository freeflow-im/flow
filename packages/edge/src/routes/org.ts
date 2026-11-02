// Everything an organization owns goes to its object: the path names the organization, or an id the directory can look up.
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { UserDTO } from '@flow/shared';
import type { AuthKind } from '../directory/core';
import { hashToken, newId } from '../directory/core';
import { notFound, unauthorized } from '../errors';
import type { Org } from '../org/object';
import { directory, type AuthEnv } from './auth';

export interface OrgRouteEnv extends AuthEnv { ORG: DurableObjectNamespace<Org> }
type C = Context<{ Bindings: OrgRouteEnv }>;

const orgStub = (c: C, id: string) => c.env.ORG.get(c.env.ORG.idFromName(id));
const IN_PATH = /^\/v1\/workspaces\/([0-9a-f-]{36})(?:\/|$)/;
const BY_ID = /^\/v1\/(?:channels|messages|files|artifacts|scheduled-messages)\/([0-9a-f-]{36})(?:\/|$)/;

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
  return orgStub(c, id).handle(c.req.raw, who, id);
});

/** An invitation or join link names its organization only through its token, whose hash the object reported when it was made. */
const TOKEN_PATH = /^\/v1\/(?:invites\/(?:accept|decline)|join-links\/redeem)$/;
const JOIN_PREVIEW = /^\/v1\/join-links\/([^/]+)$/;

async function organizationOfToken(c: C, pathname: string): Promise<string | null> {
  const preview = c.req.method === 'GET' ? JOIN_PREVIEW.exec(pathname)?.[1] : undefined;
  const body = preview || !TOKEN_PATH.test(pathname) ? {} : ((await c.req.raw.clone().json().catch(() => ({}))) as { token?: string; inviteId?: string });
  if (body.inviteId) return directory(c, 'organizationOfId', body.inviteId);
  const token = preview ?? body.token;
  return token ? directory(c, 'organizationOfId', await hashToken(token)) : null;
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
  if (!id) {
    // Paths that name no organization (join links, a member's own notifications, avatars) go to the caller's first one for now.
    if (!who.user) throw unauthorized('missing bearer token');
    id = (await directory(c, 'organizationsOf', who.user.id))[0] ?? null;
    if (!id) throw notFound();
  }
  return orgStub(c, id).handle(c.req.raw, who, null);
});
