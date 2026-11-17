// Workspace setup (docs/specs/onboarding.md): a person's place in it, and the team agent, Omni.
//
// GET  /v1/workspaces/:id/setup       → { pending, step }: pending from when the person joined (or made the workspace)
//                                         until they finish; never pending for a member from before setup shipped.
// PUT  /v1/workspaces/:id/setup       { step } or { done: true }.
// GET  /v1/workspaces/:id/team-agent  → { agent: { id, displayName } | null }
// POST /v1/workspaces/:id/team-agent  makes Omni (owners and admins), or answers the one there is: a hosted shared agent
//                                         that joins every public channel (§2).
import { Hono } from 'hono';
import { z } from 'zod';
import { badRequest, forbidden } from '../errors';
import { directory } from './auth';
import { makeHostedSharedAgent, memberOf, type AgentRouteEnv, type C } from './agents';

export const setupRoutes = new Hono<{ Bindings: AgentRouteEnv }>();

/** What Omni is told it is for (onboarding.md §2); its sponsor may change it later like any shared agent's. */
export const TEAM_AGENT_NAME = 'Omni';
export const TEAM_AGENT_INSTRUCTIONS = [
  "You are Omni, this workspace's shared agent: the team's memory. Anyone in the workspace, people and agents, may ask you.",
  'You see what the whole team shares: public channels, files shared with everyone or with you, calendars shared with you, and shared inboxes you are given.',
  'Answer from that shared material, say where each answer came from (a channel, a file, a thread), and say plainly when you do not know.',
  'Never repeat what was told to you in private to anyone else, and keep your answers short.',
].join('\n');

interface OrgSetup {
  setupOf(userId: string): Promise<{ pending: boolean; step: number } | null>;
  saveSetup(userId: string, patch: { step?: number; done?: boolean }): Promise<{ pending: boolean; step: number }>;
  teamAgentId(): Promise<string | null>;
  markTeamAgent(agentId: string): Promise<void>;
}
const orgOf = (c: C, id: string) => c.env.ORG.get(c.env.ORG.idFromName(id)) as unknown as OrgSetup;

const SetupBody = z.object({ step: z.number().int().min(1).max(5).optional(), done: z.literal(true).optional() });

setupRoutes.get('/v1/workspaces/:id/setup', async (c) => {
  const { organizationId, userId } = await memberOf(c);
  const setup = await orgOf(c, organizationId).setupOf(userId);
  c.header('Cache-Control', 'no-store');
  return c.json(setup ?? { pending: false, step: 1 });
});

setupRoutes.put('/v1/workspaces/:id/setup', async (c) => {
  const { organizationId, userId } = await memberOf(c);
  const r = SetupBody.safeParse(await c.req.json().catch(() => undefined));
  if (!r.success || (r.data.step === undefined && !r.data.done)) throw badRequest('validation', 'give step or done');
  return c.json(await orgOf(c, organizationId).saveSetup(userId, r.data));
});

async function teamAgentOf(c: C, organizationId: string): Promise<{ id: string; displayName: string } | null> {
  const id = await orgOf(c, organizationId).teamAgentId();
  if (!id) return null;
  const account = await directory(c, 'accountFor', id, organizationId);
  return account && account.state !== 'removed' ? { id, displayName: account.displayName ?? TEAM_AGENT_NAME } : null;
}

setupRoutes.get('/v1/workspaces/:id/team-agent', async (c) => {
  const { organizationId } = await memberOf(c);
  return c.json({ agent: await teamAgentOf(c, organizationId) });
});

setupRoutes.post('/v1/workspaces/:id/team-agent', async (c) => {
  const { organizationId, userId, account } = await memberOf(c);
  if (account.role !== 'owner' && account.role !== 'admin') throw forbidden('only an owner or admin adds the team agent');
  const there = await teamAgentOf(c, organizationId);
  if (there) return c.json({ agent: there });
  const made = await makeHostedSharedAgent(c, organizationId, userId, TEAM_AGENT_NAME, TEAM_AGENT_INSTRUCTIONS);
  await orgOf(c, organizationId).markTeamAgent(made.agent.id);
  return c.json({ agent: { id: made.agent.id, displayName: made.agent.displayName } }, 201);
});
