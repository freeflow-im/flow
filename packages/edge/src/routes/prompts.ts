// The assistant's suggested prompts (docs/specs/agents.md §1.2): the organization's own, by page, kept by its Org object.
// GET /v1/workspaces/:id/assistant-prompts gives any member the pages the organization changed (the apps offer their
// defaults for the rest); PUT sets them, for an owner or an admin only.
import { Hono, type Context } from 'hono';
import { cleanPrompts, type AssistantPrompts } from '@flow/shared/assistant';
import type { AccountDTO } from '@flow/shared';
import { ApiError, badRequest, forbidden, unauthorized } from '../errors';
import { resolveCaller, type AuthEnv } from './auth';

interface PromptStore {
  assistantPrompts(): Promise<AssistantPrompts>;
  setAssistantPrompts(prompts: AssistantPrompts): Promise<AssistantPrompts>;
}
export interface PromptRouteEnv extends AuthEnv {}
type C = Context<{ Bindings: PromptRouteEnv }>;

export const promptRoutes = new Hono<{ Bindings: PromptRouteEnv }>();

const ORG_ID = /^[0-9a-f-]{36}$/;
const PATH = '/v1/workspaces/:id/assistant-prompts';

async function caller(c: C): Promise<{ organizationId: string; account: AccountDTO }> {
  const organizationId = c.req.param('id') ?? '';
  if (!ORG_ID.test(organizationId)) throw badRequest('validation', 'not an organization id');
  const who = await resolveCaller(c, organizationId);
  if (!who.user) throw unauthorized('missing bearer token');
  if (!who.account) throw new ApiError(403, 'no_account', 'not a member of this organization');
  return { organizationId, account: who.account };
}

const store = (c: C, organizationId: string) => c.env.ORG.get(c.env.ORG.idFromName(organizationId)) as unknown as PromptStore;

promptRoutes.get(PATH, async (c) => {
  const { organizationId } = await caller(c);
  return c.json({ prompts: await store(c, organizationId).assistantPrompts() });
});

promptRoutes.put(PATH, async (c) => {
  const { organizationId, account } = await caller(c);
  if (account.role !== 'owner' && account.role !== 'admin') throw forbidden('only an owner or an admin changes the suggested prompts');
  const body = (await c.req.json().catch(() => null)) as { prompts?: unknown } | null;
  if (!body || typeof body.prompts !== 'object' || body.prompts === null) throw badRequest('validation', 'prompts: an object of lists, by page');
  return c.json({ prompts: await store(c, organizationId).setAssistantPrompts(cleanPrompts(body.prompts)) });
});
