// Hosted shared agents (docs/specs/agents.md §6, phase C): made from the Admin app, with a definition kept by the agent's
// runtime object. POST /v1/workspaces/:id/agents/hosted makes one (the Org object's member under its sponsoring policy,
// the directory's `runtime = hosted`, the runtime adopted for the agent's account); GET and PUT …/agents/:userId/definition
// read and set its name and instructions (any member reads; the sponsor or an owner or admin sets).
//
// A person's other private agents (agents.md §1.3): POST …/agents/personal makes one (up to five with their assistant), its
// definition is read and set through the same …/definition routes by its sponsor alone, and DELETE …/agents/personal/:userId
// removes it (never the assistant, which goes only with its person).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AccountDTO, UsableAgentDTO } from '@flow/shared';
import type { Assistant } from '../assistant/object';
import { ApiError, badRequest, forbidden, notFound, unauthorized } from '../errors';
import { directory, guestRefusal, resolveCaller, type AuthEnv } from './auth';
import { MAX_PERSONAL_AGENTS } from '../directory/agents';

export interface AgentRouteEnv extends AuthEnv { ASSISTANT: DurableObjectNamespace<Assistant> }
type C = Context<{ Bindings: AgentRouteEnv }>;

export const agentRoutes = new Hono<{ Bindings: AgentRouteEnv }>();

const ORG_ID = /^[0-9a-f-]{36}$/;
const HostedAgentBody = z.object({ name: z.string().trim().min(1).max(80), instructions: z.string().max(8_000).optional() });
const DefinitionBody = z.object({ name: z.string().trim().min(1).max(80).optional(), instructions: z.string().max(8_000).optional() });

async function memberOf(c: C): Promise<{ organizationId: string; userId: string; account: AccountDTO }> {
  const organizationId = c.req.param('id') ?? '';
  if (!ORG_ID.test(organizationId)) throw badRequest('validation', 'not an organization id');
  const who = await resolveCaller(c, organizationId);
  if (!who.user) throw unauthorized('missing bearer token');
  if (!who.account) throw new ApiError(403, 'no_account', 'not a member of this organization');
  const guest = guestRefusal(who.account, 'agents');
  if (guest) throw guest;
  if (who.user.isAgent) throw forbidden('an agent cannot make or change agents');
  return { organizationId, userId: who.user.id, account: who.account };
}

const runtimeOf = (c: C, key: string) => c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName(key));

/** The runtime object a hosted agent's loop runs in (directory hostedRuntimeOf): its own account's, or for a personal agent its sponsor's or `agent:<account>`. */
async function runtimeKeyOf(c: C, account: AccountDTO): Promise<string> {
  const runtime = await directory(c, 'hostedRuntimeOf', account.id);
  if (!runtime) throw notFound('no such hosted agent here');
  return runtime.runtimeKey;
}

/**
 * The agent's account here, or a 404; and whether the caller may change its definition. A shared agent: any member reads,
 * its sponsor, an owner or an admin changes. A personal agent is its sponsor's alone (agents.md §1): anyone else gets a 404.
 */
async function hostedAgent(c: C, organizationId: string, userId: string, me: AccountDTO): Promise<{ account: AccountDTO; mayEdit: boolean }> {
  const account = await directory(c, 'accountFor', userId, organizationId);
  if (!account || account.state === 'removed' || !account.agentMode || account.agentRuntime !== 'hosted') throw notFound('no such hosted agent here');
  if (account.agentMode === 'personal') {
    if (account.sponsorId !== me.principalId) throw notFound('no such hosted agent here');
    return { account, mayEdit: true };
  }
  const mayEdit = me.role === 'owner' || me.role === 'admin' || account.sponsorId === me.principalId;
  return { account, mayEdit };
}

const orgOf = (c: C, organizationId: string) => c.env.ORG.get(c.env.ORG.idFromName(organizationId)) as unknown as {
  addHostedPersonalAgent(account: AccountDTO): Promise<void>;
  renameAssistant(agentId: string, name: string, address: string | null): Promise<void>;
  dropPersonalAgent(userId: string): Promise<void>;
};

/** The caller's own hosted agents here (agents.md §1.3): their assistant first (`self`), then the others they made. */
agentRoutes.get('/v1/workspaces/:id/agents/mine', async (c) => {
  const { organizationId, userId } = await memberOf(c);
  const agents = (await directory(c, 'usableAgents', userId, organizationId)).filter((a) => a.mode === 'personal');
  return c.json({ agents, limit: MAX_PERSONAL_AGENTS });
});

agentRoutes.post('/v1/workspaces/:id/agents/personal', async (c) => {
  const { organizationId, userId, account: me } = await memberOf(c);
  const r = HostedAgentBody.safeParse(await c.req.json().catch(() => undefined));
  if (!r.success) throw badRequest('validation', r.error.issues[0]?.message ?? 'invalid request');
  const account = await directory(c, 'createPersonalAgentFor', userId, organizationId, r.data.name);
  await orgOf(c, organizationId).addHostedPersonalAgent(account);
  // Its runtime is owned by the sponsor's account, as the assistant's is: the panel's turns are made as the sponsor.
  const runtime = runtimeOf(c, await runtimeKeyOf(c, account));
  await runtime.adopt(me, r.data.name);
  const definition = r.data.instructions ? await runtime.updateDefinition({ name: r.data.name, instructions: r.data.instructions }) : await runtime.updateDefinition({ name: r.data.name });
  const agent: UsableAgentDTO = { id: account.principalId, accountId: account.id, displayName: account.displayName, mode: 'personal', self: false };
  return c.json({ agent, definition }, 201);
});

agentRoutes.delete('/v1/workspaces/:id/agents/personal/:userId', async (c) => {
  const { organizationId, account: me } = await memberOf(c);
  const { account } = await hostedAgent(c, organizationId, c.req.param('userId'), me);
  if (account.agentMode !== 'personal') throw notFound('no such private agent here');
  if ((await directory(c, 'assistantOf', me.principalId, organizationId)) === account.principalId) throw new ApiError(409, 'assistant', 'your assistant goes only with you; remove another agent');
  const removed = await directory(c, 'removePersonalAgent', organizationId, account.id);
  await orgOf(c, organizationId).dropPersonalAgent(account.principalId);
  return c.json({ account: removed });
});

agentRoutes.post('/v1/workspaces/:id/agents/hosted', async (c) => {
  const { organizationId, userId, account: me } = await memberOf(c);
  const r = HostedAgentBody.safeParse(await c.req.json().catch(() => undefined));
  if (!r.success) throw badRequest('validation', r.error.issues[0]?.message ?? 'invalid request');
  // The member, under the organization's agentsBy policy, with the person as sponsor (the Org object refuses otherwise).
  const org = c.env.ORG.get(c.env.ORG.idFromName(organizationId)) as unknown as { createSharedAgent(p: { sponsorId: string; name: string }): Promise<{ userId: string }> };
  const made = await org.createSharedAgent({ sponsorId: userId, name: r.data.name });
  await directory(c, 'setAgentRuntime', made.userId, 'hosted');
  await (c.env.ORG.get(c.env.ORG.idFromName(organizationId)) as unknown as { markHostedAgent(userId: string): Promise<void> }).markHostedAgent(made.userId);
  const account = await directory(c, 'accountFor', made.userId, organizationId);
  if (!account) throw new ApiError(500, 'internal', 'the agent has no account');
  const definition = await runtimeOf(c, account.id).adopt(account, r.data.name);
  const final = r.data.instructions ? await runtimeOf(c, account.id).updateDefinition({ instructions: r.data.instructions }) : definition;
  void definition;
  const agent: UsableAgentDTO = { id: made.userId, accountId: account.id, displayName: account.displayName, mode: 'shared', self: false };
  void me;
  return c.json({ agent, definition: final }, 201);
});

/**
 * An agent's memory (agents.md §6.1), the Memory tab. A personal agent's is its sponsor's alone (hostedAgent's 404 for
 * anyone else). A shared agent's: the team folder for its sponsor and the organization's owners and admins, and each
 * person's own `you` folder for that person.
 */
async function memoryScopeOf(c: C) {
  const { organizationId, userId, account: me } = await memberOf(c);
  const { account, mayEdit } = await hostedAgent(c, organizationId, c.req.param('userId') ?? '', me);
  const runtime = runtimeOf(c, await runtimeKeyOf(c, account));
  const shared = account.agentMode === 'shared';
  return { runtime, shared, mayEditTeam: !shared || mayEdit, scope: { shared, asker: shared ? userId : null } };
}
const MemoryPut = z.object({ path: z.string().min(1).max(240), body: z.string().max(4_000) });
const teamPath = (p: string) => p === '/memories/team' || p.startsWith('/memories/team/');

agentRoutes.get('/v1/workspaces/:id/agents/:userId/memory', async (c) => {
  const { runtime, shared, mayEditTeam, scope } = await memoryScopeOf(c);
  const files = (await runtime.memoryFiles(scope)).filter((f) => !shared || mayEditTeam || !teamPath(f.path));
  return c.json({ files, shared, mayEditTeam });
});

agentRoutes.put('/v1/workspaces/:id/agents/:userId/memory', async (c) => {
  const { runtime, shared, mayEditTeam, scope } = await memoryScopeOf(c);
  const r = MemoryPut.safeParse(await c.req.json().catch(() => undefined));
  if (!r.success) throw badRequest('validation', r.error.issues[0]?.message ?? 'invalid request');
  if (shared && teamPath(r.data.path) && !mayEditTeam) throw forbidden("only the agent's sponsor, an owner or an admin changes its team memory");
  const refusal = await runtime.memoryPut(scope, r.data.path, r.data.body);
  if (refusal) throw badRequest('memory', refusal);
  return c.json({ ok: true });
});

agentRoutes.delete('/v1/workspaces/:id/agents/:userId/memory', async (c) => {
  const { runtime, shared, mayEditTeam, scope } = await memoryScopeOf(c);
  const path = c.req.query('path');
  if (shared && !mayEditTeam) {
    // Their own you folder only.
    if (path && teamPath(path)) throw forbidden("only the agent's sponsor, an owner or an admin changes its team memory");
    const mine = (await runtime.memoryFiles(scope)).filter((f) => !teamPath(f.path));
    let removed = 0;
    for (const f of path ? mine.filter((f) => f.path === path) : mine) removed += await runtime.memoryRemove(scope, f.path);
    return c.json({ removed });
  }
  return c.json({ removed: await runtime.memoryRemove(scope, path || undefined) });
});

agentRoutes.get('/v1/workspaces/:id/agents/:userId/definition', async (c) => {
  const { organizationId, account: me } = await memberOf(c);
  const { account, mayEdit } = await hostedAgent(c, organizationId, c.req.param('userId'), me);
  return c.json({ definition: await runtimeOf(c, await runtimeKeyOf(c, account)).currentDefinition(), mayEdit });
});

agentRoutes.put('/v1/workspaces/:id/agents/:userId/definition', async (c) => {
  const { organizationId, account: me } = await memberOf(c);
  const { account, mayEdit } = await hostedAgent(c, organizationId, c.req.param('userId'), me);
  if (!mayEdit) throw forbidden("only the agent's sponsor, an owner or an admin changes its definition");
  const r = DefinitionBody.safeParse(await c.req.json().catch(() => undefined));
  if (!r.success) throw badRequest('validation', r.error.issues[0]?.message ?? 'invalid request');
  // The name is the directory's, where the panel and the rosters read it; a personal agent's member row follows at once.
  if (r.data.name) {
    await directory(c, 'renameAgent', account.principalId, r.data.name);
    if (account.agentMode === 'personal') await orgOf(c, organizationId).renameAssistant(account.principalId, r.data.name.trim(), account.address);
  }
  return c.json({ definition: await runtimeOf(c, await runtimeKeyOf(c, account)).updateDefinition(r.data), mayEdit });
});
