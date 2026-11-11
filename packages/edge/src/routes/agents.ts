// Hosted shared agents (docs/specs/agents.md §6, phase C): made from the Admin app, with a definition kept by the agent's
// runtime object. POST /v1/workspaces/:id/agents/hosted makes one (the Org object's member under its sponsoring policy,
// the directory's `runtime = hosted`, the runtime adopted for the agent's account); GET and PUT …/agents/:userId/definition
// read and set its name and instructions (any member reads; the sponsor or an owner or admin sets).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AccountDTO, UsableAgentDTO } from '@flow/shared';
import type { Assistant } from '../assistant/object';
import { ApiError, badRequest, forbidden, notFound, unauthorized } from '../errors';
import { directory, resolveCaller, type AuthEnv } from './auth';

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
  if (who.user.isAgent) throw forbidden('an agent cannot make or change agents');
  return { organizationId, userId: who.user.id, account: who.account };
}

const runtimeOf = (c: C, accountId: string) => c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName(accountId));

/** The agent's account here, or a 404; and whether the caller may change its definition (its sponsor, an owner or an admin). */
async function hostedAgent(c: C, organizationId: string, userId: string, me: AccountDTO): Promise<{ account: AccountDTO; mayEdit: boolean }> {
  const account = await directory(c, 'accountFor', userId, organizationId);
  if (!account || account.state === 'removed' || !account.agentMode || account.agentRuntime !== 'hosted') throw notFound('no such hosted agent here');
  const mayEdit = me.role === 'owner' || me.role === 'admin' || account.sponsorId === me.principalId;
  return { account, mayEdit };
}

agentRoutes.post('/v1/workspaces/:id/agents/hosted', async (c) => {
  const { organizationId, userId, account: me } = await memberOf(c);
  const r = HostedAgentBody.safeParse(await c.req.json().catch(() => undefined));
  if (!r.success) throw badRequest('validation', r.error.issues[0]?.message ?? 'invalid request');
  // The member, under the organization's agentsBy policy, with the person as sponsor (the Org object refuses otherwise).
  const org = c.env.ORG.get(c.env.ORG.idFromName(organizationId)) as unknown as { createSharedAgent(p: { sponsorId: string; name: string }): Promise<{ userId: string }> };
  const made = await org.createSharedAgent({ sponsorId: userId, name: r.data.name });
  await directory(c, 'setAgentRuntime', made.userId, 'hosted');
  const account = await directory(c, 'accountFor', made.userId, organizationId);
  if (!account) throw new ApiError(500, 'internal', 'the agent has no account');
  const definition = await runtimeOf(c, account.id).adopt(account, r.data.name);
  const final = r.data.instructions ? await runtimeOf(c, account.id).updateDefinition({ instructions: r.data.instructions }) : definition;
  const agent: UsableAgentDTO = { id: made.userId, accountId: account.id, displayName: account.displayName, mode: 'shared', self: false };
  void me;
  return c.json({ agent, definition: final }, 201);
});

agentRoutes.get('/v1/workspaces/:id/agents/:userId/definition', async (c) => {
  const { organizationId, account: me } = await memberOf(c);
  const { account, mayEdit } = await hostedAgent(c, organizationId, c.req.param('userId'), me);
  return c.json({ definition: await runtimeOf(c, account.id).currentDefinition(), mayEdit });
});

agentRoutes.put('/v1/workspaces/:id/agents/:userId/definition', async (c) => {
  const { organizationId, account: me } = await memberOf(c);
  const { account, mayEdit } = await hostedAgent(c, organizationId, c.req.param('userId'), me);
  if (!mayEdit) throw forbidden("only the agent's sponsor, an owner or an admin changes its definition");
  const r = DefinitionBody.safeParse(await c.req.json().catch(() => undefined));
  if (!r.success) throw badRequest('validation', r.error.issues[0]?.message ?? 'invalid request');
  return c.json({ definition: await runtimeOf(c, account.id).updateDefinition(r.data), mayEdit });
});
