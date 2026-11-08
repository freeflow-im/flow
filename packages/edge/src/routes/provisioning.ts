// Provisioning's routes (platform.md §3.4, phase 5.3): an owner or admin sends every account of the organization that has
// no hosted mailbox to be provisioned (its members from before the provider, and any whose run stopped); and, in local dev
// with the fake provider only, the provider's call log for the e2e. Mounted before routes/org.ts, whose catch-all would
// send these to the Org object.
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { directory, type AuthEnv } from './auth';
import { adminOf } from './domains';
import { FakeMailProvider } from '../mailprovider/fake';
import { mailProviderFor, type MailProviderEnv } from '../mailprovider/index';

type ProvisioningRouteEnv = AuthEnv & MailProviderEnv & { EDGE_ORIGIN_SECRET?: string };

export const provisioningRoutes = new Hono<{ Bindings: ProvisioningRouteEnv }>();

provisioningRoutes.post('/v1/workspaces/:id/provision', async (c) => {
  const id = await adminOf(c as never, 'set up mailboxes');
  return c.json({ queued: await directory(c, 'provisionMissing', id) });
});

/** The fake provider's calls in this isolate, newest last, behind the origin secret: what the e2e checks a suspension by. */
provisioningRoutes.get('/v1/admin/mailprovider/log', (c) => {
  const given = Buffer.from(c.req.header('x-edge-secret') ?? ''), want = Buffer.from(c.env.EDGE_ORIGIN_SECRET ?? '');
  if (!want.length || given.length !== want.length || !timingSafeEqual(given, want)) return c.json({ error: { code: 'forbidden', message: 'forbidden' } }, 403);
  const provider = mailProviderFor(c.env);
  if (!(provider instanceof FakeMailProvider)) return c.json({ error: { code: 'not_found', message: 'only with MAIL_PROVIDER=fake' } }, 404);
  return c.json({ calls: provider.calls });
});
