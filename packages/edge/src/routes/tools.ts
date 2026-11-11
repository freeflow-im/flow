// GET /v1/tools?door=bridge: the registry's tool definitions for the bridge's `flow` MCP server (platform.md §5.4), which
// lists the ones it implements. Definitions only: the bridge runs its tools itself, over the API. Any signed-in caller (an
// agent's token, in practice); the definitions say nothing about the caller's data.
import { Hono } from 'hono';
import { toolsFor } from '../registry';
import { badRequest } from '../errors';
import { requireAuth, type AuthEnv } from './auth';

export const toolRoutes = new Hono<{ Bindings: AuthEnv }>();

toolRoutes.get('/v1/tools', requireAuth as never, (c) => {
  const door = c.req.query('door');
  if (door !== 'bridge') throw badRequest('bad_door', 'door: only bridge is served here (/mcp lists its own tools, and the assistant has its own)');
  c.header('Cache-Control', 'no-store');
  // The caller's kind (agents.md §1): a personal agent's token answers as its sponsor with `via`; a shared agent is itself.
  const user = c.get('user' as never) as { isAgent?: boolean; agentMode?: 'personal' | 'shared' | null };
  const agentMode = c.get('via' as never) ? 'personal' : user.isAgent ? (user.agentMode ?? 'shared') : null;
  return c.json({ tools: toolsFor('bridge', { agentMode }).map((t) => t.definition) });
});
