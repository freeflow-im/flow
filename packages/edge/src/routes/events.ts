// The event bus's one-shot read (docs/specs/platform.md §5.2): GET /v1/events?workspace=<id>&since=<seq>&limit=&types=a,b
// &ref=&channel=&actor=person|agent. The caller's account in the organization names the reader; the Org object says
// which private channels it is in; the organization's Events object answers what follows `since` that it may see.
// Subscriptions (durable consumers with a cursor) under /v1/events/subscriptions: the caller's account is the consumer.
import { Hono, type Context } from 'hono';
import type { ZodTypeAny, z } from 'zod';
import { AckSubscriptionBody, CreateSubscriptionBody } from '@flow/shared';
import type { Events } from '../events/object';
import type { ReadQuery } from '../events/core';
import { subscriptionsAs } from '../events/subscriptions';
import { badRequest, notFound } from '../errors';
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

// ---- subscriptions -------------------------------------------------------------------------------------------------

async function bodyOf<S extends ZodTypeAny>(schema: S, c: Context): Promise<z.output<S>> {
  const r = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!r.success) {
    const issue = r.error.issues[0];
    throw badRequest('validation', issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid request');
  }
  return r.data;
}

/** The caller's subscriptions in the organization (`?workspace=`), as its account. */
async function opsOf(c: Context<{ Bindings: EventRouteEnv }>) {
  const who = await resolveAccountCaller(c, 'events');
  const org = who.account.organizationId;
  c.header('Cache-Control', 'no-store');
  return subscriptionsAs(c.env.EVENTS.get(c.env.EVENTS.idFromName(org)), c.env.ORG.get(c.env.ORG.idFromName(org)), who.account.id, who.user.id);
}

const noSuch = () => notFound('no such subscription');

eventRoutes.post('/v1/events/subscriptions', async (c) => {
  const ops = await opsOf(c);
  const body = await bodyOf(CreateSubscriptionBody, c);
  return c.json({ subscription: await ops.create(body) }, 201);
});

eventRoutes.get('/v1/events/subscriptions', async (c) => c.json({ subscriptions: await (await opsOf(c)).list() }));

eventRoutes.get('/v1/events/subscriptions/:id', async (c) => {
  const ops = await opsOf(c);
  const limit = Number(c.req.query('limit')) || undefined;
  const out = await ops.read(c.req.param('id'), limit, Number(c.req.query('wait')) || 0);
  if (!out) throw noSuch();
  return c.json(out);
});

eventRoutes.post('/v1/events/subscriptions/:id/ack', async (c) => {
  const ops = await opsOf(c);
  const { cursor } = await bodyOf(AckSubscriptionBody, c);
  const stored = await ops.ack(c.req.param('id'), cursor);
  if (stored === null) throw noSuch();
  return c.json({ cursor: stored });
});

eventRoutes.delete('/v1/events/subscriptions/:id', async (c) => {
  if (!(await (await opsOf(c)).remove(c.req.param('id')))) throw noSuch();
  return c.json({ ok: true });
});
