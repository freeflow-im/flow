// The event bus's one-shot read (docs/specs/platform.md §5.2): GET /v1/events?workspace=<id>&since=<seq>&limit=&types=a,b
// &ref=&channel=&actor=person|agent. The caller's account in the organization names the reader; the Org object says
// which private channels it is in; the organization's Events object answers what follows `since` that it may see.
// Subscriptions (durable consumers with a cursor) under /v1/events/subscriptions: the caller's account is the consumer (an
// agent it sponsors, for `wake`). A wake job's agent acks it, extends its lease and says it is done under /v1/events/jobs.
import { Hono, type Context } from 'hono';
import type { ZodTypeAny, z } from 'zod';
import { AckSubscriptionBody, CreateSubscriptionBody, JobDoneBody } from '@flow/shared';
import type { Events } from '../events/object';
import type { ReadQuery } from '../events/core';
import { subscriptionsAs } from '../events/subscriptions';
import { badRequest, notFound } from '../errors';
import { ApiError } from '../errors';
import { resolveAccountCaller, resolveCaller, type AuthEnv } from './auth';

export interface EventRouteEnv extends AuthEnv { EVENTS: DurableObjectNamespace<Events> }

export const eventRoutes = new Hono<{ Bindings: EventRouteEnv }>();

eventRoutes.get('/v1/events', async (c) => {
  const who = await resolveAccountCaller(c, 'events');
  const org = who.account.organizationId;
  const q = (name: string) => c.req.query(name) || undefined;
  const actor = q('actor');
  const query: ReadQuery = {
    since: Number(q('since') ?? 0) || 0,
    // `before`: newest first, from the head (0) or below a seq; the Admin app's Event log pages this way.
    ...(q('before') !== undefined ? { before: Number(q('before')) || 0 } : {}),
    ...(q('limit') ? { limit: Number(q('limit')) } : {}),
    ...(q('text') ? { text: q('text')! } : {}),
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

// What is shared with the caller in the organization, from its share index (platform.md §4.5): for Chat and the suite bar.
// `?org=1` adds what is shared with the whole organization (phase 4.4). Docs' own Shared with me
// (`/api/library?scope=shared`) stays authoritative for Docs, and leaves those out: Organization files lists them.
eventRoutes.get('/v1/workspaces/:id/shared-with-me', async (c) => {
  const org = c.req.param('id');
  const who = await resolveCaller(c, org);
  if (!who.user) throw new ApiError(401, 'unauthorized', 'missing bearer token');
  if (!who.account) throw new ApiError(403, 'no_account', 'not a member of this organization');
  const includeOrg = c.req.query('org') === '1';
  const shares = await c.env.ORG.get(c.env.ORG.idFromName(org)).sharedWith({ accountId: who.account.id }, { includeOrg });
  c.header('Cache-Control', 'no-store');
  return c.json({ shares: shares.map(({ ref, kind, title, role, principal, grantedBy, at, url }) => ({ ref, kind, title, role, principal: principal.startsWith('link:') ? 'link' : principal, grantedBy, at, url })) });
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
  return subscriptionsAs(c.env.EVENTS.get(c.env.EVENTS.idFromName(org)), c.env.ORG.get(c.env.ORG.idFromName(org)), who.account.id, who.user.id, who.account.role, org);
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

// ---- wake jobs (§5.2): the agent's ack, lease and outcome; the owner's (or agent's) list -------------------------------

const noJob = () => notFound('no such job');

eventRoutes.get('/v1/events/jobs', async (c) => {
  const ops = await opsOf(c);
  const sub = c.req.query('subscription');
  if (!sub) throw notFound('name a subscription: ?subscription=<id>');
  const jobs = await ops.jobs(sub);
  if (!jobs) throw noSuch();
  return c.json({ jobs });
});

for (const step of ['ack', 'extend', 'done'] as const) {
  eventRoutes.post(`/v1/events/jobs/:id/${step}`, async (c) => {
    const ops = await opsOf(c);
    const opts = step === 'done' ? await bodyOf(JobDoneBody, c) : {};
    const job = await ops.jobStep(c.req.param('id'), step, opts);
    if (!job) throw noJob();
    return c.json({ job });
  });
}
