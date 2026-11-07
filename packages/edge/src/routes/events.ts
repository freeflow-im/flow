// The event bus's one-shot read (docs/specs/platform.md §5.2): GET /v1/events?workspace=<id>&since=<seq>&limit=&types=a,b
// &ref=&channel=&actor=person|agent. The caller's account in the organization names the reader; the Org object says
// which private channels it is in; the organization's Events object answers what follows `since` that it may see.
import { Hono } from 'hono';
import type { Events } from '../events/object';
import type { ReadQuery } from '../events/core';
import { resolveAccountCaller, type AuthEnv } from './auth';

export interface EventRouteEnv extends AuthEnv { EVENTS: DurableObjectNamespace<Events> }

export const eventRoutes = new Hono<{ Bindings: EventRouteEnv }>();

eventRoutes.get('/v1/events', async (c) => {
  const who = await resolveAccountCaller(c, 'events');
  const org = who.account.organizationId;
  const q = (name: string) => c.req.query(name) || undefined;
  const actor = q('actor');
  const query: ReadQuery = {
    since: Number(q('since') ?? 0) || 0,
    ...(q('limit') ? { limit: Number(q('limit')) } : {}),
    ...(q('types') ? { types: q('types')!.split(',') } : {}),
    ...(q('ref') ? { ref: q('ref')! } : {}),
    ...(q('channel') ? { channelId: q('channel')! } : {}),
    ...(actor === 'person' || actor === 'agent' ? { actorKind: actor } : {}),
  };
  const orgObject = c.env.ORG.get(c.env.ORG.idFromName(org));
  const [channelIds, agentAccountIds] = await Promise.all([
    orgObject.privateChannelIdsOf(who.user.id),
    query.actorKind ? orgObject.agentAccountIds() : Promise.resolve(undefined),
  ]);
  const answer = await c.env.EVENTS.get(c.env.EVENTS.idFromName(org)).read(query, { accountId: who.account.id, channelIds, ...(agentAccountIds ? { agentAccountIds } : {}) });
  c.header('Cache-Control', 'no-store');
  return c.json(answer);
});
