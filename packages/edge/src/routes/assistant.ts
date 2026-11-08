// The assistant's routes (platform.md §5.5): Docs' old paths, /api/agent, /api/agent/turn, /api/agent/reset,
// /api/agent/permission and /api/settings/assistant, served by the Assistant object of the caller's account
// (src/assistant/object.ts, `idFromName(accountId)`), so Docs', Mail's and Calendar's panels talk to it unchanged. Mounted
// before Docs' /api/*; the rest of /api/agent (the jobs) stays Docs'. Answers are Docs-shaped (`{ error: string }`), as
// the three clients read them.
//
// The organization is the one the request names (`?workspace=`, as Mail and Calendar send it, or a turn's `workspace`, as
// Docs sends it), else the one a file chat's file is in, else the caller's first, as Docs' routes place a request.
import { Hono, type Context } from 'hono';
import type { Assistant } from '../assistant/object';
import { ApiError } from '../errors';
import { isFileId } from '../docs/server/ids.ts';
import { chatScope } from '../docs/shared/agent/protocol.ts';
import { directory, resolveCaller, tokenOf, type AuthEnv } from './auth';

export interface AssistantRouteEnv extends AuthEnv { ASSISTANT: DurableObjectNamespace<Assistant> }
type C = Context<{ Bindings: AssistantRouteEnv }>;

export const assistantRoutes = new Hono<{ Bindings: AssistantRouteEnv }>();

/** The organization a request is for: named, else a file chat's file's, else the caller's first; null in none. */
async function organizationOf(c: C, userId: string): Promise<string | null> {
  const named = c.req.query('workspace') || c.req.query('org');
  if (named) return named;
  let scope = c.req.query('scope');
  if (c.req.method === 'POST') {
    const body = (await c.req.raw.clone().json().catch(() => null)) as { workspace?: unknown; scope?: unknown; context?: unknown } | null;
    if (typeof body?.workspace === 'string' && body.workspace) return body.workspace;
    if (typeof body?.scope === 'string') scope = body.scope;
    else if (body?.context && typeof body.context === 'object') scope = chatScope(body.context as never);
  }
  if (scope && isFileId(scope)) {
    const org = await directory(c, 'organizationOfId', scope).catch(() => null);
    if (org) return org;
  }
  return (await directory(c, 'organizationsOf', userId))[0] ?? null;
}

async function forward(c: C): Promise<Response> {
  try {
    if (!tokenOf(c)) return c.json({ error: 'Not signed in' }, 401);
    const signedIn = await resolveCaller(c, null);
    if (!signedIn.user) return c.json({ error: 'Not signed in' }, 401);
    const organizationId = await organizationOf(c, signedIn.user.id);
    const who = organizationId ? await resolveCaller(c, organizationId) : signedIn;
    if (!who.user) return c.json({ error: 'Not signed in' }, 401);
    if (!who.account) return c.json({ error: organizationId ? 'You are not a member of this organization.' : 'Join an organization to use the assistant.', code: 'no_account' }, 403);
    const org = c.env.ORG.get(c.env.ORG.idFromName(who.account.organizationId));
    const channelIds = await org.channelIdsOf(who.user.id);
    const docs = { userId: who.user.id, email: who.user.email, token: who.token, ip: who.ip, accountId: who.account.id, channelIds };
    return await c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName(who.account.id)).handle(c.req.raw, who, docs);
  } catch (err) {
    if (err instanceof ApiError) return c.json({ error: err.message, code: err.code }, err.statusCode as 400);
    throw err;
  }
}

for (const path of ['/api/agent', '/api/agent/turn', '/api/agent/reset', '/api/agent/permission', '/api/settings/assistant']) assistantRoutes.all(path, forward);
