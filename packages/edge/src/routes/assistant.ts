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
import { isFileId } from '@flow/docs/server/ids.ts';
import { chatScope } from '@flow/docs/shared/agent/protocol.ts';
import { directory, guestRefusal, resolveCaller, tokenOf, type AuthEnv } from './auth';
import { orgModelKey } from '../assistant/orgModel';

export interface AssistantRouteEnv extends AuthEnv { ASSISTANT: DurableObjectNamespace<Assistant>; DOCS: DurableObjectNamespace<import('../docs/object').Docs>; MAIL: DurableObjectNamespace<import('../imap/object').Mail> }
type C = Context<{ Bindings: AssistantRouteEnv }>;

export const assistantRoutes = new Hono<{ Bindings: AssistantRouteEnv }>();

/** The organization a request is for: named, else a file chat's file's, else the caller's first; null in none. */
async function organizationOf(c: C, req: Request, userId: string): Promise<string | null> {
  const named = (new URL(req.url).searchParams.get('workspace') ?? undefined) || (new URL(req.url).searchParams.get('org') ?? undefined);
  if (named) return named;
  let scope = (new URL(req.url).searchParams.get('scope') ?? undefined);
  if (req.method === 'POST') {
    const body = (await req.clone().json().catch(() => null)) as { workspace?: unknown; scope?: unknown; context?: unknown } | null;
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

/** The agent a request names (`?agent=`, or a turn's `agent`), or null for the person's own assistant. */
async function agentOf(req: Request): Promise<string | null> {
  const q = (new URL(req.url).searchParams.get('agent') ?? undefined);
  if (q) return q;
  if (req.method !== 'POST') return null;
  const body = (await req.clone().json().catch(() => null)) as { agent?: unknown; scope?: unknown; context?: unknown } | null;
  return typeof body?.agent === 'string' && body.agent ? body.agent : null;
}

/** The files a request is about, to check a shared agent may see them (agents.md §6): the chat's, and the open page's. */
async function filesOf(req: Request): Promise<string[]> {
  const ids = new Set<string>();
  if (req.method === 'GET') {
    const scope = (new URL(req.url).searchParams.get('scope') ?? undefined);
    if (scope && isFileId(scope)) ids.add(scope);
    return [...ids];
  }
  const body = (await req.clone().json().catch(() => null)) as { scope?: unknown; context?: unknown } | null;
  if (typeof body?.scope === 'string' && isFileId(body.scope)) ids.add(body.scope);
  if (body?.context && typeof body.context === 'object') {
    const page = chatScope(body.context as never);
    if (isFileId(page)) ids.add(page);
  }
  return [...ids];
}

async function forward(c: C, req: Request = c.req.raw): Promise<Response> {
  try {
    if (!tokenOf(c)) return c.json({ error: 'Not signed in' }, 401);
    const signedIn = await resolveCaller(c, null);
    if (!signedIn.user) return c.json({ error: 'Not signed in' }, 401);
    const organizationId = await organizationOf(c, req, signedIn.user.id);
    const who = organizationId ? await resolveCaller(c, organizationId) : signedIn;
    if (!who.user) return c.json({ error: 'Not signed in' }, 401);
    if (!who.account) return c.json({ error: organizationId ? 'You are not a member of this organization.' : 'Join an organization to use the assistant.', code: 'no_account' }, 403);
    // A guest uses Chat alone (decision_log 2026-11-09): no assistant, their own or a shared one.
    const guest = guestRefusal(who.account, 'the assistant');
    if (guest) return c.json({ error: guest.message, code: guest.code }, 403);
    // The model every agent runs on is the organization's (operator ruling 2026-11-11, assistant/orgModel.ts): anyone may
    // see it, an owner or admin sets it.
    if (new URL(req.url).pathname === '/api/settings/assistant') {
      const keeper = c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName(orgModelKey(who.account.organizationId)));
      if (req.method === 'GET') return c.json({ settings: await keeper.orgSettings() });
      if (req.method !== 'PUT') return c.json({ error: 'Not found' }, 404);
      if (who.account.role !== 'owner' && who.account.role !== 'admin') return c.json({ error: "Only the organization's owners and admins choose the model its agents run on.", code: 'not_admin' }, 403);
      const answer = await keeper.updateOrgSettings(((await req.json().catch(() => ({}))) ?? {}) as never);
      return answer.ok ? c.json({ settings: answer.settings }) : c.json({ error: answer.message, code: 'invalid' }, 400);
    }
    const org = c.env.ORG.get(c.env.ORG.idFromName(who.account.organizationId));
    const [agents, wanted] = await Promise.all([directory(c, 'usableAgents', who.user.id, who.account.organizationId), agentOf(req)]);
    const self = agents.find((a) => a.self);
    const chosen = wanted && wanted !== self?.id ? agents.find((a) => a.id === wanted) : null;
    if (wanted && wanted !== self?.id && !chosen) return c.json({ error: 'That agent is not one you can use here.', code: 'no_agent' }, 404);
    if (chosen) {
      // A hosted shared agent (agents.md §6): the turn runs as the agent, in its own runtime, asked by the person; the
      // conversation is the person's with it. Its definition and settings are the Admin app's (routes/agents.ts), not any
      // asker's. On a file the agent has no grant on, the page is not its to see: the chat's file and the page's both.
      const path = new URL(req.url).pathname;
      if (path === '/api/agent/definition' || path === '/api/agent/mail-allowlist' || path === '/api/settings/assistant') return c.json({ error: "A shared agent's definition is set in Organization settings, by its sponsor or an admin.", code: 'not_yours' }, 403);
      const identity = await directory(c, 'agentIdentity', chosen.id, who.account.organizationId);
      if (!identity) return c.json({ error: 'That agent is not one you can use here.', code: 'no_agent' }, 404);
      const agentDocs = { userId: identity.user.id, email: identity.user.email, token: '', ip: who.ip, accountId: identity.account.id, channelIds: await org.channelIdsOf(identity.user.id) };
      for (const file of await filesOf(req)) {
        const seen = await c.env.DOCS.get(c.env.DOCS.idFromName(who.account.organizationId)).handle(new Request(`${c.env.WEB_URL_BASE.replace(/\/+$/, '')}/api/places/${encodeURIComponent(file)}`), agentDocs, who.account.organizationId);
        const place = seen.ok ? ((await seen.json()) as { role?: string }) : null;
        if (!place?.role) return c.json({ error: `${chosen.displayName} can't see this page. Share it with ${chosen.displayName} first, or ask your own assistant.`, code: 'agent_cannot_see', agent: chosen.displayName }, 403);
      }
      const asAgent = { user: identity.user, token: who.token, authKind: 'agent' as const, ip: who.ip, organizationId: who.account.organizationId, account: identity.account, invokedBy: who.account.id };
      return await c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName(identity.account.id)).handle(req, asAgent, agentDocs, chosen.displayName, { conversationUser: who.user.id });
    }
    // The person's assistant (agents.md §6): their hosted personal agent, whose runtime is their account's object. Its
    // turns are the person's, marked `via` the agent, so the events it causes say "Ann (via assistant)".
    const channelIds = await org.channelIdsOf(who.user.id);
    const docs = { userId: who.user.id, email: who.user.email, token: who.token, ip: who.ip, accountId: who.account.id, channelIds };
    // Naming the assistant (agents.md §1.1) names it everywhere: its member row and account too, and the first name gives
    // it its address, mailbox and calendar.
    const naming = req.method === 'PUT' && new URL(req.url).pathname === '/api/agent/definition' && self
      ? ((await req.clone().json().catch(() => null)) as { name?: unknown } | null)?.name : undefined;
    const res = await c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName(who.account.id)).handle(req, { ...who, ...(self ? { via: self.id } : {}) }, docs, self?.displayName);
    // A changed allowlist (agents.md §1.1): the assistant's mailbox starts or stops being checked.
    if (res.ok && self && req.method === 'PUT' && new URL(req.url).pathname === '/api/agent/mail-allowlist') {
      await c.env.MAIL.get(c.env.MAIL.idFromName(self.accountId)).assistantPolicyChanged().catch((err: Error) => console.error(`[assistant] allowlist: ${err.message}`));
    }
    if (res.ok && self && typeof naming === 'string' && naming.trim() && naming.trim() !== self.displayName) {
      const account = await directory(c, 'nameAssistant', self.id, who.account.organizationId, naming);
      await org.renameAssistant(self.id, account.displayName, account.address);
    }
    return res;
  } catch (err) {
    if (err instanceof ApiError) return c.json({ error: err.message, code: err.code }, err.statusCode as 400);
    throw err;
  }
}

for (const path of ['/api/agent', '/api/agent/turn', '/api/agent/reset', '/api/agent/permission', '/api/agent/definition', '/api/agent/mail-allowlist', '/api/settings/assistant']) assistantRoutes.all(path, (c) => forward(c));

/**
 * The person's own assistant as the platform serves it (agents.md §1.1, decision_log 2026-11-11): its definition, who may
 * mail it, and the model it runs on, for the organization in the path. The Admin app's "Your assistant" reads these, so it
 * depends on no app: they go to the same Assistant object as Docs' /api paths above, and answer in /v1's error shape.
 */
const ASSISTANT_PARTS: Record<string, string> = { definition: '/api/agent/definition', senders: '/api/agent/mail-allowlist', model: '/api/settings/assistant' };
for (const [part, inner] of Object.entries(ASSISTANT_PARTS)) {
  for (const method of ['GET', 'PUT'] as const) {
    assistantRoutes.on(method, `/v1/workspaces/:id/assistant/${part}`, async (c) => {
      const url = new URL(c.req.url);
      const target = `${url.origin}${inner}?workspace=${encodeURIComponent(c.req.param('id'))}`;
      const res = await forward(c, new Request(target, { method, headers: c.req.raw.headers, ...(method === 'PUT' ? { body: await c.req.raw.text() } : {}) }));
      if (res.ok) return res;
      const err = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      return c.json({ error: { code: err?.code ?? 'error', message: err?.error ?? `${res.status}` } }, res.status as 400);
    });
  }
}

/** The agents the person may talk to from the panel in the organization (agents.md §6): their assistant, hosted shared agents. */
assistantRoutes.get('/api/agent/agents', async (c) => {
  try {
    if (!tokenOf(c)) return c.json({ error: 'Not signed in' }, 401);
    const signedIn = await resolveCaller(c, null);
    if (!signedIn.user) return c.json({ error: 'Not signed in' }, 401);
    const organizationId = await organizationOf(c, c.req.raw, signedIn.user.id);
    if (!organizationId) return c.json({ agents: [] });
    const who = await resolveCaller(c, organizationId);
    if (!who.account) return c.json({ agents: [] });
    const guest = guestRefusal(who.account, 'the assistant');
    if (guest) return c.json({ error: guest.message, code: guest.code }, 403);
    return c.json({ agents: await directory(c, 'usableAgents', who.user!.id, organizationId) });
  } catch (err) {
    if (err instanceof ApiError) return c.json({ error: err.message, code: err.code }, err.statusCode as 400);
    throw err;
  }
});
