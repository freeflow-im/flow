// The assistant's routes (platform.md §5.5): Docs' old paths, /api/agent, /api/agent/turn, /api/agent/reset, /api/agent/history, /api/agent/reopen,
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

/** The model pin of the agent a request names (`?agent=`), else of the person's assistant (its runtime is their account's). */
async function pinOf(c: C, req: Request, userId: string, organizationId: string, ownAccountId: string): Promise<string | null> {
  const wanted = await agentOf(req);
  let runtimeKey = ownAccountId;
  if (wanted) {
    const agent = (await directory(c, 'usableAgents', userId, organizationId)).find((a) => a.id === wanted);
    if (!agent) return null;
    if (agent.mode === 'personal' && !agent.self) runtimeKey = (await directory(c, 'hostedRuntimeOf', agent.accountId))?.runtimeKey ?? '';
    else if (!agent.self) runtimeKey = agent.accountId;
    if (!runtimeKey) return null;
  }
  return (await c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName(runtimeKey)).currentDefinition()).modelId ?? null;
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
      if (req.method === 'GET') {
        // What the agent the panel talks to runs on (task #26): its pin, else the default. `?agent=` names one of the
        // person's agents; without it, their assistant.
        const pin = await pinOf(c, req, who.user.id, who.account.organizationId, who.account.id).catch(() => null);
        return c.json({ settings: (await keeper.orgModel(pin)).shown });
      }
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
    if (chosen && chosen.mode === 'personal') {
      // Another of the person's own agents (agents.md §1.3): it acts as the person, marked `via` it, as their assistant
      // does, in its own runtime (`agent:<account>`, owned by the person's account), with its own definition and
      // conversations. No mailbox yet, so no allowlist; the model is the organization's.
      const path = new URL(req.url).pathname;
      if (path === '/api/agent/mail-allowlist') return c.json({ error: `${chosen.displayName} has no mailbox.`, code: 'no_mailbox' }, 404);
      const runtime = await directory(c, 'hostedRuntimeOf', chosen.accountId);
      if (!runtime) return c.json({ error: 'That agent is not one you can use here.', code: 'no_agent' }, 404);
      const channelIds = await org.channelIdsOf(who.user.id);
      const docs = { userId: who.user.id, email: who.user.email, token: who.token, ip: who.ip, accountId: who.account.id, channelIds };
      const naming = req.method === 'PUT' && path === '/api/agent/definition'
        ? ((await req.clone().json().catch(() => null)) as { name?: unknown } | null)?.name : undefined;
      const res = await c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName(runtime.runtimeKey)).handle(req, { ...who, via: chosen.id }, docs, chosen.displayName);
      if (res.ok && typeof naming === 'string' && naming.trim() && naming.trim() !== chosen.displayName) {
        await directory(c, 'renameAgent', chosen.id, naming.trim());
        await org.renameAssistant(chosen.id, naming.trim(), null);
      }
      return res;
    }
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
      // The admin agent (agents.md §1.4) is for owners and admins alone: usableAgents lists it only for them, and a role
      // lost since is checked here. Its admin tools act with this person's token (assistant/adminTools.ts).
      if (chosen.role === 'admin' && who.account.role !== 'owner' && who.account.role !== 'admin') return c.json({ error: 'Only owners and admins can use the admin agent.', code: 'not_admin' }, 403);
      const asAgent = { user: identity.user, token: who.token, authKind: 'agent' as const, ip: who.ip, organizationId: who.account.organizationId, account: identity.account, invokedBy: who.account.id };
      return await c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName(identity.account.id)).handle(req, asAgent, agentDocs, chosen.displayName, { conversationUser: who.user.id, agentAccountId: identity.account.id, agentMode: 'shared', ...(chosen.role ? { agentRole: chosen.role } : {}) });
    }
    // The person's assistant (agents.md §6): their hosted personal agent, whose runtime is their account's object. Its
    // turns are the person's, marked `via` the agent, so the events it causes say "Ann (via assistant)".
    const channelIds = await org.channelIdsOf(who.user.id);
    const docs = { userId: who.user.id, email: who.user.email, token: who.token, ip: who.ip, accountId: who.account.id, channelIds };
    // Naming the assistant (agents.md §1.1) names it everywhere: its member row and account too, and the first name gives
    // it its address, mailbox and calendar.
    const naming = req.method === 'PUT' && new URL(req.url).pathname === '/api/agent/definition' && self
      ? ((await req.clone().json().catch(() => null)) as { name?: unknown } | null)?.name : undefined;
    const res = await c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName(who.account.id)).handle(req, { ...who, ...(self ? { via: self.id } : {}) }, docs, self?.displayName, self ? { agentAccountId: self.accountId, agentMode: 'personal' } : {});
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

// Email waiting for the person's click (assistant/mailApprovals.ts): always the person's own object, whichever agent wrote it.
assistantRoutes.all('/api/agent/mail-approvals', (c) => forward(c));
assistantRoutes.all('/api/agent/mail-approvals/*', (c) => forward(c));
for (const path of ['/api/agent', '/api/agent/turn', '/api/agent/reset', '/api/agent/history', '/api/agent/reopen', '/api/agent/permission', '/api/agent/definition', '/api/agent/mail-allowlist', '/api/settings/assistant']) assistantRoutes.all(path, (c) => forward(c));

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

/**
 * The organization's model list (task #26): every member reads it (to pin their own agents), its owners and admins change
 * it. Kept by the `org:<id>` Assistant object (assistant/orgModel.ts).
 */
async function modelsCaller(c: C, admin: boolean): Promise<{ keeper: DurableObjectStub<Assistant> } | Response> {
  const fail = (status: number, code: string, message: string) => c.json({ error: { code, message } }, status as 400);
  if (!tokenOf(c)) return fail(401, 'unauthorized', 'Not signed in');
  const organizationId = c.req.param('id')!;
  const who = await resolveCaller(c, organizationId);
  if (!who.user) return fail(401, 'unauthorized', 'Not signed in');
  if (!who.account) return fail(403, 'no_account', 'You are not a member of this organization.');
  const guest = guestRefusal(who.account, 'the assistant');
  if (guest) return fail(403, guest.code, guest.message);
  if (admin && who.account.role !== 'owner' && who.account.role !== 'admin') return fail(403, 'not_admin', "Only the organization's owners and admins choose the models its agents run on.");
  return { keeper: c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName(orgModelKey(who.account.organizationId))) };
}
type Answer<T> = { ok: true } & T | { ok: false; message: string };
const answer = <T extends object>(c: C, a: Answer<T>) => (a.ok ? c.json(a) : c.json({ error: { code: 'invalid', message: a.message } }, 400));

assistantRoutes.get('/v1/workspaces/:id/assistant/models', async (c) => {
  const r = await modelsCaller(c, false);
  return r instanceof Response ? r : c.json(await r.keeper.orgModels());
});
assistantRoutes.post('/v1/workspaces/:id/assistant/models', async (c) => {
  const r = await modelsCaller(c, true);
  if (r instanceof Response) return r;
  return answer(c, await r.keeper.addOrgModel(((await c.req.json().catch(() => ({}))) ?? {}) as never));
});
assistantRoutes.delete('/v1/workspaces/:id/assistant/models/:entry', async (c) => {
  const r = await modelsCaller(c, true);
  return r instanceof Response ? r : answer(c, await r.keeper.changeOrgModel(c.req.param('entry'), 'remove'));
});
assistantRoutes.put('/v1/workspaces/:id/assistant/models/:entry/default', async (c) => {
  const r = await modelsCaller(c, true);
  return r instanceof Response ? r : answer(c, await r.keeper.changeOrgModel(c.req.param('entry'), 'default'));
});
assistantRoutes.put('/v1/workspaces/:id/assistant/keys/brave', async (c) => {
  const r = await modelsCaller(c, true);
  if (r instanceof Response) return r;
  const key = (((await c.req.json().catch(() => ({}))) ?? {}) as { key?: unknown }).key;
  if (typeof key !== 'string' || !key.trim()) return c.json({ error: { code: 'invalid', message: 'Enter the Brave Search API key.' } }, 400);
  return answer(c, await r.keeper.setOrgBraveKey(key.trim()));
});
assistantRoutes.delete('/v1/workspaces/:id/assistant/keys/:provider', async (c) => {
  const r = await modelsCaller(c, true);
  if (r instanceof Response) return r;
  const p = c.req.param('provider');
  if (p !== 'anthropic' && p !== 'openai' && p !== 'openrouter' && p !== 'brave') return c.json({ error: { code: 'not_found', message: 'No such key.' } }, 404);
  return c.json(await r.keeper.removeOrgKey(p));
});

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
    const agents = await directory(c, 'usableAgents', who.user!.id, organizationId);
    // `?app=`: the panel over an installed app's screen offers only the agents that may use that app (user-apps.md §5.2).
    const app = new URL(c.req.url).searchParams.get('app');
    if (!app) return c.json({ agents });
    const org = c.env.ORG.get(c.env.ORG.idFromName(organizationId));
    const person = { accountId: who.account.id, kind: who.account.kind, agentMode: null, via: null };
    const may = new Set(await org.userAppAgents(app, person, agents.map((a) => ({ id: a.id, accountId: a.accountId, mode: a.mode }))));
    return c.json({ agents: agents.filter((a) => may.has(a.id)) });
  } catch (err) {
    if (err instanceof ApiError) return c.json({ error: err.message, code: err.code }, err.statusCode as 400);
    throw err;
  }
});
