// GET /v1/tools?door=bridge: the registry's tool definitions for the bridge's `flow` MCP server (platform.md §5.4), which
// lists the ones it implements. Definitions only: the bridge runs its built-in tools itself, over the API. Any signed-in
// caller (an agent's token, in practice); the built-in definitions say nothing about the caller's data.
//
// `&workspace=<id>` adds the tools of the apps installed there that the caller may use (user-apps.md §3.3), which the
// bridge runs through POST /v1/workspaces/:id/tools/call.
import { Hono } from 'hono';
import { toolsFor } from '../registry';
import { appToolsFor } from '../registry/userApps';
import { badRequest } from '../errors';
import { requireAuth, resolveCaller, type AuthEnv } from './auth';

export const toolRoutes = new Hono<{ Bindings: AuthEnv }>();

const ORG_ID = /^[0-9a-f-]{36}$/;

toolRoutes.get('/v1/tools', requireAuth as never, async (c) => {
  const door = c.req.query('door');
  if (door !== 'bridge') throw badRequest('bad_door', 'door: only bridge is served here (/mcp lists its own tools, and the assistant has its own)');
  c.header('Cache-Control', 'no-store');
  // The caller's kind (agents.md §1): an agent token names a shared agent; a person's session is no agent.
  const user = c.get('user' as never) as { id: string; displayName: string; isAgent?: boolean; agentMode?: 'personal' | 'shared' | null };
  const agentMode = user.isAgent ? (user.agentMode ?? 'shared') : null;
  const tools = toolsFor('bridge', { agentMode }).map((t) => t.definition);
  const workspace = c.req.query('workspace');
  if (workspace && ORG_ID.test(workspace)) {
    const who = await resolveCaller(c, workspace);
    if (who.account) {
      tools.push(...(await appToolsFor(c.env, {
        organizationId: workspace, account: who.account, userId: user.id, displayName: user.displayName, via: who.via ?? null, invokedBy: who.invokedBy ?? null,
      }, 'bridge')));
    }
  }
  return c.json({ tools });
});
