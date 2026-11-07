// An organization's domains (platform.md §3.2, phase 5.1), owner or admin only. The directory keeps them; the records to
// publish and the checks are directory/dns.ts. Mounted before routes/org.ts, whose catch-all would send these to the Org object.
import { Hono, type Context } from 'hono';
import type { ZodTypeAny, z } from 'zod';
import { AddDomainBody, PatchDomainBody } from '@flow/shared';
import { ApiError, badRequest, unauthorized } from '../errors';
import { directory, resolveCaller, type AuthEnv } from './auth';
import { platformDns, type PlatformDnsEnv } from '../directory/providers/cloudflareDns';
import { recordsFor } from '../directory/dns';
import { mailProviderFor, type MailProviderEnv } from '../mailprovider/index';

type DomainEnv = AuthEnv & PlatformDnsEnv & MailProviderEnv;
type C = Context<{ Bindings: DomainEnv }>;

export const domainRoutes = new Hono<{ Bindings: DomainEnv }>();

const ORG_ID = /^[0-9a-f-]{36}$/;

/** The organization in the path, for an owner or admin of it. */
async function adminOf(c: C): Promise<string> {
  const id = c.req.param('id') ?? '';
  if (!ORG_ID.test(id)) throw badRequest('validation', 'not an organization id');
  const who = await resolveCaller(c, id);
  if (!who.user) throw unauthorized('missing bearer token');
  if (who.account?.role !== 'owner' && who.account?.role !== 'admin') throw new ApiError(403, 'forbidden', 'only owners and admins manage domains');
  return id;
}

async function bodyOf<S extends ZodTypeAny>(c: C, schema: S): Promise<z.output<S>> {
  const r = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!r.success) throw badRequest('validation', r.error.issues[0]?.message ?? 'invalid request');
  return r.data;
}

const domainParam = (c: C) => decodeURIComponent(c.req.param('domain') ?? '').toLowerCase();

domainRoutes.get('/v1/workspaces/:id/domains', async (c) => {
  const id = await adminOf(c);
  return c.json({ domains: await directory(c, 'describeDomains', id, c.req.query('refresh') === '1') });
});

domainRoutes.post('/v1/workspaces/:id/domains', async (c) => {
  const id = await adminOf(c);
  const body = await bodyOf(c, AddDomainBody);
  const row = await directory(c, 'addDomain', id, body.domain);
  const dto = (await directory(c, 'describeDomains', id)).find((d) => d.domain === row.domain);
  return c.json(dto, 201);
});

domainRoutes.post('/v1/workspaces/:id/domains/:domain/verify', async (c) => {
  const id = await adminOf(c);
  return c.json(await directory(c, 'verifyDomain', id, domainParam(c)));
});

// DKIM (phase 5.2): a new key for a verified domain, given to the mail provider, the private key kept sealed in the
// directory. The answer is the TXT record to publish; the platform subdomain's is written to our zone here.
domainRoutes.post('/v1/workspaces/:id/domains/:domain/dkim', async (c) => {
  const id = await adminOf(c);
  const out = await directory(c, 'setDomainDkim', id, domainParam(c));
  if (out.kind === 'platform') {
    const provider = mailProviderFor(c.env).records(out.domain, { selector: out.selector, value: out.record.value });
    c.executionCtx.waitUntil(platformDns(c.env, provider).publish(recordsFor(out.domain, provider)).catch((err) => console.error(`platform dns ${out.domain}: ${(err as Error).message}`)));
  }
  return c.json(out);
});

domainRoutes.patch('/v1/workspaces/:id/domains/:domain', async (c) => {
  const id = await adminOf(c);
  await bodyOf(c, PatchDomainBody);
  const row = await directory(c, 'setPrimaryDomain', id, domainParam(c));
  return c.json({ domain: row.domain, kind: row.kind, verified: row.verified, primary: row.primary });
});

domainRoutes.delete('/v1/workspaces/:id/domains/:domain', async (c) => {
  const id = await adminOf(c);
  await directory(c, 'removeDomain', id, domainParam(c));
  return c.json({ ok: true });
});
